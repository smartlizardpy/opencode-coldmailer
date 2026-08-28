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
