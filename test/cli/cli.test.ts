/** The CLI surface, and the version comparison inside `doctor`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meetsMinimum } from "../../src/server/main.ts";

const run = promisify(execFile);
const BIN = join(process.cwd(), "bin/coldcall.js");
/**
 * Each of these spawns a real coldcall process, which opens a database and runs every
 * migration - about three seconds on an idle machine, and the only way to test the shim people
 * actually run rather than the module behind it.
 *
 * `node --test` runs files in parallel across every core, so these contend with each other,
 * with every other test file, and with whatever else the developer has open. Measured on a
 * four-core laptop at load average 30 - an ordinary desktop with a browser running - the same
 * three-second command took over 150. Thirty seconds was inside that range, and so was 120.
 *
 * This timeout exists only to stop a hang wedging the suite forever, and a hang is not
 * something anyone needs caught within the minute. Set it well past anything scheduling can
 * produce, so a red test always means a real failure.
 */
const CLI_TIMEOUT_MS = 300_000;

const cli = async (args: string[], home: string) =>
  (await run(process.execPath, [BIN, ...args], { env: { ...process.env, COLDCALL_HOME: home }, timeout: CLI_TIMEOUT_MS })).stdout;

test("version comparison is numeric, not lexical", () => {
  assert.equal(meetsMinimum("25.9.0", "22.13.0"), true);
  assert.equal(meetsMinimum("22.13.0", "22.13.0"), true);
  assert.equal(meetsMinimum("22.14.0", "22.13.0"), true);
  assert.equal(meetsMinimum("22.5.0", "22.13.0"), false, "22.5 < 22.13 - a string compare gets this backwards");
  assert.equal(meetsMinimum("9.0.0", "22.13.0"), false, "a string compare would rank 9 above 22");
  assert.equal(meetsMinimum("24.0.0", "22.13.0"), true);
});

test("--help lists the commands and exits cleanly", async () => {
  const out = await cli(["--help"], await mkdtemp(join(tmpdir(), "cc-")));
  for (const c of ["repair", "doctor", "where", "COLDCALL_PORT", "COLDCALL_HOME"]) {
    assert.ok(out.includes(c), `--help should mention ${c}`);
  }
});

test("--version prints just the version", async () => {
  const out = await cli(["--version"], await mkdtemp(join(tmpdir(), "cc-")));
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test("where prints the paths, and creates the home directory", async () => {
  const home = join(await mkdtemp(join(tmpdir(), "cc-")), "data");
  const out = await cli(["where"], home);
  assert.ok(out.includes(home));
  assert.ok(out.includes("coldcall.db"));
});

test("doctor runs on an empty install and reports each check", async () => {
  const out = await cli(["doctor"], await mkdtemp(join(tmpdir(), "cc-")));
  for (const label of ["opencode", "node", "database", "integrity", "writing model", "mailbox"]) {
    assert.ok(out.includes(label), `doctor should check ${label}`);
  }
  assert.match(out, /schema v\d+/, "doctor must create and migrate the database");
});

test("repair on a fresh database says there is nothing to do", async () => {
  const out = await cli(["repair"], await mkdtemp(join(tmpdir(), "cc-")));
  assert.match(out, /Nothing to repair/);
});

test("an unknown command fails loudly rather than starting a server", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-"));
  await assert.rejects(
    () => cli(["definitely-not-a-command"], home),
    (e: { stdout?: string; stderr?: string; code?: number }) => {
      assert.equal(e.code, 1);
      assert.match(String(e.stderr), /Unknown command/);
      return true;
    },
  );
});
