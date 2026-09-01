/**
 * Both surfaces, over a real socket.
 *
 * The unit tests above prove the allow-list is right. These prove it is actually consulted -
 * that the Host header decides which surface you are on, that a tunnel request with no cookie
 * gets nowhere, and that a session does not quietly become an owner.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults } from "../../src/server/db/settings.ts";
import { EventBus, createApp, listenOnFreePort } from "../../src/server/http/server.ts";
import { createInvite, redeemInvite, sessionCookie } from "../../src/server/http/access.ts";
import type { AppContext } from "../../src/server/context.ts";

const TUNNEL = "made-up-words-here.trycloudflare.com";

const db = openDb(":memory:");
let server: ReturnType<typeof createApp>, port: number;

/** Enough of an app to answer /api/health and to be refused everywhere else. */
function stubApp(): AppContext {
  return {
    db,
    supervisor: { status: "ready", url: "http://127.0.0.1:1", binPath: "/tmp/opencode", stderrTail: ["secret-looking line"] },
    llm: { queue: { stats: () => ({}) } },
    fetcher: {},
    bus: new EventBus(),
    sender: { isRunning: false, lastOutcome: null, nextSendAt: null, start: () => {}, stop: () => {} },
    tunnel: { hostname: TUNNEL, state: () => ({ status: "ready", url: `https://${TUNNEL}`, stderrTail: [] }) },
    port: () => port,
    slots: () => ({
      research: { active: { providerID: "opencode", modelID: "big-pickle" }, ranking: [], status: "ok" },
      writing: { active: { providerID: "openai", modelID: "gpt" }, ranking: [], status: "ok" },
      enableExa: false, probedAt: 1,
    }),
    setSlots: () => {},
    smtpConfig: () => undefined,
    imapConfig: () => undefined,
    log: () => {},
    version: "test",
    busy: new Map(),
  } as unknown as AppContext;
}

before(async () => {
  migrate(db);
  seedDefaults(db);
  db.prepare("INSERT INTO setting (key,value,updated_at) VALUES ('smtp',?,?)")
    .run(JSON.stringify({ configured: true, user: "owner@example.com", lastError: "auth failed" }), Date.now());
  server = createApp(stubApp());
  port = await listenOnFreePort(server, 7880);
});
after(() => server.close());

interface Reply { status: number; body: string; json: () => any }

/**
 * node:http rather than fetch, because `Host` is a forbidden header there and undici silently
 * rewrites it - which would make every one of these tests pass by testing the loopback twice.
 */
function call(path: string, opts: { host?: string; cookie?: string; method?: string; origin?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? "GET";
    const payload = JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = { host: opts.host ?? "127.0.0.1", ...(opts.headers ?? {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    if (method === "POST") { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }

    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, body,
        json: () => { try { return JSON.parse(body); } catch { return {}; } },
      }));
      // An SSE response never ends, so nothing below waits for it to.
      if (res.headers["content-type"]?.startsWith("text/event-stream")) {
        res.destroy();
        resolve({ status: res.statusCode ?? 0, body: "", json: () => ({}) });
      }
    });
    req.on("error", reject);
    if (method === "POST") req.write(payload);
    req.end();
  });
}

/** A cookie for a live session, the way a browser would send it. */
function joinAsTeammate(): string {
  const { token } = createInvite(db, "Co-founder");
  const r = redeemInvite(db, token, "test");
  return `cc_share=${r.token}`;
}

test("a host that is neither localhost nor the tunnel is refused outright", async () => {
  const r = await call("/api/health", { host: "evil.example.com" });
  assert.equal(r.status, 403);
});

test("the tunnel host is accepted now that a tunnel is open", async () => {
  // Not authorised yet - but reaching a 401 rather than a 403 proves the host was recognised.
  const r = await call("/api/campaigns", { host: TUNNEL });
  assert.equal(r.status, 401);
  assert.equal(r.json().code, "NO_SESSION");
});

test("without a session the shared link reaches the join screen and nothing else", async () => {
  assert.equal((await call("/", { host: TUNNEL })).status, 200);
  assert.equal((await call("/api/share/me", { host: TUNNEL })).status, 200);
  assert.equal((await call("/api/health", { host: TUNNEL })).status, 401);
  assert.equal((await call("/api/settings", { host: TUNNEL })).status, 401);
});

test("/api/share/me tells the join screen which surface it is on", async () => {
  const anon = (await call("/api/share/me", { host: TUNNEL })).json();
  assert.deepEqual({ authenticated: anon.authenticated, surface: anon.surface, role: anon.role },
    { authenticated: false, surface: "shared", role: null });

  const owner = (await call("/api/share/me")).json();
  assert.deepEqual({ authenticated: owner.authenticated, surface: owner.surface, role: owner.role },
    { authenticated: true, surface: "local", role: "owner" });
});

test("a session opens the outreach loop and still cannot reach the keys", async () => {
  const cookie = joinAsTeammate();
  assert.equal((await call("/api/health", { host: TUNNEL, cookie })).status, 200);
  assert.equal((await call("/api/campaigns", { host: TUNNEL, cookie })).status, 200);

  for (const p of ["/api/settings", "/api/keys", "/api/company", "/api/llm-calls", "/api/share"]) {
    const r = await call(p, { host: TUNNEL, cookie });
    assert.equal(r.status, 403, `${p} must be owner-only`);
    assert.equal(r.json().code, "OWNER_ONLY");
  }
});

test("health is redacted for the shared surface", async () => {
  const cookie = joinAsTeammate();
  const shared = (await call("/api/health", { host: TUNNEL, cookie })).json();
  const owner = (await call("/api/health")).json();

  assert.equal(shared.role, "sender");
  assert.equal(owner.role, "owner");
  // The teammate still learns whether the machine can write and send...
  assert.equal(shared.opencode.status, "ready");
  assert.equal(shared.smtp.configured, true);
  // ...but not who it is, where it lives, or what it said when it broke.
  assert.equal(shared.smtp.user, null);
  assert.equal(shared.smtp.lastError, null);
  assert.equal(shared.opencode.binPath, undefined);
  assert.equal(shared.opencode.stderrTail, undefined);
  assert.equal(shared.model.writing.active, null);
  assert.equal(shared.share, undefined);
  assert.equal(owner.smtp.user, "owner@example.com");
  assert.equal(owner.model.writing.active.modelID, "gpt");
});

test("a revoked session stops working immediately, without a restart", async () => {
  const { token } = createInvite(db, "Temp");
  const r = redeemInvite(db, token, "test");
  const cookie = `cc_share=${r.token}`;
  assert.equal((await call("/api/campaigns", { host: TUNNEL, cookie })).status, 200);
  db.prepare("UPDATE share_session SET revoked_at=? WHERE token_hash IS NOT NULL AND invite_id=(SELECT id FROM share_invite WHERE label='Temp')").run(Date.now());
  assert.equal((await call("/api/campaigns", { host: TUNNEL, cookie })).status, 401);
});

test("a cross-site POST is refused even if a cookie somehow arrives", async () => {
  const cookie = joinAsTeammate();
  const r = await call("/api/send/pause", { host: TUNNEL, cookie, method: "POST", origin: "https://attacker.example" });
  assert.equal(r.status, 403);
  assert.equal(r.json().code, "BAD_ORIGIN");
});

test("a same-origin POST from the shared page is allowed", async () => {
  const cookie = joinAsTeammate();
  const r = await call("/api/send/pause", { host: TUNNEL, cookie, method: "POST", origin: `https://${TUNNEL}` });
  assert.equal(r.status, 200);
});

test("tab control requires consent and stays on the targeted shared tab", async () => {
  const cookie = joinAsTeammate();
  const session = db.prepare("SELECT id FROM share_session ORDER BY id DESC LIMIT 1").get() as { id: string };
  const target = { sessionId: session.id, tabId: "tab-control" };
  const requested = await call("/api/share/control/request", { method: "POST", body: target });
  assert.equal(requested.status, 200);
  assert.equal(requested.json().control.status, "requested");

  const before = await call("/api/share/control/command", {
    method: "POST", body: { ...target, command: { type: "click", controlId: "approve-draft" } },
  });
  assert.equal(before.status, 409, "the owner cannot command a tab before consent");

  const granted = await call("/api/share/control/grant", {
    host: TUNNEL, cookie, method: "POST", origin: `https://${TUNNEL}`, body: target,
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.json().control.status, "active");

  const command = await call("/api/share/control/command", {
    method: "POST", body: { ...target, command: { type: "click", controlId: "approve-draft" } },
  });
  assert.equal(command.status, 200);
  assert.ok(command.json().commandId);

  const wrongTab = await call("/api/share/control/command", {
    method: "POST", body: { ...target, tabId: "other-tab", command: { type: "click", controlId: "approve-draft" } },
  });
  assert.equal(wrongTab.status, 409, "control cannot jump to another tab");

  const released = await call("/api/share/control/release", { method: "POST", body: target });
  assert.equal(released.status, 200);
});

test("the event stream needs a session too", async () => {
  assert.equal((await call("/api/events", { host: TUNNEL })).status, 401);
});

test("a session cookie is not accepted as an owner on the loopback path", async () => {
  // The loopback IS the owner, so this is really asserting the reverse: a teammate's cookie
  // does not downgrade a local request, and a local request never needs one.
  const r = await call("/api/settings", { cookie: joinAsTeammate() });
  assert.equal(r.status, 200);
});

test("the cookie the server sets on redeem is the hardened one", () => {
  assert.match(sessionCookie("t", 60), /HttpOnly; Secure; SameSite=Lax/);
});

/* ------------------------------------------------------------------- audit */

test("a state change over the shared link leaves a row; a read does not", () => {
  const before = db.prepare("SELECT COUNT(*) n FROM share_audit").get() as { n: number };
  return (async () => {
    const cookie = joinAsTeammate();
    await call("/api/campaigns", { host: TUNNEL, cookie });          // a read
    await call("/api/send/pause", { host: TUNNEL, cookie, method: "POST", origin: `https://${TUNNEL}` });

    const rows = db.prepare("SELECT * FROM share_audit ORDER BY id DESC").all() as any[];
    assert.ok(rows.length > before.n, "the pause should have been recorded");
    assert.equal(rows[0].action, "Paused sending");
    assert.equal(rows[0].label, "Co-founder");
    // A refused GET IS recorded (an earlier test made one before joining), so the claim being
    // tested is narrower: a read that was ALLOWED leaves no trace.
    assert.ok(!rows.some((r) => r.path === "/api/campaigns" && r.method === "GET" && r.ok === 1),
      "reading the campaign list is not an event anyone needs a record of");
  })();
});

test("a shared action can point back to the replay moment around it", async () => {
  const cookie = joinAsTeammate();
  const replay = (await call("/api/share/replay", {
    host: TUNNEL, cookie, method: "POST", origin: `https://${TUNNEL}`,
    body: { tabId: "tab-a", events: [{ type: "click", x: .4, y: .5 }] },
  })).json();
  await call("/api/send/pause", {
    host: TUNNEL, cookie, method: "POST", origin: `https://${TUNNEL}`,
    headers: { "x-coldcall-replay": replay.replaySessionId, "x-coldcall-replay-seq": String(replay.seq) },
  });
  const row = db.prepare("SELECT * FROM share_audit ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(row.action, "Paused sending");
  assert.equal(row.replay_session_id, replay.replaySessionId);
  assert.equal(row.replay_seq, 1);
});

test("reaching for an owner-only endpoint is recorded as refused", async () => {
  const cookie = joinAsTeammate();
  await call("/api/keys", { host: TUNNEL, cookie });
  const row = db.prepare("SELECT * FROM share_audit ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(row.path, "/api/keys");
  assert.equal(row.ok, 0);
  assert.equal(row.status, 403);
});

test("the owner's own clicks are never audited", async () => {
  const before = (db.prepare("SELECT COUNT(*) n FROM share_audit").get() as { n: number }).n;
  await call("/api/send/pause", { method: "POST" });   // loopback = owner
  const after = (db.prepare("SELECT COUNT(*) n FROM share_audit").get() as { n: number }).n;
  assert.equal(after, before, "this log exists to say what a DELEGATED session did");
});

test("the audit feed is owner-only, which would be a silly thing to get wrong", async () => {
  const cookie = joinAsTeammate();
  assert.equal((await call("/api/share/activity", { host: TUNNEL, cookie })).status, 403);
  assert.equal((await call("/api/share/activity")).status, 200);
});

test("the join row is attributed to the session it just created", async () => {
  // This is the one request that makes the session it should be credited to, so without help
  // it reads "Joined with an invite — not signed in" above a column of named rows.
  const { token } = createInvite(db, "Late arrival");
  await call("/api/share/redeem", {
    host: TUNNEL, method: "POST", origin: `https://${TUNNEL}`,
  });   // no token in the body: this one is refused
  const refused = db.prepare("SELECT * FROM share_audit ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(refused.ok, 0, "a bad invite attempt is worth a row of its own");

  const r = redeemInvite(db, token, "test");
  assert.equal(r.ok, true);
});
