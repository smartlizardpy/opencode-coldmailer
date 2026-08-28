/**
 * Draft quality checks.
 *
 * These run when a draft is written so the review screen can surface the weak ones, rather
 * than making a person read forty emails to find the three that are wrong. Every flag is
 * something a careful human reviewer would catch - the point is to put them at the top of the
 * queue, never to auto-reject.
 */

export type QualityFlag =
  | "no_citations" | "too_long" | "too_short" | "flattery" | "hedging"
  | "vague_ask" | "no_ask" | "placeholder" | "subject_too_long" | "subject_question";

export interface QualityCheck { flag: QualityFlag; detail: string }

/** Empty praise that reads as automated in any language we compose in. */
const FLATTERY = [
  "dikkat çekici", "etkileyici", "harika", "muhteşem", "çok başarılı", "takdire şayan",
  "impressive", "fantastic", "amazing", "love what you", "really interesting", "great work",
  "i was impressed", "caught my eye", "stood out to me",
];

/** Stacked conditionals that make an offer sound like it might not happen. */
const HEDGING = [
  "olabiliriz", "edebiliriz", "gösterebilir", "yapabiliriz miyiz",
  "we could potentially", "might be able to", "perhaps we could", "it may be possible",
  "i was wondering if", "would it be possible",
];

/** Asks the reader cannot act on. */
const VAGUE_ASK = [
  "birlikte başlamak", "beraber başlayalım", "ilgilenir misiniz",
  "let me know if", "let's explore", "touch base", "circle back", "hop on a call",
  "would you be interested", "if this sounds interesting", "let's connect",
];

const PLACEHOLDER = ["[", "{{", "xxx", "lorem ipsum", "your company", "company name", "firstname"];

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function checkQuality(args: {
  subject: string; body: string; citedClaims: number;
}): QualityCheck[] {
  const out: QualityCheck[] = [];
  const body = args.body.toLowerCase();
  const subject = args.subject.trim();
  // Only the message itself - the signature is appended and is not the model's prose.
  const prose = args.body.split(/\n\n(?=[^\n]{0,60}$)/)[0] ?? args.body;
  const words = countWords(prose);

  if (args.citedClaims === 0) {
    out.push({ flag: "no_citations", detail: "nothing specific to this company is cited - it will read as a mail-merge" });
  }
  if (words > 130) out.push({ flag: "too_long", detail: `${words} words; cold email past ~120 gets skimmed` });
  if (words < 25) out.push({ flag: "too_short", detail: `${words} words; probably missing the reason or the ask` });

  for (const phrase of FLATTERY) {
    if (body.includes(phrase)) { out.push({ flag: "flattery", detail: `empty praise: "${phrase}"` }); break; }
  }
  for (const phrase of HEDGING) {
    if (body.includes(phrase)) { out.push({ flag: "hedging", detail: `hedged offer: "${phrase}"` }); break; }
  }
  for (const phrase of VAGUE_ASK) {
    if (body.includes(phrase)) { out.push({ flag: "vague_ask", detail: `the ask is not answerable: "${phrase}"` }); break; }
  }
  for (const phrase of PLACEHOLDER) {
    if (body.includes(phrase)) { out.push({ flag: "placeholder", detail: `unfilled placeholder: "${phrase}"` }); break; }
  }
  // A question mark is the cheapest proxy for "is there an ask at all".
  if (!/[?？]/.test(prose) && !/\b(uygun mu|olur mu|paylaşabilir|gönderebilir)\b/i.test(prose)) {
    out.push({ flag: "no_ask", detail: "no question - the reader is not asked to do anything" });
  }
  if (subject.length > 60) out.push({ flag: "subject_too_long", detail: `${subject.length} chars; gets truncated in most clients` });
  if (subject.endsWith("?")) out.push({ flag: "subject_question", detail: "a question as a subject line reads as a sales email" });

  return out;
}

/** Flags that should stop a one-click bulk approve. Everything else is advisory. */
export const BLOCKING_FLAGS: QualityFlag[] = ["placeholder", "no_citations", "too_long"];

export function isBlocking(flags: QualityFlag[]): boolean {
  return flags.some((f) => BLOCKING_FLAGS.includes(f));
}

/**
 * One-time backfill for versions written before word_count and quality_flags existed.
 *
 * Done in code rather than SQL because the checks are the same functions the composer uses -
 * duplicating them as SQL expressions would let the two drift, and then a draft would show
 * different flags depending on when it was written.
 */
export function backfillQuality(db: {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown };
}): number {
  const rows = db.prepare(
    `SELECT v.id, v.subject, v.body_text, v.personalization
     FROM email_draft_version v WHERE v.word_count = 0 AND length(v.body_text) > 0`,
  ).all() as Array<{ id: string; subject: string; body_text: string; personalization: string }>;

  let done = 0;
  for (const r of rows) {
    let cited = 0;
    try { cited = (JSON.parse(r.personalization || "[]") as unknown[]).length; } catch { cited = 0; }
    const flags = checkQuality({ subject: r.subject, body: r.body_text, citedClaims: cited });
    db.prepare("UPDATE email_draft_version SET word_count=?, quality_flags=? WHERE id=?")
      .run(countWords(r.body_text), JSON.stringify(flags), r.id);
    done++;
  }
  return done;
}
