/**
 * The key store. The property that matters is the one the README claims about coldcall.db:
 * that the database on its own is safe to copy around.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import {
  decrypt, deleteCredential, encrypt, forgetVaultKey, getCompanyProfile, getCredential,
  hintFor, identityLine, listCredentials, profileComplete, putCredential, setCompanyProfile,
  vaultKeyFile,
} from "../../src/server/vault.ts";

let home: string, previous: string | undefined;

before(async () => {
  previous = process.env.COLDCALL_HOME;
  home = await mkdtemp(join(tmpdir(), "coldcall-vault-"));
  process.env.COLDCALL_HOME = home;
  forgetVaultKey();
});
after(async () => {
  if (previous === undefined) delete process.env.COLDCALL_HOME; else process.env.COLDCALL_HOME = previous;
  forgetVaultKey();
  await rm(home, { recursive: true, force: true });
});

const fresh = () => { const db = openDb(":memory:"); migrate(db); return db; };

test("a value round-trips", async () => {
  assert.equal(await decrypt(await encrypt("hunter2")), "hunter2");
});

test("the same value encrypts differently every time", async () => {
  // A deterministic ciphertext would let anyone holding the database tell that two keys are
  // equal, or that a key has not been rotated.
  assert.notEqual(await encrypt("same"), await encrypt("same"));
});

test("tampered ciphertext is rejected rather than silently decoded", async () => {
  const packed = await encrypt("secret");
  const [iv, tag, body] = packed.split(":");
  const flipped = Buffer.from(body, "base64");
  flipped[0] ^= 0xff;
  await assert.rejects(() => decrypt([iv, tag, flipped.toString("base64")].join(":")));
});

test("the key file is created 0600 and lives outside the database", async () => {
  await encrypt("x");
  const st = await stat(vaultKeyFile());
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(vaultKeyFile().startsWith(home));
});

test("a stored key is not readable from the database alone", async () => {
  const db = fresh();
  await putCredential(db, "provider.key", "sk-live-abcdef0123456789", { label: "Provider" });
  const dump = JSON.stringify(db.prepare("SELECT * FROM credential").all());
  assert.ok(!dump.includes("sk-live-abcdef0123456789"),
    "the plaintext key must not appear anywhere in coldcall.db");
  assert.equal(await getCredential(db, "provider.key"), "sk-live-abcdef0123456789");
});

test("listing keys never selects the ciphertext, so it cannot be spread into a response", async () => {
  const db = fresh();
  await putCredential(db, "a.key", "value-one");
  const [row] = listCredentials(db);
  assert.ok(!("ciphertext" in row), "listCredentials must not return the ciphertext column");
  assert.equal(row.name, "a.key");
});

test("a hint identifies a key without being usable as one", () => {
  assert.equal(hintFor("sk-abcdefghijklmnop1234"), "sk-…1234");
  assert.equal(hintFor("short"), "•••••");
  assert.ok(!hintFor("sk-abcdefghijklmnop1234").includes("abcdefghijkl"));
});

test("re-storing a key replaces it rather than creating a second row", async () => {
  const db = fresh();
  await putCredential(db, "a.key", "first");
  await putCredential(db, "a.key", "second");
  assert.equal(listCredentials(db).length, 1);
  assert.equal(await getCredential(db, "a.key"), "second");
});

test("a key name is validated, so it cannot be used to reach another row", async () => {
  const db = fresh();
  await assert.rejects(() => putCredential(db, "bad name/../x", "v"), /letters, numbers/);
  await assert.rejects(() => putCredential(db, "ok.name", ""), /needs a value/);
});

test("a missing key reads as absent rather than throwing", async () => {
  const db = fresh();
  assert.equal(await getCredential(db, "nothing.here"), undefined);
  assert.equal(deleteCredential(db, "nothing.here"), false);
});

test("an unreadable value reads as absent rather than crashing the send", async () => {
  // Someone deletes vault.key, or restores a database next to the wrong one. A send must fail
  // as "no password" - which the UI explains - not as an uncaught crypto error.
  const db = fresh();
  await putCredential(db, "a.key", "value");
  db.prepare("UPDATE credential SET ciphertext='garbage' WHERE name='a.key'").run();
  assert.equal(await getCredential(db, "a.key"), undefined);
});

/* ------------------------------------------------------------------ company */

test("the company profile starts blank rather than missing", () => {
  const db = fresh();
  const p = getCompanyProfile(db);
  assert.equal(p.legal_name, "");
  assert.equal(profileComplete(p), false);
});

test("there is exactly one company profile, however many times it is saved", () => {
  const db = fresh();
  setCompanyProfile(db, { legal_name: "WearSide Labs Ltd" });
  setCompanyProfile(db, { trading_name: "WearSide Labs" });
  const n = (db.prepare("SELECT COUNT(*) n FROM company_profile").get() as { n: number }).n;
  assert.equal(n, 1);
  const p = getCompanyProfile(db);
  assert.equal(p.legal_name, "WearSide Labs Ltd", "a later save must not blank an earlier field");
  assert.equal(p.trading_name, "WearSide Labs");
});

test("the identity line is built from the profile, not retyped", () => {
  const db = fresh();
  const p = setCompanyProfile(db, {
    sender_name: "Ozan", sender_title: "founder", trading_name: "WearSide Labs",
    address: "Durham", country: "UK", website: "wearsidelabs.com",
  });
  assert.equal(identityLine(p), "Ozan, founder at WearSide Labs · Durham, UK · wearsidelabs.com");
  assert.equal(profileComplete(p), true);
});

test("a half-filled profile produces a line with no dangling separators", () => {
  const db = fresh();
  const p = setCompanyProfile(db, { sender_name: "Ozan", website: "wearsidelabs.com" });
  assert.equal(p.sender_title, "");
  assert.ok(!identityLine(p).includes("··"));
  assert.ok(!identityLine(p).trim().endsWith("·"));
});
