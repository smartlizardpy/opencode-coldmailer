/**
 * Pasting a list. People paste bare domains, "domain Name" lines, and CSVs exported from a
 * spreadsheet or another tool. Requiring them to say which would be a worse product than
 * working it out, so these tests cover the shapes people actually paste.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompanyList, parseCsv } from "../../src/server/research/importList.ts";
import { toCsv } from "../../src/server/stats.ts";

test("a bare list of domains", () => {
  const r = parseCompanyList("bethellandco.co.uk\npta.com.tr\n");
  assert.equal(r.format, "lines");
  assert.deepEqual(r.rows.map((x) => x.website), ["bethellandco.co.uk", "pta.com.tr"]);
});

test("domain followed by a name", () => {
  const r = parseCompanyList("bethellandco.co.uk Bethell & Co");
  assert.deepEqual(r.rows, [{ website: "bethellandco.co.uk", name: "Bethell & Co" }]);
});

test("a CSV with a labelled website column", () => {
  const r = parseCompanyList('Company,Website,Notes\nAcme Ltd,acme.co.uk,big\nBeta,beta.com,small');
  assert.equal(r.format, "csv");
  assert.deepEqual(r.rows, [
    { website: "acme.co.uk", name: "Acme Ltd" },
    { website: "beta.com", name: "Beta" },
  ]);
});

test("a CSV with no header at all - the URL column is found by looking", () => {
  const r = parseCompanyList("Acme Ltd,acme.co.uk\nBeta,beta.com");
  assert.equal(r.format, "csv");
  assert.deepEqual(r.rows.map((x) => x.website), ["acme.co.uk", "beta.com"]);
  assert.deepEqual(r.rows.map((x) => x.name), ["Acme Ltd", "Beta"]);
});

test("our own export round-trips back in", () => {
  const csv = toCsv([
    { name: "Bethell & Co", domain: "bethellandco.co.uk", website_url: "https://www.bethellandco.co.uk/", city: "Durham" },
    { name: "PTA", domain: "pta.com.tr", website_url: "https://pta.com.tr", city: "İstanbul" },
  ]);
  const r = parseCompanyList(csv);
  assert.equal(r.format, "csv");
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].name, "Bethell & Co", "a quoted field containing & must survive");
});

test("quoted fields, escaped quotes and embedded newlines", () => {
  const rows = parseCsv('a,"b,with comma","he said ""hi"""\n"multi\nline",y,z');
  assert.deepEqual(rows[0], ["a", "b,with comma", 'he said "hi"']);
  assert.deepEqual(rows[1], ["multi\nline", "y", "z"]);
});

test("rows that are not domains are reported, never silently dropped", () => {
  const r = parseCompanyList("acme.co.uk\nnot a domain at all\nbeta.com");
  assert.deepEqual(r.rows.map((x) => x.website), ["acme.co.uk", "beta.com"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /not a domain/);
});

test("empty input yields nothing rather than throwing", () => {
  for (const t of ["", "   ", "\n\n"]) assert.deepEqual(parseCompanyList(t).rows, []);
});

test("a full URL is accepted, not just a bare domain", () => {
  const r = parseCompanyList("https://www.bethellandco.co.uk/contact");
  assert.equal(r.rows[0].website, "https://www.bethellandco.co.uk/contact");
});

test("the name column is not duplicated into the name when it IS the domain", () => {
  const r = parseCompanyList("Website\nacme.co.uk");
  assert.equal(r.rows[0].website, "acme.co.uk");
  assert.equal(r.rows[0].name, undefined);
});

test("the import is bounded", () => {
  const many = Array.from({ length: 900 }, (_, i) => `c${i}.com`).join("\n");
  assert.equal(parseCompanyList(many, 500).rows.length, 500);
});

/* The shapes people actually paste. This is the fallback path when discovery has not worked
   for them, so rejecting a whole paste over its formatting is the worst possible moment. */

const websites = (text: string) => parseCompanyList(text).rows.map((r) => r.website);
const named = (text: string) => parseCompanyList(text).rows.map((r) => `${r.website}|${r.name ?? ""}`);

test("the domain can be anywhere on the line, not only first", () => {
  // Requiring the first token to be the domain rejected the whole line, and "Name domain" is
  // how anyone who wrote the list by hand tends to write it.
  assert.deepEqual(named("Ankara Masasi ankaramasasi.com.tr"), ["ankaramasasi.com.tr|Ankara Masasi"]);
  assert.deepEqual(named("ankaramasasi.com.tr Ankara Masasi"), ["ankaramasasi.com.tr|Ankara Masasi"]);
});

test("a separator between the name and the domain is not part of the name", () => {
  for (const sep of ["-", "–", "—", ":", "|"]) {
    assert.deepEqual(named(`Ankara Masasi ${sep} ankaramasasi.com.tr`), ["ankaramasasi.com.tr|Ankara Masasi"], sep);
  }
});

test("bulleted and numbered lists import", () => {
  // Copying out of a document, a notes app or a chat answer produces exactly these.
  assert.deepEqual(websites("- ankaramasasi.com.tr\n- sporankara.org"), ["ankaramasasi.com.tr", "sporankara.org"]);
  assert.deepEqual(websites("* ankaramasasi.com.tr\n• sporankara.org"), ["ankaramasasi.com.tr", "sporankara.org"]);
  assert.deepEqual(websites("1. ankaramasasi.com.tr\n2) sporankara.org"), ["ankaramasasi.com.tr", "sporankara.org"]);
});

test("brackets around the domain or the name are dropped", () => {
  assert.deepEqual(named("Ankara Masasi (ankaramasasi.com.tr)"), ["ankaramasasi.com.tr|Ankara Masasi"]);
  assert.deepEqual(named("* Ankara Masasi - ankaramasasi.com.tr"), ["ankaramasasi.com.tr|Ankara Masasi"]);
});

test("a comma-separated line of domains is several companies, not one with an odd name", () => {
  // "a.com, b.com" parses as one CSV row of two fields, and the second was being taken as the
  // first one's name - importing half the list under a name that is somebody else's domain.
  assert.deepEqual(websites("ankaramasasi.com.tr, sporankara.org"), ["ankaramasasi.com.tr", "sporankara.org"]);
  assert.deepEqual(parseCompanyList("a.com, b.com, c.com").rows.every((r) => r.name === undefined), true);
});

test("a real CSV still gets its names", () => {
  assert.deepEqual(named("name,website\nAnkara Masasi,ankaramasasi.com.tr"), ["ankaramasasi.com.tr|Ankara Masasi"]);
  assert.deepEqual(named("Ankara Masasi,ankaramasasi.com.tr"), ["ankaramasasi.com.tr|Ankara Masasi"]);
});

test("a line with no domain in it is skipped with a reason, not silently", () => {
  const r = parseCompanyList("Here are some sites:\n- ankaramasasi.com.tr");
  assert.deepEqual(r.rows.map((x) => x.website), ["ankaramasasi.com.tr"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /not a domain/);
});
