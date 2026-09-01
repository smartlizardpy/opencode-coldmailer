/**
 * Session replay for the shared coldcall tab.
 *
 * This is co-browse, not screen capture. The browser page sends a bounded stream of events from
 * inside coldcall: route changes, pointer/clicks, scroll, keyboard shortcuts, focus, input
 * values and occasional sanitized DOM snapshots. The owner can watch the live state over SSE
 * and can replay the stored event stream later.
 */
import { ulid, now, tx, type Db } from "../db/index.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_MS = 25_000;
const ACTIVE_MS = 60 * 60 * 1000;
const MAX_BATCH = 120;
const MAX_VALUE = 20_000;
const MAX_SELECTOR = 220;
const MAX_FIELD = 120;
const MAX_ROUTE = 80;
const MAX_SNAPSHOT = 450_000;
const MAX_PAYLOAD = 520_000;

const TYPES = new Set([
  "route", "viewport", "pointer", "click", "scroll", "focus", "blur", "input", "key", "snapshot", "end",
]);

type Point = { x: number; y: number };
type Viewport = { w: number; h: number };

export interface ReplaySessionRow {
  id: string;
  share_session_id: string | null;
  tab_id: string;
  label: string;
  user_agent: string;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  event_count: number;
  last_route: string;
}

export interface ReplayEventRow {
  id?: number;
  replay_session_id: string;
  at: number;
  seq: number;
  type: string;
  route: string | null;
  payload: Record<string, unknown>;
}

export interface ReplayLiveState {
  replaySessionId: string;
  sessionId: string | null;
  tabId: string;
  label: string;
  at: number;
  route?: string;
  cursor?: Point;
  viewport?: Viewport;
  field?: string;
  selector?: string;
  typed?: string;
  key?: { label: string; at: number };
  scroll?: { selector: string; x: number; y: number; maxX: number; maxY: number };
  snapshot?: { html: string; theme?: string; at: number };
  clicks: Array<Point & { at: number; seq: number }>;
  seq: number;
}

interface ActiveReplay { replayId: string; lastSeq: number; lastAt: number; shareSessionId: string | null; tabId: string }
interface CleanEvent { at: number; type: string; route: string | null; payload: Record<string, unknown> }

const activeByTab = new Map<string, ActiveReplay>();
const live = new Map<string, ReplayLiveState>();
let nextPruneAt = 0;

const finite = (n: unknown): number | undefined => {
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
};
const clamp = (n: unknown, min: number, max: number): number | undefined => {
  const v = finite(n);
  return v === undefined ? undefined : Math.max(min, Math.min(max, v));
};
const unit = (n: unknown): number | undefined => clamp(n, 0, 1);
const short = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
};
const route = (v: unknown): string | undefined => short(v, MAX_ROUTE);
const selector = (v: unknown): string | undefined => short(v, MAX_SELECTOR);
const field = (v: unknown): string | undefined => short(v, MAX_FIELD);
const value = (v: unknown): string | undefined => short(v, MAX_VALUE);
const tab = (v: unknown): string => (short(v, 80) ?? "tab").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) || "tab";

function eventTime(v: unknown): number {
  const t = finite(v);
  const n = now();
  // Client clocks are only advisory. Keeping a five-minute window preserves natural ordering
  // across a batch without letting a bad clock make the timeline jump to 1970 or next month.
  if (t === undefined || t < n - 5 * 60_000 || t > n + 60_000) return n;
  return Math.floor(t);
}

function pointFrom(raw: Record<string, unknown>): Point | undefined {
  const x = unit(raw.x), y = unit(raw.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function cleanEvent(raw: unknown, fallbackRoute?: string): CleanEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = short(r.type, 24);
  if (!type || !TYPES.has(type)) return undefined;

  const at = eventTime(r.at);
  const rt = route(r.route) ?? fallbackRoute ?? null;

  if (type === "pointer" || type === "click") {
    const p = pointFrom(r);
    if (!p) return undefined;
    return { at, type, route: rt, payload: type === "click" ? { ...p, button: Math.floor(finite(r.button) ?? 0) } : p };
  }

  if (type === "viewport") {
    const w = clamp(r.w, 1, 10_000), h = clamp(r.h, 1, 10_000);
    if (w === undefined || h === undefined) return undefined;
    return { at, type, route: rt, payload: { w: Math.round(w), h: Math.round(h) } };
  }

  if (type === "scroll") {
    const x = clamp(r.x, 0, 5_000_000) ?? 0;
    const y = clamp(r.y, 0, 5_000_000) ?? 0;
    const maxX = clamp(r.maxX, 0, 5_000_000) ?? 0;
    const maxY = clamp(r.maxY, 0, 5_000_000) ?? 0;
    return { at, type, route: rt, payload: {
      selector: selector(r.selector) ?? "#content",
      x: Math.round(x), y: Math.round(y), maxX: Math.round(maxX), maxY: Math.round(maxY),
    } };
  }

  if (type === "focus" || type === "blur") {
    return { at, type, route: rt, payload: {
      field: field(r.field) ?? "",
      selector: selector(r.selector) ?? "",
      redacted: r.redacted === true,
    } };
  }

  if (type === "input") {
    return { at, type, route: rt, payload: {
      field: field(r.field) ?? "",
      selector: selector(r.selector) ?? "",
      value: r.redacted === true ? "" : (value(r.value) ?? ""),
      redacted: r.redacted === true,
    } };
  }

  if (type === "key") {
    const key = short(r.key, 40);
    if (!key) return undefined;
    return { at, type, route: rt, payload: {
      key,
      code: short(r.code, 40) ?? "",
      alt: r.alt === true, ctrl: r.ctrl === true, meta: r.meta === true, shift: r.shift === true,
    } };
  }

  if (type === "route") {
    const nextRoute = route(r.route) ?? rt;
    if (!nextRoute) return undefined;
    return { at, type, route: nextRoute, payload: { route: nextRoute } };
  }

  if (type === "snapshot") {
    const html = short(r.html, MAX_SNAPSHOT);
    if (!html) return undefined;
    return { at, type, route: rt, payload: {
      html,
      theme: short(r.theme, 20) ?? "",
    } };
  }

  if (type === "end") return { at, type, route: rt, payload: {} };
  return undefined;
}

function payloadJson(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return json.length > MAX_PAYLOAD ? JSON.stringify({ truncated: true }) : json;
}

function replayKey(shareSessionId: string, tabId: string): string {
  return `${shareSessionId}:${tabId}`;
}

function rowFor(db: Db, replayId: string): ReplaySessionRow | undefined {
  return db.prepare("SELECT * FROM share_replay_session WHERE id=?").get(replayId) as ReplaySessionRow | undefined;
}

function createReplaySession(db: Db, shareSessionId: string, label: string, userAgent: string, tabId: string): ReplaySessionRow {
  const id = ulid();
  const t = now();
  db.prepare(
    `INSERT INTO share_replay_session (id,share_session_id,tab_id,label,user_agent,started_at,last_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, shareSessionId, tabId, label.slice(0, 80), userAgent.slice(0, 200), t, t);
  return rowFor(db, id)!;
}

function maxSeq(db: Db, replayId: string): number {
  return Number((db.prepare("SELECT COALESCE(MAX(seq),0) n FROM share_replay_event WHERE replay_session_id=?")
    .get(replayId) as { n: number }).n);
}

function activeReplay(
  db: Db,
  shareSessionId: string,
  label: string,
  userAgent: string,
  tabId: string,
  requestedReplayId?: string,
): ActiveReplay {
  const key = replayKey(shareSessionId, tabId);
  const cur = activeByTab.get(key);
  if (cur && now() - cur.lastAt < ACTIVE_MS && (!requestedReplayId || requestedReplayId === cur.replayId)) return cur;

  if (requestedReplayId) {
    const existing = rowFor(db, requestedReplayId);
    if (existing && existing.share_session_id === shareSessionId && existing.tab_id === tabId) {
      const a = { replayId: existing.id, lastSeq: maxSeq(db, existing.id), lastAt: now(), shareSessionId, tabId };
      activeByTab.set(key, a);
      return a;
    }
  }

  const row = createReplaySession(db, shareSessionId, label, userAgent, tabId);
  const a = { replayId: row.id, lastSeq: 0, lastAt: row.last_at, shareSessionId, tabId };
  activeByTab.set(key, a);
  return a;
}

function applyLive(state: ReplayLiveState, e: ReplayEventRow): void {
  state.at = Math.max(state.at, e.at);
  state.seq = Math.max(state.seq, e.seq);
  if (e.route) state.route = e.route;

  if (e.type === "pointer") {
    const x = unit(e.payload.x), y = unit(e.payload.y);
    if (x !== undefined && y !== undefined) state.cursor = { x, y };
  } else if (e.type === "click") {
    const x = unit(e.payload.x), y = unit(e.payload.y);
    if (x !== undefined && y !== undefined) {
      state.cursor = { x, y };
      state.clicks.push({ x, y, at: e.at, seq: e.seq });
      state.clicks = state.clicks.slice(-12);
    }
  } else if (e.type === "viewport") {
    const w = finite(e.payload.w), h = finite(e.payload.h);
    if (w && h) state.viewport = { w: Math.round(w), h: Math.round(h) };
  } else if (e.type === "scroll") {
    state.scroll = {
      selector: String(e.payload.selector ?? "#content"),
      x: Math.round(finite(e.payload.x) ?? 0),
      y: Math.round(finite(e.payload.y) ?? 0),
      maxX: Math.round(finite(e.payload.maxX) ?? 0),
      maxY: Math.round(finite(e.payload.maxY) ?? 0),
    };
  } else if (e.type === "focus") {
    state.field = String(e.payload.field ?? "");
    state.selector = String(e.payload.selector ?? "");
    state.typed = e.payload.redacted ? "not recorded" : state.typed;
  } else if (e.type === "blur") {
    state.field = "";
    state.selector = "";
  } else if (e.type === "input") {
    state.field = String(e.payload.field ?? state.field ?? "");
    state.selector = String(e.payload.selector ?? state.selector ?? "");
    state.typed = e.payload.redacted ? "not recorded" : String(e.payload.value ?? "");
  } else if (e.type === "key") {
    const mods = [e.payload.meta ? "⌘" : "", e.payload.ctrl ? "Ctrl" : "", e.payload.alt ? "Alt" : "", e.payload.shift ? "Shift" : ""]
      .filter(Boolean).join("+");
    const k = String(e.payload.key ?? "");
    state.key = { label: mods ? `${mods}+${k}` : k, at: e.at };
  } else if (e.type === "route") {
    state.route = String(e.payload.route ?? e.route ?? "");
  } else if (e.type === "snapshot") {
    state.snapshot = { html: String(e.payload.html ?? ""), theme: String(e.payload.theme ?? ""), at: e.at };
  }
}

function ensureLive(replay: ActiveReplay, row: ReplaySessionRow): ReplayLiveState {
  const existing = live.get(replay.replayId);
  if (existing) return existing;
  const state: ReplayLiveState = {
    replaySessionId: replay.replayId,
    sessionId: row.share_session_id,
    tabId: row.tab_id,
    label: row.label || "Teammate",
    at: row.last_at,
    route: row.last_route || undefined,
    clicks: [],
    seq: replay.lastSeq,
  };
  live.set(replay.replayId, state);
  return state;
}

export function recordReplayBatch(db: Db, args: {
  shareSessionId: string;
  label: string;
  userAgent: string;
  input?: Record<string, unknown>;
}): { replaySession: ReplaySessionRow; events: ReplayEventRow[]; live: ReplayLiveState } {
  const input = args.input && typeof args.input === "object" ? args.input : {};
  const tabId = tab(input.tabId);
  const requestedReplayId = short(input.replaySessionId, 40);
  const fallbackRoute = route(input.route);
  const rawEvents = Array.isArray(input.events) ? input.events.slice(0, MAX_BATCH) : [];
  const cleaned = rawEvents.map((e) => cleanEvent(e, fallbackRoute)).filter((e): e is CleanEvent => !!e);

  pruneOldReplays(db);

  const replay = activeReplay(db, args.shareSessionId, args.label, args.userAgent, tabId, requestedReplayId);
  const rows: ReplayEventRow[] = [];

  tx(db, () => {
    const insert = db.prepare(
      `INSERT INTO share_replay_event (replay_session_id,at,seq,type,route,payload_json)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const e of cleaned) {
      const seq = ++replay.lastSeq;
      insert.run(replay.replayId, e.at, seq, e.type, e.route, payloadJson(e.payload));
      rows.push({ replay_session_id: replay.replayId, at: e.at, seq, type: e.type, route: e.route, payload: e.payload });
    }
    const t = rows.length ? Math.max(...rows.map((r) => r.at)) : now();
    const lastRoute = [...rows].reverse().find((r) => r.route)?.route ?? fallbackRoute ?? undefined;
    db.prepare(
      `UPDATE share_replay_session
          SET last_at=?, event_count=event_count+?, last_route=COALESCE(?, last_route), ended_at=CASE WHEN ? THEN ? ELSE ended_at END
        WHERE id=?`,
    ).run(t, rows.length, lastRoute ?? null, rows.some((r) => r.type === "end") ? 1 : 0, t, replay.replayId);
    replay.lastAt = t;
  });

  const row = rowFor(db, replay.replayId)!;
  const state = ensureLive(replay, row);
  if (!rows.length) {
    state.at = row.last_at;
    state.seq = replay.lastSeq;
    if (row.last_route) state.route = row.last_route;
  }
  for (const e of rows) applyLive(state, e);
  activeByTab.set(replayKey(args.shareSessionId, tabId), replay);
  return { replaySession: row, events: rows, live: state };
}

export function liveReplayStates(maxAgeMs = LIVE_MS): ReplayLiveState[] {
  const cutoff = now() - maxAgeMs;
  for (const [id, state] of live) {
    if (state.at <= cutoff) live.delete(id);
  }
  return [...live.values()].sort((a, b) => b.at - a.at);
}

export function replayMarkerForRequest(
  db: Db,
  shareSessionId: string | undefined,
  replayIdHeader: string | string[] | undefined,
  seqHeader: string | string[] | undefined,
): { replaySessionId: string; replaySeq: number | null } | undefined {
  if (!shareSessionId) return undefined;
  const replayId = Array.isArray(replayIdHeader) ? replayIdHeader[0] : replayIdHeader;
  const seqRaw = Array.isArray(seqHeader) ? seqHeader[0] : seqHeader;
  if (replayId) {
    const row = rowFor(db, replayId);
    if (row?.share_session_id === shareSessionId) {
      const seq = finite(seqRaw);
      return { replaySessionId: row.id, replaySeq: seq === undefined ? null : Math.min(maxSeq(db, row.id), Math.max(0, Math.floor(seq))) };
    }
  }
  const active = [...activeByTab.values()]
    .filter((a) => a.shareSessionId === shareSessionId && now() - a.lastAt < LIVE_MS)
    .sort((a, b) => b.lastAt - a.lastAt)[0];
  return active ? { replaySessionId: active.replayId, replaySeq: active.lastSeq } : undefined;
}

export function listReplays(db: Db, opts: { limit?: number; sessionId?: string } = {}): ReplaySessionRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sessionId) { where.push("share_session_id = ?"); args.push(opts.sessionId); }
  return db.prepare(
    `SELECT * FROM share_replay_session ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY last_at DESC LIMIT ?`,
  ).all(...args, Math.min(100, Math.max(1, opts.limit ?? 30))) as ReplaySessionRow[];
}

export function replaySession(db: Db, id: string): ReplaySessionRow | undefined {
  return rowFor(db, id);
}

export function listReplayEvents(db: Db, replayId: string, opts: { limit?: number } = {}): ReplayEventRow[] {
  const rows = db.prepare(
    `SELECT id,replay_session_id,at,seq,type,route,payload_json
       FROM share_replay_event
      WHERE replay_session_id=?
      ORDER BY seq ASC
      LIMIT ?`,
  ).all(replayId, Math.min(20_000, Math.max(1, opts.limit ?? 10_000))) as Array<Omit<ReplayEventRow, "payload"> & { payload_json: string }>;
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload_json); } catch { payload = {}; }
    return { id: r.id, replay_session_id: r.replay_session_id, at: r.at, seq: r.seq, type: r.type, route: r.route, payload };
  });
}

export function pruneOldReplays(db: Db, retentionMs = RETENTION_MS): number {
  const t = now();
  if (retentionMs === RETENTION_MS && t < nextPruneAt) return 0;
  nextPruneAt = t + 60_000;
  try {
    const r = db.prepare("DELETE FROM share_replay_session WHERE last_at < ?").run(t - retentionMs);
    return Number(r.changes);
  } catch {
    return 0;
  }
}

/** Test helper: clear in-memory live state without touching the database. */
export function clearLiveReplay(): void {
  activeByTab.clear();
  live.clear();
  nextPruneAt = 0;
}
