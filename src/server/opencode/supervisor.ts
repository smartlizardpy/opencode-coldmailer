/**
 * Spawns and owns a private `opencode serve` child.
 *
 * We always spawn our own rather than attaching to a running server: an existing server carries
 * the USER's config, with tools enabled and permission "*": "allow" on the default build agent.
 * Attaching would silently void the entire sandbox.
 *
 * Verified against opencode v1.14.41:
 *   - `opencode serve` defaults to --port 0 --hostname 127.0.0.1
 *   - it prints `opencode server listening on http://<host>:<port>` to STDOUT
 *   - there is no --dangerously-skip-permissions on `serve` (that flag is `run`-only)
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "./client.ts";
import { assertAllPolicies, configContent, processPermission } from "./policy.ts";

const LISTEN_RE = /opencode server listening on (https?:\/\/[^\s]+)/i;
const RING_SIZE = 200;

export type SupervisorStatus =
  | "stopped" | "not_installed" | "starting" | "ready" | "degraded" | "failed";

export interface SupervisorOptions {
  /** Working dir opencode runs in. Must be empty of AGENTS.md and not a git repo. */
  agentCwd?: string;
  binPath?: string;
  startTimeoutMs?: number;
}

const CANDIDATE_PATHS = [
  join(homedir(), ".opencode/bin/opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  join(homedir(), ".bun/bin/opencode"),
  join(homedir(), ".local/bin/opencode"),
];

export async function locateOpencode(explicit?: string): Promise<string | undefined> {
  const candidates = [
    explicit,
    process.env.COLDCALL_OPENCODE_BIN,
    ...CANDIDATE_PATHS,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  // Fall back to PATH.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "opencode");
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export class OpencodeSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private _status: SupervisorStatus = "stopped";
  private _url?: string;
  private _client?: OpencodeClient;
  private _binPath?: string;
  private readonly ring: string[] = [];
  private readonly password = randomBytes(32).toString("hex");
  private shuttingDown = false;
  private readonly agentCwd: string;
  private readonly opts: SupervisorOptions;

  constructor(opts: SupervisorOptions = {}) {
    this.opts = opts;
    this.agentCwd = opts.agentCwd ?? join(homedir(), ".coldcall/agent-cwd");
  }

  get status(): SupervisorStatus { return this._status; }
  get url(): string | undefined { return this._url; }
  get binPath(): string | undefined { return this._binPath; }
  get client(): OpencodeClient | undefined { return this._client; }
  get stderrTail(): string[] { return [...this.ring]; }

  private push(line: string): void {
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.shift();
  }

  async start(): Promise<void> {
    // Fail loudly before spawning if any shipped policy could resolve the wrong way.
    assertAllPolicies();

    // Never inherit a permissive permission map from the parent environment.
    const inherited = process.env.OPENCODE_PERMISSION;
    if (inherited && inherited.includes("allow")) {
      throw new Error(
        "refusing to start: inherited OPENCODE_PERMISSION contains an allow-rule. " +
          "coldcall always sets this itself.",
      );
    }

    const bin = await locateOpencode(this.opts.binPath);
    if (!bin) {
      this._status = "not_installed";
      throw new Error("opencode binary not found");
    }
    this._binPath = bin;

    await mkdir(this.agentCwd, { recursive: true });

    this._status = "starting";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_PERMISSION: JSON.stringify(processPermission()),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent()),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_SERVER_USERNAME: "coldcall",
      OPENCODE_SERVER_PASSWORD: this.password,
    };
    // Explicitly do NOT enable Exa for non-opencode providers unless the user opted in.
    delete env.OPENCODE_ENABLE_EXA;
    delete env.OPENCODE_EXPERIMENTAL_EXA;

    const child = spawn(
      bin,
      ["serve", "--hostname", "127.0.0.1", "--port", "0", "--pure", "--log-level", "WARN"],
      { stdio: ["ignore", "pipe", "pipe"], detached: false, cwd: this.agentCwd, env },
    );
    this.child = child;

    const url = await new Promise<string>((resolve, reject) => {
      const timeoutMs = this.opts.startTimeoutMs ?? 30_000;
      const timer = setTimeout(
        () => reject(new Error(`opencode did not report a listen address within ${timeoutMs}ms\n${this.ring.join("\n")}`)),
        timeoutMs,
      );
      const done = (fn: () => void) => { clearTimeout(timer); fn(); };

      // Keep draining BOTH pipes forever. If we stop reading, the OS pipe buffer fills at
      // ~64KB and the child blocks on write - a hang that looks exactly like a model timeout.
      createInterface({ input: child.stdout }).on("line", (line) => {
        this.push(`[out] ${line}`);
        const m = LISTEN_RE.exec(line);
        if (m) done(() => resolve(m[1]));
      });
      createInterface({ input: child.stderr }).on("line", (line) => this.push(`[err] ${line}`));

      child.on("error", (err) => done(() => reject(err)));
      child.on("exit", (code, signal) =>
        done(() =>
          reject(new Error(`opencode exited (code=${code} signal=${signal}) before listening\n${this.ring.join("\n")}`)),
        ),
      );
    });

    this._url = url;
    this._client = new OpencodeClient({
      baseUrl: url,
      username: "coldcall",
      password: this.password,
      directory: this.agentCwd,
    });

    const health = await this._client.health();
    if (!health.healthy) {
      this._status = "failed";
      throw new Error(`opencode reported unhealthy: ${JSON.stringify(health)}`);
    }
    this._status = "ready";
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const child = this.child;
    this._status = "stopped";
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const kill9 = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve();
      }, 3_000);
      child.once("exit", () => { clearTimeout(kill9); resolve(); });
      try { child.kill("SIGTERM"); } catch { clearTimeout(kill9); resolve(); }
    });
  }
}
