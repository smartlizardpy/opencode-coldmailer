/**
 * Draft quality checks.
 *
 * A check has a FLAG, which the UI turns into a short label, and a DETAIL, which must add the
 * specifics rather than restate the label - the two are rendered together as
 * "<label> — <detail>", and a detail that repeats its own label reads as a stutter.
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

/**
 * Asks the reader cannot act on. Regexes rather than literals: Turkish agglutination means
 * "birlikte başlamak" and "birlikte kısa bir içerikle başlatmak" are the same empty ask, and
 * a literal list would only catch the first.
 */
const VAGUE_ASK: Array<[RegExp, string]> = [
  [/birlikte\b[^.?!]{0,40}\bbaşla/i, "birlikte … başlamak"],
  [/beraber\b[^.?!]{0,40}\bbaşla/i, "beraber … başlamak"],
  [/ilgilenir misiniz/i, "ilgilenir misiniz"],
  [/görüşmek ister misiniz/i, "görüşmek ister misiniz"],
  [/let me know if/i, "let me know if"],
  [/let'?s (explore|connect|chat)/i, "let's explore"],
  [/touch base|circle back|hop on a (quick )?call/i, "touch base"],
  [/would you be interested/i, "would you be interested"],
  [/if this sounds (interesting|good)/i, "if this sounds interesting"],
];

const PLACEHOLDER = ["[", "{{", "xxx", "lorem ipsum", "your company", "company name", "firstname"];

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Drop a trailing signature block so it is not counted or analysed as prose.
 *
 * A signature is trailing short lines with no sentence-ending punctuation ("Ozan\nWearSide
 * Labs"). Length alone is not enough to identify one: a short final paragraph is very often
 * the ask itself ("Bu hafta paylaşabilir misiniz?"), and an earlier version of this function
 * silently discarded exactly that, which then made every good email look like it had no ask.
 */
export function stripSignature(body: string): string {
  const blocks = body.trim().split(/\n\s*\n/);
  while (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const lines = last.split("\n").map((l) => l.trim()).filter(Boolean);
    const looksLikeSignature =
      lines.length <= 3 &&
      lines.every((l) => l.length <= 48) &&
      !/[.?!…]\s*$/.test(last.trim()) &&
      !/\b(mi|mı|mu|mü)siniz\b/i.test(last);
    if (!looksLikeSignature) break;
    blocks.pop();
  }
  return blocks.join("\n\n");
}

export function checkQuality(args: {
  subject: string; body: string; citedClaims: number;
}): QualityCheck[] {
  const out: QualityCheck[] = [];
  const body = args.body.toLowerCase();
  const subject = args.subject.trim();
  const prose = stripSignature(args.body);
  const words = countWords(prose);

  if (args.citedClaims === 0) {
    out.push({ flag: "no_citations", detail: "it will read as a mail-merge" });
  }
  if (words > 130) out.push({ flag: "too_long", detail: `${words} words — past about 120 it gets skimmed` });
  if (words < 25) out.push({ flag: "too_short", detail: `${words} words` });

  for (const phrase of FLATTERY) {
    if (body.includes(phrase)) { out.push({ flag: "flattery", detail: `"${phrase}"` }); break; }
  }
  for (const phrase of HEDGING) {
    if (body.includes(phrase)) { out.push({ flag: "hedging", detail: `"${phrase}"` }); break; }
  }
  for (const [re, label] of VAGUE_ASK) {
    if (re.test(args.body)) { out.push({ flag: "vague_ask", detail: `"${label}"` }); break; }
  }
  for (const phrase of PLACEHOLDER) {
    if (body.includes(phrase)) { out.push({ flag: "placeholder", detail: `"${phrase}"` }); break; }
  }
  // A question mark is the cheapest proxy for "is there an ask at all".
  if (!/[?？]/.test(prose) && !/\b(uygun mu|olur mu|paylaşabilir|gönderebilir)\b/i.test(prose)) {
    out.push({ flag: "no_ask", detail: "the reader is not asked to do anything" });
  }
  if (subject.length > 60) out.push({ flag: "subject_too_long", detail: `${subject.length} characters` });
  if (subject.endsWith("?")) out.push({ flag: "subject_question", detail: "reads as a sales email" });

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
/**
 * Bumped whenever the checks or their wording change, so existing drafts are re-checked once
 * instead of showing flags produced by an older version of the rules.
 */
export const QUALITY_VERSION = 2;

export function backfillQuality(db: {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown; get?: (...a: unknown[]) => unknown };
}, force = false): number {
  const rows = db.prepare(
    force
      ? `SELECT v.id, v.subject, v.body_text, v.personalization
         FROM email_draft_version v WHERE length(v.body_text) > 0`
      : `SELECT v.id, v.subject, v.body_text, v.personalization
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
