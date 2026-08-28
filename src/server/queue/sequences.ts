/**
 * Follow-up sequences.
 *
 * Most replies to cold email come from the second or third touch, so a tool that only ever
 * sends one is leaving most of its results on the table. The rules that matter are the ones
 * that stop a follow-up going somewhere it shouldn't:
 *
 *   - a contact who replied never receives another step, ever
 *   - a suppressed address never receives another step
 *   - a step is only generated once the previous one has actually been SENT, and only after
 *     its delay has elapsed
 *   - nothing is auto-approved: a follow-up lands in review like any other draft
 */
import { ulid, now, tx, type Db } from "../db/index.ts";
import { isSuppressed } from "./sendQueue.ts";

export interface SequenceStep {
  id: string; campaign_id: string; step_number: number;
  delay_days: number; instruction: string; enabled: number;
}

export const DEFAULT_FOLLOWUPS = [
  { step_number: 2, delay_days: 4,
    instruction: "A short follow-up on the first email. Do not repeat it. Add one new, concrete reason to reply - a different angle or a smaller ask. Two or three sentences. Never say 'just following up', 'bumping this' or 'in case you missed it'." },
  { step_number: 3, delay_days: 7,
    instruction: "The last email. One or two sentences. Say plainly that you will stop here, and leave the door open without any pressure. No new pitch." },
];

export function listSteps(db: Db, campaignId: string): SequenceStep[] {
  return db.prepare("SELECT * FROM sequence_step WHERE campaign_id=? ORDER BY step_number").all(campaignId) as SequenceStep[];
}

export function setSteps(db: Db, campaignId: string, steps: Array<{ step_number: number; delay_days: number; instruction: string; enabled?: boolean }>): void {
  tx(db, () => {
    db.prepare("DELETE FROM sequence_step WHERE campaign_id=?").run(campaignId);
    for (const s of steps) {
      if (s.step_number < 2) continue;   // step 1 is the initial email, not a sequence step
      db.prepare(
        "INSERT INTO sequence_step (id,campaign_id,step_number,delay_days,instruction,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(ulid(), campaignId, s.step_number, Math.min(60, Math.max(1, s.delay_days)),
            s.instruction ?? "", s.enabled === false ? 0 : 1, now(), now());
    }
  });
}

export function seedDefaultSteps(db: Db, campaignId: string): void {
  if (listSteps(db, campaignId).length > 0) return;
  setSteps(db, campaignId, DEFAULT_FOLLOWUPS);
}

export interface DueFollowUp {
  campaignCompanyId: string; contactId: string; step: number;
  instruction: string; followsSendId: string; dueAt: number;
  email: string; company: string;
}

/**
 * Which follow-ups are due right now.
 *
 * Deliberately a query rather than a scheduler: the answer is derived from the send log every
 * time it is asked, so a restart, a clock change or a manual database edit cannot leave a
 * stale scheduled job pointing at someone who has since replied.
 */
export function dueFollowUps(db: Db, campaignId?: string, limit = 100): DueFollowUp[] {
  const rows = db.prepare(
    `SELECT s.id send_id, s.campaign_id, s.contact_id, s.sent_at, d.campaign_company_id,
            d.step_number, ct.email, co.name company
     FROM send_log s
     JOIN email_draft d ON d.id = s.draft_id
     JOIN contact ct ON ct.id = s.contact_id
     JOIN campaign_company cc ON cc.id = d.campaign_company_id
     JOIN company co ON co.id = cc.company_id
     WHERE s.status = 'sent'
       ${campaignId ? "AND s.campaign_id = ?" : ""}
       -- never follow up someone who answered
       AND NOT EXISTS (SELECT 1 FROM reply r WHERE r.contact_id = s.contact_id
                         AND r.kind IN ('reply','bounce_hard'))
       -- only the latest step we actually sent to this person
       AND d.step_number = (SELECT MAX(d2.step_number) FROM email_draft d2
                            JOIN send_log s2 ON s2.draft_id = d2.id AND s2.status='sent'
                            WHERE d2.contact_id = s.contact_id AND d2.campaign_id = s.campaign_id)
     ORDER BY s.sent_at`,
  ).all(...(campaignId ? [campaignId] : [])) as any[];

  const out: DueFollowUp[] = [];
  for (const r of rows) {
    const next = db.prepare("SELECT * FROM sequence_step WHERE campaign_id=? AND step_number=? AND enabled=1")
      .get(r.campaign_id, r.step_number + 1) as SequenceStep | undefined;
    if (!next) continue;

    // Already drafted this step for this person?
    const exists = db.prepare("SELECT 1 FROM email_draft WHERE campaign_id=? AND contact_id=? AND step_number=?")
      .get(r.campaign_id, r.contact_id, next.step_number);
    if (exists) continue;

    const dueAt = r.sent_at + next.delay_days * 24 * 3600_000;
    if (dueAt > Date.now()) continue;
    if (isSuppressed(db, r.email).suppressed) continue;

    out.push({
      campaignCompanyId: r.campaign_company_id, contactId: r.contact_id,
      step: next.step_number, instruction: next.instruction,
      followsSendId: r.send_id, dueAt, email: r.email, company: r.company,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** What the next touch would be for each contact, for the UI timeline. */
export function upcomingFollowUps(db: Db, campaignId: string, limit = 50): Array<{ email: string; company: string; step: number; dueAt: number }> {
  const rows = db.prepare(
    `SELECT s.contact_id, s.sent_at, d.step_number, ct.email, co.name company
     FROM send_log s JOIN email_draft d ON d.id = s.draft_id
     JOIN contact ct ON ct.id = s.contact_id
     JOIN campaign_company cc ON cc.id = d.campaign_company_id
     JOIN company co ON co.id = cc.company_id
     WHERE s.status='sent' AND s.campaign_id=?
       AND NOT EXISTS (SELECT 1 FROM reply r WHERE r.contact_id = s.contact_id
                         AND r.kind IN ('reply','bounce_hard'))
     ORDER BY s.sent_at DESC`).all(campaignId) as any[];
  const out: Array<{ email: string; company: string; step: number; dueAt: number }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.contact_id)) continue;
    seen.add(r.contact_id);
    const next = db.prepare("SELECT * FROM sequence_step WHERE campaign_id=? AND step_number=? AND enabled=1")
      .get(campaignId, r.step_number + 1) as SequenceStep | undefined;
    if (!next) continue;
    if (db.prepare("SELECT 1 FROM email_draft WHERE campaign_id=? AND contact_id=? AND step_number=?")
          .get(campaignId, r.contact_id, next.step_number)) continue;
    out.push({ email: r.email, company: r.company, step: next.step_number,
               dueAt: r.sent_at + next.delay_days * 24 * 3600_000 });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}
