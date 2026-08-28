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
import { integrityReport, migrate, recoverAfterCrash, repairOrphans, schemaVersion } from "./db/migrate.ts";
import { seedDefaults, getSetting, setSetting } from "./db/settings.ts";
import { backfillQuality, QUALITY_VERSION } from "./research/quality.ts";
import { OpencodeSupervisor, locateOpencode } from "./opencode/supervisor.ts";
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

/** Semver-ish compare. A string compare would rank "9.0.0" above "22.13.0". */
export function meetsMinimum(actual: string, minimum: string): boolean {
  const a = actual.split(".").map((n) => parseInt(n, 10) || 0);
  const b = minimum.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const HELP = `coldcall - local cold email, powered by opencode

  coldcall              start the app and open the web UI
  coldcall --no-open    start without opening a browser
  coldcall repair       resolve references left dangling by an external edit
  coldcall doctor       report what is and is not working, then exit
  coldcall where        print where your data lives
  coldcall --version    print the version

Environment:
  COLDCALL_PORT         web UI port (default 7788)
  COLDCALL_HOME         data directory (default ~/.coldcall)
`;

/** Commands that inspect or repair without starting a server. */
async function runCommand(cmd: string, home: string): Promise<boolean> {
  const { openDb } = await import("./db/index.ts");
  const dbPath = join(home, "coldcall.db");

  if (cmd === "where") {
    console.log(`data      ${home}`);
    console.log(`database  ${dbPath}`);
    console.log(`agent cwd ${join(home, "agent-cwd")}`);
    return true;
  }
  if (cmd === "repair") {
    const db = openDb(dbPath);
    migrate(db);
    const before = integrityReport(db);
    if (before.ok) { console.log("Nothing to repair - every reference resolves."); return true; }
    console.log(`Found ${before.violations.reduce((n, v) => n + v.count, 0)} dangling reference(s): ` +
                before.violations.map((v) => `${v.count} in ${v.table}`).join(", "));
    const resolved = repairOrphans(db);
    const after = integrityReport(db);
    console.log(after.ok
      ? `Resolved ${resolved}. Rows whose reference was optional were kept.`
      : `Resolved ${resolved}, but ${after.violations.reduce((n, v) => n + v.count, 0)} remain. Please report this.`);
    return true;
  }
  if (cmd === "doctor") {
    const db = openDb(dbPath);
    migrate(db);
    const bin = await locateOpencode();
    const integrity = integrityReport(db);
    const smtp = getSetting<{ configured?: boolean; user?: string }>(db, "smtp", {});
    const slots = getSetting<ModelSlots>(db, "model_slots", EMPTY_SLOTS);
    const line = (ok: boolean, label: string, detail: string) =>
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
    console.log(`coldcall ${VERSION}\n`);
    line(!!bin, "opencode", bin ?? "not found - curl -fsSL https://opencode.ai/install | bash");
    line(meetsMinimum(process.versions.node, "22.13.0"), "node",
         `${process.versions.node}${meetsMinimum(process.versions.node, "22.13.0") ? "" : " - node:sqlite needs >= 22.13.0"}`);
    line(true, "database", `${dbPath} (schema v${schemaVersion(db)})`);
    line(integrity.ok, "integrity", integrity.ok ? "no dangling references" : "run: coldcall repair");
    line(slots.writing?.status === "ok", "writing model", slots.writing?.active
      ? `${slots.writing.active.providerID}/${slots.writing.active.modelID}` : "not probed - start the app once");
    line(slots.research?.status === "ok", "research model", slots.research?.active
      ? `${slots.research.active.providerID}/${slots.research.active.modelID}` : "none - discovery falls back to manual");
    line(!!smtp.configured, "mailbox", smtp.configured ? (smtp.user ?? "configured") : "not set up - Settings in the web UI");
    return true;
  }
  return false;
}

export async function main(argv: string[] = []): Promise<void> {
  const home = coldcallHome();

  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  if (argv.includes("--version") || argv.includes("-v")) { console.log(VERSION); return; }

  const cmd = argv.find((a) => !a.startsWith("-"));
  if (cmd) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (await runCommand(cmd, home)) return;
    console.error(`Unknown command "${cmd}".\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "run"), { recursive: true });

  const log = (msg: string) => console.log(`[coldcall] ${msg}`);

  // 1. Database first - nothing works without it, and it is the fastest thing to fail.
  const db = openDb(join(home, "coldcall.db"));
  const applied = migrate(db);
  if (applied.length) log(`applied migrations: ${applied.join(", ")} (schema v${schemaVersion(db)})`);
  seedDefaults(db);
  // Re-check every draft when the rules themselves change, so nobody is shown a flag written
  // by a version of the checker that no longer exists.
  const storedQuality = getSetting<number>(db, "quality_version", 0);
  const backfilled = backfillQuality(db as never, storedQuality < QUALITY_VERSION);
  if (backfilled) log(`re-checked quality on ${backfilled} draft version(s)`);
  if (storedQuality < QUALITY_VERSION) setSetting(db, "quality_version", QUALITY_VERSION);

  const integrity = integrityReport(db);
  if (!integrity.ok) {
    log(`WARNING: ${integrity.violations.reduce((n, v) => n + v.count, 0)} row(s) reference something that no longer exists ` +
        `(${integrity.violations.map((v) => `${v.count} in ${v.table}`).join(", ")}). ` +
        `This cannot happen through the app - something else edited ${join(home, "coldcall.db")}. ` +
        `Settings has a Repair button, or run: coldcall repair`);
  }

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
  const llm = new LlmService({
    client: () => supervisor.client, slots: () => slots, db,
    probing: () => app.busy.has("probe"),
  });
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
        // Register it the same way a route-triggered job is, so /api/health reports it. Without
        // this the first run shows "no usable model" with nothing to say a probe is under way,
        // and any request in that window fails with a NO_MODEL that looks permanent.
        app.busy.set("probe", { label: "Probing models", startedAt: Date.now() });
        bus.emit("job:start", { key: "probe", label: "Probing models" });
        try {
          slots = await probeModels(supervisor.client!, { maxCandidates: 3 });
          setSetting(db, "model_slots", slots);
          log(`research=${slots.research.active?.modelID ?? "none"}  writing=${slots.writing.active?.providerID ?? "none"}/${slots.writing.active?.modelID ?? ""}`);
        } finally {
          app.busy.delete("probe");
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
