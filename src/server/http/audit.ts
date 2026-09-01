/**
 * What the shared surface did.
 *
 * The send log records that this machine sent something. It cannot record who decided to, and
 * once the link is open that is a different person. This fills the gap: one row per state
 * change made over the tunnel, written where every such request already passes.
 *
 * Two decisions worth stating.
 *
 * **Reads are not recorded.** A row per page render buries the six rows that matter under a
 * thousand that do not, and "they looked at the review queue" is not a fact anyone needs. The
 * exception is an export, because a CSV is the only way data actually leaves through the link.
 *
 * **The sentence is written now, not derived later.** Storing `POST /api/drafts/x/approve` and
 * rendering it on demand means every future change to a route has to stay compatible with a log
 * of everything that ever happened. A sentence written at the time stays true.
 */
import { ulid, now, type Db } from "../db/index.ts";

export interface AuditRow {
  id: string; session_id: string | null; label: string; method: string; path: string;
  action: string; detail: string; subject_type: string | null; subject_id: string | null;
  status: number; ok: number; created_at: number;
  replay_session_id?: string | null; replay_seq?: number | null;
}

interface Rule {
  method: string;
  pattern: RegExp;
  /** The sentence, and optionally what it was done to. */
  describe: (m: RegExpExecArray, body: any, db: Db) => { action: string; detail?: string; subject?: [string, string] };
}

const rule = (method: string, path: string, describe: Rule["describe"]): Rule => ({
  method,
  pattern: new RegExp("^" + path.replace(/:([A-Za-z_]+)/g, "([^/]+)") + "$"),
  describe,
});

const str = (v: unknown, max = 120): string => String(v ?? "").trim().slice(0, max);

/** Who a draft is actually addressed to. The whole point of the row, for the rows that matter. */
function draftTarget(db: Db, draftId: string): string {
  const r = db.prepare(
    `SELECT c.email, co.name AS company FROM email_draft d
       JOIN contact c  ON c.id = d.contact_id
       JOIN company co ON co.id = c.company_id
      WHERE d.id = ?`,
  ).get(draftId) as { email?: string; company?: string } | undefined;
  if (!r?.email) return "";
  return r.company ? `${r.email} at ${r.company}` : r.email;
}

function campaignName(db: Db, id: string): string {
  return str((db.prepare("SELECT name FROM campaign WHERE id=?").get(id) as { name?: string } | undefined)?.name);
}

function companyName(db: Db, ccId: string): string {
  const r = db.prepare(
    "SELECT co.name, co.domain FROM campaign_company cc JOIN company co ON co.id=cc.company_id WHERE cc.id=?",
  ).get(ccId) as { name?: string; domain?: string } | undefined;
  return r ? str(r.name || r.domain) : "";
}

/* The order here is the order they are tried, so a literal path must come before its ":id" twin. */
const RULES: Rule[] = [
  rule("POST", "/api/campaigns", (_m, b) => ({ action: "Created a campaign", detail: str(b?.name) })),
  rule("POST", "/api/campaigns/reframe", () => ({ action: "Used Tidy this up on a campaign target" })),
  rule("POST", "/api/campaigns/suggest", () => ({ action: "Asked for campaign suggestions" })),
  rule("POST", "/api/campaigns/test-target", (_m, b) => ({
    action: "Checked a site against the targeting gate", detail: str(b?.website),
  })),
  rule("POST", "/api/campaigns/:id/test-target", (m, b, db) => ({
    action: "Checked a site against the targeting gate",
    detail: [str(b?.website), campaignName(db, m[1])].filter(Boolean).join(" · "),
    subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/settings", (m, _b, db) => ({
    action: "Changed a campaign's settings", detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/discover", (m, b, db) => ({
    action: "Searched the web for companies",
    detail: [campaignName(db, m[1]), str(b?.extra)].filter(Boolean).join(" · "),
    subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/manual", (m, b, db) => ({
    action: "Pasted a list of companies",
    detail: [campaignName(db, m[1]), `${String(b?.text ?? "").split("\n").filter((l: string) => l.trim()).length} line(s)`].filter(Boolean).join(" · "),
    subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/select-all", (m, b, db) => ({
    action: b?.selected === false ? "Unticked every company" : "Ticked every company",
    detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/run", (m, _b, db) => ({
    action: "Started research and writing", detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/sequence", (m, _b, db) => ({
    action: "Changed the follow-up sequence", detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),
  rule("POST", "/api/campaigns/:id/sequence/draft-due", (m, _b, db) => ({
    action: "Drafted the follow-ups that were due", detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),
  // A GET, and logged anyway: a CSV is the only way data leaves through the shared link.
  rule("GET", "/api/campaigns/:id/export/:kind", (m, _b, db) => ({
    action: `Exported ${m[2]} as CSV`, detail: campaignName(db, m[1]), subject: ["campaign", m[1]],
  })),

  rule("POST", "/api/companies/:ccId/select", (m, b, db) => ({
    action: b?.selected ? "Ticked a company" : "Unticked a company",
    detail: companyName(db, m[1]), subject: ["campaign_company", m[1]],
  })),
  rule("POST", "/api/companies/:ccId/override", (m, _b, db) => ({
    action: "Overruled the targeting gate", detail: companyName(db, m[1]), subject: ["campaign_company", m[1]],
  })),
  rule("POST", "/api/companies/:ccId/retry", (m, _b, db) => ({
    action: "Retried a company", detail: companyName(db, m[1]), subject: ["campaign_company", m[1]],
  })),
  rule("POST", "/api/companies/:ccId/contacts", (m, b, db) => ({
    action: "Added a contact by hand",
    detail: [str(b?.email), companyName(db, m[1])].filter(Boolean).join(" at "),
    subject: ["campaign_company", m[1]],
  })),
  rule("POST", "/api/companies/:ccId/draft/:contactId", (m, _b, db) => ({
    action: "Wrote a draft", detail: companyName(db, m[1]), subject: ["campaign_company", m[1]],
  })),

  rule("POST", "/api/drafts/bulk-approve", (_m, b) => ({
    action: `Bulk-approved ${Array.isArray(b?.ids) ? b.ids.length : "several"} drafts`,
  })),
  rule("POST", "/api/drafts/:id/edit", (m, _b, db) => ({
    action: "Edited a draft", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),
  rule("POST", "/api/drafts/:id/regenerate", (m, _b, db) => ({
    action: "Rewrote a draft", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),
  rule("POST", "/api/drafts/:id/approve", (m, _b, db) => ({
    action: "Approved a draft", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),
  rule("POST", "/api/drafts/:id/unapprove", (m, _b, db) => ({
    action: "Took an approval back", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),
  rule("POST", "/api/drafts/:id/skip", (m, _b, db) => ({
    action: "Skipped a draft", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),
  rule("POST", "/api/drafts/:id/send-now", (m, _b, db) => ({
    action: "Sent an email immediately", detail: draftTarget(db, m[1]), subject: ["draft", m[1]],
  })),

  rule("POST", "/api/send/start", () => ({ action: "Started sending" })),
  rule("POST", "/api/send/pause", () => ({ action: "Paused sending" })),

  rule("POST", "/api/replies/poll", () => ({ action: "Checked for replies" })),
  rule("POST", "/api/replies/:id/body", (m) => ({ action: "Opened a reply", subject: ["reply", m[1]] })),
  rule("POST", "/api/replies/:id/draft", (m) => ({ action: "Drafted an answer to a reply", subject: ["reply", m[1]] })),
  rule("POST", "/api/replies/:id/handled", (m) => ({ action: "Marked a reply handled", subject: ["reply", m[1]] })),

  rule("POST", "/api/suppression", (_m, b) => ({
    action: "Added an address to never-contact", detail: str(b?.pattern),
  })),

  rule("POST", "/api/share/redeem", () => ({ action: "Joined with an invite" })),
  rule("POST", "/api/share/leave", () => ({ action: "Signed out" })),
  rule("POST", "/api/share/control/request", () => ({ action: "Requested control of a shared tab" })),
  rule("POST", "/api/share/control/grant", () => ({ action: "Allowed owner control" })),
  rule("POST", "/api/share/control/deny", () => ({ action: "Declined owner control" })),
  rule("POST", "/api/share/control/release", () => ({ action: "Stopped shared-tab control" })),
];

/** The sentence for a request, or undefined when it is not worth a row. */
export function describeAction(
  db: Db, method: string, path: string, body: unknown,
): { action: string; detail: string; subject?: [string, string] } | undefined {
  for (const r of RULES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    const out = r.describe(m, body, db);
    return { action: out.action, detail: out.detail ?? "", subject: out.subject };
  }
  // Anything else that changes state still gets a row, just a blunt one. A route added later
  // and forgotten about here should show up as SOMETHING rather than vanish.
  if (method === "POST") return { action: `${method} ${path}`, detail: "" };
  return undefined;
}

export function recordAudit(db: Db, entry: {
  sessionId: string | null; label: string; method: string; path: string;
  action: string; detail: string; subject?: [string, string]; status: number;
  replay?: { replaySessionId: string; replaySeq: number | null };
}): AuditRow | undefined {
  try {
    const id = ulid();
    db.prepare(
      `INSERT INTO share_audit (id,session_id,label,method,path,action,detail,subject_type,subject_id,status,ok,created_at,replay_session_id,replay_seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, entry.sessionId, entry.label.slice(0, 80), entry.method, entry.path.slice(0, 200),
          entry.action.slice(0, 200), entry.detail.slice(0, 200),
          entry.subject?.[0] ?? null, entry.subject?.[1] ?? null,
          entry.status, entry.status < 400 ? 1 : 0, now(),
          entry.replay?.replaySessionId ?? null, entry.replay?.replaySeq ?? null);
    return db.prepare("SELECT * FROM share_audit WHERE id=?").get(id) as AuditRow;
  } catch {
    // An audit row failing must never fail the request it is describing. The action already
    // happened; losing the note about it is the lesser of the two.
    return undefined;
  }
}

export function listAudit(db: Db, opts: { limit?: number; sessionId?: string; failedOnly?: boolean } = {}): AuditRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sessionId) { where.push("session_id = ?"); args.push(opts.sessionId); }
  if (opts.failedOnly) where.push("ok = 0");
  return db.prepare(
    `SELECT * FROM share_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC LIMIT ?`,
  ).all(...args, Math.min(500, Math.max(1, opts.limit ?? 200))) as AuditRow[];
}

/** Counts for the header strip: enough to see at a glance whether anything unusual happened. */
export function auditSummary(db: Db): { today: number; sends: number; approvals: number; refused: number; lastAt: number | null } {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const one = (sql: string, ...a: unknown[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
  return {
    today: one("SELECT COUNT(*) n FROM share_audit WHERE created_at > ?", since),
    sends: one("SELECT COUNT(*) n FROM share_audit WHERE created_at > ? AND action LIKE 'Sent an email%'", since),
    // "Bulk-approved 40 drafts" is an approval too. Counting actions rather than drafts, which
    // is what the label says; the feed row underneath carries the number.
    approvals: one(
      "SELECT COUNT(*) n FROM share_audit WHERE created_at > ? AND (action LIKE 'Approved%' OR action LIKE 'Bulk-approved%')",
      since),
    refused: one("SELECT COUNT(*) n FROM share_audit WHERE created_at > ? AND ok = 0", since),
    lastAt: (db.prepare("SELECT MAX(created_at) n FROM share_audit").get() as { n: number | null }).n,
  };
}
