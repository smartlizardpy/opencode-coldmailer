/**
 * The mailbox password must not be in coldcall.db.
 *
 * That is the whole reason the file is safe to back up or attach to a bug report, and it was
 * false for several weeks: POST /api/settings/test spread the request body - password included -
 * back into the settings row, and GET /api/settings then returned it to the browser on every
 * load. These tests pin both halves: writes are sanitised, and a database that already leaked
 * is cleaned up on boot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { setSetting, getSetting } from "../../src/server/db/settings.ts";
import { evictLeakedPassword, getSecret } from "../../src/server/mail/secrets.ts";
import { sanitizeSmtp, carriesSecret } from "../../src/server/context.ts";

const PASSWORD = "abcd efgh ijkl mnop";

function scratch(): { dir: string; db: ReturnType<typeof openDb>; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "coldcall-secrets-"));
  const prev = process.env.COLDCALL_HOME;
  process.env.COLDCALL_HOME = dir;
  const db = openDb(join(dir, "coldcall.db"));
  migrate(db);
  return { dir, db, done: () => {
    try { db.close(); } catch { /* a test may have closed it to read the file */ }
    if (prev === undefined) delete process.env.COLDCALL_HOME; else process.env.COLDCALL_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("sanitizeSmtp drops every secret-shaped key and keeps the rest", () => {
  const out = sanitizeSmtp({
    user: "a@b.com", host: "smtp.b.com", port: 465, configured: true,
    password: PASSWORD, pass: "x", appPassword: "y", secret: "z", token: "t",
  });
  assert.deepEqual(out, { user: "a@b.com", host: "smtp.b.com", port: 465, configured: true });
  assert.equal(JSON.stringify(out).includes(PASSWORD), false);
});

test("sanitizeSmtp does not invent keys for a secret that was not there", () => {
  assert.deepEqual(sanitizeSmtp({ user: "a@b.com" }), { user: "a@b.com" });
});

test("carriesSecret ignores an empty or absent password", () => {
  assert.equal(carriesSecret({ user: "a@b.com" }), false);
  assert.equal(carriesSecret({ user: "a@b.com", password: "" }), false);
  assert.equal(carriesSecret({ user: "a@b.com", password: null }), false);
  assert.equal(carriesSecret({ user: "a@b.com", password: PASSWORD }), true);
});

test("a leaked password is moved to the secret store and stripped from the row", async () => {
  const s = scratch();
  try {
    setSetting(s.db, "smtp", { user: "a@b.com", password: PASSWORD, configured: true } as never);
    assert.equal(await evictLeakedPassword(s.db), "moved");

    const after = getSetting<Record<string, unknown>>(s.db, "smtp", {});
    assert.equal("password" in after, false);
    assert.equal(after.user, "a@b.com", "the rest of the settings survive");
    assert.equal(after.configured, true);
    assert.equal(await getSecret(s.db, "smtp.password"), PASSWORD, "and sending still works");
  } finally { s.done(); }
});

test("eviction is idempotent - a second boot finds nothing to do", async () => {
  const s = scratch();
  try {
    setSetting(s.db, "smtp", { user: "a@b.com", password: PASSWORD } as never);
    assert.equal(await evictLeakedPassword(s.db), "moved");
    assert.equal(await evictLeakedPassword(s.db), "none");
    assert.equal(await evictLeakedPassword(s.db), "none");
  } finally { s.done(); }
});

test("an already-stored password is never overwritten by the leaked one", async () => {
  // The stored secret is the newer of the two. Adopting a stale value from the settings row
  // would replace a working password with one that no longer authenticates, and the failure
  // would not show up until the next send.
  const s = scratch();
  try {
    const { setSecret } = await import("../../src/server/mail/secrets.ts");
    await setSecret(s.db, "smtp.password", "the current one");
    setSetting(s.db, "smtp", { user: "a@b.com", password: "a stale one" } as never);

    assert.equal(await evictLeakedPassword(s.db), "dropped");
    assert.equal(await getSecret(s.db, "smtp.password"), "the current one");
    assert.equal("password" in getSetting<Record<string, unknown>>(s.db, "smtp", {}), false);
  } finally { s.done(); }
});

test("the password does not survive in the database file", async () => {
  // Rewriting the row is not the same as removing the bytes - a shortened cell can leave the
  // original page on the freelist, where `strings` still finds it.
  const s = scratch();
  try {
    setSetting(s.db, "smtp", { user: "a@b.com", password: PASSWORD } as never);
    await evictLeakedPassword(s.db);
    s.db.close();
    const path = join(s.dir, "coldcall.db");
    assert.equal(readFileSync(path).includes(Buffer.from(PASSWORD)), false, "password still in coldcall.db");
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) {
        assert.equal(readFileSync(path + suffix).includes(Buffer.from(PASSWORD)), false, `password still in ${suffix}`);
      }
    }
  } finally { s.done(); }
});

test("a settings row with no smtp key at all is handled", async () => {
  const s = scratch();
  try { assert.equal(await evictLeakedPassword(s.db), "none"); } finally { s.done(); }
});

test("the schema itself refuses settings that are not valid JSON", () => {
  // The parse in evictLeakedPassword is guarded anyway, but this is why that guard can never
  // actually fire through the app: the column will not accept the input in the first place.
  const s = scratch();
  try {
    assert.throws(
      () => s.db.prepare("INSERT OR REPLACE INTO setting(key,value,updated_at) VALUES('smtp','{not json',0)").run(),
      /json_valid/,
    );
  } finally { s.done(); }
});
