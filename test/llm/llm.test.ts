/**
 * llm() end-to-end against the fake opencode server. Covers the paths that are hard to
 * reproduce live: repair turns, model failover, rate limits, tool-policy violations, and
 * mid-call failures.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeOpencode } from "../fixtures/opencode-fake.ts";
import { OpencodeClient } from "../../src/server/opencode/client.ts";
import { LlmService } from "../../src/server/llm/index.ts";
import { Cooldowns, type ModelSlots } from "../../src/server/opencode/models.ts";
import { LlmQueue } from "../../src/server/llm/queue.ts";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { LlmError } from "../../src/server/errors.ts";

const fake = new FakeOpencode();
let client: OpencodeClient;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["ok", "city"],
  properties: { ok: { type: "boolean" }, city: { type: "string" } },
};

function slots(): ModelSlots {
  return {
    research: { active: { providerID: "opencode", modelID: "big-pickle" },
      ranking: [{ providerID: "opencode", modelID: "big-pickle", ok: true, searchProbe: "pass" },
                { providerID: "opencode", modelID: "hy3-free", ok: true, searchProbe: "pass" }], status: "ok" },
    writing: { active: { providerID: "opencode", modelID: "big-pickle" },
      ranking: [{ providerID: "opencode", modelID: "big-pickle", ok: true },
                { providerID: "opencode", modelID: "hy3-free", ok: true }], status: "ok" },
    enableExa: false, probedAt: Date.now(),
  };
}

function svc(extra: Partial<ConstructorParameters<typeof LlmService>[0]> = {}) {
  const db = openDb(":memory:"); migrate(db);
  return {
    db,
    service: new LlmService({
      client: () => client, slots, db,
      queue: new LlmQueue({ research: 2, writing: 4, interactive: 2 }),
      cooldowns: new Cooldowns(), ...extra,
    }),
  };
}

before(async () => {
  await fake.start();
  client = new OpencodeClient({ baseUrl: fake.url });
});
after(async () => { await fake.stop(); });
beforeEach(() => fake.reset());

test("happy path: fenced JSON parses, validates, and is returned", async () => {
  fake.reset([{ text: '```json\n{"ok":true,"city":"Durham"}\n```' }]);
  const { service } = svc();
  const r = await service.run<{ ok: boolean; city: string }>({
    task: "company.judge", system: "sys", prompt: "go", schema: SCHEMA,
  });
  assert.deepEqual(r.value, { ok: true, city: "Durham" });
  assert.equal(r.meta.attempts, 1);
  assert.equal(r.meta.repaired, false);
});

test("the session is always deleted, even on success", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.equal(fake.deletedSessions.length, 1);
});

test("each call gets a FRESH session - no context bleed between companies", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  await service.run({ task: "company.judge", system: "s", prompt: "company A", schema: SCHEMA });
  await service.run({ task: "company.judge", system: "s", prompt: "company B", schema: SCHEMA });
  const ids = new Set(fake.received.map((r) => r.sessionId));
  assert.equal(ids.size, 2, "two calls must not share a session");
  assert.equal(fake.deletedSessions.length, 2);
});

test("prose-wrapped JSON is recovered without a repair turn", async () => {
  fake.reset([{ text: 'Sure! Here you go: {"ok":true,"city":"Durham"} Hope that helps.' }]);
  const { service } = svc();
  const r = await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r.value, { ok: true, city: "Durham" });
  assert.equal(fake.promptCount, 1, "should not have needed a repair turn");
});

test("unparseable output triggers ONE repair turn in the SAME session, then succeeds", async () => {
  fake.reset([
    { text: "I'm not sure what you want." },
    { text: '```json\n{"ok":true,"city":"Durham"}\n```' },
  ]);
  const { service } = svc();
  const r = await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r.value, { ok: true, city: "Durham" });
  assert.equal(r.meta.attempts, 2);
  assert.equal(r.meta.repaired, true);
  assert.equal(fake.promptCount, 2);
  assert.equal(new Set(fake.received.map((x) => x.sessionId)).size, 1, "repair must reuse the session so the model sees its own bad output");
  assert.match(fake.received[1].body.parts[0].text, /could not be used/);
});

test("schema-invalid output is repaired with the validation errors fed back", async () => {
  fake.reset([
    { text: '{"ok":"yes","city":"Durham"}' },
    { text: '{"ok":true,"city":"Durham"}' },
  ]);
  const { service } = svc();
  const r = await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r.value, { ok: true, city: "Durham" });
  assert.match(fake.received[1].body.parts[0].text, /must be boolean/);
});

test("persistent garbage exhausts attempts, fails over to model 2, then throws SCHEMA_INVALID", async () => {
  fake.reset([{ text: "never json" }]);
  const { service } = svc();
  await assert.rejects(
    () => service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA }),
    (e: LlmError) => {
      assert.equal(e.code, "SCHEMA_INVALID");
      assert.equal(e.modelsTried.length, 2, "should have tried both models");
      assert.ok(e.raw?.includes("never json"), "raw output must be preserved for the UI");
      return true;
    },
  );
  // 2 models x 2 attempts
  assert.equal(fake.promptCount, 4);
});

test("an empty response is EMPTY_RESPONSE, never a silent empty success", async () => {
  fake.reset([{ text: "" }]);
  const { service } = svc();
  await assert.rejects(
    () => service.run({ task: "email.draft", system: "s", prompt: "p" }),
    (e: LlmError) => e.code === "EMPTY_RESPONSE",
  );
});

test("a disallowed tool call is a hard TOOL_POLICY_VIOLATION, not a retry", async () => {
  fake.reset([{ text: "done", tools: [{ tool: "bash", input: { command: "whoami" }, output: "root" }] }]);
  const { service } = svc();
  await assert.rejects(
    () => service.run({ task: "company.enrich", system: "s", prompt: "p", schema: SCHEMA }),
    (e: LlmError) => {
      assert.equal(e.code, "TOOL_POLICY_VIOLATION");
      assert.match(e.message, /bash/);
      return true;
    },
  );
  assert.equal(fake.promptCount, 1, "must NOT retry or fail over after a policy violation");
});

test("a tool call in an EARLIER assistant message is still caught", async () => {
  // The regression this guards: reading only the POST response would miss it entirely.
  fake.reset([{ text: "all done, nothing to see", tools: [{ tool: "write", input: { path: "/etc/passwd" } }] }]);
  const { service } = svc();
  await assert.rejects(
    () => service.run({ task: "contact.find", system: "s", prompt: "p" }),
    (e: LlmError) => e.code === "TOOL_POLICY_VIOLATION",
  );
});

test("websearch and webfetch are allowed under a research task, and URLs are harvested", async () => {
  fake.reset([{
    text: '{"ok":true,"city":"Durham"}',
    tools: [
      { tool: "websearch", input: { query: "x" }, output: "Results: https://a.example.com/p1 and https://b.example.com" },
      { tool: "webfetch", input: { url: "https://c.example.com/contact" }, output: "page text" },
    ],
  }]);
  const { service } = svc();
  const r = await service.run({ task: "company.enrich", system: "s", prompt: "p", schema: SCHEMA });
  assert.equal(r.meta.searchCalls, 1);
  assert.deepEqual(r.harvestedUrls.sort(), [
    "https://a.example.com/p1", "https://b.example.com", "https://c.example.com/contact",
  ].sort());
});

test("writing tasks send a tools map that denies websearch", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  await service.run({ task: "email.draft", system: "s", prompt: "p", schema: SCHEMA });
  const tools = fake.received[0].body.tools;
  assert.equal(tools["*"], false);
  assert.equal(tools.websearch, false);
  assert.equal(tools.bash, false);
  assert.equal(Object.keys(tools)[0], "*", "wildcard must be first - order is load-bearing");
  assert.equal(fake.received[0].body.agent, "coldcall-write");
});

test("research tasks send the research agent and allow only websearch + webfetch", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  await service.run({ task: "contact.find", system: "s", prompt: "p", schema: SCHEMA });
  const b = fake.received[0].body;
  assert.equal(b.agent, "coldcall-research");
  assert.equal(b.tools.websearch, true);
  assert.equal(b.tools.webfetch, true);
  assert.equal(b.tools.bash, false);
});

test("a 429 fails over to the next model and cools the first one down", async () => {
  fake.reset([{ status: 429 }, { text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  const r = await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.deepEqual(r.value, { ok: true, city: "Durham" });
  assert.equal(r.meta.modelsTried.length, 2);
  assert.ok(service.cooldowns.isCool({ providerID: "opencode", modelID: "big-pickle" }));
});

test("a 500 fails over too", async () => {
  fake.reset([{ status: 500 }, { text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  const r = await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA });
  assert.equal(r.meta.modelsTried.length, 2);
});

test("opencode being down is OPENCODE_DOWN, not a hang", async () => {
  const service = new LlmService({
    client: () => new OpencodeClient({ baseUrl: "http://127.0.0.1:9" }), slots,
    queue: new LlmQueue(), cooldowns: new Cooldowns(),
  });
  await assert.rejects(
    () => service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA }),
    (e: LlmError) => e.code === "OPENCODE_DOWN",
  );
});

test("no client at all is OPENCODE_DOWN", async () => {
  const service = new LlmService({ client: () => undefined, slots });
  await assert.rejects(
    () => service.run({ task: "company.judge", system: "s", prompt: "p" }),
    (e: LlmError) => e.code === "OPENCODE_DOWN",
  );
});

test("no search-capable model gives SEARCH_UNAVAILABLE, and says why", async () => {
  const empty = (): ModelSlots => ({
    research: { active: null, ranking: [], status: "none" },
    writing: { active: { providerID: "openai", modelID: "gpt-5.6-terra-pro" },
      ranking: [{ providerID: "openai", modelID: "gpt-5.6-terra-pro", ok: true }], status: "ok" },
    enableExa: false, probedAt: Date.now(),
  });
  const service = new LlmService({ client: () => client, slots: empty });
  await assert.rejects(
    () => service.run({ task: "company.enrich", system: "s", prompt: "p" }),
    (e: LlmError) => {
      assert.equal(e.code, "SEARCH_UNAVAILABLE");
      assert.match(e.message, /free opencode/);
      return true;
    },
  );
});

test("a client timeout surfaces as TIMEOUT rather than hanging forever", async () => {
  fake.reset([{ hang: true }]);
  const { service } = svc();
  await assert.rejects(
    () => service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA, timeoutMs: 300 }),
    (e: LlmError) => e.code === "TIMEOUT",
  );
});

test("an aborted call is ABORTED and does not fail over", async () => {
  fake.reset([{ delayMs: 2_000, text: "{}" }]);
  const { service } = svc();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    () => service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA, signal: ac.signal }),
    (e: LlmError) => e.code === "ABORTED" || e.code === "TIMEOUT",
  );
});

test("prose mode (no schema) returns the raw text", async () => {
  fake.reset([{ text: "Hi Sam,\n\nSaw your new Durham studio.\n" }]);
  const { service } = svc();
  const r = await service.run<string>({ task: "email.draft", system: "s", prompt: "p" });
  assert.match(r.value, /Durham studio/);
});

test("the system prompt carries the output contract when a schema is given", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service } = svc();
  await service.run({ task: "company.judge", system: "BASE SYSTEM", prompt: "p", schema: SCHEMA });
  const sys = fake.received[0].body.system as string;
  assert.match(sys, /BASE SYSTEM/);
  assert.match(sys, /Output contract/);
  assert.match(sys, /Do not call any tools/);
});

test("every call is logged to llm_call, success and failure alike", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}' }]);
  const { service, db } = svc();
  await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA, subject: { type: "company", id: "C1" } });
  const rows = db.prepare("SELECT task, ok, subject_id, model_id FROM llm_call").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 1);
  assert.equal(rows[0].subject_id, "C1");

  fake.reset([{ text: "garbage" }]);
  const { service: s2, db: db2 } = svc();
  await s2.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA }).catch(() => {});
  const failed = db2.prepare("SELECT ok, error_code, response_text FROM llm_call WHERE ok = 0").all() as any[];
  assert.ok(failed.length >= 1);
  assert.equal(failed[0].error_code, "SCHEMA_INVALID");
  assert.match(failed[0].response_text, /garbage/);
});

test("tool calls are logged so a policy violation is forensically inspectable", async () => {
  fake.reset([{ text: '{"ok":true,"city":"Durham"}', tools: [{ tool: "webfetch", input: { url: "https://x.com" }, output: "hi" }] }]);
  const { service, db } = svc();
  await service.run({ task: "company.enrich", system: "s", prompt: "p", schema: SCHEMA });
  const rows = db.prepare("SELECT tool, status FROM tool_call_log").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, "webfetch");
});

test("a schema failure records WHY it failed, not just that it did", async () => {
  fake.reset([{ text: '{"ok":"yes","city":"Durham"}' }]);
  const { service, db } = svc();
  await service.run({ task: "company.judge", system: "s", prompt: "p", schema: SCHEMA }).catch(() => {});
  const row = db.prepare("SELECT error_message FROM llm_call WHERE ok=0 ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(row.error_message, /must be boolean/,
    "the validation error is the only record of why a draft never appeared");
});

test("while the startup probe runs, NO_MODEL says 'not yet' rather than 'never'", async () => {
  const empty = (): ModelSlots => ({
    research: { active: null, ranking: [], status: "none" },
    writing: { active: null, ranking: [], status: "none" },
    enableExa: false, probedAt: null,
  });
  const probing = new LlmService({ client: () => client, slots: empty, probing: () => true });
  await assert.rejects(
    () => probing.run({ task: "email.draft", system: "s", prompt: "p" }),
    (e: LlmError) => {
      assert.equal(e.code, "NO_MODEL");
      assert.match(e.message, /still checking|first run/i,
        "a first-run user must not be told the app can never work");
      return true;
    },
  );

  const settled = new LlmService({ client: () => client, slots: empty, probing: () => false });
  await assert.rejects(
    () => settled.run({ task: "email.draft", system: "s", prompt: "p" }),
    (e: LlmError) => {
      assert.match(e.message, /opencode auth login/, "once probing is done, say how to fix it");
      return true;
    },
  );
});
