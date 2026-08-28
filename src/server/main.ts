/**
 * coldcall entry point.
 *
 * Boot order matters: database, then the HTTP server and the browser, and only THEN opencode.
 * Everything that can fail happens after the UI is visible, so a failure renders as a banner
 * with a fix button instead of a stack trace in a terminal the user may never look at.
 */
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openDb } from "./db/index.ts";
import { migrate, recoverAfterCrash, schemaVersion } from "./db/migrate.ts";
import { seedDefaults, getSetting, setSetting } from "./db/settings.ts";
import { OpencodeSupervisor } from "./opencode/supervisor.ts";
import { LlmService } from "./llm/index.ts";
import { probeModels, type ModelSlots } from "./opencode/models.ts";
import { Fetcher } from "./research/fetcher.ts";
import { EventBus, createApp, listenOnFreePort } from "./http/server.ts";
import { SendRunner } from "./queue/sendQueue.ts";
import { coldcallHome, readImapConfig, readSmtpConfig, type AppContext } from "./context.ts";
import { pollReplies } from "./mail/imap.ts";

const VERSION = "0.1.0";

const EMPTY_SLOTS: ModelSlots = {
  research: { active: null, ranking: [], status: "none" },
  writing: { active: null, ranking: [], status: "none" },
  enableExa: false, probedAt: null,
};

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* user can click the link */ }
}

export async function main(argv: string[] = []): Promise<void> {
  const home = coldcallHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "run"), { recursive: true });

  const log = (msg: string) => console.log(`[coldcall] ${msg}`);

  // 1. Database first - nothing works without it, and it is the fastest thing to fail.
  const db = openDb(join(home, "coldcall.db"));
  const applied = migrate(db);
  if (applied.length) log(`applied migrations: ${applied.join(", ")} (schema v${schemaVersion(db)})`);
  seedDefaults(db);
  const recovered = recoverAfterCrash(db);
  if (recovered.jobsReset || recovered.sendsFailed) {
    log(`recovered from an unclean shutdown: ${recovered.jobsReset} job(s) requeued, ${recovered.sendsFailed} interrupted send(s) marked failed (never retried automatically)`);
  }

  // 2. Reap an opencode we orphaned in a previous run.
  const pidFile = join(home, "run", "opencode.pid");
  try {
    const old = Number(await readFile(pidFile, "utf8"));
    if (old > 0) { try { process.kill(old, "SIGTERM"); log(`reaped orphaned opencode pid ${old}`); } catch { /* already gone */ } }
    await unlink(pidFile).catch(() => {});
  } catch { /* no pid file */ }

  const supervisor = new OpencodeSupervisor({ agentCwd: join(home, "agent-cwd"), startTimeoutMs: 45_000 });
  let slots: ModelSlots = getSetting<ModelSlots>(db, "model_slots", EMPTY_SLOTS) ?? EMPTY_SLOTS;
  if (!slots?.research) slots = EMPTY_SLOTS;

  const bus = new EventBus();
  const llm = new LlmService({ client: () => supervisor.client, slots: () => slots, db });
  const sender = new SendRunner(db, () => readSmtpConfig(db));

  const app: AppContext = {
    db, supervisor, llm, fetcher: new Fetcher(), bus, sender,
    slots: () => slots,
    setSlots: (s) => { slots = s; },
    smtpConfig: () => readSmtpConfig(db),
    imapConfig: () => readImapConfig(db),
    log, version: VERSION, busy: new Map(),
  };

  // 3. HTTP + browser BEFORE opencode.
  const server = createApp(app);
  const port = await listenOnFreePort(server, Number(process.env.COLDCALL_PORT) || 7788);
  const url = `http://127.0.0.1:${port}`;
  log(`web UI ready at ${url}`);
  if (!argv.includes("--no-open")) openBrowser(url);

  // 4. opencode, in the background. Failure is a banner, not a crash.
  void (async () => {
    try {
      await supervisor.start();
      await writeFile(pidFile, String((supervisor as any).child?.pid ?? ""), "utf8").catch(() => {});
      log(`opencode ready at ${supervisor.url}`);
      bus.emit("opencode:ready", { url: supervisor.url });

      if (slots.writing.status !== "ok") {
        log("probing models (first run takes a minute)...");
        bus.emit("job:start", { key: "probe", label: "Probing models" });
        try {
          slots = await probeModels(supervisor.client!, { maxCandidates: 3 });
          setSetting(db, "model_slots", slots);
          log(`research=${slots.research.active?.modelID ?? "none"}  writing=${slots.writing.active?.providerID ?? "none"}/${slots.writing.active?.modelID ?? ""}`);
        } finally {
          bus.emit("job:end", { key: "probe" });
          bus.emit("models:changed", slots);
        }
      }
    } catch (e) {
      log(`opencode failed to start: ${(e as Error).message}`);
      bus.emit("opencode:error", { error: (e as Error).message, stderr: supervisor.stderrTail.slice(-20) });
    }
  })();

  // 5. Reply polling, if configured. Quiet on failure - it is a background convenience.
  const replyTimer = setInterval(() => {
    const cfg = readImapConfig(db);
    if (!cfg || app.busy.has("poll")) return;
    void pollReplies(db, cfg).then((r) => { if (r.matched) bus.emit("replies:changed", r); }).catch(() => {});
  }, 120_000);

  if (!getSetting<{ paused: boolean }>(db, "sending", { paused: true }).paused) sender.start();

  // 6. Shutdown: never orphan the child.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) { process.exit(1); return; }
    shuttingDown = true;
    log(`${signal} - shutting down`);
    clearInterval(replyTimer);
    sender.stop();
    server.close();
    await supervisor.stop();
    await unlink(pidFile).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => { try { (supervisor as any).child?.kill("SIGKILL"); } catch { /* gone */ } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { console.error("[coldcall] fatal:", e); process.exit(1); });
}
