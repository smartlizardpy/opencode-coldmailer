/**
 * Follow-up rules. Every test here is a way a sequence could email someone it must not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults } from "../../src/server/db/settings.ts";
import { dueFollowUps, listSteps, seedDefaultSteps, setSteps, upcomingFollowUps } from "../../src/server/queue/sequences.ts";
import { suppress } from "../../src/server/queue/sendQueue.ts";

const DAY = 24 * 3600_000;

function world() {
  const db = openDb(":memory:"); migrate(db); seedDefaults(db);
  const t = now();
  const ids = { p: ulid(), c: ulid(), co: ulid(), cc: ulid(), ct: ulid() };
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(ids.p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.c, ids.p, "C", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.co, "x.com", "X Ltd", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.cc, ids.c, ids.co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ids.ct, ids.co, "a@x.com", "https://x.com/contact", "published", t, t);
  seedDefaultSteps(db, ids.c);
  return { db, ids };
}

/** Send step `step` `daysAgo` days ago. */
function sent(db: any, ids: any, step: number, daysAgo: number) {
  const draftId = ulid(), versionId = ulid(), sendId = ulid();
  const at = Date.now() - daysAgo * DAY;
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'sent',?,?,?)")
    .run(draftId, ids.c, ids.cc, ids.ct, step, at, at);
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(versionId, draftId, 1, "s", "b", at);
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
    .run(sendId, draftId, versionId, ids.c, ids.ct, "a@x.com", "me@me.com", "s", `<${sendId}@cc>`, at, at);
  return { draftId, sendId };
}

test("default sequence is two follow-ups, at 4 and 7 days", () => {
  const { db, ids } = world();
  const steps = listSteps(db, ids.c);
  assert.deepEqual(steps.map((s) => [s.step_number, s.delay_days]), [[2, 4], [3, 7]]);
});

test("no follow-up before the delay has elapsed", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 2);                       // sent 2 days ago, step 2 waits 4
  assert.deepEqual(dueFollowUps(db, ids.c), []);
});

test("follow-up becomes due once the delay passes", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 5);
  const due = dueFollowUps(db, ids.c);
  assert.equal(due.length, 1);
  assert.equal(due[0].step, 2);
  assert.equal(due[0].email, "a@x.com");
  assert.match(due[0].instruction, /Do not repeat it/);
});

test("a contact who replied is NEVER followed up", () => {
  const { db, ids } = world();
  const { sendId } = sent(db, ids, 1, 10);
  assert.equal(dueFollowUps(db, ids.c).length, 1, "due before the reply");
  db.prepare("INSERT INTO reply (id,send_log_id,campaign_id,contact_id,from_email,received_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(ulid(), sendId, ids.c, ids.ct, "a@x.com", now(), now());
  assert.deepEqual(dueFollowUps(db, ids.c), [], "a reply must stop the sequence dead");
});

test("a suppressed address is never followed up", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 10);
  assert.equal(dueFollowUps(db, ids.c).length, 1);
  suppress(db, "a@x.com", "unsubscribe");
  assert.deepEqual(dueFollowUps(db, ids.c), []);
});

test("a suppressed DOMAIN is never followed up", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 10);
  suppress(db, "@x.com", "manual");
  assert.deepEqual(dueFollowUps(db, ids.c), []);
});

test("the same step is never generated twice", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 10);
  assert.equal(dueFollowUps(db, ids.c).length, 1);
  // draft step 2 without sending it
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'needs_review',2,?,?)")
    .run(ulid(), ids.c, ids.cc, ids.ct, now(), now());
  assert.deepEqual(dueFollowUps(db, ids.c), [], "already drafted, must not queue again");
});

test("the sequence advances step by step and then stops", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 20);
  assert.equal(dueFollowUps(db, ids.c)[0].step, 2);
  sent(db, ids, 2, 12);
  assert.equal(dueFollowUps(db, ids.c)[0].step, 3, "after step 2 lands, step 3 is next");
  sent(db, ids, 3, 1);
  assert.deepEqual(dueFollowUps(db, ids.c), [], "there is no step 4 - the sequence ends");
});

test("a disabled step is skipped entirely", () => {
  const { db, ids } = world();
  setSteps(db, ids.c, [{ step_number: 2, delay_days: 1, instruction: "x", enabled: false }]);
  sent(db, ids, 1, 10);
  assert.deepEqual(dueFollowUps(db, ids.c), []);
});

test("a follow-up is never queued for an email that only failed to send", () => {
  const { db, ids } = world();
  const draftId = ulid(), versionId = ulid();
  const at = Date.now() - 10 * DAY;
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'failed',1,?,?)")
    .run(draftId, ids.c, ids.cc, ids.ct, at, at);
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(versionId, draftId, 1, "s", "b", at);
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'failed',?)")
    .run(ulid(), draftId, versionId, ids.c, ids.ct, "a@x.com", "me@me.com", "s", "<f@cc>", at);
  assert.deepEqual(dueFollowUps(db, ids.c), [], "nothing was ever delivered, so there is nothing to follow up");
});

test("upcoming shows the next touch and when it lands", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 1);
  const up = upcomingFollowUps(db, ids.c);
  assert.equal(up.length, 1);
  assert.equal(up[0].step, 2);
  assert.ok(up[0].dueAt > Date.now(), "not due yet");
  assert.equal(up[0].company, "X Ltd");
});

test("setSteps refuses to create a step 1 - that is the initial email", () => {
  const { db, ids } = world();
  setSteps(db, ids.c, [{ step_number: 1, delay_days: 1, instruction: "nope" },
                       { step_number: 2, delay_days: 3, instruction: "ok" }]);
  assert.deepEqual(listSteps(db, ids.c).map((s) => s.step_number), [2]);
});

/* Cross-campaign duplicate protection. */
import { contactedElsewhere, sendOne } from "../../src/server/queue/sendQueue.ts";

test("a contact already emailed from another campaign is detected", () => {
  const { db, ids } = world();
  const other = ulid();
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(other, ids.p, "Other campaign", now(), now());
  assert.equal(contactedElsewhere(db, ids.ct, ids.c).contacted, false);

  // a send from the OTHER campaign to the same person
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'sent',1,?,?)")
    .run(d, other, ids.cc, ids.ct, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(v, d, 1, "s", "b", now());
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
    .run(ulid(), d, v, other, ids.ct, "a@x.com", "m@m.com", "s", "<o@cc>", Date.now(), now());

  const r = contactedElsewhere(db, ids.ct, ids.c);
  assert.equal(r.contacted, true);
  assert.equal(r.campaignName, "Other campaign");
});

test("a send within the SAME campaign is not treated as a cross-campaign duplicate", () => {
  const { db, ids } = world();
  sent(db, ids, 1, 5);
  assert.equal(contactedElsewhere(db, ids.ct, ids.c).contacted, false,
    "follow-ups in the same campaign are the point, not a duplicate");
});

test("sendOne refuses a contact already emailed from another campaign", async () => {
  const { db, ids } = world();
  const other = ulid();
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(other, ids.p, "Other campaign", now(), now());
  const d1 = ulid(), v1 = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'sent',1,?,?)")
    .run(d1, other, ids.cc, ids.ct, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(v1, d1, 1, "s", "b", now());
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
    .run(ulid(), d1, v1, other, ids.ct, "a@x.com", "m@m.com", "s", "<x@cc>", Date.now(), now());

  const d2 = ulid(), v2 = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'approved',1,?,?)")
    .run(d2, ids.c, ids.cc, ids.ct, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(v2, d2, 1, "s2", "b2", now());

  const out = await sendOne(db, d2, {
    host: "localhost", port: 1, secure: false, user: "u", fromEmail: "m@m.com", fromName: "",
  });
  assert.equal(out.sent, false);
  assert.equal((out as { code: string }).code, "ALREADY_CONTACTED",
    "must refuse BEFORE reaching SMTP");
});
