/**
 * Live presence — the co-browse state.
 *
 * The one property that matters most is the one that is easiest to lose in a refactor: this
 * carries where the cursor is and which field is focused, and it has NOWHERE to put the text
 * that was typed into that field. A live cursor is co-browsing; a keystroke log is not, and the
 * difference has to be structural, not a promise.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  forgetPresence, isWatched, livePresence, markWatching, recordPresence, stopWatching,
} from "../../src/server/http/presence.ts";

beforeEach(() => {
  for (const p of livePresence(0)) forgetPresence(p.sessionId);   // livePresence(0) prunes all
  stopWatching();
});

test("the state has no channel for typed text at all", () => {
  // A caller trying to smuggle keystrokes through gets them dropped on the floor: there is no
  // `typed` field, so passing one changes nothing that comes back out.
  const s = recordPresence("s1", "Sam", { field: "Campaign target", typed: "secret words" } as never);
  assert.equal(s.field, "Campaign target");
  assert.equal("typed" in s, false, "presence must not carry keystroke content");
  assert.ok(!JSON.stringify(s).includes("secret words"), "and certainly must not echo it");
});

test("the cursor is clamped to the viewport, whatever the client sends", () => {
  const s = recordPresence("s1", "Sam", { cursor: { x: 5, y: -2 } });
  assert.deepEqual(s.cursor, { x: 1, y: 0 });
});

test("a partial update keeps the fields it did not mention", () => {
  recordPresence("s1", "Sam", { route: "review", cursor: { x: .5, y: .5 } });
  const s = recordPresence("s1", "Sam", { clicks: [{ x: .1, y: .1 }] });
  assert.equal(s.route, "review", "a click batch must not blank the route");
  assert.deepEqual(s.cursor, { x: .5, y: .5 });
  assert.equal(s.clicks.length, 1);
});

test("an empty field label is a real value — focus left the field", () => {
  recordPresence("s1", "Sam", { field: "Campaign name" });
  const s = recordPresence("s1", "Sam", { field: "" });
  assert.equal(s.field, "", "sending '' must clear the field, not fall back to the old one");
});

test("clicks are capped so a flood cannot grow the state without bound", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ x: i / 50, y: 0 }));
  const s = recordPresence("s1", "Sam", { clicks: many });
  assert.ok(s.clicks.length <= 8);
});

test("presence ages out on its own", () => {
  recordPresence("s1", "Sam", { cursor: { x: .5, y: .5 } });
  assert.equal(livePresence().length, 1);
  assert.equal(livePresence(0).length, 0, "a zero window prunes everything stale");
});

test("watching decays rather than sticking on forever", () => {
  assert.equal(isWatched(), false);
  markWatching(50);
  assert.equal(isWatched(), true);
  return new Promise((r) => setTimeout(() => { assert.equal(isWatched(), false, "a watcher who walked away stops being one"); r(undefined); }, 80));
});

test("stopWatching is immediate, for when the owner leaves the screen", () => {
  markWatching(10_000);
  assert.equal(isWatched(), true);
  stopWatching();
  assert.equal(isWatched(), false);
});
