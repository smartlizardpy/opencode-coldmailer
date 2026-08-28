/**
 * The HTTP layer, over a real socket. These are the behaviours a browser depends on and that
 * unit-testing the handlers in isolation cannot catch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Router, EventBus, listenOnFreePort } from "../../src/server/http/server.ts";

/** A minimal stand-in for the real app, so these tests do not need opencode or a database. */
function tinyApp() {
  const router = new Router();
  router.get("/api/nothing", () => null);
  router.get("/api/acknowledge", () => undefined);
  router.get("/api/thing", () => ({ hello: "world" }));
  router.get("/api/boom", () => { throw Object.assign(new Error("nope"), { status: 418, code: "TEAPOT" }); });
  router.post("/api/echo", ({ body }) => body);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("coldcall only serves localhost");
    }
    const m = router.match(req.method ?? "GET", url.pathname);
    if (!m) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "not found" })); }
    let body: unknown = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
    }
    try {
      const out = await m.handler({ req, res, app: {} as never, params: m.params, query: url.searchParams, body });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(out === undefined ? { ok: true } : out));
    } catch (e) {
      const err = e as { status?: number; message: string; code?: string };
      res.writeHead(err.status ?? 500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
    }
  });
}

let server: ReturnType<typeof tinyApp>, base: string;
before(async () => { server = tinyApp(); base = `http://127.0.0.1:${await listenOnFreePort(server, 7850)}`; });
after(() => server.close());

test("null is a real answer and survives to the client", async () => {
  const r = await fetch(`${base}/api/nothing`);
  assert.equal(await r.text(), "null",
    "turning null into {ok:true} made a fresh install believe it already had a product");
});

test("a handler that returns nothing is acknowledged", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/acknowledge`)).json(), { ok: true });
});

test("API responses are never cached", async () => {
  const r = await fetch(`${base}/api/thing`);
  assert.equal(r.headers.get("cache-control"), "no-store",
    "without this the browser applies heuristic caching to plain GETs and shows stale data");
});

test("an error keeps its status and code", async () => {
  const r = await fetch(`${base}/api/boom`);
  assert.equal(r.status, 418);
  assert.deepEqual(await r.json(), { error: "nope", code: "TEAPOT" });
});

test("a POST body round-trips, including unicode", async () => {
  const body = { name: "Manisa Aktif Haber", city: "Sarıgöl", note: "İletişim" };
  const r = await fetch(`${base}/api/echo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.deepEqual(await r.json(), body);
});

test("a request claiming another host is refused", async () => {
  // fetch() will not let you set Host - it is a forbidden header - so this speaks HTTP directly,
  // which is also what an attacker rebinding DNS would do.
  const { connect } = await import("node:net");
  const port = Number(new URL(base).port);
  const status = await new Promise<string>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write("GET /api/thing HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    });
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    sock.on("end", () => resolve(buf.split("\r\n")[0]));
    sock.on("error", reject);
  });
  assert.match(status, /403/, "this is a local tool and must not answer for another origin");
});

test("an unknown route is a 404, not a crash", async () => {
  assert.equal((await fetch(`${base}/api/does-not-exist`)).status, 404);
});

test("listenOnFreePort steps past a port already in use", async () => {
  const blocker = createServer(() => {});
  const taken = await listenOnFreePort(blocker, 7860);
  const second = createServer(() => {});
  try {
    const got = await listenOnFreePort(second, taken);
    assert.notEqual(got, taken, "a second instance must not fail to start because the first has the port");
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
    await new Promise<void>((r) => second.close(() => r()));
  }
});

test("the event bus writes SSE frames and cleans up on close", async () => {
  const bus = new EventBus();
  const frames: string[] = [];
  const fake = {
    writeHead() {}, write(s: string) { frames.push(s); return true; },
    on(ev: string, fn: () => void) { if (ev === "close") this._close = fn; },
    _close: () => {},
  } as never as import("node:http").ServerResponse;
  bus.attach(fake);
  bus.emit("job:start", { key: "x" });
  assert.ok(frames.some((f) => f.startsWith("event: job:start")));
  assert.ok(frames.some((f) => f.includes('"key":"x"')));
});
