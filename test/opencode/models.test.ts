/**
 * Model selection. The probe measures latency; this is what decides whether that measurement
 * changes anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickByPreferenceAndSpeed, type ProbedModel } from "../../src/server/opencode/models.ts";

/* Which of the passing models actually gets used. */

const probed = (modelID: string, latencyMs?: number): ProbedModel =>
  ({ providerID: "opencode", modelID, ok: true, latencyMs, searchProbe: "pass" });

test("a preferred model that is drastically slower loses to one that passed just as well", () => {
  // Measured on a real probe: nemotron answered a trivial prompt in 16.8s, big-pickle in
  // under a second, and both passed the search probe. Preference order alone sent every
  // research call to the slow one, which is a campaign taking ninety minutes instead of six.
  const pick = pickByPreferenceAndSpeed([probed("nemotron", 16757), probed("big-pickle", 965), probed("hy3", 1740)]);
  assert.equal(pick?.modelID, "big-pickle");
});

test("preference still decides between models of comparable speed", () => {
  // The whole point of the preference list is that it is a judgement about quality. Speed
  // only overrides it when the difference is far outside anything one noisy sample explains.
  assert.equal(pickByPreferenceAndSpeed([probed("nemotron", 1200), probed("big-pickle", 965)])?.modelID, "nemotron");
  assert.equal(pickByPreferenceAndSpeed([probed("nemotron", 5000), probed("big-pickle", 1000)])?.modelID,
    "nemotron", "exactly at the threshold is still acceptable");
  assert.equal(pickByPreferenceAndSpeed([probed("nemotron", 5001), probed("big-pickle", 1000)])?.modelID,
    "big-pickle", "just past it is not");
});

test("a lone candidate is used however slow it is", () => {
  // Slow is not a reason to have no research model at all.
  assert.equal(pickByPreferenceAndSpeed([probed("nemotron", 99_999)])?.modelID, "nemotron");
});

test("a model with no timing is not penalised for it", () => {
  const untimed = { providerID: "opencode", modelID: "unmeasured", ok: true, searchProbe: "pass" } as ProbedModel;
  assert.equal(pickByPreferenceAndSpeed([untimed, probed("b", 100), probed("c", 200)])?.modelID, "unmeasured");
});

test("no candidates means no model, not a crash", () => {
  assert.equal(pickByPreferenceAndSpeed([]), undefined);
});
