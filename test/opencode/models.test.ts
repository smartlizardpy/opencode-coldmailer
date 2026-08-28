/**
 * Model selection. The probe measures latency; this is what decides whether that measurement
 * changes anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, Cooldowns, pickByPreferenceAndSpeed, type ProbedModel } from "../../src/server/opencode/models.ts";

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

/* The order requests are actually tried in. */

const slots = (activeId: string, ids: string[]) => ({
  research: {
    active: { providerID: "opencode", modelID: activeId },
    ranking: ids.map((modelID) => ({ providerID: "opencode", modelID, ok: true, searchProbe: "pass" as const })),
    status: "ok" as const,
  },
  writing: { active: null, ranking: [], status: "none" as const },
});

test("the active model is tried first, even when it is not first in the ranking", () => {
  // The active model was only prepended when it was ABSENT from the ranking - so in the
  // normal case, where it is present, the order fell back to raw preference and the first
  // request went to a different model than the one the slot named.
  const c = candidatesFor(slots("big-pickle", ["nemotron", "big-pickle", "hy3"]) as never, "research", new Cooldowns(), 2);
  assert.deepEqual(c.map((m) => m.modelID), ["big-pickle", "nemotron"]);
});

test("the rest of the ranking follows as failover, without duplicating the active one", () => {
  const c = candidatesFor(slots("hy3", ["nemotron", "big-pickle", "hy3"]) as never, "research", new Cooldowns(), 4);
  assert.deepEqual(c.map((m) => m.modelID), ["hy3", "nemotron", "big-pickle"]);
});

test("a cooled-down model is skipped, active or not", () => {
  const cd = new Cooldowns();
  cd.add({ providerID: "opencode", modelID: "big-pickle" }, 60_000, "429");
  const c = candidatesFor(slots("big-pickle", ["nemotron", "big-pickle", "hy3"]) as never, "research", cd, 2);
  assert.deepEqual(c.map((m) => m.modelID), ["nemotron", "hy3"]);
});

test("research candidates never include a model that failed the search probe", () => {
  const s = {
    research: {
      active: { providerID: "opencode", modelID: "big-pickle" },
      ranking: [
        { providerID: "opencode", modelID: "big-pickle", ok: true, searchProbe: "pass" as const },
        { providerID: "opencode", modelID: "no-search", ok: true, searchProbe: "fail" as const },
      ],
      status: "ok" as const,
    },
    writing: { active: null, ranking: [], status: "none" as const },
  };
  assert.deepEqual(candidatesFor(s as never, "research", new Cooldowns(), 4).map((m) => m.modelID), ["big-pickle"]);
});
