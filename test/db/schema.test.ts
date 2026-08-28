/**
 * These tests assert the invariants the SCHEMA enforces, not the ones the application intends.
 * Each one corresponds to a way this product could quietly do something wrong to a real person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, tx, ulid, now } from "../../src/server/db/index.ts";
import { migrate, schemaVersion, recoverAfterCrash, loadMigrations } from "../../src/server/db/migrate.ts";
import { seedDefaults, getSetting, setSetting } from "../../src/server/db/settings.ts";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  seedDefaults(db);
  return db;
}

/** Minimal product -> campaign -> company -> contact -> draft chain. */
function seedChain(db: ReturnType<typeof fresh>) {
  const t = now();
  const productId = ulid(), campaignId = ulid(), companyId = ulid(), ccId = ulid(), contactId = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(productId, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(campaignId, productId, "C", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(companyId, "example.com", "Example", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(ccId, campaignId, companyId, t, t);
  db.prepare(
    "INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(contactId, companyId, "a@example.com", "https://example.com/contact", "published", t, t);
  return { productId, campaignId, companyId, ccId, contactId, t };
}

test("migrations apply once and are idempotent", () => {
  const db = fresh();
  // Assert against the migration files on disk, not a hardcoded number, so adding a
  // migration does not fail this test for the wrong reason.
  const latest = Math.max(...loadMigrations().map((m) => m.version));
  assert.equal(schemaVersion(db), latest);
  assert.deepEqual(migrate(db), []);
});

test("a campaign carries its own target, separate from the product's signals", () => {
  const db = fresh();
  const { campaignId } = seedChain(db);
  // Default is empty - targetOf() then falls back to the product signals.
  assert.equal((db.prepare("SELECT target_description FROM campaign WHERE id=?").get(campaignId) as any).target_description, "");
  db.prepare("UPDATE campaign SET target_description=? WHERE id=?").run("small independent news websites", campaignId);
  assert.equal((db.prepare("SELECT target_description FROM campaign WHERE id=?").get(campaignId) as any).target_description, "small independent news websites");
});

test("a company can be rejected after we fetch it, with the reason kept", () => {
  const db = fresh();
  const { ccId } = seedChain(db);
  db.prepare("UPDATE campaign_company SET status='rejected', selected=0, rejected_reason=? WHERE id=?")
    .run("not the target kind - it is a tennis academy", ccId);
  const row = db.prepare("SELECT status, selected, rejected_reason FROM campaign_company WHERE id=?").get(ccId) as any;
  assert.equal(row.status, "rejected");
  assert.equal(row.selected, 0);
  assert.match(row.rejected_reason, /tennis academy/);
});

test("footer defaults to OFF", () => {
  const db = fresh();
  assert.equal(getSetting<{ footerEnabled: boolean }>(db, "sending", { footerEnabled: true }).footerEnabled, false);
});

test("settings round-trip and overwrite", () => {
  const db = fresh();
  setSetting(db, "sending", { dailyLimit: 5, footerEnabled: true });
  assert.equal(getSetting<{ dailyLimit: number }>(db, "sending", { dailyLimit: 0 }).dailyLimit, 5);
});

test("a contact cannot exist without a provenance URL", () => {
  const db = fresh();
  const { companyId, t } = seedChain(db);
  assert.throws(
    () => db.prepare("INSERT INTO contact (id,company_id,email,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(ulid(), companyId, "b@example.com", "published", t, t),
    /NOT NULL/i,
  );
});

test("contact source_kind is constrained to the four tiers", () => {
  const db = fresh();
  const { companyId, t } = seedChain(db);
  assert.throws(
    () => db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ulid(), companyId, "c@example.com", "https://x", "guessed", t, t),
    /CHECK/i,
  );
});

test("the same email cannot be stored twice for one company, case-insensitively", () => {
  const db = fresh();
  const { companyId, t } = seedChain(db);
  assert.throws(
    () => db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ulid(), companyId, "A@Example.com", "https://x", "published", t, t),
    /UNIQUE/i,
  );
});

test("an email may not be personalised with an unverified claim", () => {
  const db = fresh();
  const { campaignId, companyId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);

  const unverified = ulid();
  db.prepare("INSERT INTO claim (id,company_id,claim,source_url,quote,verified,created_at) VALUES (?,?,?,?,?,0,?)")
    .run(unverified, companyId, "They use Wix", "https://example.com", "Powered by Wix", t);

  assert.throws(
    () => db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(ulid(), draftId, 1, "hi", "body", "llm", JSON.stringify([{ claim_id: unverified }]), t),
    /unverified claim/,
  );
});

test("an email may not cite a claim that does not exist at all", () => {
  const db = fresh();
  const { campaignId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);
  assert.throws(
    () => db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(ulid(), draftId, 1, "hi", "body", "llm", JSON.stringify([{ claim_id: "NOPE" }]), t),
    /missing or unverified claim/,
  );
});

test("a verified claim is accepted, and an empty personalization is fine", () => {
  const db = fresh();
  const { campaignId, companyId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);
  const verified = ulid();
  db.prepare("INSERT INTO claim (id,company_id,claim,source_url,quote,verified,verify_method,created_at) VALUES (?,?,?,?,?,1,'exact',?)")
    .run(verified, companyId, "They use Wix", "https://example.com", "Powered by Wix", t);

  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(ulid(), draftId, 1, "hi", "body", "llm", JSON.stringify([{ claim_id: verified, source_url: "https://example.com" }]), t));
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,personalization,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(ulid(), draftId, 2, "hi", "body", "human", "[]", t));
});

test("email_draft_current resolves to MAX(version), so we can never send a stale draft", () => {
  const db = fresh();
  const { campaignId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);
  for (const [v, subj] of [[1, "first"], [2, "second"], [3, "third"]] as Array<[number, string]>) {
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(ulid(), draftId, v, subj, "b", "llm", t);
  }
  const row = db.prepare("SELECT version, subject FROM email_draft_current WHERE draft_id = ?").get(draftId) as { version: number; subject: string };
  assert.equal(row.version, 3);
  assert.equal(row.subject, "third");
});

test("a draft can only have one live send - the DB prevents double-sends", () => {
  const db = fresh();
  const { campaignId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid(), versionId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(versionId, draftId, 1, "s", "b", "llm", t);

  const send = (status: string, msgId: string) =>
    db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(ulid(), draftId, versionId, campaignId, contactId, "a@example.com", "me@me.com", "s", msgId, status, t);

  send("sent", "<1@coldcall>");
  assert.throws(() => send("queued", "<2@coldcall>"), /UNIQUE/i);
  // ...but a failed send does not block a retry.
  db.prepare("UPDATE send_log SET status='failed' WHERE draft_id=?").run(draftId);
  assert.doesNotThrow(() => send("queued", "<3@coldcall>"));
});

test("message_id is globally unique, so a reply can never match two sends", () => {
  const db = fresh();
  const { campaignId, ccId, contactId, t } = seedChain(db);
  const mk = (n: number) => {
    const draftId = ulid(), versionId = ulid();
    db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(draftId, campaignId, ccId, contactId, t + n, t);
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(versionId, draftId, 1, "s", "b", "llm", t);
    return { draftId, versionId };
  };
  const a = mk(1);
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(ulid(), a.draftId, a.versionId, campaignId, contactId, "x@y.com", "m@m.com", "s", "<dup@coldcall>", "sent", t);
  assert.throws(() => {
    // second draft would need its own contact; reuse is blocked by the draft unique index, so
    // assert on the message_id index directly.
    db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(ulid(), a.draftId, a.versionId, campaignId, contactId, "x@y.com", "m@m.com", "s", "<dup@coldcall>", "failed", t);
  }, /UNIQUE/i);
});

test("suppression patterns are unique case-insensitively", () => {
  const db = fresh();
  const t = now();
  db.prepare("INSERT INTO suppression (id,pattern,kind,reason,created_at) VALUES (?,?,?,?,?)")
    .run(ulid(), "no@thanks.com", "email", "unsubscribe", t);
  assert.throws(
    () => db.prepare("INSERT INTO suppression (id,pattern,kind,reason,created_at) VALUES (?,?,?,?,?)")
      .run(ulid(), "NO@Thanks.com", "email", "manual", t),
    /UNIQUE/i,
  );
});

test("a job cannot be queued twice for the same subject while one is live", () => {
  const db = fresh();
  const t = now();
  const ins = (status: string) =>
    db.prepare("INSERT INTO job (id,kind,subject_type,subject_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ulid(), "enrich", "company", "abc", status, t, t);
  ins("pending");
  assert.throws(() => ins("running"), /UNIQUE/i);
  db.prepare("UPDATE job SET status='done' WHERE subject_id='abc'").run();
  assert.doesNotThrow(() => ins("pending"));
});

test("crash recovery re-runs jobs but never re-sends a message that may have left", () => {
  const db = fresh();
  const { campaignId, ccId, contactId, t } = seedChain(db);
  const draftId = ulid(), versionId = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(draftId, campaignId, ccId, contactId, t, t);
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(versionId, draftId, 1, "s", "b", "llm", t);
  db.prepare("INSERT INTO job (id,kind,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(ulid(), "enrich", "running", t, t);
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(ulid(), draftId, versionId, campaignId, contactId, "x@y.com", "m@m.com", "s", "<r@coldcall>", "sending", t);

  assert.deepEqual(recoverAfterCrash(db), { jobsReset: 1, sendsFailed: 1 });
  assert.equal((db.prepare("SELECT status FROM job").get() as { status: string }).status, "pending");
  assert.equal((db.prepare("SELECT status,error_code FROM send_log").get() as { status: string; error_code: string }).status, "failed");
});

test("tx rolls back fully on error", () => {
  const db = fresh();
  const t = now();
  assert.throws(() =>
    tx(db, () => {
      db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(ulid(), "keep", t, t);
      throw new Error("boom");
    }), /boom/);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM product").get() as { c: number }).c, 0);
});

test("ulid sorts chronologically and is monotonic within a millisecond", () => {
  const ids = Array.from({ length: 500 }, () => ulid());
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, 500);
  assert.ok(ulid(1_000) < ulid(2_000));
  assert.equal(ulid(Date.now()).length, 26);
});

test("sending starts PAUSED - nothing leaves the machine without an explicit start", () => {
  const db = fresh();
  assert.equal(getSetting<{ paused: boolean }>(db, "sending", { paused: false }).paused, true);
});
