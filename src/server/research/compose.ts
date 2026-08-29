/**
 * Draft generation.
 *
 * The composer is only ever shown VERIFIED claims. If the model still cites a claim id that is
 * not verified, the database trigger rejects the insert - so an unverifiable fact cannot reach
 * an email even if every layer above this one fails.
 */
import type { LlmService } from "../llm/index.ts";
import { ulid, now, tx, type Db } from "../db/index.ts";
import * as P from "../llm/prompts.ts";
import { briefOf } from "./pipeline.ts";
import { getSetting, type SendingSettings } from "../db/settings.ts";
import { checkQuality, countWords } from "./quality.ts";

export interface ComposeResult {
  draftId: string; version: number; subject: string; body: string;
  usedClaims: number; flags: string[];
}

/**
 * The message plus the signature, and the opt-out footer if it is switched on.
 *
 * Called when a draft is displayed and again when it is sent, rather than baked in at compose
 * time, so editing your name or enabling the footer applies to everything not yet sent. The
 * footer is OFF by default, by explicit instruction.
 */
export function renderBody(db: Db, body: string, product: { sender_name?: string; sender_title?: string; sender_company?: string } | undefined): string {
  const s = getSetting<SendingSettings>(db, "sending", {} as SendingSettings);
  const sig = [product?.sender_name, product?.sender_title, product?.sender_company]
    .filter(Boolean).join("\n");
  let out = (body ?? "").trim();
  if (sig) out += `\n\n${sig}`;
  if (s.footerEnabled && s.footerText?.trim()) out += `\n\n${s.footerText.trim()}`;
  return out;
}

/**
 * The email as it will actually be sent.
 *
 * A version written before this change already contains the signature, so re-rendering it
 * would duplicate it. signature_mode records which kind a row is.
 */
export function renderedBody(
  db: Db,
  version: { body_text: string; signature_mode?: string },
  product?: { sender_name?: string; sender_title?: string; sender_company?: string },
): string {
  if (version.signature_mode !== "rendered") return version.body_text;
  return renderBody(db, version.body_text, product);
}

export function productForDraft(db: Db, draftId: string): { sender_name?: string; sender_title?: string; sender_company?: string } | undefined {
  return db.prepare(
    `SELECT p.sender_name, p.sender_title, p.sender_company
     FROM email_draft d JOIN campaign c ON c.id = d.campaign_id
     JOIN product p ON p.id = c.product_id WHERE d.id = ?`,
  ).get(draftId) as never;
}

export async function composeDraft(
  deps: { db: Db; llm: LlmService },
  campaignCompanyId: string,
  contactId: string,
  opts: { instruction?: string; priority?: "interactive" | "batch"; step?: number; followsSendId?: string; dueAt?: number } = {},
): Promise<ComposeResult> {
  const { db, llm } = deps;
  const cc = db.prepare("SELECT * FROM campaign_company WHERE id=?").get(campaignCompanyId) as any;
  if (!cc) throw new Error("campaign_company not found");
  const campaign = db.prepare("SELECT * FROM campaign WHERE id=?").get(cc.campaign_id) as any;
  const product = db.prepare("SELECT * FROM product WHERE id=?").get(campaign.product_id) as any;
  const company = db.prepare("SELECT * FROM company WHERE id=?").get(cc.company_id) as any;
  const contact = db.prepare("SELECT * FROM contact WHERE id=?").get(contactId) as any;
  if (!contact) throw new Error("contact not found");

  // VERIFIED ONLY. This is the whole guarantee.
  const claims = db.prepare(
    "SELECT id, claim, quote, source_url FROM claim WHERE campaign_company_id=? AND verified=1 ORDER BY id",
  ).all(campaignCompanyId) as Array<{ id: string; claim: string; quote: string; source_url: string }>;

  const r = await llm.run<{ variants: Array<{ subject: string; body: string; used_claim_ids: string[] }> }>({
    task: opts.instruction ? "email.revise" : "email.draft",
    system: P.COMPOSE_SYSTEM,
    prompt: P.composePrompt({
      brief: briefOf(product), goal: campaign.goal,
      company: { name: company.name, domain: company.domain, summary: company.summary },
      contact: { full_name: contact.full_name, title: contact.title, email: contact.email, is_role_account: !!contact.is_role_account },
      claims, instruction: opts.instruction,
    }),
    schema: P.COMPOSE_SCHEMA,
    priority: opts.priority ?? "batch",
    subject: { type: "contact", id: contactId },
  });

  const variants = r.value.variants ?? [];
  if (variants.length === 0) throw new Error("model returned no variants");
  const valid = new Set(claims.map((c) => c.id));

  return tx(db, () => {
    const step = opts.step ?? 1;
    let draft = db.prepare("SELECT * FROM email_draft WHERE campaign_id=? AND contact_id=? AND step_number=?")
      .get(campaign.id, contactId, step) as any;
    if (!draft) {
      const id = ulid();
      db.prepare(
        `INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,
           follows_send_id,due_at,created_at,updated_at) VALUES (?,?,?,?,'needs_review',?,?,?,?,?)`,
      ).run(id, campaign.id, campaignCompanyId, contactId, step,
            opts.followsSendId ?? null, opts.dueAt ?? null, now(), now());
      draft = { id };
    }
    const maxV = db.prepare("SELECT COALESCE(MAX(version),0) v FROM email_draft_version WHERE draft_id=?").get(draft.id) as { v: number };

    let firstResult: ComposeResult | undefined;
    variants.forEach((v, i) => {
      // Drop any citation the model invented; the trigger would reject it anyway, but a clear
      // drop here means one bad id does not lose the whole draft.
      const used = (v.used_claim_ids ?? []).filter((id) => valid.has(id));
      const personalization = used.map((id) => ({
        claim_id: id, source_url: claims.find((c) => c.id === id)!.source_url,
      }));
      const version = maxV.v + i + 1;
      const versionId = ulid();
      const message = v.body.trim();
      const flags = checkQuality({ subject: v.subject, body: message, citedClaims: used.length, step });
      db.prepare(
        `INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,llm_call_id,
           edit_note,personalization,word_count,quality_flags,signature_mode,created_at)
         VALUES (?,?,?,?,?,'llm',?,?,?,?,?,'rendered',?)`,
      ).run(versionId, draft.id, version, v.subject.trim(), message,
            r.meta.llmCallId, opts.instruction ?? null, JSON.stringify(personalization),
            countWords(message), JSON.stringify(flags), now());
      if (!firstResult) firstResult = {
        draftId: draft.id, version, subject: v.subject.trim(), body: v.body,
        usedClaims: used.length, flags: flags.map((f) => f.flag),
      };
    });

    db.prepare("UPDATE email_draft SET status='needs_review', updated_at=? WHERE id=?").run(now(), draft.id);
    db.prepare("UPDATE campaign_company SET status='drafted', updated_at=? WHERE id=?").run(now(), campaignCompanyId);
    return firstResult!;
  });
}

/** Save a human edit as a new version. Human edits carry no citations - the person owns them. */
/** Which email in the sequence a draft is, so the quality rules match its job. */
function stepOfDraft(db: Db, draftId: string): number {
  return (db.prepare("SELECT step_number FROM email_draft WHERE id=?").get(draftId) as { step_number?: number } | undefined)?.step_number ?? 1;
}

export function saveHumanEdit(db: Db, draftId: string, subject: string, body: string, note?: string): number {
  return tx(db, () => {
    const maxV = db.prepare("SELECT COALESCE(MAX(version),0) v FROM email_draft_version WHERE draft_id=?").get(draftId) as { v: number };
    const version = maxV.v + 1;
    // A human edit is checked too, but the citation flag is not applied: the person writing it
    // owns what they wrote, and we did not give them claim ids to cite.
    const flags = checkQuality({ subject, body, citedClaims: 1, step: stepOfDraft(db, draftId) });
    // A human edit is stored exactly as typed: if someone deletes the signature we must not
    // put it back, so their text is treated as the complete email.
    db.prepare(
      `INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,edit_note,
         personalization,word_count,quality_flags,signature_mode,created_at)
       VALUES (?,?,?,?,?,'human',?,'[]',?,?,'baked',?)`,
    ).run(ulid(), draftId, version, subject, body, note ?? null,
          countWords(body), JSON.stringify(flags), now());
    db.prepare("UPDATE email_draft SET updated_at=? WHERE id=?").run(now(), draftId);
    return version;
  });
}
