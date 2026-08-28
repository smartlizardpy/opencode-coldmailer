/**
 * Node's type-stripping is erasable-syntax-only. Parameter properties, enums, namespaces and
 * decorators all fail AT IMPORT TIME, which turns a typo into a crash on the user's machine
 * rather than a build error on ours. This test imports every module to prove they all load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FILES = walk("src");

test("no non-erasable TypeScript anywhere in src/", () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    const src = readFileSync(f, "utf8");
    if (/constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w/s.test(src)) offenders.push(`${f}: parameter property`);
    if (/^\s*(export\s+)?enum\s+\w/m.test(src)) offenders.push(`${f}: enum`);
    if (/^\s*(export\s+)?namespace\s+\w/m.test(src)) offenders.push(`${f}: namespace`);
    if (/^\s*@\w+\s*\(/m.test(src)) offenders.push(`${f}: decorator`);
  }
  assert.deepEqual(offenders, [], `non-erasable syntax found:\n${offenders.join("\n")}`);
});

test("every module in src/ imports cleanly on bare Node", async () => {
  for (const f of FILES) {
    await assert.doesNotReject(() => import(`../../${f}`), `${f} failed to import`);
  }
});
