/**
 * The local HTTP server: JSON API + SSE progress + the static UI.
 *
 * Plain node:http - no framework. The API surface is small enough that a router adds more
 * dependency risk than it removes convenience, and this keeps the install a download.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../context.ts";
import { registerRoutes } from "./routes.ts";
import {
  allows, anonymousAllows, readCookie, sessionFor, SESSION_COOKIE,
  type Role, type SessionRow,
} from "./access.ts";
import { describeAction, recordAudit } from "./audit.ts";
import { replayMarkerForRequest } from "./replay.ts";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../ui");

export type Handler = (ctx: RouteCtx) => Promise<unknown> | unknown;
export interface RouteCtx {
  req: IncomingMessage; res: ServerResponse; app: AppContext;
  params: Record<string, string>; query: URLSearchParams; body: any;
  /** "owner" on 127.0.0.1, "sender" through the tunnel. See http/access.ts. */
  role: Role;
  /** True when the request arrived over the shared tunnel rather than the loopback. */
  remote: boolean;
  session?: SessionRow;
}

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  readonly routes: Route[] = [];
  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, pattern, keys, handler });
  }
  get(p: string, h: Handler) { this.add("GET", p, h); }
  post(p: string, h: Handler) { this.add("POST", p, h); }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return undefined;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Server-sent events, so the UI can show live progress without polling.
 *
 * Every client carries the role it connected with. Some events are the owner's business only -
 * `opencode:error` quotes the child process's stderr, `models:changed` names the models this
 * machine is signed in to - and an event stream is the easy place to forget that, because the
 * emit call sites are scattered and none of them look like an API response.
 */
export class EventBus {
  private readonly clients = new Set<{ res: ServerResponse; role: Role; sessionId?: string }>();

  attach(res: ServerResponse, role: Role = "owner", sessionId?: string): void {
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const client = { res, role, sessionId };
    this.clients.add(client);
    // unref: a keepalive ping should never be the only thing keeping the process alive.
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25_000);
    ping.unref?.();
    res.on("close", () => { clearInterval(ping); this.clients.delete(client); });
  }

  emit(type: string, data: unknown, ownerOnly = false, targetSessionId?: string): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (ownerOnly && c.role !== "owner") continue;
      if (targetSessionId && c.sessionId !== targetSessionId) continue;
      try { c.res.write(frame); } catch { this.clients.delete(c); }
    }
  }
}

export function createApp(app: AppContext): Server {
  const router = new Router();
  registerRoutes(router, app);

  const json = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    /* -------------------------------------------------- which surface is this?
       Two are legitimate: the loopback, which is the owner's own machine, and the exact
       hostname the tunnel is currently answering on. Matching the tunnel host exactly is also
       what stops DNS rebinding - a page on another origin that resolves a name to 127.0.0.1
       still has to send a Host header, and neither of these will be it. */
    const host = (req.headers.host ?? "").toLowerCase();
    const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
    const tunnelHost = app.tunnel?.hostname?.toLowerCase();
    const isTunnel = !!tunnelHost && host === tunnelHost;

    if (!isLocal && !isTunnel) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("coldcall only serves localhost, or the shared link while it is open");
    }

    const session = isTunnel ? sessionFor(app.db, readCookie(req.headers.cookie, SESSION_COOKIE)) : undefined;
    const role: Role | null = isLocal ? "owner" : (session?.role ?? null);

    /* CSRF. The session cookie is SameSite=Lax, so a cross-site POST carries no cookie at all
       and this is the second lock rather than the first. It is worth having anyway: Lax is a
       browser promise, and this is a check we make ourselves. */
    if (isTunnel && method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin.toLowerCase() !== `https://${tunnelHost}`) {
        return json(res, 403, { error: "cross-site request refused", code: "BAD_ORIGIN" });
      }
    }

    const authorized = (m: string, p: string): boolean =>
      role === null ? anonymousAllows(m, p) : allows(role, m, p);

    /**
     * One row per state change made over the shared link, written here because here is the one
     * place every such request passes. Refusals are recorded too - a 403 against the settings
     * endpoint is the single most interesting line this log can contain.
     *
     * Never for the owner: this exists to say what a DELEGATED session did, and logging the
     * machine's own user's every click would bury that under noise about themselves.
     */
    const audit = (status: number, body?: unknown, always = false): void => {
      if (!isTunnel) return;
      // Presence is posted several times a second; a row each would drown the log it lives
      // next to. It is live-only state, and the audit trail already records what came of it.
      if (["/api/share/presence", "/api/share/replay", "/api/share/control/heartbeat", "/api/share/control/poll", "/api/share/control/result"]
        .includes(path)) return;
      if (path === "/api/share/control/command" && body?.command?.type === "pointer") return;
      // A refusal is recorded whatever the method. `describeAction` deliberately ignores plain
      // reads, but "they reached for /api/keys" is a GET and is the single most interesting
      // line this log can contain — dropping it because of its verb would be absurd.
      const what = describeAction(app.db, method, path, body)
        ?? (always ? { action: `${method} ${path}`, detail: "", subject: undefined } : undefined);
      if (!what) return;
      /* The join row is the one request that creates the session it should be attributed to,
         so `session` was legitimately undefined when this request arrived. Attribute it to the
         session it just made, or the feed reads "Joined with an invite — not signed in" above a
         column of rows that all know exactly who this is. */
      const joined = !session && status < 400 && path === "/api/share/redeem"
        ? app.db.prepare("SELECT id, label FROM share_session ORDER BY id DESC LIMIT 1").get() as { id: string; label: string } | undefined
        : undefined;
      const replay = session ? replayMarkerForRequest(
        app.db, session.id, req.headers["x-coldcall-replay"], req.headers["x-coldcall-replay-seq"],
      ) : undefined;
      const row = recordAudit(app.db, {
        sessionId: session?.id ?? joined?.id ?? null,
        label: session?.label ?? joined?.label ?? "not signed in",
        method, path, action: what.action, detail: what.detail, subject: what.subject, status, replay,
      });
      if (row) app.bus.emit("share:activity", row, true);
    };

    if (path === "/api/events") {
      if (!role) return json(res, 401, { error: "this link needs an invite", code: "NO_SESSION" });
      return app.bus.attach(res, role, session?.id);
    }

    if (path.startsWith("/api/")) {
      if (!authorized(method, path)) {
        // Worth a row even though nothing happened: someone reaching for the settings endpoint
        // over the shared link is exactly what the owner would want to know about.
        audit(role === null ? 401 : 403, undefined, true);
        return role === null
          ? json(res, 401, { error: "this link needs an invite", code: "NO_SESSION" })
          : json(res, 403, {
              error: "that is only available on the machine running coldcall",
              code: "OWNER_ONLY",
            });
      }
      const m = router.match(method, path);
      if (!m) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "not found" })); }
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        const out = await m.handler({
          req, res, app, params: m.params, query: url.searchParams, body,
          role: role ?? "sender", remote: isTunnel, session,
        });
        audit(200, body);
        if (res.writableEnded) return;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          // API responses are live state and must never be cached. Without this the browser
          // applies heuristic caching to plain GETs and will happily show yesterday's data.
          "cache-control": "no-store",
        });
        // `undefined` means the handler returned nothing, so acknowledge it. `null` is a real
        // answer - "there is no product yet" - and turning it into {ok:true} made the UI
        // believe a product existed on a completely fresh install.
        return res.end(JSON.stringify(out === undefined ? { ok: true } : out));
      } catch (e) {
        const err = e as any;
        app.log(`API ${path} failed: ${err?.message}`);
        audit(err?.status ?? 500, undefined, true);
        if (res.writableEnded) return;
        res.writeHead(err?.status ?? 500, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({
          error: err?.message ?? "internal error",
          code: err?.code ?? "INTERNAL",
          raw: typeof err?.raw === "string" ? err.raw.slice(0, 2000) : undefined,
          validationErrors: err?.validationErrors,
        }));
      }
    }

    // Static UI. Everything unknown falls through to index.html (single page app).
    // index.html gets its asset URLs stamped with the app version, so a browser that cached
    // the previous release's CSS under an older policy cannot show a stale stylesheet.
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const safe = join(UI_DIR, rel);
    if (!safe.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
    // Version assets by mtime, not by app version: editing a file during development changes
    // the URL, and so does shipping a new release. Keying on the app version alone leaves the
    // browser serving a stale stylesheet for every edit within one version.
    const assetVersion = async (file: string): Promise<string> => {
      try {
        const st = await stat(join(UI_DIR, file));
        return `${app.version}-${Math.floor(st.mtimeMs).toString(36)}`;
      } catch { return app.version; }
    };
    const stamp = async (html: Buffer): Promise<string> => {
      const [css, js] = await Promise.all([assetVersion("app.css"), assetVersion("app.js")]);
      return html.toString("utf8").replace(/(href|src)="\/(app\.css|app\.js)"/g,
        (_m, attr, file) => `${attr}="/${file}?v=${encodeURIComponent(file === "app.css" ? css : js)}"`);
    };

    try {
      const data = await readFile(safe);
      res.writeHead(200, {
        "content-type": MIME[extname(safe)] ?? "application/octet-stream",
        // Everything is served from disk on localhost, so revalidating costs nothing and an
        // upgrade never leaves a stale stylesheet behind.
        "cache-control": "no-cache",
      });
      return res.end(extname(safe) === ".html" ? await stamp(data) : data);
    } catch {
      try {
        const data = await readFile(join(UI_DIR, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
        return res.end(await stamp(data));
      } catch {
        res.writeHead(404); return res.end("UI not found");
      }
    }
  });
}

export async function listenOnFreePort(server: Server, preferred = 7788, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = preferred + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => { server.removeListener("listening", onOk); reject(e); };
        const onOk = () => { server.removeListener("error", onErr); resolve(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  // Give up on a tidy port and let the kernel choose.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
