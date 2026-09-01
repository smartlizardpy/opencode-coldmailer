/**
 * Who is asking, and what they are allowed to do.
 *
 * coldcall serves two surfaces from one process:
 *
 *   - the **local** surface on 127.0.0.1, which is the owner's machine. It sets up the
 *     mailbox, the app password, the models and the product. Anything reaching it has already
 *     proved more than a password could: it is running as the user, on the user's machine.
 *   - the **shared** surface, a Cloudflare tunnel URL handed to a co-founder who runs the
 *     campaigns and sends the mail. It is on the public internet, so it proves itself with a
 *     session cookie obtained by redeeming an invite the owner generated.
 *
 * The rule that makes this safe is that the allow-list is positive and per-route. A new
 * endpoint is invisible to the shared surface until someone adds it here on purpose, so
 * forgetting about this file fails closed. The alternative - a deny-list of sensitive routes -
 * fails open, and the thing it would leak first is the SMTP password.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ulid, now, type Db } from "../db/index.ts";

export type Role = "owner" | "sender";

/** 30 days: long enough that a co-founder is not re-authenticating every morning. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "cc_share";

/* ------------------------------------------------------------------ scopes */

interface Scope { method: string; pattern: RegExp }

function scope(method: string, path: string): Scope {
  return { method, pattern: new RegExp("^" + path.replace(/:([A-Za-z_]+)/g, "([^/]+)") + "$") };
}

/**
 * Everything the shared surface may do. The co-founder's job is the whole outreach loop -
 * set a campaign up, find companies, read the drafts, approve them, watch the replies - so
 * this is deliberately wide. What it excludes is anything that reads a credential, changes
 * how this machine sends, or destroys history:
 *
 *   /api/settings*        the mailbox, the app password, the send window, the daily cap
 *   /api/models/probe     which models this machine uses
 *   /api/interview/*      the product interview, and POST /api/product/:id
 *   /api/llm-calls        the Activity log, which quotes prompts and raw model output
 *   /api/integrity*       database repair
 *   /api/campaigns/:id/delete   deletes the send log, which is what the daily cap counts
 *   /api/suppression/:id/delete un-blocks an address someone deliberately blocked
 *   /api/share/*          minting and revoking invites, which is the owner's key ring
 */
const SENDER_SCOPES: Scope[] = [
  scope("GET", "/api/health"),
  scope("GET", "/api/stats"),
  scope("GET", "/api/product"),

  scope("GET", "/api/campaigns"),
  scope("POST", "/api/campaigns"),
  scope("POST", "/api/campaigns/reframe"),
  scope("POST", "/api/campaigns/suggest"),
  scope("POST", "/api/campaigns/test-target"),
  scope("GET", "/api/campaigns/:id"),
  scope("POST", "/api/campaigns/:id/settings"),
  scope("GET", "/api/campaigns/:id/companies"),
  scope("POST", "/api/campaigns/:id/discover"),
  scope("POST", "/api/campaigns/:id/manual"),
  scope("POST", "/api/campaigns/:id/select-all"),
  scope("POST", "/api/campaigns/:id/run"),
  scope("POST", "/api/campaigns/:id/test-target"),
  scope("GET", "/api/campaigns/:id/drafts"),
  scope("GET", "/api/campaigns/:id/sequence"),
  scope("POST", "/api/campaigns/:id/sequence"),
  scope("POST", "/api/campaigns/:id/sequence/draft-due"),
  scope("GET", "/api/campaigns/:id/export/:kind"),

  scope("GET", "/api/companies/:ccId"),
  scope("POST", "/api/companies/:ccId/select"),
  scope("POST", "/api/companies/:ccId/override"),
  scope("POST", "/api/companies/:ccId/retry"),
  scope("POST", "/api/companies/:ccId/contacts"),
  scope("POST", "/api/companies/:ccId/draft/:contactId"),

  scope("GET", "/api/drafts/:id"),
  scope("POST", "/api/drafts/bulk-approve"),
  scope("POST", "/api/drafts/:id/edit"),
  scope("POST", "/api/drafts/:id/regenerate"),
  scope("POST", "/api/drafts/:id/approve"),
  scope("POST", "/api/drafts/:id/unapprove"),
  scope("POST", "/api/drafts/:id/skip"),
  scope("POST", "/api/drafts/:id/send-now"),

  scope("GET", "/api/send/status"),
  scope("POST", "/api/send/start"),
  scope("POST", "/api/send/pause"),

  scope("GET", "/api/replies"),
  scope("POST", "/api/replies/poll"),
  scope("POST", "/api/replies/:id/body"),
  scope("POST", "/api/replies/:id/draft"),
  scope("POST", "/api/replies/:id/handled"),

  scope("GET", "/api/deliverability"),
  scope("GET", "/api/suppression"),
  scope("POST", "/api/suppression"),

  scope("GET", "/api/share/me"),
  scope("POST", "/api/share/leave"),
  // A teammate who already has a session and opens a fresh invite link should re-join, not
  // be told they are forbidden from the very screen that got them in.
  scope("POST", "/api/share/redeem"),
  // The page reporting its own cursor/clicks/screen so the owner can watch live. Their own
  // activity, sent by their own page - and the response tells them they are being watched.
  scope("POST", "/api/share/presence"),
];

/** Reachable over the tunnel with no session at all: the join screen and its assets. */
const ANONYMOUS_PATHS = new Set(["/", "/index.html", "/app.css", "/app.js", "/icons.svg", "/favicon.ico"]);
const ANONYMOUS_API: Scope[] = [
  scope("GET", "/api/share/me"),
  scope("POST", "/api/share/redeem"),
];

export function allows(role: Role, method: string, path: string): boolean {
  if (role === "owner") return true;
  return SENDER_SCOPES.some((s) => s.method === method && s.pattern.test(path));
}

export function anonymousAllows(method: string, path: string): boolean {
  if (method === "GET" && ANONYMOUS_PATHS.has(path)) return true;
  return ANONYMOUS_API.some((s) => s.method === method && s.pattern.test(path));
}

/** Exposed for the tests, which assert the shape of the surface rather than a handful of paths. */
export const senderScopeList = (): string[] =>
  SENDER_SCOPES.map((s) => `${s.method} ${s.pattern.source}`);

/* ------------------------------------------------------------------ tokens */

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * Both sides are already fixed-length SHA-256 output, so the length check below is about a
 * malformed input rather than about the secret.
 */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const newToken = (): string => randomBytes(32).toString("base64url");

/* ----------------------------------------------------------------- cookies */

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * `Secure` is unconditional: the shared surface only ever exists behind an HTTPS tunnel, and a
 * cookie that would also travel over plaintext is a cookie that can be read off a café network.
 * `SameSite=Lax` is the CSRF half - a cross-site POST carries no cookie at all - and the Origin
 * check in the server is the belt to its braces.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
export const clearedCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/* ----------------------------------------------------------------- invites */

export interface InviteRow {
  id: string; label: string; role: Role; expires_at: number | null;
  revoked_at: number | null; uses: number; last_used_at: number | null; created_at: number;
}

/** Returns the token exactly once. It is never stored and cannot be shown again. */
export function createInvite(db: Db, label: string, ttlMs = INVITE_TTL_MS): { invite: InviteRow; token: string } {
  const token = newToken();
  const id = ulid();
  const t = now();
  db.prepare(
    "INSERT INTO share_invite (id, token_hash, label, role, expires_at, created_at) VALUES (?,?,?,?,?,?)",
  ).run(id, sha256(token), label.slice(0, 80), "sender", t + ttlMs, t);
  return { invite: db.prepare("SELECT id,label,role,expires_at,revoked_at,uses,last_used_at,created_at FROM share_invite WHERE id=?").get(id) as InviteRow, token };
}

export function listInvites(db: Db): InviteRow[] {
  return db.prepare(
    "SELECT id,label,role,expires_at,revoked_at,uses,last_used_at,created_at FROM share_invite ORDER BY id DESC",
  ).all() as InviteRow[];
}

/** Revoking an invite revokes every session it ever created - that is the point of revoking. */
export function revokeInvite(db: Db, id: string): number {
  const t = now();
  db.prepare("UPDATE share_invite SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(t, id);
  const r = db.prepare("UPDATE share_session SET revoked_at=? WHERE invite_id=? AND revoked_at IS NULL").run(t, id);
  return Number(r.changes);
}

/* ---------------------------------------------------------------- sessions */

export interface SessionRow {
  id: string; invite_id: string | null; role: Role; label: string; user_agent: string;
  created_at: number; last_seen_at: number; expires_at: number; revoked_at: number | null;
}

export interface RedeemResult { ok: boolean; token?: string; maxAge?: number; error?: string }

/**
 * Turn an invite token into a session.
 *
 * The lookup is by hash, so a database read cannot recover the link the owner sent. The
 * digest comparison is still constant-time: the row is found by an indexed equality on the
 * hash, and `sameDigest` then re-checks it so the code does not depend on SQLite's comparison
 * for the security property.
 */
export function redeemInvite(db: Db, token: string, userAgent: string): RedeemResult {
  const clean = String(token ?? "").trim();
  if (!clean || clean.length > 200) return { ok: false, error: "that invite link is not valid" };

  const hash = sha256(clean);
  const row = db.prepare("SELECT * FROM share_invite WHERE token_hash=?").get(hash) as
    (InviteRow & { token_hash: string }) | undefined;
  if (!row || !sameDigest(row.token_hash, hash)) return { ok: false, error: "that invite link is not valid" };
  if (row.revoked_at) return { ok: false, error: "that invite has been revoked" };
  if (row.expires_at && row.expires_at < now()) return { ok: false, error: "that invite has expired" };

  const sessionToken = newToken();
  const t = now();
  db.prepare(
    `INSERT INTO share_session (id, invite_id, token_hash, role, label, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(ulid(), row.id, sha256(sessionToken), row.role, row.label, String(userAgent ?? "").slice(0, 200), t, t, t + SESSION_TTL_MS);
  db.prepare("UPDATE share_invite SET uses=uses+1, last_used_at=? WHERE id=?").run(t, row.id);

  return { ok: true, token: sessionToken, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

/** The live session for a cookie, or undefined. Touches last_seen_at at most once a minute. */
export function sessionFor(db: Db, token: string | undefined): SessionRow | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  const row = db.prepare("SELECT * FROM share_session WHERE token_hash=?").get(hash) as
    (SessionRow & { token_hash: string }) | undefined;
  if (!row || !sameDigest(row.token_hash, hash)) return undefined;
  if (row.revoked_at || row.expires_at < now()) return undefined;
  if (now() - row.last_seen_at > 60_000) {
    db.prepare("UPDATE share_session SET last_seen_at=? WHERE id=?").run(now(), row.id);
  }
  return row;
}

export function listSessions(db: Db): SessionRow[] {
  return db.prepare(
    `SELECT id,invite_id,role,label,user_agent,created_at,last_seen_at,expires_at,revoked_at
     FROM share_session WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
  ).all(now()) as SessionRow[];
}

export function revokeSession(db: Db, id: string): boolean {
  return Number(db.prepare("UPDATE share_session SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), id).changes) > 0;
}

export function revokeSessionByToken(db: Db, token: string | undefined): boolean {
  const s = sessionFor(db, token);
  return s ? revokeSession(db, s.id) : false;
}

export function revokeEverything(db: Db): { invites: number; sessions: number } {
  const t = now();
  const i = db.prepare("UPDATE share_invite SET revoked_at=? WHERE revoked_at IS NULL").run(t);
  const s = db.prepare("UPDATE share_session SET revoked_at=? WHERE revoked_at IS NULL").run(t);
  return { invites: Number(i.changes), sessions: Number(s.changes) };
}

/* ------------------------------------------------------------ rate limiting */

/**
 * A tunnel URL is on the public internet, and an invite token is the only thing between it
 * and the drafts. Guessing one is infeasible at 256 bits, but an unthrottled endpoint still
 * lets someone try forever and fills the log while they do.
 *
 * In memory on purpose: it protects a process, and persisting it would let a restart-loop be
 * used to lock the co-founder out.
 */
const attempts = new Map<string, { n: number; until: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function throttled(key: string): boolean {
  const a = attempts.get(key);
  if (!a) return false;
  if (a.until < Date.now()) { attempts.delete(key); return false; }
  return a.n >= MAX_ATTEMPTS;
}

export function recordFailure(key: string): void {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { n: 1, until: Date.now() + WINDOW_MS });
  else a.n += 1;
}

export function clearFailures(key: string): void { attempts.delete(key); }
