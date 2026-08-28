/**
 * Where the signature and the opt-out footer come from.
 *
 * They used to be baked into the draft when it was written, so changing your name or switching
 * the footer on only affected drafts written afterwards. The footer is a compliance setting -
 * someone who enables it reasonably expects it to apply to everything not yet sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults, setSetting } from "../../src/server/db/settings.ts";
import { renderBody, renderedBody } from "../../src/server/research/compose.ts";

const PRODUCT = { sender_name: "Ozan", sender_title: "", sender_company: "WearSide Labs" };

function db0() {
  const db = openDb(":memory:"); migrate(db); seedDefaults(db);
  return db;
}

test("the signature is appended, and the footer is not, by default", () => {
  const db = db0();
  const out = renderBody(db, "Hello there.", PRODUCT);
  assert.equal(out, "Hello there.\n\nOzan\nWearSide Labs");
});

test("switching the footer on affects rendering immediately", () => {
  const db = db0();
  const version = { body_text: "Hello there.", signature_mode: "rendered" };
  assert.ok(!renderedBody(db, version, PRODUCT).includes("Reply 'no thanks'"));

  setSetting(db, "sending", {
    dailyLimit: 30, minGapSeconds: 60, maxGapSeconds: 180, paused: true,
    footerEnabled: true, footerText: "Reply 'no thanks' and I won't write again.",
  });
  const after = renderedBody(db, version, PRODUCT);
  assert.match(after, /Reply 'no thanks'/,
    "a draft written before the footer was enabled must still get it");
  assert.match(after, /Ozan\nWearSide Labs/);
});

test("changing your name in the brief changes what will be sent", () => {
  const db = db0();
  const version = { body_text: "Hello there.", signature_mode: "rendered" };
  assert.match(renderedBody(db, version, PRODUCT), /Ozan/);
  assert.match(renderedBody(db, version, { sender_name: "Doruk", sender_company: "Avenza" }), /Doruk\nAvenza/);
});

test("a draft written before this change is left exactly as it is", () => {
  const db = db0();
  // 'baked' rows already contain the signature; rendering again would duplicate it.
  const legacy = { body_text: "Hello there.\n\nOzan\nWearSide Labs", signature_mode: "baked" };
  assert.equal(renderedBody(db, legacy, PRODUCT), "Hello there.\n\nOzan\nWearSide Labs");
  assert.equal((renderedBody(db, legacy, PRODUCT).match(/Ozan/g) ?? []).length, 1);
});

test("a human edit is sent exactly as typed", () => {
  const db = db0();
  // If someone deletes the signature deliberately, we must not put it back.
  const edited = { body_text: "Just this, no sign-off.", signature_mode: "baked" };
  assert.equal(renderedBody(db, edited, PRODUCT), "Just this, no sign-off.");
});

test("an empty footer setting adds nothing even when enabled", () => {
  const db = db0();
  setSetting(db, "sending", { dailyLimit: 30, paused: true, footerEnabled: true, footerText: "   " });
  assert.equal(renderBody(db, "Hi.", PRODUCT), "Hi.\n\nOzan\nWearSide Labs");
});

test("a product with no sender details adds no signature block", () => {
  const db = db0();
  assert.equal(renderBody(db, "Hi.", {}), "Hi.");
  assert.equal(renderBody(db, "Hi.", undefined), "Hi.");
});
