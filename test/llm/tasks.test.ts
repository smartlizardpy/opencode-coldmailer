/**
 * Every task name a caller uses must be registered.
 *
 * LlmTask is a union type, so `task: "discover.search"` with no matching entry should be a
 * compile error - except nothing compiles this project. Node strips types without checking
 * them, which is what lets the whole app run from source with no build step, and the price is
 * that a union violation is a runtime error instead. Renaming one task took a whole discovery
 * stage down and every query failed with `unknown task`.
 *
 * So the check is a test: read the call sites, read the registry, compare.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../../src/server", import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Task names as they appear in the registry's own object literal. */
function registeredTasks(): Set<string> {
  const src = readFileSync(join(SRC, "llm/index.ts"), "utf8");
  const block = /const TASK_CONFIG[^{]*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "TASK_CONFIG literal not found - this test needs updating");
  return new Set([...block[1].matchAll(/^\s*"([a-z_]+\.[a-z_]+)":/gim)].map((m) => m[1]));
}

/** Task names as they appear at call sites: `task: "..."`. */
function usedTasks(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    if (file.endsWith(join("llm", "index.ts"))) continue;   // the registry itself
    const src = readFileSync(file, "utf8");
    // Not just `task: "x"` - compose.ts picks between two with a ternary, and a regex that
    // only matched the simple form reported both of them as dead registry entries.
    for (const m of src.matchAll(/"([a-z_]+\.[a-z_]+)"/g)) {
      if (!/\btask\b/.test(src.slice(Math.max(0, m.index - 120), m.index + 40))) continue;
      const rel = file.slice(SRC.length + 1);
      used.set(m[1], [...(used.get(m[1]) ?? []), rel]);
    }
  }
  return used;
}

test("every task used by a caller is in TASK_CONFIG", () => {
  const registered = registeredTasks();
  const missing = [...usedTasks()].filter(([name]) => !registered.has(name));
  assert.deepEqual(missing.map(([n, files]) => `${n} (${files.join(", ")})`), []);
});

test("the registry is not carrying tasks nothing calls", () => {
  // A stale entry is harmless but it is also a lie about what the app does, and it is the
  // half of a rename that gets left behind.
  const used = usedTasks();
  const orphans = [...registeredTasks()].filter((name) => !used.has(name));
  assert.deepEqual(orphans, []);
});

test("the registry was actually found and is not trivially empty", () => {
  // Both tests above pass vacuously if the regex stops matching after a refactor.
  const registered = registeredTasks();
  assert.ok(registered.size >= 8, `only found ${registered.size} registered tasks`);
  assert.ok(usedTasks().size >= 8, "found suspiciously few call sites");
});
