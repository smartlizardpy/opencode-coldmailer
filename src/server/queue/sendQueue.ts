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

export interface SendGuards { dailyLimit: number; sentLast24h: number; paused: boolean; remaining: number }

export function sendGuards(db: Db, campaignId?: string): SendGuards {
  const s = getSetting<SendingSettings>(db, "sending", { dailyLimit: 30, paused: false } as SendingSettings);
  const since = Date.now() - 24 * 3600_000;
  const row = db.prepare("SELECT COUNT(*) c FROM send_log WHERE status='sent' AND sent_at >= ?").get(since) as { c: number };
  let limit = s.dailyLimit ?? 30;
  if (campaignId) {
    const c = db.prepare("SELECT daily_send_limit FROM campaign WHERE id=?").get(campaignId) as { daily_send_limit: number } | undefined;
    if (c) limit = Math.min(limit, c.daily_send_limit);
  }
  return { dailyLimit: limit, sentLast24h: row.c, paused: !!s.paused, remaining: Math.max(0, limit - row.c) };
}

/** Suppression matches the exact address or the whole domain. */
export function isSuppressed(db: Db, email: string): { suppressed: boolean; reason?: string } {
  const e = email.toLowerCase();
  const domain = `@${e.split("@")[1] ?? ""}`;
  const row = db.prepare("SELECT reason, pattern FROM suppression WHERE lower(pattern)=? OR lower(pattern)=?")
    .get(e, domain) as { reason: string; pattern: string } | undefined;
  return row ? { suppressed: true, reason: `${row.pattern} (${row.reason})` } : { suppressed: false };
}

export function suppress(db: Db, pattern: string, reason: string, note?: string): void {
  const p = pattern.trim().toLowerCase();
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
  db.prepare("UPDATE email_draft SET status='approved', approved_at=?, updated_at=? WHERE id=? AND status IN ('draft','needs_review')")
    .run(now(), now(), draftId);
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

  const dupe = contactedElsewhere(db, d.contact_id, d.campaign_id);
  if (dupe.contacted) {
    db.prepare("UPDATE email_draft SET status='discarded', error_code='ALREADY_CONTACTED', error_message=?, updated_at=? WHERE id=?")
      .run(`already emailed from "${dupe.campaignName}"`, now(), draftId);
    return { sent: false, reason: `already emailed from "${dupe.campaignName}" - not sending a second cold email`, code: "ALREADY_CONTACTED" };
  }

  const g = sendGuards(db, d.campaign_id);
  if (g.paused) return { sent: false, reason: "sending is paused", code: "PAUSED" };
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
    const r = await sendMail(smtp, password, { to: contact.email, subject: d.subject, text: d.body_text, messageId });
    tx(db, () => {
      db.prepare("UPDATE send_log SET status='sent', sent_at=?, smtp_response=? WHERE id=?").run(now(), r.response.slice(0, 500), sendLogId);
      db.prepare("UPDATE email_draft SET status='sent', updated_at=? WHERE id=?").run(now(), draftId);
      db.prepare("UPDATE campaign_company SET status='sent', updated_at=? WHERE id=?").run(now(), d.campaign_company_id);
    });
    return { sent: true, sendLogId, messageId };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    tx(db, () => {
      db.prepare("UPDATE send_log SET status='failed', error_code='SMTP_ERROR', error_message=? WHERE id=?").run(msg, sendLogId);
      db.prepare("UPDATE email_draft SET status='failed', error_code='SMTP_ERROR', error_message=?, updated_at=? WHERE id=?").run(msg, now(), draftId);
    });
    return { sent: false, reason: msg, code: "SMTP_ERROR" };
  }
}

export function nextApprovedDraftId(db: Db, campaignId?: string): string | undefined {
  const sql = campaignId
    ? "SELECT id FROM email_draft WHERE status='approved' AND campaign_id=? ORDER BY approved_at LIMIT 1"
    : "SELECT id FROM email_draft WHERE status='approved' ORDER BY approved_at LIMIT 1";
  const row = (campaignId ? db.prepare(sql).get(campaignId) : db.prepare(sql).get()) as { id: string } | undefined;
  return row?.id;
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
      if (g.paused) { this.lastOutcome = "paused"; return this.schedule(30_000); }
      if (g.remaining <= 0) { this.lastOutcome = `daily cap reached (${g.sentLast24h}/${g.dailyLimit})`; return this.schedule(15 * 60_000); }
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
