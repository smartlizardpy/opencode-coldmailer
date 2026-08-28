/**
 * Secret storage. macOS login Keychain where available, a 0600 file otherwise.
 *
 * Honest about what this buys: the password is not in coldcall.db - the file people back up to
 * iCloud and paste into bug reports. It does NOT stop another process running as the same user
 * from reading it, and there is no way it could for an app that sends mail unattended.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { now, type Db } from "../db/index.ts";

const exec = promisify(execFile);
const SERVICE = "coldcall";

export type Storage = "keychain" | "file";

export function secretsFile(): string {
  return join(process.env.COLDCALL_HOME ?? join(homedir(), ".coldcall"), "secrets.json");
}

async function keychainAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try { await exec("/usr/bin/security", ["list-keychains"], { timeout: 5_000 }); return true; }
  catch { return false; }
}

async function fileRead(): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(secretsFile(), "utf8")) as Record<string, string>; }
  catch { return {}; }
}

async function fileWrite(all: Record<string, string>): Promise<void> {
  const path = secretsFile();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function setSecret(db: Db, name: string, value: string): Promise<Storage> {
  const useKeychain = await keychainAvailable();
  if (useKeychain) {
    await exec("/usr/bin/security", ["add-generic-password", "-U", "-a", name, "-s", SERVICE, "-w", value], { timeout: 10_000 });
  } else {
    const all = await fileRead();
    all[name] = value;
    await fileWrite(all);
  }
  const storage: Storage = useKeychain ? "keychain" : "file";
  db.prepare(
    `INSERT INTO secret_ref (name,storage,locator,created_at,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET storage=excluded.storage, locator=excluded.locator, updated_at=excluded.updated_at`,
  ).run(name, storage, useKeychain ? `${SERVICE}/${name}` : name, now(), now());
  return storage;
}

export async function getSecret(db: Db, name: string): Promise<string | undefined> {
  const ref = db.prepare("SELECT storage FROM secret_ref WHERE name=?").get(name) as { storage: Storage } | undefined;
  if (!ref) return undefined;
  if (ref.storage === "keychain") {
    try {
      const { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-a", name, "-s", SERVICE, "-w"], { timeout: 10_000 });
      return stdout.replace(/\n$/, "");
    } catch { return undefined; }
  }
  return (await fileRead())[name];
}

export async function deleteSecret(db: Db, name: string): Promise<void> {
  const ref = db.prepare("SELECT storage FROM secret_ref WHERE name=?").get(name) as { storage: Storage } | undefined;
  if (ref?.storage === "keychain") {
    await exec("/usr/bin/security", ["delete-generic-password", "-a", name, "-s", SERVICE], { timeout: 10_000 }).catch(() => {});
  } else if (ref) {
    const all = await fileRead(); delete all[name]; await fileWrite(all);
  }
  db.prepare("DELETE FROM secret_ref WHERE name=?").run(name);
}

/** What the settings UI must tell the user, verbatim. */
export function storageDescription(storage: Storage): string {
  return storage === "keychain"
    ? "Stored in your macOS login Keychain. Any process running as you can still read it."
    : `Stored UNENCRYPTED in ${secretsFile()} (file mode 0600).`;
}
