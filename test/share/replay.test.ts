/**
 * Shared-tab session replay.
 *
 * Presence is deliberately text-free; replay is the explicit, disclosed channel that records what
 * was typed inside coldcall so the owner can answer "how did this get approved?" later.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { createInvite, redeemInvite, sessionFor } from "../../src/server/http/access.ts";
import {
  clearLiveReplay, listReplayEvents, listReplays, liveReplayStates,
  pruneOldReplays, recordReplayBatch, replayMarkerForRequest,
} from "../../src/server/http/replay.ts";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  const { token } = createInvite(db, "Co-founder");
  const redeemed = redeemInvite(db, token, "Firefox");
  const session = sessionFor(db, redeemed.token)!;
  return { db, session };
}

beforeEach(() => clearLiveReplay());

test("records pointer, click, scroll, focus, input and snapshot events in order", () => {
  const { db, session } = fresh();
  const batch = recordReplayBatch(db, {
    shareSessionId: session.id,
    label: session.label,
    userAgent: session.user_agent,
    input: { tabId: "tab-1", route: "review", events: [
      { type: "viewport", w: 1200, h: 800 },
      { type: "pointer", x: .25, y: .5 },
      { type: "click", x: .3, y: .6 },
      { type: "scroll", selector: "#content", x: 0, y: 450, maxY: 2000 },
      { type: "focus", selector: "#draftBody", field: "Email body" },
      { type: "input", selector: "#draftBody", field: "Email body", value: "looks good" },
      { type: "key", key: "a", code: "KeyA" },
      { type: "snapshot", html: "<div class=\"app\">review</div>", theme: "light" },
    ] },
  });

  assert.equal(batch.replaySession.label, "Co-founder");
  assert.equal(batch.events.length, 8);
  assert.deepEqual(batch.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);

  const events = listReplayEvents(db, batch.replaySession.id);
  assert.equal(events[5].type, "input");
  assert.equal(events[5].payload.value, "looks good");
  assert.equal(events[6].type, "key");

  const [live] = liveReplayStates();
  assert.equal(live.route, "review");
  assert.deepEqual(live.cursor, { x: .3, y: .6 });
  assert.equal(live.scroll?.y, 450);
  assert.equal(live.field, "Email body");
  assert.equal(live.typed, "looks good");
  assert.equal(live.key?.label, "a");
  assert.match(live.snapshot?.html ?? "", /review/);
});

test("redacted inputs keep the field but not the typed value", () => {
  const { db, session } = fresh();
  const batch = recordReplayBatch(db, {
    shareSessionId: session.id,
    label: session.label,
    userAgent: session.user_agent,
    input: { tabId: "tab-1", events: [
      { type: "focus", field: "a private field", selector: "#password", redacted: true },
      { type: "input", field: "a private field", selector: "#password", value: "secret", redacted: true },
    ] },
  });
  const events = listReplayEvents(db, batch.replaySession.id);
  assert.equal(events[1].payload.value, "");
  assert.equal(events[1].payload.redacted, true);
  assert.ok(!JSON.stringify(events).includes("secret"));
});

test("events are clamped and batches are bounded", () => {
  const { db, session } = fresh();
  const many = Array.from({ length: 200 }, (_, i) => ({ type: "pointer", x: i, y: -i }));
  const batch = recordReplayBatch(db, {
    shareSessionId: session.id,
    label: session.label,
    userAgent: session.user_agent,
    input: { tabId: "tab-1", events: many },
  });
  assert.equal(batch.events.length, 120);
  assert.deepEqual(batch.events[0].payload, { x: 0, y: 0 });
  assert.deepEqual(batch.events.at(-1)?.payload, { x: 1, y: 0 });
});

test("an audit request can be attached to the replay session and sequence", () => {
  const { db, session } = fresh();
  const batch = recordReplayBatch(db, {
    shareSessionId: session.id,
    label: session.label,
    userAgent: session.user_agent,
    input: { tabId: "tab-1", events: [{ type: "click", x: .5, y: .5 }] },
  });
  const marker = replayMarkerForRequest(db, session.id, batch.replaySession.id, String(batch.live.seq));
  assert.deepEqual(marker, { replaySessionId: batch.replaySession.id, replaySeq: 1 });

  assert.equal(replayMarkerForRequest(db, "someone-else", batch.replaySession.id, "1"), undefined,
    "a replay id from one shared session must not be attached to another");
});

test("old replay sessions are pruned with their events", () => {
  const { db, session } = fresh();
  const batch = recordReplayBatch(db, {
    shareSessionId: session.id,
    label: session.label,
    userAgent: session.user_agent,
    input: { tabId: "tab-1", events: [{ type: "click", x: .5, y: .5 }] },
  });
  db.prepare("UPDATE share_replay_session SET last_at=? WHERE id=?").run(Date.now() - 10_000, batch.replaySession.id);
  assert.equal(pruneOldReplays(db, 1), 1);
  assert.equal(listReplays(db).length, 0);
  assert.equal(listReplayEvents(db, batch.replaySession.id).length, 0);
});
