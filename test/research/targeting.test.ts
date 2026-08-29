/**
 * The qualification gate.
 *
 * Reference case: a campaign looking for "küçük haber siteleri" (small local news sites) got
 * as far as writing an email to Performans Tenis Akademisi, a tennis academy. Two separate
 * holes let that happen, and both are covered here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecision, targetOf } from "../../src/server/research/pipeline.ts";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";

/* ---------------------------------------------------- hole 1: the decision */

test("a topical near-miss is rejected: a tennis academy is not a news site", () => {
  const d = gateDecision({
    matchesTarget: false, fitScore: 0, floor: 45,
    targetKind: "local news website", entityKind: "tennis academy",
  });
  assert.equal(d.rejected, true);
  assert.match(d.reason!, /local news website/);
  assert.match(d.reason!, /tennis academy/);
});

test("the reason names both kinds, so the miss is legible without opening the site", () => {
  const d = gateDecision({ matchesTarget: false, fitScore: 0, floor: 45, targetKind: "dental practice", entityKind: "dental equipment supplier" });
  assert.match(d.reason!, /looking for dental practice.*this is a dental equipment supplier/);
});

test("a right-kind but weak fit is still rejected by the numeric floor", () => {
  // The floor is the second, independent reason: matches_target is one boolean and a model
  // will rationalise a near-miss. A number will not.
  const d = gateDecision({ matchesTarget: true, fitScore: 20, floor: 45, targetKind: "news site", entityKind: "news site" });
  assert.equal(d.rejected, true);
  assert.match(d.reason!, /20 is below this campaign's floor of 45/);
});

test("a right-kind, good fit passes", () => {
  assert.deepEqual(
    gateDecision({ matchesTarget: true, fitScore: 80, floor: 45, targetKind: "news site", entityKind: "local news site" }),
    { rejected: false },
  );
});

test("a fit exactly on the floor passes - the floor is a minimum, not an exclusive bound", () => {
  assert.equal(gateDecision({ matchesTarget: true, fitScore: 45, floor: 45 }).rejected, false);
});

test("a missing or non-numeric fit score is treated as zero, never as a pass", () => {
  for (const bad of [NaN, undefined as unknown as number]) {
    assert.equal(gateDecision({ matchesTarget: true, fitScore: bad, floor: 45 }).rejected, true);
  }
});

test("a floor of 0 disables the numeric check without disabling the kind check", () => {
  assert.equal(gateDecision({ matchesTarget: true, fitScore: 0, floor: 0 }).rejected, false);
  assert.equal(gateDecision({ matchesTarget: false, fitScore: 100, floor: 0 }).rejected, true);
});

test("the reason survives a model that returns empty kind strings", () => {
  const d = gateDecision({ matchesTarget: false, fitScore: 0, floor: 45, targetKind: "  ", entityKind: "" });
  assert.equal(d.rejected, true);
  assert.ok(d.reason && !d.reason.includes("undefined"), `reason was: ${d.reason}`);
});

/* ------------------------------------- hole 2: the instruction reaching it */

function campaignRow(over: Record<string, unknown> = {}) {
  return { target_description: "", ...over };
}
const PRODUCT = {
  signals: JSON.stringify([{ signal: "publishes local stories" }]),
  audience: JSON.stringify({ who: "small businesses", where: "Durham" }),
};

test("an explicit campaign target beats the product's generic audience", () => {
  const t = targetOf(campaignRow({ target_description: "small local news websites" }), PRODUCT);
  assert.equal(t, "small local news websites");
  assert.ok(!t.includes("small businesses"), "the generic audience must not leak in and soften the target");
});

test("with no campaign target it falls back to the product audience and signals", () => {
  const t = targetOf(campaignRow(), PRODUCT);
  assert.match(t, /small businesses/);
  assert.match(t, /publishes local stories/);
});

test("min_fit_score exists with a sane default, so old campaigns get the floor too", () => {
  const db = openDb(":memory:");
  migrate(db);
  const t = now();
  const p = ulid(), c = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(c, p, "C", t, t);
  const row = db.prepare("SELECT min_fit_score FROM campaign WHERE id=?").get(c) as { min_fit_score: number };
  assert.equal(row.min_fit_score, 45);
});

test("the floor is per-campaign and settable", () => {
  const db = openDb(":memory:");
  migrate(db);
  const t = now();
  const p = ulid(), c = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,min_fit_score,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(c, p, "C", 70, t, t);
  assert.equal((db.prepare("SELECT min_fit_score FROM campaign WHERE id=?").get(c) as any).min_fit_score, 70);
});
