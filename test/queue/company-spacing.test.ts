/**
 * Per-company send spacing.
 *
 * Three people at one publisher, sent 60-180s apart, arrive as a blast: the recipients compare
 * notes, and the receiving server sees three near-identical cold emails to one domain inside
 * ten minutes. Drafts are approved a company at a time, so plain oldest-first ordering produced
 * exactly that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults, getSetting, setSetting } from "../../src/server/db/settings.ts";
import { nextApprovedDraftId, heldForCompanyGap, companyGapMs } from "../../src/server/queue/sendQueue.ts";

const HOUR = 3600_000;

/** Two companies, `n` approved drafts each, so ordering across companies is observable. */
function world(perCompany = 2) {
  const db = openDb(":memory:");
  migrate(db);
  seedDefaults(db);
  const t = now();
  const p = ulid(), camp = ulid();
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(camp, p, "C", t, t);

  const companies: Record<string, { co: string; cc: string; drafts: string[] }> = {};
  let approvedAt = t;
  for (const domain of ["alpha.com", "beta.com"]) {
    const co = ulid(), cc = ulid();
    db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(co, domain, domain, t, t);
    db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,status,created_at,updated_at) VALUES (?,?,?,'contacts_found',?,?)")
      .run(cc, camp, co, t, t);
    const drafts: string[] = [];
    for (let i = 0; i < perCompany; i++) {
      const ct = ulid(), d = ulid(), v = ulid();
      db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(ct, co, `p${i}@${domain}`, `https://${domain}/contact`, "published", t, t);
      db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,approved_at,created_at,updated_at) VALUES (?,?,?,?,'approved',?,?,?)")
        .run(d, camp, cc, ct, ++approvedAt, t, t);
      db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,1,?,?,'llm',?)")
        .run(v, d, "s", "b", t);
      drafts.push(d);
    }
    companies[domain] = { co, cc, drafts };
  }
  return { db, camp, companies };
}

/** Record a sent message for a draft, at a given time. */
function markSent(db: ReturnType<typeof world>["db"], camp: string, draftId: string, sentAt: number) {
  const d = db.prepare("SELECT campaign_company_id, contact_id FROM email_draft WHERE id=?").get(draftId) as any;
  const v = db.prepare("SELECT id FROM email_draft_version WHERE draft_id=?").get(draftId) as any;
  db.prepare(`INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)`)
    .run(ulid(), draftId, v.id, camp, d.contact_id, "x@y.com", "me@me.com", "s", `<${ulid()}@t>`, sentAt, sentAt);
  db.prepare("UPDATE email_draft SET status='sent' WHERE id=?").run(draftId);
}

test("with nothing sent yet, the oldest approved draft goes first", () => {
  const { db, companies } = world();
  assert.equal(nextApprovedDraftId(db), companies["alpha.com"].drafts[0]);
});

test("after emailing one person, the next send goes to a DIFFERENT company", () => {
  const { db, camp, companies } = world();
  const first = nextApprovedDraftId(db)!;
  markSent(db, camp, first, Date.now());
  const second = nextApprovedDraftId(db)!;
  assert.ok(companies["beta.com"].drafts.includes(second),
    "the second send must not be another person at the company we just emailed");
});

test("a second person at the same company is held back, not dropped", () => {
  const { db, camp, companies } = world(2);
  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now());
  // Beta is still available, so the queue is not stuck...
  assert.ok(companies["beta.com"].drafts.includes(nextApprovedDraftId(db)!));
  // ...and once beta is done too, alpha's second person is reported as held, not as "nothing".
  markSent(db, camp, companies["beta.com"].drafts[0], Date.now());
  markSent(db, camp, companies["beta.com"].drafts[1], Date.now());
  assert.equal(nextApprovedDraftId(db), undefined, "everything left is inside the gap");
  assert.equal(heldForCompanyGap(db), 1, "and it is reported as held, so it is not mistaken for an empty queue");
});

test("once the gap has passed, the held draft is released", () => {
  const { db, camp, companies } = world(2);
  const longAgo = Date.now() - 5 * HOUR;
  markSent(db, camp, companies["alpha.com"].drafts[0], longAgo);
  markSent(db, camp, companies["beta.com"].drafts[0], longAgo);
  markSent(db, camp, companies["beta.com"].drafts[1], longAgo);
  assert.equal(nextApprovedDraftId(db), companies["alpha.com"].drafts[1]);
  assert.equal(heldForCompanyGap(db), 0);
});

test("the company that has been left alone longest goes first", () => {
  const { db, camp, companies } = world(2);
  // alpha emailed 10h ago, beta 6h ago — with a 1h gap both are eligible, alpha is staler.
  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now() - 10 * HOUR);
  markSent(db, camp, companies["beta.com"].drafts[0], Date.now() - 6 * HOUR);
  assert.equal(nextApprovedDraftId(db, undefined, { gapMs: HOUR }), companies["alpha.com"].drafts[1]);
});

test("a company never contacted always beats one that has been", () => {
  const { db, camp, companies } = world(2);
  // Alpha was emailed long enough ago to be eligible again, but beta has never been touched.
  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now() - 99 * HOUR);
  assert.ok(companies["beta.com"].drafts.includes(nextApprovedDraftId(db, undefined, { gapMs: HOUR })!));
});

test("the gap spans campaigns — the same company in two campaigns is still one company", () => {
  const { db, camp, companies } = world(1);
  const t = now();
  const p = db.prepare("SELECT id FROM product LIMIT 1").get() as any;
  const camp2 = ulid(), cc2 = ulid(), ct2 = ulid(), d2 = ulid(), v2 = ulid();
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(camp2, p.id, "C2", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,status,created_at,updated_at) VALUES (?,?,?,'contacts_found',?,?)")
    .run(cc2, camp2, companies["alpha.com"].co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ct2, companies["alpha.com"].co, "other@alpha.com", "https://alpha.com/c", "published", t, t);
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,approved_at,created_at,updated_at) VALUES (?,?,?,?,'approved',?,?,?)")
    .run(d2, camp2, cc2, ct2, t, t, t);
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,1,?,?,'llm',?)")
    .run(v2, d2, "s", "b", t);

  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now());
  // beta is the only eligible one; the second campaign's alpha draft is inside the gap.
  assert.ok(companies["beta.com"].drafts.includes(nextApprovedDraftId(db)!));
  markSent(db, camp, companies["beta.com"].drafts[0], Date.now());
  assert.equal(nextApprovedDraftId(db), undefined, "two campaigns hitting one company is the same problem");
});

test("a failed send does not start the gap — nothing arrived", () => {
  const { db, camp, companies } = world(2);
  const d = companies["alpha.com"].drafts[0];
  const v = db.prepare("SELECT id FROM email_draft_version WHERE draft_id=?").get(d) as any;
  const c = db.prepare("SELECT contact_id FROM email_draft WHERE id=?").get(d) as any;
  db.prepare(`INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,'failed',?)`)
    .run(ulid(), d, v.id, camp, c.contact_id, "x@y.com", "me@me.com", "s", `<${ulid()}@t>`, now());
  assert.equal(nextApprovedDraftId(db), d, "a failure must not lock the company out for four hours");
});

test("the gap is configurable, and zero stops it BLOCKING anything", () => {
  // Two separate behaviours share this code, and only one of them is the gap:
  //   - the gap EXCLUDES a company emailed too recently
  //   - the ordering PREFERS whichever company has been left alone longest
  // Setting the gap to zero turns off the exclusion. It does not, and should not, turn off the
  // preference: given a choice, going to a company you have not touched is simply better.
  const { db, camp, companies } = world(2);
  assert.equal(companyGapMs(db), 4 * HOUR, "four hours by default");
  setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), companyGapHours: 0 });
  assert.equal(companyGapMs(db), 0);

  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now());
  assert.equal(heldForCompanyGap(db, { gapMs: 0 }), 0, "with the gap off, nothing is held back");
  assert.ok(companies["beta.com"].drafts.includes(nextApprovedDraftId(db, undefined, { gapMs: 0 })!),
    "an untouched company is still preferred");

  // Once beta is exhausted, alpha's second person sends immediately rather than waiting.
  markSent(db, camp, companies["beta.com"].drafts[0], Date.now());
  markSent(db, camp, companies["beta.com"].drafts[1], Date.now());
  assert.equal(nextApprovedDraftId(db, undefined, { gapMs: 0 }), companies["alpha.com"].drafts[1],
    "with the gap off there is no waiting, which is the whole point of setting it to zero");
});

test("scoping to one campaign still respects the gap", () => {
  const { db, camp, companies } = world(2);
  markSent(db, camp, companies["alpha.com"].drafts[0], Date.now());
  const next = nextApprovedDraftId(db, camp)!;
  assert.ok(companies["beta.com"].drafts.includes(next));
});
