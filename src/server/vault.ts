/**
 * Encrypted-at-rest storage for keys, inside coldcall.db.
 *
 * The existing secret store keeps the mailbox password OUT of the database on purpose: that is
 * what makes coldcall.db safe to back up and safe to paste into a bug report. This does not
 * undo that. Ciphertext lives in the database; the key that opens it is a separate 0600 file
 * (~/.coldcall/vault.key). A copied database is still useless on its own, which is the property
 * worth keeping.
 *
 * What it does NOT protect against, stated plainly because a vault invites people to assume
 * otherwise: another process running as you can read the key file, exactly as it can read the
 * macOS Keychain entry or ~/.coldcall/secrets.json. No design can prevent that for an app that
 * must send mail while nobody is watching. What it buys is that the two files have to be stolen
 * together, and only one of them is the file people copy around.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { now, type Db } from "./db/index.ts";

const ALGO = "aes-256-gcm";

export function vaultKeyFile(): string {
  return join(process.env.COLDCALL_HOME ?? join(homedir(), ".coldcall"), "vault.key");
}

let cached: Buffer | undefined;

/** Read the key, creating one on first use. Cached, because every send touches it. */
export async function vaultKey(): Promise<Buffer> {
  if (cached) return cached;
  const path = vaultKeyFile();
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) { cached = key; return key; }
    // A truncated or edited key file would otherwise throw deep inside createDecipheriv with
    // a message about IV length, which says nothing about what actually went wrong.
    throw new Error(`${path} does not contain a 32-byte key`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, key.toString("base64"), { mode: 0o600 });
  await chmod(path, 0o600);
  cached = key;
  return key;
}

/** Only for tests, which create and discard homes. */
export function forgetVaultKey(): void { cached = undefined; }

export async function encrypt(plaintext: string): Promise<string> {
  const key = await vaultKey();
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export async function decrypt(packed: string): Promise<string> {
  const [iv, tag, body] = packed.split(":");
  if (!iv || !tag || !body) throw new Error("stored value is not in the expected format");
  const d = createDecipheriv(ALGO, await vaultKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

/* ------------------------------------------------------------- credentials */

export interface CredentialRow {
  name: string; label: string; hint: string; kind: string;
  last_used_at: number | null; created_at: number; updated_at: number;
}

/**
 * Enough of a key to recognise it, never enough to use it.
 *
 * Four trailing characters of a 40-character key is not a meaningful fraction of its entropy,
 * and without them a list of three keys is three identical rows.
 */
export function hintFor(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(Math.max(4, v.length));
  const head = /^(sk|pk|ghp|xox[a-z]|Bearer)[-_]?/.exec(v)?.[0] ?? "";
  return `${head}…${v.slice(-4)}`;
}

export async function putCredential(
  db: Db, name: string, value: string,
  meta: { label?: string; kind?: CredentialRow["kind"] } = {},
): Promise<CredentialRow> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw Object.assign(new Error("a key name may only contain letters, numbers, dot, dash and underscore"), { code: "BAD_NAME", status: 400 });
  }
  if (!value) throw Object.assign(new Error("a key needs a value"), { code: "BAD_REQUEST", status: 400 });
  const t = now();
  db.prepare(
    `INSERT INTO credential (name,label,ciphertext,hint,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET label=excluded.label, ciphertext=excluded.ciphertext,
       hint=excluded.hint, kind=excluded.kind, updated_at=excluded.updated_at`,
  ).run(name, (meta.label ?? name).slice(0, 80), await encrypt(value), hintFor(value), meta.kind ?? "api_key", t, t);
  return listCredentials(db).find((c) => c.name === name)!;
}

/** Never selects `ciphertext`, so a careless spread into a JSON response cannot leak it. */
export function listCredentials(db: Db): CredentialRow[] {
  return db.prepare(
    "SELECT name,label,hint,kind,last_used_at,created_at,updated_at FROM credential ORDER BY name",
  ).all() as CredentialRow[];
}

export async function getCredential(db: Db, name: string): Promise<string | undefined> {
  const row = db.prepare("SELECT ciphertext FROM credential WHERE name=?").get(name) as { ciphertext: string } | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE credential SET last_used_at=? WHERE name=?").run(now(), name);
  try { return await decrypt(row.ciphertext); }
  catch { return undefined; }   // wrong or missing vault.key: treat as not set, never as a crash
}

export function deleteCredential(db: Db, name: string): boolean {
  return Number(db.prepare("DELETE FROM credential WHERE name=?").run(name).changes) > 0;
}

/* ---------------------------------------------------------- company profile */

export interface CompanyProfile {
  legal_name: string; trading_name: string; website: string; contact_email: string;
  phone: string; address: string; country: string; company_number: string;
  vat_number: string; sender_name: string; sender_title: string; notes: string;
  updated_at?: number;
}

const PROFILE_FIELDS = [
  "legal_name", "trading_name", "website", "contact_email", "phone", "address",
  "country", "company_number", "vat_number", "sender_name", "sender_title", "notes",
] as const;

export function getCompanyProfile(db: Db): CompanyProfile {
  const row = db.prepare("SELECT * FROM company_profile WHERE id=1").get() as CompanyProfile | undefined;
  if (row) return row;
  const blank = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, ""]));
  return blank as unknown as CompanyProfile;
}

export function setCompanyProfile(db: Db, patch: Partial<CompanyProfile>): CompanyProfile {
  const current = getCompanyProfile(db);
  const next = { ...current } as Record<string, string>;
  for (const f of PROFILE_FIELDS) {
    if (f in patch) next[f] = String((patch as Record<string, unknown>)[f] ?? "").slice(0, 500);
  }
  const t = now();
  db.prepare(
    `INSERT INTO company_profile (id,${PROFILE_FIELDS.join(",")},created_at,updated_at)
     VALUES (1,${PROFILE_FIELDS.map(() => "?").join(",")},?,?)
     ON CONFLICT(id) DO UPDATE SET ${PROFILE_FIELDS.map((f) => `${f}=excluded.${f}`).join(", ")}, updated_at=excluded.updated_at`,
  ).run(...PROFILE_FIELDS.map((f) => next[f]), t, t);
  return getCompanyProfile(db);
}

/**
 * The identity line a cold email needs to be lawful B2B mail in the UK: who is writing, for
 * which business, reachable how. Built from the profile rather than typed out again, because
 * a footer people have to retype is a footer people leave wrong.
 */
export function identityLine(p: CompanyProfile): string {
  const who = [p.sender_name, p.sender_title].filter(Boolean).join(", ");
  const firm = p.trading_name || p.legal_name;
  const where = [p.address, p.country].filter(Boolean).join(", ");
  const reach = p.website || p.contact_email;
  return [who && firm ? `${who} at ${firm}` : who || firm, where, reach].filter(Boolean).join(" · ");
}

/** Whether there is enough here to identify the sender at all. */
export function profileComplete(p: CompanyProfile): boolean {
  return !!(p.sender_name && (p.trading_name || p.legal_name) && (p.website || p.contact_email));
}
