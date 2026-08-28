/**
 * Upgrade safety.
 *
 * Two migrations rebuild a table (email_draft, to change a UNIQUE constraint SQLite cannot
 * drop, and again for the sequence columns). A table rebuild with foreign keys on performs an
 * implicit DELETE FROM first, which cascades into every child row - so a mistake here does not
 * error, it silently destroys the user's drafts and send log. These tests populate a v1
 * database the way a real one looks and then upgrade it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now, type Db } from "../../src/server/db/index.ts";
import { migrate, loadMigrations, schemaVersion } from "../../src/server/db/migrate.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "src/server/db/migrations");
const LATEST = Math.max(...loadMigrations().map((m) => m.version));

/** A database at schema v1 with a realistic amount of connected data. */
function v1WithData(): Db {
  const db = openDb(":memory:");
  db.exec(readFileSync(join(MIG_DIR, "001_init.sql"), "utf8"));
  db.prepare("INSERT INTO schema_migrations (version,name,applied_at) VALUES (1,'init',?)").run(now());

  const t = now();
  const p = ulid(), c = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(c, p, "C", t, t);

  for (let i = 0; i < 5; i++) {
    const co = ulid(), cc = ulid(), ct = ulid(), d = ulid(), v = ulid(), sp = ulid(), cl = ulid();
    db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(co, `c${i}.com`, `C${i}`, t, t);
    db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(cc, c, co, t, t);
    db.prepare("INSERT INTO source_page (id,url,url_hash,company_id,text,fetched_at) VALUES (?,?,?,?,?,?)").run(sp, `https://c${i}.com/`, `h${i}`, co, "text", t);
    db.prepare("INSERT INTO claim (id,company_id,claim,source_url,quote,verified,created_at) VALUES (?,?,?,?,?,1,?)").run(cl, co, "claim", `https://c${i}.com/`, "quote", t);
    db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(ct, co, `a${i}@c${i}.com`, "https://x", "published", t, t);
    db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,created_at,updated_at) VALUES (?,?,?,?,'sent',?,?)").run(d, c, cc, ct, t, t);
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,'llm',?,?)")
      .run(v, d, 1, `s${i}`, "body", JSON.stringify([{ claim_id: cl }]), t);
    db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
      .run(ulid(), d, v, c, ct, `a${i}@c${i}.com`, "me@me.com", `s${i}`, `<m${i}@cc>`, t, t);
    db.prepare("INSERT INTO reply (id,campaign_id,contact_id,from_email,received_at,created_at) VALUES (?,?,?,?,?,?)").run(ulid(), c, ct, `a${i}@c${i}.com`, t, t);
  }
  return db;
}

const counts = (db: Db) => Object.fromEntries(
  ["company", "campaign_company", "contact", "claim", "source_page",
   "email_draft", "email_draft_version", "send_log", "reply"]
    .map((t) => [t, (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]));

test("upgrading a populated v1 database loses nothing", () => {
  const db = v1WithData();
  const before = counts(db);
  const applied = migrate(db);
  assert.deepEqual(applied, Array.from({ length: LATEST - 1 }, (_, i) => i + 2));
  assert.equal(schemaVersion(db), LATEST);
  assert.deepEqual(counts(db), before,
    "a table rebuild with FKs on cascades deletes into children - this is the test that catches it");
});

test("no foreign key is left dangling by the rebuilds", () => {
  const db = v1WithData();
  migrate(db);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
});

test("foreign keys are ON again after a rebuild migration", () => {
  const db = v1WithData();
  migrate(db);
  assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1,
    "leaving them off would silently disable every cascade for the rest of the session");
});

test("the view and the verified-claim trigger survive the rebuilds", () => {
  const db = v1WithData();
  migrate(db);
  const row = db.prepare("SELECT draft_id, step_number, word_count FROM email_draft_current LIMIT 1").get() as any;
  assert.ok(row, "the view must exist and return rows after email_draft was recreated");
  assert.equal(row.step_number, 1, "existing drafts become step 1");

  const d = db.prepare("SELECT id FROM email_draft LIMIT 1").get() as { id: string };
  assert.throws(
    () => db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,'llm',?,?)")
      .run(ulid(), d.id, 99, "s", "b", JSON.stringify([{ claim_id: "MISSING" }]), now()),
    /unverified claim/, "the anti-hallucination trigger must still be attached");
});

test("upgrading is idempotent and every migration is numbered uniquely", () => {
  const db = v1WithData();
  migrate(db);
  assert.deepEqual(migrate(db), []);
  const versions = loadMigrations().map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, "duplicate migration numbers would silently skip one");
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), "migrations must be ordered");
});

test("follow-up steps become possible only after the upgrade", () => {
  const db = v1WithData();
  const d = db.prepare("SELECT id, campaign_id, campaign_company_id, contact_id FROM email_draft LIMIT 1").get() as any;
  // v1 had UNIQUE (campaign_id, contact_id): a second touch to the same person was impossible.
  assert.throws(() => db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(ulid(), d.campaign_id, d.campaign_company_id, d.contact_id, now(), now()), /UNIQUE/);
  migrate(db);
  assert.doesNotThrow(() => db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,step_number,created_at,updated_at) VALUES (?,?,?,?,2,?,?)")
    .run(ulid(), d.campaign_id, d.campaign_company_id, d.contact_id, now(), now()));
});
