/**
 * The local HTTP server: JSON API + SSE progress + the static UI.
 *
 * Plain node:http - no framework. The API surface is small enough that a router adds more
 * dependency risk than it removes convenience, and this keeps the install a download.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../context.ts";
import { registerRoutes } from "./routes.ts";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../ui");

export type Handler = (ctx: RouteCtx) => Promise<unknown> | unknown;
export interface RouteCtx {
  req: IncomingMessage; res: ServerResponse; app: AppContext;
  params: Record<string, string>; query: URLSearchParams; body: any;
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

/** Server-sent events, so the UI can show live progress without polling. */
export class EventBus {
  private readonly clients = new Set<ServerResponse>();

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25_000);
    res.on("close", () => { clearInterval(ping); this.clients.delete(res); });
  }

  emit(type: string, data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) { try { c.write(frame); } catch { this.clients.delete(c); } }
  }
}

export function createApp(app: AppContext): Server {
  const router = new Router();
  registerRoutes(router, app);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Local-only tool: refuse anything that did not come from this machine.
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("coldcall only serves localhost");
    }

    if (path === "/api/events") return app.bus.attach(res);

    if (path.startsWith("/api/")) {
      const m = router.match(req.method ?? "GET", path);
      if (!m) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "not found" })); }
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        const out = await m.handler({ req, res, app, params: m.params, query: url.searchParams, body });
        if (res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(out ?? { ok: true }));
      } catch (e) {
        const err = e as any;
        app.log(`API ${path} failed: ${err?.message}`);
        if (res.writableEnded) return;
        res.writeHead(err?.status ?? 500, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          error: err?.message ?? "internal error",
          code: err?.code ?? "INTERNAL",
          raw: typeof err?.raw === "string" ? err.raw.slice(0, 2000) : undefined,
          validationErrors: err?.validationErrors,
        }));
      }
    }

    // Static UI. Everything unknown falls through to index.html (single page app).
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const safe = join(UI_DIR, rel);
    if (!safe.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = await readFile(safe);
      res.writeHead(200, { "content-type": MIME[extname(safe)] ?? "application/octet-stream" });
      return res.end(data);
    } catch {
      try {
        const data = await readFile(join(UI_DIR, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(data);
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
