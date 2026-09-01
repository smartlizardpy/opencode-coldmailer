/** Control is a separate, explicit permission from passive viewing. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  cleanControlCommand, clearControls, controlFor, grantControl, heartbeatControl,
  requestControl, releaseControl,
} from "../../src/server/http/control.ts";

beforeEach(() => clearControls());

test("control starts as a request and only becomes active after an explicit grant", () => {
  const target = { sessionId: "session-1", tabId: "tab-1", replaySessionId: "replay-1" };
  assert.equal(controlFor(target), undefined);
  const requested = requestControl(target)!;
  assert.equal(requested.status, "requested");
  assert.equal(grantControl(target)?.status, "active");
  assert.equal(controlFor(target)?.status, "active");
});

test("control is scoped to one session and tab", () => {
  requestControl({ sessionId: "session-1", tabId: "tab-1" });
  assert.equal(grantControl({ sessionId: "session-1", tabId: "tab-2" }), undefined);
  assert.equal(grantControl({ sessionId: "session-2", tabId: "tab-1" }), undefined);
});

test("only an active grant can heartbeat or release", () => {
  const target = { sessionId: "s", tabId: "t" };
  assert.equal(heartbeatControl(target), undefined);
  requestControl(target);
  assert.equal(heartbeatControl(target), undefined);
  grantControl(target);
  assert.ok(heartbeatControl(target));
  assert.equal(releaseControl(target), true);
  assert.equal(heartbeatControl(target), undefined);
});

test("commands allow safe control ids but no arbitrary selectors or scripts", () => {
  assert.deepEqual(cleanControlCommand({ type: "pointer", x: .5, y: .25 }),
    { type: "pointer", x: .5, y: .25, visible: true });
  assert.deepEqual(cleanControlCommand({ type: "click", controlId: "approve-draft" }),
    { type: "click", controlId: "approve-draft" });
  assert.deepEqual(cleanControlCommand({ type: "type", controlId: "draft-body", value: "hello" }),
    { type: "type", controlId: "draft-body", value: "hello" });
  assert.equal(cleanControlCommand({ type: "click", controlId: "#app button" }), undefined);
  assert.equal(cleanControlCommand({ type: "run", code: "document.body.remove()" }), undefined);
  assert.deepEqual(cleanControlCommand({ type: "navigate", route: "settings" }),
    { type: "navigate", route: "settings" }, "the client applies its shared-route allow-list");
});
