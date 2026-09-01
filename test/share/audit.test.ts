/**
 * The audit trail.
 *
 * The question it exists to answer is "who approved the one that bounced" — which the send log
 * cannot, because every row in it says only that this machine sent it. So the tests are about
 * whether a row is written, whether it names the actual recipient, and whether it survives the
 * moment someone wants to read it: after the session that did it has been revoked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { auditSummary, describeAction, listAudit, recordAudit } from "../../src/server/http/audit.ts";
import { createInvite, redeemInvite, revokeInvite, sessionFor } from "../../src/server/http/access.ts";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

/** product -> campaign -> company -> contact -> draft, so a draft has a real recipient. */
function seedDraft(db: ReturnType<typeof fresh>) {
  const t = now();
  const p = ulid(), camp = ulid(), co = ulid(), cc = ulid(), ct = ulid(), d = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(camp, p, "Haber Siteleri", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(co, "thenorthernecho.co.uk", "The Northern Echo", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(cc, camp, co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ct, co, "editor@thenorthernecho.co.uk", "https://x/contact", "published", t, t);
  db.prepare(
    "INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(d, camp, cc, ct, t, t);
  return { campaignId: camp, ccId: cc, draftId: d };
}

/* ------------------------------------------------------------- describing */

test("an approval names who it was actually addressed to", () => {
  const db = fresh();
  const { draftId } = seedDraft(db);
  const what = describeAction(db, "POST", `/api/drafts/${draftId}/approve`, {});
  assert.equal(what?.action, "Approved a draft");
  assert.equal(what?.detail, "editor@thenorthernecho.co.uk at The Northern Echo",
    "a row saying only 'approved a draft' does not answer the question this table exists for");
});

test("a send by hand is described as what it is", () => {
  const db = fresh();
  const { draftId } = seedDraft(db);
  assert.equal(describeAction(db, "POST", `/api/drafts/${draftId}/send-now`, {})?.action,
    "Sent an email immediately");
});

test("campaign actions carry the campaign's name, not its id", () => {
  const db = fresh();
  const { campaignId } = seedDraft(db);
  const what = describeAction(db, "POST", `/api/campaigns/${campaignId}/run`, {});
  assert.equal(what?.action, "Started research and writing");
  assert.equal(what?.detail, "Haber Siteleri");
});

test("an export is recorded even though it is a GET", () => {
  // A CSV is the only way data actually leaves through the shared link.
  const db = fresh();
  const { campaignId } = seedDraft(db);
  const what = describeAction(db, "GET", `/api/campaigns/${campaignId}/export/contacts`, {});
  assert.equal(what?.action, "Exported contacts as CSV");
});

test("ordinary reads are not recorded", () => {
  const db = fresh();
  assert.equal(describeAction(db, "GET", "/api/campaigns", {}), undefined);
  assert.equal(describeAction(db, "GET", "/api/drafts/01ABC", {}), undefined);
  assert.equal(describeAction(db, "GET", "/api/stats", {}), undefined);
});

test("a route nobody described still gets a row rather than vanishing", () => {
  const db = fresh();
  const what = describeAction(db, "POST", "/api/something/added/later", {});
  assert.equal(what?.action, "POST /api/something/added/later");
});

test("a literal path is not swallowed by the :id rule that follows it", () => {
  const db = fresh();
  assert.equal(describeAction(db, "POST", "/api/campaigns/suggest", {})?.action,
    "Asked for campaign suggestions");
  assert.equal(describeAction(db, "POST", "/api/campaigns/test-target", { website: "a.com" })?.action,
    "Checked a site against the targeting gate");
  assert.equal(describeAction(db, "POST", "/api/drafts/bulk-approve", { ids: [1, 2, 3] })?.action,
    "Bulk-approved 3 drafts");
});

test("a detail is truncated rather than storing whatever was pasted", () => {
  const db = fresh();
  const row = recordAudit(db, {
    sessionId: null, label: "x", method: "POST", path: "/api/suppression",
    action: "a".repeat(500), detail: "b".repeat(500), status: 200,
  });
  assert.equal(row?.action.length, 200);
  assert.equal(row?.detail.length, 200);
});

/* ------------------------------------------------------------- recording */

test("what a session did outlives the session being revoked", () => {
  // Revoking is exactly the moment somebody wants to read this table, so a cascade here would
  // erase the evidence at the instant it became interesting.
  const db = fresh();
  const { invite, token } = createInvite(db, "Co-founder");
  const s = sessionFor(db, redeemInvite(db, token, "ua").token)!;
  recordAudit(db, {
    sessionId: s.id, label: s.label, method: "POST", path: "/api/drafts/x/approve",
    action: "Approved a draft", detail: "someone@example.com", status: 200,
  });

  revokeInvite(db, invite.id);
  const rows = listAudit(db);
  assert.equal(rows.length, 1, "the record must survive the revoke");
  assert.equal(rows[0].label, "Co-founder", "and must still say who did it");
});

test("a refusal is recorded, because it is the most interesting line here", () => {
  const db = fresh();
  recordAudit(db, {
    sessionId: null, label: "Co-founder", method: "GET", path: "/api/settings",
    action: "GET /api/settings", detail: "", status: 403,
  });
  const [row] = listAudit(db);
  assert.equal(row.ok, 0);
  assert.equal(row.status, 403);
  assert.equal(listAudit(db, { failedOnly: true }).length, 1);
});

test("the feed is newest first and bounded", () => {
  const db = fresh();
  for (let i = 0; i < 30; i++) {
    recordAudit(db, { sessionId: null, label: "x", method: "POST", path: "/p",
      action: `action ${i}`, detail: "", status: 200 });
  }
  const rows = listAudit(db, { limit: 5 });
  assert.equal(rows.length, 5);
  assert.equal(rows[0].action, "action 29");
  assert.ok(listAudit(db, { limit: 9999 }).length <= 500, "an unbounded limit is still capped");
});

test("the summary counts the things worth glancing at", () => {
  const db = fresh();
  const add = (action: string, status = 200) => recordAudit(db, {
    sessionId: null, label: "x", method: "POST", path: "/p", action, detail: "", status });
  add("Sent an email immediately");
  add("Approved a draft");
  add("Bulk-approved 3 drafts");
  add("GET /api/keys", 403);
  const sum = auditSummary(db);
  assert.equal(sum.today, 4);
  assert.equal(sum.sends, 1);
  assert.equal(sum.approvals, 2, "a bulk approve is an approval too");
  assert.equal(sum.refused, 1);
  assert.ok(sum.lastAt);
});

test("a broken audit write never takes the request down with it", () => {
  // The action already happened. Losing the note about it is the lesser of the two failures.
  const db = fresh();
  db.exec("DROP TABLE share_audit");
  assert.doesNotThrow(() => recordAudit(db, {
    sessionId: null, label: "x", method: "POST", path: "/p", action: "a", detail: "", status: 200 }));
});
