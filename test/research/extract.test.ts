/**
 * Contact-page discovery. The regression these lock in: an English-only path matcher silently
 * reduced every non-English site to a homepage-only crawl, which the pipeline then reported as
 * "no publishable address found" - a wrong answer that looks like a correct one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickContactPages, foldPath, quoteAppearsIn, cleanEmail, isRoleAccount,
         inferEmailPattern, applyEmailPattern } from "../../src/server/research/extract.ts";

test("Turkish contact paths are found", () => {
  const picked = pickContactPages([
    "https://pta.com.tr/iletisim", "https://pta.com.tr/hakkimizda",
    "https://pta.com.tr/ekibimiz", "https://pta.com.tr/kurslar",
  ], "https://pta.com.tr/");
  assert.ok(picked.includes("https://pta.com.tr/iletisim"), "must find /iletisim");
  assert.ok(picked.includes("https://pta.com.tr/hakkimizda"), "must find /hakkimizda");
  assert.ok(!picked.includes("https://pta.com.tr/kurslar"), "/kurslar is not a contact page");
});

test("percent-encoded and accented paths fold to the same words", () => {
  assert.equal(foldPath("/%C4%B0leti%C5%9Fim"), "/iletisim");
  assert.equal(foldPath("/Hakkımızda"), "/hakkimizda");
  assert.equal(foldPath("/Über-uns"), "/uber-uns");
  const picked = pickContactPages(["https://x.com/%C4%B0leti%C5%9Fim"], "https://x.com/");
  assert.equal(picked.length, 1);
});

test("contact ranks above team, which ranks above about", () => {
  const picked = pickContactPages([
    "https://x.com/hakkimizda", "https://x.com/ekibimiz", "https://x.com/iletisim",
  ], "https://x.com/");
  assert.deepEqual(picked, ["https://x.com/iletisim", "https://x.com/ekibimiz", "https://x.com/hakkimizda"]);
});

test("German, French and Spanish contact pages are found too", () => {
  for (const p of ["/impressum", "/kontakt", "/contacto", "/contatti", "/quienes-somos", "/a-propos"]) {
    assert.equal(pickContactPages([`https://x.com${p}`], "https://x.com/").length, 1, `missed ${p}`);
  }
});

test("other domains and deep archive paths are still excluded", () => {
  assert.deepEqual(pickContactPages(["https://other.com/iletisim"], "https://x.com/"), []);
  assert.deepEqual(pickContactPages(["https://x.com/blog/2024/01/contact/deep"], "https://x.com/"), []);
});

test("junk addresses are rejected", () => {
  assert.equal(cleanEmail("filler@godaddy.com"), undefined);
  assert.equal(cleanEmail("noreply@pta.com.tr"), undefined);
  assert.equal(cleanEmail("info@pta.com.tr"), "info@pta.com.tr");
  assert.ok(isRoleAccount("info@pta.com.tr"));
});

test("email pattern inference and application", () => {
  assert.equal(inferEmailPattern([{ email: "ozgur.yilmaz@pta.com.tr", fullName: "Özgür Yılmaz" }]), undefined,
    "diacritics in the name should not silently produce a wrong pattern");
  assert.equal(inferEmailPattern([{ email: "john.smith@x.com", fullName: "John Smith" }]), "first.last");
  assert.equal(applyEmailPattern("first.last", "Jane Doe", "x.com"), "jane.doe@x.com");
});

test("quote verification still rejects fabrications", () => {
  const text = "PTA, Beykoz'da 4 yaşından itibaren tenis eğitimi veren butik bir akademidir.";
  assert.ok(quoteAppearsIn("4 yaşından itibaren tenis eğitimi", text).ok);
  assert.equal(quoteAppearsIn("Türkiye'nin en büyük 40 kortlu tesisi", text).ok, false);
});

test("every contact word scores above the fallback band, so none is ranked off the list", () => {
  // Guards the class of bug where a word is crawlable but lands in the wrong scoring band.
  const bands: Array<[string, number]> = [
    ["/iletisim", 60], ["/contact", 60], ["/kontakt", 60],
    ["/ekibimiz", 45], ["/kadro", 45], ["/antrenorler", 45], ["/team", 45],
    ["/hakkimizda", 30], ["/kurumsal", 30], ["/about", 30],
  ];
  for (const [path, minBand] of bands) {
    const picked = pickContactPages([`https://x.com${path}`, "https://x.com/kunye"], "https://x.com/");
    assert.equal(picked[0], `https://x.com${path}`,
      `${path} (band ${minBand}) should outrank the generic /kunye fallback`);
  }
});
