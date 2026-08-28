/**
 * Dashboard numbers.
 *
 * The rule for what goes on a dashboard: it answers "what should I do next" and "is anything
 * wrong". Vanity totals that never change a decision are left off. There are no open or click
 * metrics because this product does not put tracking pixels in email, so the only honest
 * engagement number is the reply rate.
 */
import type { Db } from "./db/index.ts";

export interface Funnel { discovered: number; researched: number; contacted: number; drafted: number; approved: number; sent: number; replied: number }

export interface DashboardStats {
  funnel: Funnel;
  needsReview: number;
  approvedWaiting: number;
  flaggedDrafts: number;
  sentLast24h: number;
  sentLast7d: number;
  replyRate: number | null;
  repliesUnhandled: number;
  followUpsDue: number;
  suppressed: number;
  campaigns: number;
  activeCampaigns: number;
  contactsTotal: number;
  claimsVerified: number;
  claimsRejected: number;
  sendsByDay: Array<{ day: string; sent: number; replies: number }>;
  topFailures: Array<{ reason: string; count: number }>;
  recentActivity: Array<{ at: number; kind: string; text: string }>;
}

const one = (db: Db, sql: string, ...p: unknown[]): number =>
  Number((db.prepare(sql).get(...p) as { c: number } | undefined)?.c ?? 0);

export function dashboardStats(db: Db, campaignId?: string): DashboardStats {
  const scope = campaignId ? "AND campaign_id = ?" : "";
  const arg = campaignId ? [campaignId] : [];
  const ccScope = campaignId ? "WHERE campaign_id = ?" : "";

  const funnel: Funnel = {
    discovered: one(db, `SELECT COUNT(*) c FROM campaign_company ${ccScope}`, ...arg),
    researched: one(db, `SELECT COUNT(*) c FROM campaign_company WHERE status NOT IN ('discovered','enriching') ${campaignId ? "AND campaign_id=?" : ""}`, ...arg),
    contacted: one(db, `SELECT COUNT(DISTINCT cc.id) c FROM campaign_company cc JOIN contact ct ON ct.company_id=cc.company_id ${campaignId ? "WHERE cc.campaign_id=?" : ""}`, ...arg),
    drafted: one(db, `SELECT COUNT(*) c FROM email_draft WHERE status NOT IN ('discarded') ${scope}`, ...arg),
    approved: one(db, `SELECT COUNT(*) c FROM email_draft WHERE status='approved' ${scope}`, ...arg),
    sent: one(db, `SELECT COUNT(*) c FROM send_log WHERE status='sent' ${scope}`, ...arg),
    replied: one(db, `SELECT COUNT(*) c FROM reply ${campaignId ? "WHERE campaign_id=?" : ""}`, ...arg),
  };

  // Buckets are LOCAL days. toISOString() would convert local midnight to UTC and label the
  // bucket with the previous day for anyone east of UTC - in BST every bar would be wrong.
  const localDay = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const sendsByDay: Array<{ day: string; sent: number; replies: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);
    const from = start.getTime(), to = from + 24 * 3600_000;
    sendsByDay.push({
      day: localDay(start),
      sent: one(db, `SELECT COUNT(*) c FROM send_log WHERE status='sent' AND sent_at>=? AND sent_at<? ${scope}`, from, to, ...arg),
      replies: one(db, `SELECT COUNT(*) c FROM reply WHERE received_at>=? AND received_at<? ${campaignId ? "AND campaign_id=?" : ""}`, from, to, ...arg),
    });
  }

  const topFailures = db.prepare(
    `SELECT COALESCE(error_message, error_code, 'unknown') reason, COUNT(*) count
     FROM campaign_company WHERE status IN ('failed','rejected') ${campaignId ? "AND campaign_id=?" : ""}
     GROUP BY reason ORDER BY count DESC LIMIT 5`).all(...arg) as Array<{ reason: string; count: number }>;

  const recentActivity = db.prepare(
    `SELECT * FROM (
       SELECT sent_at at, 'sent' kind, 'Sent to ' || to_email text FROM send_log WHERE status='sent' AND sent_at IS NOT NULL ${scope}
       UNION ALL
       SELECT received_at at, 'reply' kind, 'Reply from ' || from_email text FROM reply ${campaignId ? "WHERE campaign_id=?" : ""}
       UNION ALL
       SELECT created_at at, 'failed' kind, 'Model call failed: ' || COALESCE(error_code,'?') text FROM llm_call WHERE ok=0
     ) ORDER BY at DESC LIMIT 12`).all(...arg, ...arg) as Array<{ at: number; kind: string; text: string }>;

  const sent = funnel.sent;
  return {
    funnel,
    needsReview: one(db, `SELECT COUNT(*) c FROM email_draft WHERE status='needs_review' ${scope}`, ...arg),
    approvedWaiting: funnel.approved,
    flaggedDrafts: one(db,
      `SELECT COUNT(*) c FROM email_draft_current WHERE status='needs_review' AND quality_flags != '[]' ${scope}`, ...arg),
    sentLast24h: one(db, `SELECT COUNT(*) c FROM send_log WHERE status='sent' AND sent_at>=? ${scope}`, Date.now() - 24 * 3600_000, ...arg),
    sentLast7d: one(db, `SELECT COUNT(*) c FROM send_log WHERE status='sent' AND sent_at>=? ${scope}`, Date.now() - 7 * 24 * 3600_000, ...arg),
    replyRate: sent > 0 ? funnel.replied / sent : null,
    repliesUnhandled: one(db, `SELECT COUNT(*) c FROM reply WHERE handled=0 ${campaignId ? "AND campaign_id=?" : ""}`, ...arg),
    followUpsDue: 0,        // filled by the route, which has the sequence module
    suppressed: one(db, "SELECT COUNT(*) c FROM suppression"),
    campaigns: one(db, "SELECT COUNT(*) c FROM campaign"),
    activeCampaigns: one(db, "SELECT COUNT(*) c FROM campaign WHERE status IN ('researching','ready','sending')"),
    contactsTotal: one(db, "SELECT COUNT(*) c FROM contact"),
    claimsVerified: one(db, "SELECT COUNT(*) c FROM claim WHERE verified=1"),
    claimsRejected: one(db, "SELECT COUNT(*) c FROM claim WHERE verified=0"),
    sendsByDay, topFailures, recentActivity,
  };
}

/** RFC-4180 CSV. Formulas are neutralised so a cell cannot execute in a spreadsheet. */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // CSV injection guard
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

export const EXPORTS = {
  companies: (db: Db, campaignId: string) => db.prepare(
    `SELECT co.name, co.domain, co.website_url, co.city, cc.status, cc.relevance_score fit,
            cc.relevance_reason reason, cc.rejected_reason, co.summary
     FROM campaign_company cc JOIN company co ON co.id=cc.company_id
     WHERE cc.campaign_id=? ORDER BY cc.relevance_score DESC`).all(campaignId),
  contacts: (db: Db, campaignId: string) => db.prepare(
    `SELECT co.name company, co.domain, ct.full_name, ct.title, ct.email,
            ct.source_kind, ct.confidence, ct.source_url
     FROM contact ct JOIN company co ON co.id=ct.company_id
     JOIN campaign_company cc ON cc.company_id=co.id
     WHERE cc.campaign_id=? ORDER BY co.name`).all(campaignId),
  drafts: (db: Db, campaignId: string) => db.prepare(
    `SELECT co.name company, ct.email, d.step_number step, d.status, d.subject, d.body_text,
            d.word_count, d.quality_flags
     FROM email_draft_current d JOIN contact ct ON ct.id=d.contact_id
     JOIN campaign_company cc ON cc.id=d.campaign_company_id JOIN company co ON co.id=cc.company_id
     WHERE d.campaign_id=? ORDER BY co.name, d.step_number`).all(campaignId),
  sends: (db: Db, campaignId: string) => db.prepare(
    `SELECT to_email, subject, status, sent_at, error_message, message_id
     FROM send_log WHERE campaign_id=? ORDER BY created_at DESC`).all(campaignId),
} as const;
