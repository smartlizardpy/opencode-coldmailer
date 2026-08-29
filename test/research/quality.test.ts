/**
 * Draft quality checks. The reference case throughout is the real Turkish email this feature
 * was built in response to - it had six distinct problems and none of them were visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuality, countWords, isBlocking, BLOCKING_FLAGS } from "../../src/server/research/quality.ts";

const flagsOf = (a: Parameters<typeof checkQuality>[0]) => checkQuality(a).map((f) => f.flag);

const BAD_TR = `PTA'nın çocuklar için 4 yaşından itibaren yaş ve seviyeye uygun tenis eğitimi vermesi dikkat çekici.

Avenza'da spor haber bülteninde PTA haberlerini gösterebilir, tenisle ilgilenen insanların birbirini ve etkinlikleri bulmasına yardımcı olabiliriz.

Bunu birlikte kısa bir içerikle başlatmak ister misiniz?`;

const GOOD_TR = `PTA'nın çocuklara 4 yaşından itibaren yaş ve seviyeye uygun tenis eğitimi verdiğini gördüm. Bu programları Avenza'daki spor haber bülteninde ilgili kullanıcılara göstermek için yazıyorum.

Kurs ve etkinlik duyurularınızı Avenza'da yayınlıyor, kullanıcıların akademinizle tanışmasını sağlıyoruz.

Yayınlamak üzere ilk duyurunuzu bu hafta paylaşabilir misiniz?`;

test("the real bad email is flagged on every count that was wrong with it", () => {
  const f = flagsOf({ subject: "pta'yı avenza'da göstermek", body: BAD_TR, citedClaims: 0 });
  for (const expected of ["no_citations", "flattery", "hedging", "vague_ask"]) {
    assert.ok(f.includes(expected as never), `expected ${expected}, got ${f.join(",")}`);
  }
});

test("the rewritten version is clean", () => {
  assert.deepEqual(flagsOf({ subject: "pta duyuruları", body: GOOD_TR, citedClaims: 2 }), []);
});

test("flattery is caught in English too", () => {
  assert.ok(flagsOf({ subject: "x", body: "Your work is impressive. Can we talk Tuesday?", citedClaims: 1 })
    .includes("flattery"));
});

test("an unanswerable ask is caught even when everything else is fine", () => {
  const f = flagsOf({ subject: "quick note", body:
    "I saw you rebuilt your booking flow last month. We host local sports listings.\n\nLet me know if this sounds interesting.", citedClaims: 1 });
  assert.ok(f.includes("vague_ask"));
});

test("an email with no question at all is flagged", () => {
  assert.ok(flagsOf({ subject: "hello", body:
    "I saw your new workshop in Durham. We build websites for local trades. Fixed price, no retainers, usually live in two weeks.", citedClaims: 1 })
    .includes("no_ask"));
});

test("a Turkish ask without a question mark still counts as an ask", () => {
  const f = flagsOf({ subject: "duyuru", body:
    "Sitenizde yayınlanan haberleri gördüm ve bültenimize eklemek için yazıyorum. İlk duyurunuzu bu hafta paylaşabilir misiniz", citedClaims: 1 });
  assert.ok(!f.includes("no_ask"), `should not flag no_ask, got ${f.join(",")}`);
});

test("length bounds", () => {
  assert.ok(flagsOf({ subject: "x", body: "word ".repeat(140) + "?", citedClaims: 1 }).includes("too_long"));
  assert.ok(flagsOf({ subject: "x", body: "Hi. Interested?", citedClaims: 1 }).includes("too_short"));
});

test("unfilled placeholders are caught", () => {
  for (const body of ["Hi [FirstName], can we talk?", "Hello {{company}}, free Tuesday?", "Dear your company, ok?"]) {
    assert.ok(flagsOf({ subject: "x", body, citedClaims: 1 }).includes("placeholder"), body);
  }
});

test("subject rules", () => {
  assert.ok(flagsOf({ subject: "a".repeat(70), body: GOOD_TR, citedClaims: 1 }).includes("subject_too_long"));
  assert.ok(flagsOf({ subject: "quick question?", body: GOOD_TR, citedClaims: 1 }).includes("subject_question"));
});

test("blocking flags are the ones that make an email wrong, not merely weak", () => {
  assert.deepEqual([...BLOCKING_FLAGS].sort(), ["no_citations", "placeholder", "too_long"]);
  assert.ok(isBlocking(["placeholder"]));
  assert.ok(isBlocking(["no_citations", "flattery"]));
  assert.ok(!isBlocking(["flattery", "hedging"]), "style problems should not block a bulk approve");
  assert.ok(!isBlocking([]));
});

test("countWords ignores extra whitespace", () => {
  assert.equal(countWords("  one   two \n three \n\n "), 3);
  assert.equal(countWords(""), 0);
});

test("the signature is not counted against the word budget", () => {
  // A long-ish body plus a signature should not tip into too_long on the signature alone.
  const body = "word ".repeat(100) + "?\n\nOzan\nWearSide Labs";
  assert.ok(!flagsOf({ subject: "x", body, citedClaims: 1 }).includes("too_long"));
});

/* Signature handling — the bug that made every good email look like it had no ask. */
import { stripSignature } from "../../src/server/research/quality.ts";

test("a signature block is stripped", () => {
  assert.equal(stripSignature("Body text here?\n\nOzan\nWearSide Labs"), "Body text here?");
});

test("a SHORT FINAL PARAGRAPH THAT IS THE ASK is not mistaken for a signature", () => {
  const body = "Uzun bir paragraf burada.\n\nBunu bu hafta paylaşabilir misiniz?";
  assert.ok(stripSignature(body).includes("paylaşabilir misiniz"),
    "the ask must survive signature stripping");
});

test("a short final sentence with terminal punctuation is kept", () => {
  assert.equal(stripSignature("Long intro here.\n\nFree Tuesday?"), "Long intro here.\n\nFree Tuesday?");
});

test("multiple signature lines are all stripped, body is not", () => {
  assert.equal(stripSignature("The message?\n\nOzan\nWearSide Labs\nDurham"), "The message?");
});

test("a body with no signature is returned unchanged", () => {
  assert.equal(stripSignature("Just one paragraph, with a question?"), "Just one paragraph, with a question?");
});

test("a detail adds specifics rather than restating its own label", () => {
  // The UI renders "<label> — <detail>", so a detail that repeats the label stutters:
  // "Nothing specific to this company is cited — nothing specific to this company is cited…"
  const LABEL_WORDS: Record<string, string[]> = {
    no_citations: ["nothing specific", "cited"],
    flattery: ["empty praise"],
    hedging: ["hedged"],
    vague_ask: ["not answerable", "ask"],
    placeholder: ["unfilled placeholder"],
    no_ask: ["no question"],
    subject_question: ["question as a subject"],
  };
  const all = [
    ...checkQuality({ subject: "quick question?", body: BAD_TR, citedClaims: 0 }),
    ...checkQuality({ subject: "a".repeat(70), body: "Hi [FirstName].", citedClaims: 0 }),
  ];
  assert.ok(all.length > 4, "should have produced a range of flags to check");
  for (const f of all) {
    for (const word of LABEL_WORDS[f.flag] ?? []) {
      assert.ok(!f.detail.toLowerCase().includes(word),
        `${f.flag}: detail "${f.detail}" repeats "${word}" from its own label`);
    }
  }
});

test("no label contains the separator the UI joins with", () => {
  // The UI writes "<label> — <detail>". A label with its own em dash produces a double dash.
  const LABELS = [
    "Nothing specific to this company is cited", "Longer than a cold email should be",
    "Very short, so it may be missing the reason or the ask", "Contains empty praise",
    "The offer is hedged", "The ask isn't answerable", "There's no actual question",
    "Contains an unfilled placeholder", "Subject will be truncated", "Subject is a question",
  ];
  for (const l of LABELS) assert.ok(!l.includes("—"), `"${l}" contains the separator`);
});

/* The rules have to match the job the email is doing. */

// The real step-3 email the composer produced, following its own default instruction:
// "one or two sentences, say plainly that you will stop here, leave the door open without any
// pressure, no new pitch".
const SIGN_OFF = `Burada bırakıyorum; ileride Ankara spor sonuçları için hazır yayınlanabilir bir akışa ihtiyaç duyarsanız ulaşabilirsiniz.

Uygun olursa 15 dakikalık bir görüşme için dönüş yapmanız yeterli.`;

test("a closing email that does exactly what it was told is not flagged", () => {
  // It used to collect three flags - no_citations, too_short and no_ask - one of which blocks
  // a bulk approve. The checker was calling the product's own best output broken, on every
  // single sign-off, and the only way to send one was to ignore the warning.
  assert.deepEqual(flagsOf({ subject: "spor akışı", body: SIGN_OFF, citedClaims: 0, step: 3 }), []);
});

test("the same text as a FIRST email is still wrong, and still blocks", () => {
  // Relaxing the rules for a sign-off must not relax them for a first touch: with no citation,
  // no ask and nothing specific, this is exactly the mail-merge the flags exist to catch.
  const flags = flagsOf({ subject: "spor akışı", body: SIGN_OFF, citedClaims: 0, step: 1 });
  assert.ok(flags.includes("no_citations"));
  assert.ok(flags.includes("no_ask"));
  assert.equal(isBlocking(flags), true);
});

test("a follow-up still has to ask for something, but need not re-cite", () => {
  // Repeating the first email's quote is what makes a sequence read like a mail-merge, so a
  // missing citation is fine from step 2 on. Not asking anything is still worth surfacing.
  const flags = flagsOf({ subject: "spor akışı", body: SIGN_OFF, citedClaims: 0, step: 2 });
  assert.equal(flags.includes("no_citations"), false);
  assert.ok(flags.includes("no_ask"));
  assert.equal(isBlocking(flags), false, "advisory, not blocking");
});

test("the length floor moves with the step", () => {
  const twenty = "kelime ".repeat(20).trim();
  assert.ok(flagsOf({ subject: "s", body: twenty, citedClaims: 1, step: 1 }).includes("too_short"));
  assert.equal(flagsOf({ subject: "s", body: twenty, citedClaims: 1, step: 2 }).includes("too_short"), false);
  assert.equal(flagsOf({ subject: "s", body: twenty, citedClaims: 1, step: 3 }).includes("too_short"), false);
  // A sign-off can be short, but not empty.
  assert.ok(flagsOf({ subject: "s", body: "Tamam.", citedClaims: 1, step: 3 }).includes("too_short"));
});

test("an over-long email is too long whatever step it is", () => {
  const long = "kelime ".repeat(200).trim();
  for (const step of [1, 2, 3]) {
    assert.ok(flagsOf({ subject: "s", body: long, citedClaims: 1, step }).includes("too_long"), `step ${step}`);
  }
});

test("a missing step is treated as a first email", () => {
  // Every caller passes one now, but defaulting to the strictest reading is the safe way to
  // be wrong.
  assert.deepEqual(
    flagsOf({ subject: "spor akışı", body: SIGN_OFF, citedClaims: 0 }),
    flagsOf({ subject: "spor akışı", body: SIGN_OFF, citedClaims: 0, step: 1 }),
  );
});
