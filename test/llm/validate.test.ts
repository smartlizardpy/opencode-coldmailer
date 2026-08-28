/**
 * Schema validation. The trap this guards: ajv silently ignores an unknown format, so
 * `format: "uri"` on a source_url would accept any string at all - and the citation guarantee
 * would be resting on a constraint that does nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../src/server/llm/validate.ts";
import { ENRICH_SCHEMA, DISCOVER_SCHEMA, CONTACTS_SCHEMA } from "../../src/server/llm/prompts.ts";

const uriSchema = { type: "object", required: ["u"], properties: { u: { type: "string", format: "uri" } } };

test("format: uri is actually enforced, not silently ignored", () => {
  assert.equal(validate(uriSchema, { u: "https://pta.com.tr/kunye" }).ok, true);
  const bad = validate(uriSchema, { u: "not a uri at all" });
  assert.equal(bad.ok, false, "if this passes, ajv-formats is not registered and every uri check is a no-op");
  assert.match(bad.errors[0], /format/);
});

test("a bare domain is not a URI - the model must return the page it saw", () => {
  assert.equal(validate(uriSchema, { u: "pta.com.tr" }).ok, false);
});

test("every schema that carries a source_url declares it as a uri", () => {
  for (const [name, schema] of [["enrich", ENRICH_SCHEMA], ["discover", DISCOVER_SCHEMA], ["contacts", CONTACTS_SCHEMA]] as const) {
    const json = JSON.stringify(schema);
    assert.ok(json.includes("source_url"), `${name} should have a source_url`);
    assert.match(json, /"source_url":\{[^}]*"format":"uri"/, `${name}: source_url must be a real URL`);
  }
});

test("a claim without a verbatim quote is rejected by the schema", () => {
  const missingQuote = { summary: "x", claims: [{ claim: "they do X", source_url: "https://x.com/" }] };
  assert.equal(validate(ENRICH_SCHEMA as object, missingQuote).ok, false,
    "a claim with no quote cannot be verified, so it must not be representable");
});

test("a quote too short to verify is rejected", () => {
  const tiny = { summary: "x", claims: [{ claim: "they do X", source_url: "https://x.com/", quote: "short" }] };
  assert.equal(validate(ENRICH_SCHEMA as object, tiny).ok, false);
});

test("a well-formed enrichment passes", () => {
  const good = {
    summary: "A local news site.",
    claims: [{ claim: "Publishes amateur football coverage.", source_url: "https://x.com/hakkimizda",
               quote: "amatör futbol haberlerini düzenli olarak yayımlıyoruz" }],
  };
  assert.equal(validate(ENRICH_SCHEMA as object, good).ok, true);
});

test("extra keys are refused, so the model cannot smuggle fields past us", () => {
  const extra = { summary: "x", claims: [], surprise: "hello" };
  assert.equal(validate(ENRICH_SCHEMA as object, extra).ok, false);
});

test("errors are short sentences a model can act on", () => {
  const r = validate({ type: "object", required: ["a"], properties: { a: { type: "boolean" } } }, { a: "yes" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^\/a: must be boolean/);
});
