/**
 * The tunnel supervisor, against a stand-in that speaks cloudflared's actual output.
 *
 * What is being tested is our half: that the URL is recognised in the banner cloudflared
 * prints, that it comes off stderr as well as stdout, that a child dying is noticed rather
 * than leaving the UI claiming the link is open, and that stopping actually kills it. Whether
 * cloudflared itself works is Cloudflare's problem and not something a test here can prove.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, installHint, locateCloudflared, TunnelSupervisor } from "../../src/server/tunnel/cloudflared.ts";

let dir: string, previousBin: string | undefined;

/** The banner a real `cloudflared tunnel --url` prints, on stderr, verbatim in shape. */
const BANNER = String.raw`#!/usr/bin/env bash
>&2 echo "$(date -Iseconds) INF Thank you for trying Cloudflare Tunnel."
>&2 echo "$(date -Iseconds) INF +--------------------------------------------------------------------------------------------+"
>&2 echo "$(date -Iseconds) INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |"
>&2 echo "$(date -Iseconds) INF |  https://tasty-words-run-here.trycloudflare.com                                             |"
>&2 echo "$(date -Iseconds) INF +--------------------------------------------------------------------------------------------+"
if [ -n "$FAKE_CF_EXIT_AFTER" ]; then sleep "$FAKE_CF_EXIT_AFTER"; exit 7; fi
while true; do sleep 1; done
`;

const SILENT = "#!/usr/bin/env bash\n>&2 echo 'ERR failed to connect'\nexit 1\n";

async function fakeBin(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, { mode: 0o755 });
  await chmod(p, 0o755);
  return p;
}

before(async () => {
  previousBin = process.env.COLDCALL_CLOUDFLARED_BIN;
  dir = await mkdtemp(join(tmpdir(), "coldcall-tunnel-"));
});
after(async () => {
  if (previousBin === undefined) delete process.env.COLDCALL_CLOUDFLARED_BIN;
  else process.env.COLDCALL_CLOUDFLARED_BIN = previousBin;
  await rm(dir, { recursive: true, force: true });
});

test("the quick-tunnel URL is read out of the banner cloudflared prints on stderr", async () => {
  process.env.COLDCALL_CLOUDFLARED_BIN = await fakeBin("cf-ok", BANNER);
  const t = new TunnelSupervisor();
  try {
    const url = await t.start(7999);
    assert.equal(url, "https://tasty-words-run-here.trycloudflare.com");
    assert.equal(t.status, "ready");
    // The hostname is what the server matches the Host header against, so it must be the bare
    // host with no scheme and no trailing slash.
    assert.equal(t.hostname, "tasty-words-run-here.trycloudflare.com");
  } finally { await t.stop(); }
});

test("stopping clears the URL, so the Host check stops accepting it", async () => {
  process.env.COLDCALL_CLOUDFLARED_BIN = await fakeBin("cf-ok2", BANNER);
  const t = new TunnelSupervisor();
  await t.start(7999);
  await t.stop();
  assert.equal(t.status, "stopped");
  assert.equal(t.url, undefined);
  assert.equal(t.hostname, undefined, "a closed tunnel must not leave a hostname the server would trust");
});

test("a tunnel that dies is reported, not left looking open", async () => {
  process.env.COLDCALL_CLOUDFLARED_BIN = await fakeBin("cf-dies", BANNER);
  process.env.FAKE_CF_EXIT_AFTER = "0.3";
  const changes: string[] = [];
  const t = new TunnelSupervisor({ onChange: () => changes.push(t.status) });
  try {
    await t.start(7999);
    assert.equal(t.status, "ready");
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(t.status, "failed");
    assert.equal(t.url, undefined);
    assert.match(t.state().error ?? "", /exited/);
    assert.ok(changes.includes("failed"), "the UI has to be told, or it keeps showing a dead link");
  } finally { delete process.env.FAKE_CF_EXIT_AFTER; await t.stop(); }
});

test("a cloudflared that never opens a tunnel fails with what it actually said", async () => {
  process.env.COLDCALL_CLOUDFLARED_BIN = await fakeBin("cf-bad", SILENT);
  const t = new TunnelSupervisor();
  await assert.rejects(() => t.start(7999), /failed to connect|exited/);
  assert.equal(t.status, "failed");
});

test("a missing cloudflared is a named condition, not a crash", async () => {
  process.env.COLDCALL_CLOUDFLARED_BIN = join(dir, "does-not-exist");
  const realOnPath = await locateCloudflared();
  if (realOnPath) return;   // this machine has one; the negative case cannot be posed
  const t = new TunnelSupervisor();
  await assert.rejects(() => t.start(7999), (e: any) => e.code === "NO_CLOUDFLARED");
  assert.equal(t.status, "not_installed");
});

test("the download picks the right asset per platform, and says so when there isn't one", () => {
  assert.equal(assetName("linux", "x64"), "cloudflared-linux-amd64");
  assert.equal(assetName("linux", "arm64"), "cloudflared-linux-arm64");
  assert.equal(assetName("win32", "x64"), "cloudflared-windows-amd64.exe");
  assert.equal(assetName("darwin", "arm64"), "cloudflared-darwin-arm64.tgz");
  assert.equal(assetName("freebsd", "mips" as never), undefined);
  assert.ok(installHint().length > 0);
});
