/**
 * Table-driven tests for the extraction ladder. These are the cases models actually produce -
 * several were captured verbatim from live opencode runs against the free models.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, extractFence, braceScan, repairLite, outputContract } from "../../src/server/llm/json.ts";

const CASES: Array<{ name: string; raw: string; expect: unknown; method?: string }> = [
  { name: "bare object", raw: '{"ok":true}', expect: { ok: true }, method: "direct" },
  { name: "bare object with whitespace", raw: '\n  {"ok":true}\n ', expect: { ok: true }, method: "direct" },
  {
    name: "json fence (live: big-pickle, nemotron, hy3, mimo all return this)",
    raw: '```json\n{"ok": true, "city": "Durham"}\n```',
    expect: { ok: true, city: "Durham" }, method: "fence",
  },
  { name: "bare fence, no language tag", raw: '```\n{"ok":1}\n```', expect: { ok: 1 }, method: "fence" },
  {
    name: "prose before and after a fence",
    raw: 'Sure! Here is the JSON:\n```json\n{"a":1}\n```\nLet me know if you need anything else.',
    expect: { a: 1 }, method: "fence",
  },
  {
    name: "prose around bare JSON, no fence",
    raw: 'Here you go: {"a":1,"b":"x"} Hope that helps!',
    expect: { a: 1, b: "x" }, method: "brace-scan",
  },
  { name: "trailing comma", raw: '```json\n{"a":1,}\n```', expect: { a: 1 }, method: "repaired" },
  { name: "trailing comma in array", raw: '{"a":[1,2,],}', expect: { a: [1, 2] }, method: "repaired" },
  { name: "line comment", raw: '```json\n{\n  // the answer\n  "a": 1\n}\n```', expect: { a: 1 }, method: "repaired" },
  { name: "block comment", raw: '{/* hi */"a":1}', expect: { a: 1 }, method: "repaired" },
  { name: "smart quotes", raw: '{“a”:1}', expect: { a: 1 }, method: "repaired" },
  { name: "BOM prefix", raw: '﻿{"a":1}', expect: { a: 1 }, method: "direct" },
  {
    name: "structured_output wrapper (live: format:json_schema leak)",
    raw: '<structured_output>\n{\n  "ok": true\n}',
    expect: { ok: true }, method: "direct",
  },
  {
    name: "braces inside strings do not confuse the scanner",
    raw: 'text {"a":"} not the end {","b":2} tail',
    expect: { a: "} not the end {", b: 2 }, method: "brace-scan",
  },
  {
    name: "escaped quote inside a string",
    raw: '{"a":"she said \\"hi\\"","b":1}',
    expect: { a: 'she said "hi"', b: 1 }, method: "direct",
  },
  {
    name: "a url is not mistaken for a comment",
    raw: '{"url":"https://example.com/a","b":1,}',
    expect: { url: "https://example.com/a", b: 1 }, method: "repaired",
  },
  {
    name: "nested objects survive the scanner",
    raw: 'blah {"a":{"b":{"c":[1,{"d":2}]}}} blah',
    expect: { a: { b: { c: [1, { d: 2 }] } } }, method: "brace-scan",
  },
  {
    name: "last fence wins when a model shows an example first",
    raw: '```json\n{"example":true}\n```\nNow the real answer:\n```json\n{"real":true}\n```',
    expect: { real: true }, method: "fence",
  },
];

for (const c of CASES) {
  test(`extractJson: ${c.name}`, () => {
    const r = extractJson(c.raw);
    assert.ok(r.ok, `expected success, got ${r.error}`);
    assert.deepEqual(r.value, c.expect);
    if (c.method) assert.equal(r.method, c.method);
  });
}

test("extractJson fails cleanly on empty input", () => {
  for (const raw of ["", "   ", "\n\n"]) {
    const r = extractJson(raw);
    assert.equal(r.ok, false);
    assert.equal(r.method, "failed");
    assert.match(r.error!, /empty/);
  }
});

test("extractJson fails cleanly on prose with no JSON", () => {
  const r = extractJson("I'm sorry, I cannot help with that request.");
  assert.equal(r.ok, false);
  assert.match(r.error!, /no parseable JSON/);
});

test("extractJson fails on an unterminated object rather than guessing", () => {
  assert.equal(extractJson('{"a":1,"b":').ok, false);
});

test("extractJson handles an array root", () => {
  const r = extractJson('Here: [{"a":1},{"a":2}] done', "array");
  assert.ok(r.ok);
  assert.deepEqual(r.value, [{ a: 1 }, { a: 2 }]);
});

test("extractFence prefers the json fence over a bare one", () => {
  assert.equal(extractFence('```\nnot this\n```\n```json\n{"a":1}\n```')?.trim(), '{"a":1}');
});

test("braceScan returns undefined when brackets never balance", () => {
  assert.equal(braceScan('{"a":{"b":1}'), undefined);
});

test("repairLite leaves a valid document untouched", () => {
  const src = '{"url":"http://x.com//y","note":"a, b"}';
  assert.deepEqual(JSON.parse(repairLite(src)), JSON.parse(src));
});

test("outputContract embeds the schema and forbids tool use", () => {
  const c = outputContract({ type: "object", properties: { a: { type: "string" } } });
  assert.match(c, /```json/);
  assert.match(c, /Do not call any tools/);
  assert.match(c, /"type": "object"/);
});
