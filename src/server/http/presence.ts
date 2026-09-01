type Point = { x: number; y: number };
type Viewport = { w: number; h: number };

export type PresenceInput = {
  route?: unknown;
  cursor?: unknown;
  viewport?: unknown;
  field?: unknown;
  clicks?: unknown;
};

export type PresenceState = {
  sessionId: string;
  label: string;
  at: number;
  route?: string;
  cursor?: Point;
  viewport?: Viewport;
  field?: string;
  clicks: Point[];
};

const presence = new Map<string, PresenceState>();
let watchedUntil = 0;

const clamp01 = (n: unknown): number | undefined => {
  const v = Number(n);
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(1, v));
};

function point(v: unknown): Point | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { x?: unknown; y?: unknown };
  const x = clamp01(o.x);
  const y = clamp01(o.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

function viewport(v: unknown): Viewport | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { w?: unknown; h?: unknown };
  const w = Math.max(0, Math.floor(Number(o.w)) || 0);
  const h = Math.max(0, Math.floor(Number(o.h)) || 0);
  if (!w && !h) return undefined;
  return { w, h };
}

function shortString(v: unknown, max = 120): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.slice(0, max);
}

function cleanClicks(v: unknown): Point[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(point).filter((p): p is Point => !!p).slice(-8);
}

export function recordPresence(sessionId: string, label: string, input: PresenceInput = {}): PresenceState {
  const prev = presence.get(sessionId);
  const next: PresenceState = {
    sessionId,
    label: label || "Teammate",
    at: Date.now(),
    clicks: prev?.clicks ?? [],
  };

  const route = shortString(input.route, 80);
  if (route !== undefined) next.route = route;
  else if (prev?.route !== undefined) next.route = prev.route;

  const cursor = point(input.cursor);
  if (cursor) next.cursor = cursor;
  else if (prev?.cursor) next.cursor = prev.cursor;

  const vp = viewport(input.viewport);
  if (vp) next.viewport = vp;
  else if (prev?.viewport) next.viewport = prev.viewport;

  const field = shortString(input.field, 120);
  if (field !== undefined) next.field = field;
  else if (prev?.field !== undefined) next.field = prev.field;

  const clicks = cleanClicks(input.clicks);
  if (clicks) next.clicks = clicks;

  presence.set(sessionId, next);
  return next;
}

export function forgetPresence(sessionId: string): void {
  presence.delete(sessionId);
}

export function livePresence(maxAgeMs = 20_000): PresenceState[] {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, state] of presence) {
    if (state.at <= cutoff) presence.delete(id);
  }
  return [...presence.values()].sort((a, b) => b.at - a.at);
}

export function markWatching(ms = 15_000): void {
  watchedUntil = Date.now() + ms;
}

export function isWatched(): boolean {
  return Date.now() < watchedUntil;
}

export function stopWatching(): void {
  watchedUntil = 0;
}
