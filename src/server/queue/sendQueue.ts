/**
 * The sending queue.
 *
 * Every guard here is checked at the MOMENT OF SEND, not at approval time, and the daily cap is
 * computed by counting rows in send_log over a rolling 24h rather than an in-memory counter -
 * so restarting the app cannot blow past it.
 */
import { ulid, now, tx, type Db } from "../db/index.ts";
import { getSecret } from "../mail/secrets.ts";
import { newMessageId, sendMail, type SmtpConfig } from "../mail/smtp.ts";
import { getSetting, type SendingSettings } from "../db/settings.ts";
import { describeWindow, isOpen, nextOpen, normaliseWindow } from "./window.ts";
import { productForDraft, renderedBody } from "../research/compose.ts";

export interface SendGuards {
  dailyLimit: number; sentLast24h: number; paused: boolean; remaining: number;
  /** False when the configured sending window is closed right now. */
  windowOpen: boolean;
  /** Epoch ms the window next opens, absent when it is open or not configured. */
  windowOpensAt?: number;
  /** Human summary of the window, for the UI to show without re-deriving it. */
  windowLabel: string;
}

export function sendGuards(db: Db, campaignId?: string): SendGuards {
  const s = getSetting<SendingSettings>(db, "sending", { dailyLimit: 30, paused: false } as SendingSettings);
  const since = Date.now() - 24 * 3600_000;
  const row = db.prepare("SELECT COUNT(*) c FROM send_log WHERE status='sent' AND sent_at >= ?").get(since) as { c: number };
  let limit = s.dailyLimit ?? 30;
  if (campaignId) {
    const c = db.prepare("SELECT daily_send_limit FROM campaign WHERE id=?").get(campaignId) as { daily_send_limit: number } | undefined;
    if (c) limit = Math.min(limit, c.daily_send_limit);
  }
  const w = normaliseWindow(s.window);
  const opensAt = nextOpen(w);
  return {
    dailyLimit: limit, sentLast24h: row.c, paused: !!s.paused, remaining: Math.max(0, limit - row.c),
    windowOpen: isOpen(w), windowOpensAt: opensAt?.getTime(), windowLabel: describeWindow(w),
  };
}

/** Suppression matches the exact address or the whole domain. */
export function isSuppressed(db: Db, email: string): { suppressed: boolean; reason?: string } {
  const e = email.toLowerCase();
  const domain = `@${e.split("@")[1] ?? ""}`;
  const row = db.prepare("SELECT reason, pattern FROM suppression WHERE lower(pattern)=? OR lower(pattern)=?")
    .get(e, domain) as { reason: string; pattern: string } | undefined;
  return row ? { suppressed: true, reason: `${row.pattern} (${row.reason})` } : { suppressed: false };
}

/** The reasons the schema accepts. Anything else is a typo, and used to fail silently. */
export const SUPPRESSION_REASONS = ["unsubscribe", "bounce", "manual", "competitor", "customer"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function suppress(db: Db, pattern: string, reason: SuppressionReason, note?: string): void {
  const p = pattern.trim().toLowerCase();
  if (!p) throw new Error("suppress: empty pattern");
  // Checked here rather than left to the column's CHECK, because the INSERT below is
  // OR IGNORE - which exists so re-suppressing an address is a no-op, but which also
  // swallowed a bad reason without a word. A hard bounce silently failing to suppress is
  // exactly the failure this whole path exists to prevent, and it looks like success.
  if (!SUPPRESSION_REASONS.includes(reason)) {
    throw new Error(`suppress: unknown reason "${reason}" (expected ${SUPPRESSION_REASONS.join(", ")})`);
  }
  db.prepare("INSERT OR IGNORE INTO suppression (id,pattern,kind,reason,note,created_at) VALUES (?,?,?,?,?,?)")
    .run(ulid(), p, p.startsWith("@") ? "domain" : "email", reason, note ?? null, now());
}

/**
 * Has this person already been emailed from a DIFFERENT campaign?
 *
 * Campaigns are built independently, so the same address can easily end up in two of them.
 * Receiving two unrelated cold emails from the same sender is the fastest way to be marked as
 * spam by a human, and nothing else in the system would catch it: suppression only covers
 * people who asked to stop, and the per-campaign unique index only covers one campaign.
 */
export function contactedElsewhere(db: Db, contactId: string, campaignId: string):
  { contacted: boolean; campaignName?: string; sentAt?: number } {
  const row = db.prepare(
    `SELECT s.sent_at, c.name FROM send_log s JOIN campaign c ON c.id = s.campaign_id
     WHERE s.contact_id = ? AND s.campaign_id != ? AND s.status = 'sent'
     ORDER BY s.sent_at DESC LIMIT 1`,
  ).get(contactId, campaignId) as { sent_at: number; name: string } | undefined;
  return row ? { contacted: true, campaignName: row.name, sentAt: row.sent_at } : { contacted: false };
}

export function approveDraft(db: Db, draftId: string): void {
  // scheduled_for is cleared: approving again is an explicit "try this now".
  db.prepare(`UPDATE email_draft SET status='approved', approved_at=?, scheduled_for=NULL,
     error_code=NULL, error_message=NULL, updated_at=? WHERE id=? AND status IN ('draft','needs_review')`)
    .run(now(), now(), draftId);
}

/**
 * Put an approved draft back in the review queue.
 *
 * Review is keyboard-driven - `a` approves and jumps to the next one - so a mis-keyed `a` used
 * to put an email in the send queue with no way back at all. That is the wrong shape for a
 * screen whose whole promise is that nothing sends without you.
 *
 * Refuses once a send has been attempted. A row in send_log means the message either left or
 * is in flight, and un-approving it then would be pretending something can be recalled.
 */
export function unapproveDraft(db: Db, draftId: string): { ok: boolean; reason?: string } {
  const live = db.prepare(
    "SELECT status FROM send_log WHERE draft_id=? AND status IN ('queued','sending','sent') LIMIT 1",
  ).get(draftId) as { status: string } | undefined;
  if (live) {
    return { ok: false, reason: live.status === "sent" ? "it has already been sent" : "it is being sent right now" };
  }
  const res = db.prepare(
    "UPDATE email_draft SET status='needs_review', approved_at=NULL, updated_at=? WHERE id=? AND status='approved'",
  ).run(now(), draftId);
  return res.changes > 0 ? { ok: true } : { ok: false, reason: "it is not waiting to be sent" };
}

/**
 * Has this person already answered us?
 *
 * dueFollowUps checks this when it generates a step, but a draft can also be approved by hand,
 * and a reply can arrive between approving and sending. The promise is that someone who
 * replies never receives another cold email, so it has to hold at the moment of sending too.
 */
export function hasReplied(db: Db, contactId: string): boolean {
  // kind matters: a bounce and an out-of-office both land in this table, and neither is
  // someone declining to be contacted again. Blocking on them would silently drop the lead.
  return !!db.prepare("SELECT 1 FROM reply WHERE contact_id = ? AND kind = 'reply' LIMIT 1").get(contactId);
}

/**
 * Is an SMTP failure worth trying again?
 *
 * A 4xx is the server saying "not now" (greylisting, rate limit, temporary local error) and a
 * connection error is the network. Failing the draft permanently for either would silently
 * drop a perfectly good email, which is exactly the mistake the page fetcher used to make.
 * A 5xx is the server saying "no" - a bad address or a rejected message - and must not loop.
 */
export function isTransientSmtpError(e: unknown): boolean {
  const code = (e as { responseCode?: number })?.responseCode;
  if (typeof code === "number") return code >= 400 && code < 500;
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  if (/(^|\D)5\d\d(\D|$)|invalid recipient|no such user|mailbox unavailable|authentication|auth failed|username and password/.test(msg)) return false;
  return /timeout|econnreset|econnrefused|etimedout|ehostunreach|enetunreach|socket|connection|greylist|try again|temporar/.test(msg);
}

export type SendOutcome =
  | { sent: true; sendLogId: string; messageId: string }
  | { sent: false; reason: string; code: string };

/**
 * Send exactly one approved draft. Returns a reason rather than throwing for every expected
 * refusal, so the caller can log it and move on.
 */
export async function sendOne(db: Db, draftId: string, smtp: SmtpConfig): Promise<SendOutcome> {
  const d = db.prepare("SELECT * FROM email_draft_current WHERE draft_id=?").get(draftId) as any;
  if (!d) return { sent: false, reason: "draft has no version", code: "NO_VERSION" };
  if (d.status !== "approved") return { sent: false, reason: `draft is "${d.status}", not approved`, code: "NOT_APPROVED" };

  const contact = db.prepare("SELECT * FROM contact WHERE id=?").get(d.contact_id) as any;
  if (!contact) return { sent: false, reason: "contact missing", code: "NO_CONTACT" };

  const sup = isSuppressed(db, contact.email);
  if (sup.suppressed) {
    db.prepare("UPDATE email_draft SET status='discarded', error_code='SUPPRESSED', error_message=?, updated_at=? WHERE id=?")
      .run(sup.reason ?? "suppressed", now(), draftId);
    return { sent: false, reason: `suppressed: ${sup.reason}`, code: "SUPPRESSED" };
  }

  if (hasReplied(db, d.contact_id)) {
    db.prepare("UPDATE email_draft SET status='discarded', error_code='ALREADY_REPLIED', error_message=?, updated_at=? WHERE id=?")
      .run("they replied - the sequence stops here", now(), draftId);
    return { sent: false, reason: "they have already replied - not sending another", code: "ALREADY_REPLIED" };
  }

  const dupe = contactedElsewhere(db, d.contact_id, d.campaign_id);
  if (dupe.contacted) {
    db.prepare("UPDATE email_draft SET status='discarded', error_code='ALREADY_CONTACTED', error_message=?, updated_at=? WHERE id=?")
      .run(`already emailed from "${dupe.campaignName}"`, now(), draftId);
    return { sent: false, reason: `already emailed from "${dupe.campaignName}" - not sending a second cold email`, code: "ALREADY_CONTACTED" };
  }

  const g = sendGuards(db, d.campaign_id);
  if (g.paused) return { sent: false, reason: "sending is paused", code: "PAUSED" };
  // Refused, not queued. The drain loop comes back on its own when the window opens, and a
  // draft that sits approved overnight is exactly what should happen.
  if (!g.windowOpen) {
    return { sent: false, reason: `outside the sending window (${g.windowLabel})`, code: "OUTSIDE_WINDOW" };
  }
  if (g.remaining <= 0) return { sent: false, reason: `daily cap reached (${g.sentLast24h}/${g.dailyLimit})`, code: "DAILY_CAP" };

  const password = await getSecret(db, "smtp.password");
  if (!password) return { sent: false, reason: "no SMTP password stored", code: "NO_PASSWORD" };

  // Claim the send first. The partial unique index makes a concurrent double-send impossible.
  const messageId = newMessageId(smtp.fromEmail);
  const sendLogId = ulid();
  try {
    tx(db, () => {
      db.prepare(
        `INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'sending',?)`,
      ).run(sendLogId, draftId, d.version_id, d.campaign_id, d.contact_id, contact.email,
            smtp.fromEmail, d.subject, messageId, now());
    });
  } catch (e) {
    return { sent: false, reason: `already has a live send (${(e as Error).message.slice(0, 80)})`, code: "ALREADY_SENT" };
  }

  try {
    // Rendered here, not at compose time, so the signature and the opt-out footer reflect the
    // settings as they are now rather than as they were when the draft was written.
    const text = renderedBody(db, d, productForDraft(db, draftId));
    const r = await sendMail(smtp, password, { to: contact.email, subject: d.subject, text, messageId });
    tx(db, () => {
      db.prepare("UPDATE send_log SET status='sent', sent_at=?, smtp_response=? WHERE id=?").run(now(), r.response.slice(0, 500), sendLogId);
      db.prepare("UPDATE email_draft SET status='sent', updated_at=? WHERE id=?").run(now(), draftId);
      db.prepare("UPDATE campaign_company SET status='sent', updated_at=? WHERE id=?").run(now(), d.campaign_company_id);
    });
    return { sent: true, sendLogId, messageId };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const transient = isTransientSmtpError(e);
    tx(db, () => {
      // The failed send_log row does not block a retry: the one-live-send index only covers
      // queued/sending/sent.
      db.prepare("UPDATE send_log SET status='failed', error_code=?, error_message=? WHERE id=?")
        .run(transient ? "SMTP_TEMPORARY" : "SMTP_ERROR", msg, sendLogId);
      if (transient) {
        // Leave it approved so the runner picks it up again rather than losing a good email to
        // a greylist or a dropped connection - but not immediately, and not forever.
        const attempts = temporaryFailures(db, draftId);
        if (attempts >= 5) {
          db.prepare("UPDATE email_draft SET status='failed', error_code='SMTP_GAVE_UP', error_message=?, updated_at=? WHERE id=?")
            .run(`giving up after ${attempts} temporary failures: ${msg}`, now(), draftId);
        } else {
          db.prepare("UPDATE email_draft SET error_code='SMTP_TEMPORARY', error_message=?, scheduled_for=?, updated_at=? WHERE id=?")
            .run(msg, Date.now() + retryBackoffMs(attempts), now(), draftId);
        }
      } else {
        db.prepare("UPDATE email_draft SET status='failed', error_code='SMTP_ERROR', error_message=?, updated_at=? WHERE id=?")
          .run(msg, now(), draftId);
      }
    });
    return { sent: false, reason: transient ? `temporary: ${msg}` : msg, code: transient ? "SMTP_TEMPORARY" : "SMTP_ERROR" };
  }
}

/**
 * The next draft to send.
 *
 * `scheduled_for` is respected so a draft that failed temporarily waits its backoff. Without
 * that, a temporary SMTP failure leaves the draft approved and it is picked again on the very
 * next tick - a greylisted address would be retried roughly once a second, forever, which is
 * both useless and the fastest way to be treated as an attacker.
 */
export function nextApprovedDraftId(db: Db, campaignId?: string): string | undefined {
  const where = "status='approved' AND (scheduled_for IS NULL OR scheduled_for <= ?)";
  const row = (campaignId
    ? db.prepare(`SELECT id FROM email_draft WHERE ${where} AND campaign_id=? ORDER BY approved_at LIMIT 1`).get(Date.now(), campaignId)
    : db.prepare(`SELECT id FROM email_draft WHERE ${where} ORDER BY approved_at LIMIT 1`).get(Date.now())
  ) as { id: string } | undefined;
  return row?.id;
}

/** How long to wait before trying a temporarily-failed send again. */
export function retryBackoffMs(attempt: number): number {
  const minutes = [2, 10, 30, 120][Math.min(attempt - 1, 3)] ?? 120;
  return minutes * 60_000;
}

/** Temporary failures so far for this draft, from the send log rather than memory. */
export function temporaryFailures(db: Db, draftId: string): number {
  return Number((db.prepare(
    "SELECT COUNT(*) c FROM send_log WHERE draft_id=? AND error_code='SMTP_TEMPORARY'",
  ).get(draftId) as { c: number }).c);
}

export function randomGapMs(db: Db): number {
  const s = getSetting<SendingSettings>(db, "sending", { minGapSeconds: 60, maxGapSeconds: 180 } as SendingSettings);
  const min = (s.minGapSeconds ?? 60) * 1000;
  const max = Math.max(min, (s.maxGapSeconds ?? 180) * 1000);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Background drain. One send, then a randomised gap, forever, until paused or empty.
 * Deliberately not concurrent: mailbox reputation is the constraint, not throughput.
 */
export class SendRunner {
  private timer?: NodeJS.Timeout;
  private running = false;
  lastOutcome?: string;
  nextSendAt?: number;

  private readonly db: Db;
  private readonly smtp: () => SmtpConfig | undefined;

  constructor(db: Db, smtp: () => SmtpConfig | undefined) {
    this.db = db;
    this.smtp = smtp;
  }

  start(): void { if (!this.running) { this.running = true; this.schedule(500); } }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.nextSendAt = undefined; }
  get isRunning(): boolean { return this.running; }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.nextSendAt = Date.now() + ms;
    this.timer = setTimeout(() => { void this.tick(); }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const g = sendGuards(this.db);
      // Pressing Pause in the UI stops the runner outright, so this branch is for the case
      // where the setting changed underneath a running loop. Re-checked every few seconds
      // rather than every thirty: it is one SQLite read, and half a minute of apparent
      // nothing-happening after un-pausing looks like a bug whatever the cause.
      if (g.paused) { this.lastOutcome = "paused"; return this.schedule(5_000); }
      if (g.remaining <= 0) { this.lastOutcome = `daily cap reached (${g.sentLast24h}/${g.dailyLimit})`; return this.schedule(15 * 60_000); }
      if (!g.windowOpen) {
        this.lastOutcome = `outside the sending window (${g.windowLabel})`;
        // Wake a minute after it opens rather than polling: the window is minutes-accurate
        // and the gap to Monday morning can be two days.
        const wait = g.windowOpensAt ? Math.max(30_000, g.windowOpensAt - Date.now() + 60_000) : 15 * 60_000;
        return this.schedule(Math.min(wait, 60 * 60_000));
      }
      const id = nextApprovedDraftId(this.db);
      if (!id) { this.lastOutcome = "nothing approved"; return this.schedule(20_000); }
      const cfg = this.smtp();
      if (!cfg) { this.lastOutcome = "SMTP not configured"; return this.schedule(60_000); }

      const out = await sendOne(this.db, id, cfg);
      this.lastOutcome = out.sent ? `sent ${out.messageId}` : `skipped: ${out.reason}`;
      // A refusal is cheap; only a real send earns the long gap.
      this.schedule(out.sent ? randomGapMs(this.db) : 1_000);
    } catch (e) {
      this.lastOutcome = `error: ${(e as Error).message.slice(0, 200)}`;
      this.schedule(30_000);
    }
  }
}
