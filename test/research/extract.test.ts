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

/* Fetcher robustness — a transient network blip must not permanently fail a company. */
import { test as t2 } from "node:test";
import { Fetcher } from "../../src/server/research/fetcher.ts";
import { createServer } from "node:http";

t2("a transient failure is retried, and the second attempt is used", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits === 1) { req.socket.destroy(); return; }   // simulate a dropped connection
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><p>recovered</p></body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const f = new Fetcher({ respectRobots: false });
    const res = await f.fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.ok, true, "must recover on retry");
    assert.match(res.html, /recovered/);
    assert.ok(hits >= 2, "should have retried");
  } finally { server.close(); }
});

t2("a genuine 404 is NOT retried into a false success", async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.writeHead(404); res.end("nope"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const f = new Fetcher({ respectRobots: false });
    const res = await f.fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(hits, 1, "a 404 is a real answer, not a transient failure");
  } finally { server.close(); }
});

t2("a cached page still yields its contact links, so a re-crawl does not lose them", async () => {
  const { openDb } = await import("../../src/server/db/index.ts");
  const { migrate } = await import("../../src/server/db/migrate.ts");
  const { storePage, getCachedPage } = await import("../../src/server/research/fetcher.ts");
  const db = openDb(":memory:"); migrate(db);

  const res = { url: "https://x.com/", finalUrl: "https://x.com/", status: 200,
    contentType: "text/html", html: "", bytes: 10, ok: true };
  storePage(db, res as never, "home text", "Home", undefined,
    ["https://x.com/iletisim", "https://x.com/kunye"]);

  const cached = getCachedPage(db, "https://x.com/");
  assert.ok(cached, "page should be cached");
  assert.deepEqual(cached!.links, ["https://x.com/iletisim", "https://x.com/kunye"],
    "without these, a second crawl stops at the homepage and loses every contact page");
});

t2("a page stored without links reads back as an empty list, not a crash", async () => {
  const { openDb } = await import("../../src/server/db/index.ts");
  const { migrate } = await import("../../src/server/db/migrate.ts");
  const { storePage, getCachedPage } = await import("../../src/server/research/fetcher.ts");
  const db = openDb(":memory:"); migrate(db);
  storePage(db, { url: "https://y.com/", finalUrl: "https://y.com/", status: 200,
    contentType: "text/html", html: "", bytes: 1, ok: true } as never, "t", "T");
  assert.deepEqual(getCachedPage(db, "https://y.com/")!.links, []);
});

/* Cloudflare obfuscation, JSON-LD, and vendor addresses. */
import { decodeCfEmail, emailOwnership, extractPage as xp } from "../../src/server/research/extract.ts";

t2("Cloudflare-obfuscated addresses are decoded", () => {
  // Real hex captured from sporankara.org/kunye.
  assert.equal(decodeCfEmail("9afeffe9eefff1daf2fbf8ffe8e3fbe0f3f6f3f7f3b4f9f5f7"), "destek@haberyazilimi.com");
});

t2("a malformed cfemail hex is rejected rather than decoded to noise", () => {
  for (const bad of ["", "zz", "abc", "9afeffe9eefff1daf"]) assert.equal(decodeCfEmail(bad), undefined);
});

t2("both Cloudflare markup forms are picked up from a page", () => {
  const hex = "9afeffe9eefff1daf2fbf8ffe8e3fbe0f3f6f3f7f3b4f9f5f7";
  const html = `<html><body>
    <span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span>
    <a href="/cdn-cgi/l/email-protection#${hex}">write to us</a>
  </body></html>`;
  const p = xp(html, "https://x.com/kunye");
  assert.deepEqual(p.emails, ["destek@haberyazilimi.com"], "both forms decode to the same address");
});

t2("an address published only in JSON-LD is found", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"NewsMediaOrganization","name":"X","email":"bilgi@x.com.tr"}
  </script></head><body>no visible address here</body></html>`;
  assert.deepEqual(xp(html, "https://x.com.tr/").emails, ["bilgi@x.com.tr"]);
});

t2("a contact form is detected, so 'no address' can say why", () => {
  const withForm = `<html><body><form><input type="email" name="email"><button>Send</button></form></body></html>`;
  const without = `<html><body><form><input type="text" name="q"></form></body></html>`;
  assert.equal(xp(withForm, "https://x.com/iletisim").hasContactForm, true);
  assert.equal(xp(without, "https://x.com/ara").hasContactForm, false);
});

t2("a web provider's address is classified as third-party, not the company's", () => {
  assert.equal(emailOwnership("bilgi@manisaaktifhaber.com.tr", "manisaaktifhaber.com.tr"), "own-domain");
  assert.equal(emailOwnership("info@news.manisaaktifhaber.com.tr", "manisaaktifhaber.com.tr"), "own-domain");
  assert.equal(emailOwnership("sporankara@outlook.com", "sporankara.org"), "freemail");
  assert.equal(emailOwnership("destek@haberyazilimi.com", "sporankara.org"), "third-party",
    "emailing the CMS vendor instead of the newsroom is worse than sending nothing");
});

t2("a Cloudflare address survives a cache round-trip", async () => {
  const { openDb } = await import("../../src/server/db/index.ts");
  const { migrate } = await import("../../src/server/db/migrate.ts");
  const { storePage, getCachedPage } = await import("../../src/server/research/fetcher.ts");
  const db = openDb(":memory:"); migrate(db);
  // The address is in an HTML attribute and appears nowhere in the visible text.
  storePage(db, { url: "https://x.com/kunye", finalUrl: "https://x.com/kunye", status: 200,
    contentType: "text/html", html: "", bytes: 1, ok: true } as never,
    "Künye. Yayın sahibi. [email protected]", "Künye", undefined, [], ["bilgi@x.com"], true);
  const c = getCachedPage(db, "https://x.com/kunye")!;
  assert.deepEqual(c.emails, ["bilgi@x.com"], "re-deriving from text alone would lose it");
  assert.equal(c.hasForm, true);
});

t2("prefetch crawls several hosts at once but still serialises each host", async () => {
  const { openDb } = await import("../../src/server/db/index.ts");
  const { migrate } = await import("../../src/server/db/migrate.ts");
  const { ulid, now } = await import("../../src/server/db/index.ts");
  const { Fetcher } = await import("../../src/server/research/fetcher.ts");
  const { prefetchCompanies } = await import("../../src/server/research/pipeline.ts");

  // One server, but each company points at a distinct hostname alias of it.
  let inFlight = 0, peak = 0;
  const server = createServer(async (_req, res) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 120));
    inFlight--;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><p>hello</p></body></html>");
  });
  // Bind to every loopback address, not just 127.0.0.1, so the 127.0.0.x aliases below connect.
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const port = (server.address() as { port: number }).port;

  const db = openDb(":memory:"); migrate(db);
  const t = now(), p = ulid(), c = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(c, p, "C", t, t);
  const ccIds: string[] = [];
  // 127.0.0.x are distinct hosts to the per-domain throttle, and all route to the same server.
  for (let i = 1; i <= 4; i++) {
    const co = ulid(), cc = ulid();
    db.prepare("INSERT INTO company (id,domain,name,website_url,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(co, `127.0.0.${i}`, `C${i}`, `http://127.0.0.${i}:${port}/`, t, t);
    db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(cc, c, co, t, t);
    ccIds.push(cc);
  }
  try {
    const deps = { db, llm: null as never, fetcher: new Fetcher({ respectRobots: false }) };
    const r = await prefetchCompanies(deps, ccIds, 4);
    assert.equal(r.crawled, 4);
    assert.ok(peak > 1, `hosts should overlap; peak concurrency was ${peak}`);
  } finally { server.close(); }
});

t2("an address found only in HTML (not the visible text) is still accepted as on-site", () => {
  // The regression: findContacts validated candidates against page TEXT only, which rejects
  // every Cloudflare-obfuscated and JSON-LD address - the ones hardest to find in the first place.
  const hex = "9afeffe9eefff1daf2fbf8ffe8e3fbe0f3f6f3f7f3b4f9f5f7";
  const html = `<html><body><p>Bize ulasin</p>
    <span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></body></html>`;
  const p = xp(html, "https://x.com/iletisim");
  assert.deepEqual(p.emails, ["destek@haberyazilimi.com"]);
  assert.ok(!p.text.includes("destek@haberyazilimi.com"),
    "the address is deliberately absent from the visible text - that is the whole point of the obfuscation");
});
