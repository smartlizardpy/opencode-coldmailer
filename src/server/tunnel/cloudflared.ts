/**
 * The public half of the app: a Cloudflare quick tunnel pointed at the local server.
 *
 * `cloudflared tunnel --url http://127.0.0.1:PORT` opens an outbound connection to Cloudflare
 * and hands back a `*.trycloudflare.com` hostname. Nothing is forwarded into the machine, no
 * port is opened, and the process can be killed to make the URL stop existing - which is why
 * this is the shape chosen over asking someone to port-forward a router.
 *
 * Two things this deliberately does not do:
 *
 *   - It never starts on its own. A local-first tool that quietly acquires a public URL when
 *     you were not looking is a different product from the one described in the README. The
 *     owner presses a button, and the URL dies with the process.
 *   - It never downloads the binary without being asked. `install()` exists and is one click,
 *     but a tool that reaches out and fetches an executable during boot has taken a decision
 *     that is not its to take.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUICK_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const RING_SIZE = 120;

export type TunnelStatus = "stopped" | "not_installed" | "starting" | "ready" | "failed";

function home(): string {
  return process.env.COLDCALL_HOME ?? join(homedir(), ".coldcall");
}

const CANDIDATES = (): string[] => [
  process.env.COLDCALL_CLOUDFLARED_BIN ?? "",
  join(home(), "bin", "cloudflared"),
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
  join(homedir(), ".local/bin/cloudflared"),
].filter(Boolean);

export async function locateCloudflared(): Promise<string | undefined> {
  for (const p of CANDIDATES()) {
    try { await access(p, constants.X_OK); return p; } catch { /* next */ }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { const p = join(dir, "cloudflared"); await access(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return undefined;
}

/** The asset name Cloudflare publishes for this machine, or undefined if there isn't one. */
export function assetName(platform = process.platform, arch = process.arch): string | undefined {
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : arch === "arm" ? "arm" : undefined;
  if (!a) return undefined;
  if (platform === "darwin") return `cloudflared-darwin-${a === "amd64" ? "amd64" : "arm64"}.tgz`;
  if (platform === "linux") return `cloudflared-linux-${a}`;
  if (platform === "win32") return `cloudflared-windows-${a === "arm64" ? "amd64" : a}.exe`;
  return undefined;
}

export const installHint = (): string => {
  if (process.platform === "darwin") return "brew install cloudflared";
  if (process.platform === "win32") return "winget install --id Cloudflare.cloudflared";
  return "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
};

/**
 * Fetch the binary into ~/.coldcall/bin. Only ever called from an explicit click.
 *
 * There is no published per-asset checksum to pin against, so the honest verification is to
 * run the thing and see whether it identifies itself as cloudflared. That catches a truncated
 * download and a captive-portal HTML page, which are the realistic failures; it is not a
 * defence against a compromised release, and the UI says so rather than implying otherwise.
 */
export async function install(log: (m: string) => void = () => {}): Promise<string> {
  const asset = assetName();
  if (!asset) throw new Error(`no cloudflared build for ${process.platform}/${process.arch} — ${installHint()}`);
  if (asset.endsWith(".tgz")) {
    throw new Error(`coldcall can't unpack the macOS build — install it with: ${installHint()}`);
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const dir = join(home(), "bin");
  const dest = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const partial = `${dest}.partial`;

  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error("the download was too small to be cloudflared — check your connection");

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(partial, bytes, { mode: 0o755 });
  await chmod(partial, 0o755);

  const version = await new Promise<string>((resolve, reject) => {
    const p = spawn(partial, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    p.on("error", reject);
    p.on("exit", () => /cloudflared/i.test(out) ? resolve(out.trim().split("\n")[0]) : reject(new Error("the downloaded file does not run as cloudflared")));
  });

  await rename(partial, dest);
  log(`installed ${version} at ${dest}`);
  return dest;
}

export interface TunnelState {
  status: TunnelStatus;
  url?: string;
  hostname?: string;
  startedAt?: number;
  error?: string;
  binPath?: string;
  stderrTail: string[];
}

export class TunnelSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private _status: TunnelStatus = "stopped";
  private _url?: string;
  private _error?: string;
  private _binPath?: string;
  private _startedAt?: number;
  private readonly ring: string[] = [];
  private readonly log: (m: string) => void;
  private readonly onChange: () => void;
  private stopping = false;

  constructor(opts: { log?: (m: string) => void; onChange?: () => void } = {}) {
    this.log = opts.log ?? (() => {});
    this.onChange = opts.onChange ?? (() => {});
  }

  get status(): TunnelStatus { return this._status; }
  get url(): string | undefined { return this._url; }
  /** Host header the tunnel arrives with. The server accepts this and nothing else remote. */
  get hostname(): string | undefined {
    try { return this._url ? new URL(this._url).host : undefined; } catch { return undefined; }
  }

  state(): TunnelState {
    return {
      status: this._status, url: this._url, hostname: this.hostname,
      startedAt: this._startedAt, error: this._error, binPath: this._binPath,
      stderrTail: this.ring.slice(-15),
    };
  }

  private push(line: string): void {
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.shift();
  }

  async start(port: number): Promise<string> {
    if (this._status === "ready" && this._url) return this._url;
    await this.stop();
    this.stopping = false;
    this.ring.length = 0;
    this._error = undefined;

    const bin = await locateCloudflared();
    if (!bin) {
      this._status = "not_installed";
      this.onChange();
      throw Object.assign(new Error("cloudflared is not installed"), { code: "NO_CLOUDFLARED", status: 400 });
    }
    this._binPath = bin;
    this._status = "starting";
    this.onChange();

    const child = spawn(bin, [
      "tunnel", "--no-autoupdate",
      "--url", `http://127.0.0.1:${port}`,
      "--loglevel", "info",
    ], { stdio: ["ignore", "pipe", "pipe"], detached: false });
    this.child = child;

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`cloudflared did not report a URL within 45s\n${this.ring.slice(-8).join("\n")}`)),
          45_000,
        );
        const done = (fn: () => void) => { clearTimeout(timer); fn(); };
        // Both pipes are drained forever: a full pipe buffer blocks the child, and a tunnel
        // that stops relaying halfway through a review session is the worst possible failure.
        const onLine = (line: string) => {
          this.push(line);
          const m = QUICK_URL_RE.exec(line);
          if (m) done(() => resolve(m[0]));
        };
        createInterface({ input: child.stdout }).on("line", onLine);
        createInterface({ input: child.stderr }).on("line", onLine);
        child.on("error", (e) => done(() => reject(e)));
        child.on("exit", (code) => done(() => reject(new Error(`cloudflared exited (code ${code}) before opening a tunnel\n${this.ring.slice(-8).join("\n")}`))));
      });

      this._url = url;
      this._status = "ready";
      this._startedAt = Date.now();
      this.log(`tunnel open at ${url}`);

      // A tunnel that dies quietly leaves the co-founder staring at a dead link and the owner
      // looking at a UI that still says "shared". Surface it instead.
      child.on("exit", (code, signal) => {
        if (this.stopping) return;
        this._status = "failed";
        this._error = `cloudflared exited (code=${code} signal=${signal})`;
        this._url = undefined;
        this.log(`tunnel closed unexpectedly: ${this._error}`);
        this.onChange();
      });

      this.onChange();
      return url;
    } catch (e) {
      this._status = "failed";
      this._error = (e as Error).message;
      this._url = undefined;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      this.onChange();
      throw e;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.child = undefined;
    this._url = undefined;
    this._startedAt = undefined;
    if (this._status !== "not_installed") this._status = "stopped";
    if (!child || child.exitCode !== null) { this.onChange(); return; }
    await new Promise<void>((resolve) => {
      const kill9 = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(kill9); resolve(); });
      try { child.kill("SIGTERM"); } catch { clearTimeout(kill9); resolve(); }
    });
    this.onChange();
  }
}
