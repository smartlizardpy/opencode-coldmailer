/**
 * The sandbox policy is the one thing in this product that must never silently regress.
 *
 * Verified empirically against opencode v1.14.41 (scripts/verify-sandbox.ts): under this
 * policy the model reports "My available tools are `webfetch` and `websearch` only" and
 * cannot reach bash. These tests lock in the invariants that make that true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS, AGENT_RESEARCH, AGENT_EXTRACT, AGENT_WRITE,
  KNOWN_TOOL_IDS, NON_TOOL_PERMISSION_KEYS, RESEARCH_TOOLS,
  allowedToolsFor, assertAllPolicies, assertPolicyOrder,
  configContent, processPermission, toolsMapFor,
} from "../../src/server/opencode/policy.ts";

test("all shipped policies pass their own assertions", () => {
  assert.doesNotThrow(() => assertAllPolicies());
});

test('"*" is the first key and denies, in every agent', () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    const keys = Object.keys(agent.permission);
    assert.equal(keys[0], "*", `${name}: "*" must be first`);
    assert.equal(agent.permission["*"], "deny", `${name}: "*" must deny`);
  }
});

test("allow-entries come last, because resolution is findLast()", () => {
  const keys = Object.keys(AGENTS[AGENT_RESEARCH].permission);
  assert.deepEqual(keys.slice(-RESEARCH_TOOLS.length), [...RESEARCH_TOOLS]);
});

test("research agent allows exactly websearch + webfetch and nothing else", () => {
  const p = AGENTS[AGENT_RESEARCH].permission;
  const allowed = Object.entries(p).filter(([, v]) => v === "allow").map(([k]) => k);
  assert.deepEqual(allowed.sort(), [...RESEARCH_TOOLS].sort());
  for (const dangerous of ["bash", "write", "edit", "patch", "apply_patch", "read", "task", "skill"]) {
    assert.equal(p[dangerous], "deny", `${dangerous} must be denied`);
  }
});

test("writing agents allow nothing at all", () => {
  for (const name of [AGENT_EXTRACT, AGENT_WRITE]) {
    const p = AGENTS[name].permission;
    assert.equal(Object.values(p).filter((v) => v === "allow").length, 0, `${name} must allow nothing`);
    assert.equal(p.websearch, "deny");
    assert.equal(p.webfetch, "deny");
  }
});

test("external_directory and doom_loop are pinned to deny (they default to ask, which hangs headless)", () => {
  for (const key of NON_TOOL_PERMISSION_KEYS) {
    assert.equal(processPermission()[key], "deny");
    for (const [name, agent] of Object.entries(AGENTS)) {
      assert.equal(agent.permission[key], "deny", `${name}.${key}`);
    }
  }
});

test("every known tool id is named explicitly, not left to the wildcard", () => {
  for (const id of KNOWN_TOOL_IDS) {
    for (const [name, agent] of Object.entries(AGENTS)) {
      assert.ok(id in agent.permission, `${name} is missing an explicit rule for ${id}`);
    }
  }
});

test("tools map is complete, since the per-request map REPLACES session permission", () => {
  for (const policy of ["none", "research"] as const) {
    const m = toolsMapFor(policy);
    assert.equal(m["*"], false);
    assert.equal(Object.keys(m)[0], "*");
    for (const id of KNOWN_TOOL_IDS) assert.ok(id in m, `${policy}: missing ${id}`);
    assert.equal(m.bash, false);
  }
  assert.equal(toolsMapFor("research").websearch, true);
  assert.equal(toolsMapFor("research").webfetch, true);
  assert.equal(toolsMapFor("none").websearch, false);
});

test("allowedToolsFor matches the permission maps (used by the runtime violation check)", () => {
  assert.deepEqual([...allowedToolsFor("research")].sort(), [...RESEARCH_TOOLS].sort());
  assert.equal(allowedToolsFor("none").size, 0);
});

test("policy survives a JSON round-trip with key order intact", () => {
  const rt = JSON.parse(JSON.stringify(configContent()));
  assert.doesNotThrow(() => assertPolicyOrder(rt.permission, "process"));
  for (const [name, agent] of Object.entries(rt.agent as Record<string, { permission: Record<string, string> }>)) {
    assert.doesNotThrow(() => assertPolicyOrder(agent.permission as never, name));
  }
});

test("assertPolicyOrder rejects a map whose deny follows an allow", () => {
  assert.throws(
    () => assertPolicyOrder({ "*": "deny", websearch: "allow", bash: "deny", external_directory: "deny", doom_loop: "deny" }, "bad"),
    /deny.*after.*allow/i,
  );
});

test("assertPolicyOrder rejects a map that does not start with a wildcard deny", () => {
  assert.throws(() => assertPolicyOrder({ bash: "deny", "*": "deny" } as never, "bad"), /must be the first key/);
});
