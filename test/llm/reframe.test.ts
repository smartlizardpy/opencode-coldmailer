/**
 * The reframe contract.
 *
 * Reference case, written by the person this was built for:
 *   goal:   "Yeni çıkaracağımız Avenza uygulaması için yazacağımız Spor salonları ile
 *            anlaşma yapıp uygulama içi reklam."
 *   target: "small but ok spor salonları"
 *
 * The goal field describes the PRODUCT, not the ask, and the target names a kind but no
 * geography. Both are normal, and the tool has to separate the ask from the product without
 * inventing the parts that were never said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REFRAME_SCHEMA, REFRAME_SYSTEM, reframePrompt } from "../../src/server/llm/prompts.ts";
import { validate } from "../../src/server/llm/validate.ts";
import { TASK_CONFIG } from "../../src/server/llm/index.ts";

const REAL = {
  goal: "Yeni çıkaracağımız Avenza uygulaması için yazacağımız Spor salonları ile anlaşma yapıp uygulama içi reklam.",
  target: "small but ok spor salonları",
};

test("the prompt carries every field through, including a blank one", () => {
  const p = reframePrompt({ name: "", ...REAL });
  assert.match(p, /Avenza/);
  assert.match(p, /small but ok spor salonları/);
  assert.match(p, /\(blank\)/, "a blank field is labelled, not silently dropped");
});

test("proper nouns are not paraphrased away", () => {
  assert.match(REFRAME_SYSTEM, /Keep proper nouns exactly as written/);
});

test("the system prompt forbids inventing a place, size or budget", () => {
  assert.match(REFRAME_SYSTEM, /Never invent a place, a size, a budget or an industry/);
});

test("notes must not contradict the fields — the failure that made the first version worse", () => {
  // The first run returned target "Small independent gyms" alongside a note saying independence
  // was NOT assumed. A target that quietly asserts something the notes disclaim looks checked
  // and is not, which is worse than either half alone.
  // Whitespace-tolerant: the prompt is hard-wrapped, so a literal regex breaks on the wrap.
  const flat = REFRAME_SYSTEM.replace(/\s+/g, " ");
  assert.match(flat, /notes must not contradict the fields/i);
  assert.match(flat, /that attribute must not appear in target_description/i);
});

test("notes describe the tool's own action, not the person's", () => {
  // The first run wrote "you separated the product description", addressing the user as if they
  // had done the rewriting.
  assert.match(REFRAME_SYSTEM, /impersonally/);
  assert.match(REFRAME_SYSTEM, /not "you separated the product description"/);
});

test("a goal is the ask, and the prompt says so with a worked example", () => {
  assert.match(REFRAME_SYSTEM, /agree an in-app advertising partnership" is a goal/);
  assert.match(REFRAME_SYSTEM, /it describes the product/);
});

test("the target has to be a kind of organisation, not a topic", () => {
  assert.match(REFRAME_SYSTEM, /KIND of organisation/);
  assert.match(REFRAME_SYSTEM, /not a topic/);
});

test("local-language category terms are kept, because search runs in their market", () => {
  assert.match(REFRAME_SYSTEM, /spor salonu/);
});

test("a well-formed answer validates", () => {
  const ok = {
    name: "Avenza spor salonu reklam ortaklıkları",
    goal: "Avenza uygulamasında reklam yayınlamak için anlaşma yapmak.",
    target_description: "Küçük spor salonları (gyms).",
    notes: ["Ürün açıklaması e-posta hedefinden ayrıldı."],
  };
  assert.deepEqual(validate(REFRAME_SCHEMA, ok), { ok: true, errors: [] });
});

test("a missing notes array is rejected — notes are how you catch it being wrong", () => {
  const r = validate(REFRAME_SCHEMA, { name: "a", goal: "b", target_description: "c" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("notes")), r.errors.join("; "));
});

test("an extra invented field is rejected rather than silently carried", () => {
  const r = validate(REFRAME_SCHEMA, {
    name: "a", goal: "b", target_description: "c", notes: [], budget: "£500",
  });
  assert.equal(r.ok, false);
});

test("reframe runs on the writing model with no tools — it is rewriting text, not researching", () => {
  const cfg = TASK_CONFIG["campaign.reframe"];
  assert.equal(cfg.slot, "writing");
  assert.equal(cfg.policy, "none", "a rewrite must not be able to reach the web");
  assert.equal(cfg.kind, "write");
});
