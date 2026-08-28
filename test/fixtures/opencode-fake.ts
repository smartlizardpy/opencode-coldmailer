/**
 * A scriptable stand-in for `opencode serve`.
 *
 * Models the one structural detail that matters: an agentic turn produces SEVERAL assistant
 * messages, and POST /session/:id/message returns only the LAST. Tool parts live in earlier
 * messages. A fake that returned everything from POST would let broken code pass.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedTurn {
  /** Assistant text of the final message. */
  text?: string;
  /** Tool calls, emitted as a separate earlier assistant message. */
  tools?: Array<{ tool: string; status?: "completed" | "error"; input?: unknown; output?: string; error?: string }>;
  /** Respond with this HTTP status instead. */
  status?: number;
  /** Delay before responding, ms. */
  delayMs?: number;
  /** Never respond (to exercise client timeouts). */
  hang?: boolean;
}

export interface FakeOptions {
  providers?: { providers: Array<{ id: string; models: Record<string, unknown> }>; default: Record<string, string> };
  healthy?: boolean;
}

export class FakeOpencode {
  private server?: Server;
  private port = 0;
  /** Turns are consumed in order, globally. The last one repeats if the script runs out. */
  script: ScriptedTurn[] = [];
  /** Every prompt body received, for assertions. */
  readonly received: Array<{ sessionId: string; body: any }> = [];
  readonly sessions = new Map<string, any[]>();
  deletedSessions: string[] = [];
  abortedSessions: string[] = [];
  private turnIndex = 0;
  private opts: FakeOptions;

  constructor(opts: FakeOptions = {}) { this.opts = opts; }

  get url(): string { return `http://127.0.0.1:${this.port}`; }
  get promptCount(): number { return this.received.length; }

  nextTurn(): ScriptedTurn {
    const t = this.script[Math.min(this.turnIndex, this.script.length - 1)] ?? { text: "" };
    this.turnIndex++;
    return t;
  }
  reset(script: ScriptedTurn[] = []): void {
    this.script = script; this.turnIndex = 0;
    this.received.length = 0; this.sessions.clear();
    this.deletedSessions = []; this.abortedSessions = [];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };

        if (path === "/global/health") return send(200, { healthy: this.opts.healthy ?? true, version: "fake-1.14.41" });
        if (path === "/config/providers") {
          return send(200, this.opts.providers ?? {
            providers: [{ id: "opencode", models: { "big-pickle": {}, "hy3-free": {} } },
                        { id: "openai", models: { "gpt-5.6-terra-pro": {} } }],
            default: { opencode: "big-pickle", openai: "gpt-5.6-terra-pro" },
          });
        }
        if (path === "/experimental/tool/ids") return send(200, ["bash", "webfetch", "websearch", "read", "write"]);

        if (path === "/session" && req.method === "POST") {
          const id = `ses_${Math.random().toString(36).slice(2, 10)}`;
          this.sessions.set(id, []);
          return send(200, { id });
        }

        const m = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
        if (m) {
          const id = decodeURIComponent(m[1]);
          const sub = m[2] ?? "";
          if (req.method === "DELETE" && !sub) { this.deletedSessions.push(id); this.sessions.delete(id); return send(200, {}); }
          if (sub === "/abort") { this.abortedSessions.push(id); return send(200, {}); }

          if (sub === "/message" && req.method === "GET") {
            return send(200, this.sessions.get(id) ?? []);
          }

          if (sub === "/message" && req.method === "POST") {
            const parsed = JSON.parse(body || "{}");
            this.received.push({ sessionId: id, body: parsed });
            const turn = this.nextTurn();

            if (turn.hang) return;                       // deliberately never respond
            if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
            if (turn.status && turn.status >= 400) {
              return send(turn.status, { error: `scripted status ${turn.status}` });
            }

            const history = this.sessions.get(id) ?? [];
            history.push({ info: { role: "user", id: `msg_u${history.length}` },
                           parts: (parsed.parts ?? []).map((p: any) => ({ type: "text", text: p.text })) });

            // Tool calls go in their OWN earlier assistant message - as real opencode does.
            if (turn.tools?.length) {
              history.push({
                info: { role: "assistant", id: `msg_a${history.length}` },
                parts: [
                  { type: "step-start" },
                  ...turn.tools.map((t, i) => ({
                    type: "tool", tool: t.tool, callID: `call_${i}`,
                    state: { status: t.status ?? "completed", input: t.input ?? {}, output: t.output ?? "", error: t.error },
                  })),
                  { type: "step-finish" },
                ],
              });
            }

            const finalMsg = {
              info: { role: "assistant", id: `msg_a${history.length}` },
              parts: [{ type: "step-start" }, { type: "text", text: turn.text ?? "" }, { type: "step-finish" }],
            };
            history.push(finalMsg);
            this.sessions.set(id, history);
            return send(200, finalMsg);
          }
        }
        send(404, { error: "not found" });
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
