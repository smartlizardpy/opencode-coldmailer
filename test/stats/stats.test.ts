/** Dashboard numbers and CSV export. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults } from "../../src/server/db/settings.ts";
import { dashboardStats, localDay, toCsv, EXPORTS } from "../../src/server/stats.ts";

function world() {
  const db = openDb(":memory:"); migrate(db); seedDefaults(db);
  const t = now();
  const ids = { p: ulid(), c: ulid(), co: ulid(), cc: ulid(), ct: ulid() };
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(ids.p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.c, ids.p, "C", t, t);
  db.prepare("INSERT INTO company (id,domain,name,city,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(ids.co, "x.com", "X Ltd", "Durham", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,status,created_at,updated_at) VALUES (?,?,?,'contacts_found',?,?)").run(ids.cc, ids.c, ids.co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ids.ct, ids.co, "a@x.com", "https://x.com/contact", "published", t, t);
  return { db, ids };
}

function draft(db: any, ids: any, status = "needs_review", flags = "[]") {
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(d, ids.c, ids.cc, ids.ct, status, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,quality_flags,word_count,created_at) VALUES (?,?,?,?,?,'llm',?,?,?)")
    .run(v, d, 1, "s", "b", flags, 10, now());
  return { d, v };
}

test("the funnel counts each stage from the data, not from a status field", () => {
  const { db, ids } = world();
  draft(db, ids);
  const s = dashboardStats(db);
  assert.equal(s.funnel.discovered, 1);
  assert.equal(s.funnel.researched, 1);
  assert.equal(s.funnel.contacted, 1);
  assert.equal(s.funnel.drafted, 1);
  assert.equal(s.funnel.approved, 0);
  assert.equal(s.funnel.sent, 0);
});

test("discarded drafts are not counted as drafted", () => {
  const { db, ids } = world();
  draft(db, ids, "discarded");
  assert.equal(dashboardStats(db).funnel.drafted, 0);
});

test("flagged drafts are counted separately from the review queue", () => {
  const { db, ids } = world();
  draft(db, ids, "needs_review", "[]");
  const s0 = dashboardStats(db);
  assert.equal(s0.needsReview, 1);
  assert.equal(s0.flaggedDrafts, 0);

  const { db: db2, ids: ids2 } = world();
  draft(db2, ids2, "needs_review", JSON.stringify([{ flag: "flattery", detail: "x" }]));
  const s1 = dashboardStats(db2);
  assert.equal(s1.needsReview, 1);
  assert.equal(s1.flaggedDrafts, 1);
});

test("reply rate is null when nothing has been sent, not zero", () => {
  const { db } = world();
  assert.equal(dashboardStats(db).replyRate, null,
    "0% and 'no data' are different things and must not look the same");
});

test("the 14-day series has 14 LOCAL-day buckets ending today", () => {
  const { db } = world();
  const s = dashboardStats(db);
  assert.equal(s.sendsByDay.length, 14);
  const d = new Date();
  const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Not toISOString(): that converts local midnight to UTC and labels the bucket with
  // yesterday for anyone east of UTC, which is every UK user in summer.
  assert.equal(s.sendsByDay.at(-1)!.day, localToday);
  assert.equal(new Set(s.sendsByDay.map((x) => x.day)).size, 14, "no duplicate or skipped days");
});

test("a send made today lands in today's bucket", () => {
  const { db, ids } = world();
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,created_at,updated_at) VALUES (?,?,?,?,'sent',?,?)")
    .run(d, ids.c, ids.cc, ids.ct, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(v, d, 1, "s", "b", now());
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
    .run(ulid(), d, v, ids.c, ids.ct, "a@x.com", "m@m.com", "s", "<t@cc>", Date.now(), now());
  const s = dashboardStats(db);
  assert.equal(s.sendsByDay.at(-1)!.sent, 1);
  assert.equal(s.sentLast24h, 1);
});

test("failure reasons are grouped and ranked", () => {
  const { db, ids } = world();
  for (const msg of ["no publishable address found on the site", "no publishable address found on the site", "could not fetch any page from this site"]) {
    const cc = ulid(), co = ulid();
    db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(co, `${cc}.com`, "Y", now(), now());
    db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,status,error_message,created_at,updated_at) VALUES (?,?,?,'failed',?,?,?)")
      .run(cc, ids.c, co, msg, now(), now());
  }
  const top = dashboardStats(db).topFailures;
  assert.equal(top[0].count, 2);
  assert.match(top[0].reason, /no publishable address/);
});

test("stats can be scoped to one campaign", () => {
  const { db, ids } = world();
  draft(db, ids);
  assert.equal(dashboardStats(db, ids.c).funnel.drafted, 1);
  assert.equal(dashboardStats(db, "other-campaign").funnel.drafted, 0);
});

test("CSV neutralises formulas so a cell cannot execute in a spreadsheet", () => {
  for (const evil of ["=cmd|'/c calc'!A1", "+1+1", "-2+3", "@SUM(A1)"]) {
    const csv = toCsv([{ a: evil }]);
    assert.ok(csv.includes(`"'${evil}"`), `${evil} must be prefixed with an apostrophe`);
  }
});

test("CSV escapes quotes and keeps newlines inside a field", () => {
  const csv = toCsv([{ a: 'he said "hi"', b: "line1\nline2" }]);
  assert.ok(csv.includes('"he said ""hi"""'));
  assert.ok(csv.includes('"line1\nline2"'));
});

test("CSV of an empty result is empty, not a header-only lie", () => {
  assert.equal(toCsv([]), "");
});

test("every export shape returns rows for a real campaign", () => {
  const { db, ids } = world();
  draft(db, ids);
  assert.equal((EXPORTS.companies(db, ids.c) as unknown[]).length, 1);
  assert.equal((EXPORTS.contacts(db, ids.c) as unknown[]).length, 1);
  assert.equal((EXPORTS.drafts(db, ids.c) as unknown[]).length, 1);
  assert.equal((EXPORTS.sends(db, ids.c) as unknown[]).length, 0);
});

test("a company that could not be fetched does not count as researched", () => {
  const { db, ids } = world();
  db.prepare("UPDATE campaign_company SET status='failed' WHERE id=?").run(ids.cc);
  const s = dashboardStats(db);
  assert.equal(s.funnel.discovered, 1);
  assert.equal(s.funnel.researched, 0,
    "counting a failed fetch as researched hides the drop it caused, which is the one thing the funnel is for");
});

test("a company rejected after being fetched DOES count as researched", () => {
  const { db, ids } = world();
  db.prepare("UPDATE campaign_company SET status='rejected' WHERE id=?").run(ids.cc);
  assert.equal(dashboardStats(db).funnel.researched, 1,
    "we did fetch and judge it - the drop belongs at the next stage, not this one");
});

test("a reply rate is not offered until enough has been sent to mean anything", () => {
  // One reply from one send is arithmetically 100% and a completely false impression. The
  // dashboard reads this flag to decide whether to show a percentage or the raw counts.
  const { db, ids } = world();
  // A distinct contact each time: the schema allows only one draft per campaign, contact
  // and step, which is the constraint that stops a person being mailed twice for one step.
  const send = (replied: boolean) => {
    const ct = ulid();
    db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ct, ids.co, `${ct}@x.com`, "https://x.com/contact", "published", now(), now());
    const { d, v } = draft(db, { ...ids, ct }, "sent");
    const s = ulid();
    db.prepare(`INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)`)
      .run(s, d, v, ids.c, ct, `${ct}@x.com`, "me@me.com", "s", `<${s}@x>`, now(), now());
    if (replied) {
      db.prepare(`INSERT INTO reply (id,send_log_id,campaign_id,contact_id,from_email,subject,body_text,received_at,handled,created_at,kind)
                  VALUES (?,?,?,?,?,?,?,?,0,?,'reply')`)
        .run(ulid(), s, ids.c, ct, `${ct}@x.com`, "re", "", now(), now());
    }
  };

  send(true);
  let s = dashboardStats(db);
  assert.equal(s.replyRate, 1, "the arithmetic is still correct");
  assert.equal(s.replyRateIsMeaningful, false, "but it is not worth showing as a rate");

  for (let i = 0; i < 18; i++) send(false);
  assert.equal(dashboardStats(db).replyRateIsMeaningful, false, "19 sends is still under the bar");

  send(false);
  s = dashboardStats(db);
  assert.equal(s.funnel.sent, 20);
  assert.equal(s.replyRateIsMeaningful, true);
  assert.equal(s.replyRate, 0.05);
});

test("with nothing sent there is no rate at all, meaningful or otherwise", () => {
  const s = dashboardStats(world().db);
  assert.equal(s.replyRate, null);
  assert.equal(s.replyRateIsMeaningful, false);
});

test("a date a person reads is built from local parts, never from UTC", () => {
  // toISOString() converts to UTC first, so for anyone east of UTC local midnight becomes the
  // previous day. That mislabelled every dashboard bar in BST once, and it was still stamping
  // CSV exports made after local midnight with yesterday's date.
  const justAfterMidnight = new Date();
  justAfterMidnight.setHours(0, 30, 0, 0);
  const expected = `${justAfterMidnight.getFullYear()}-${
    String(justAfterMidnight.getMonth() + 1).padStart(2, "0")}-${
    String(justAfterMidnight.getDate()).padStart(2, "0")}`;

  assert.equal(localDay(justAfterMidnight), expected);
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/);

  // Months and days are zero-padded, so the strings sort chronologically.
  assert.equal(localDay(new Date(2026, 0, 5, 12, 0)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});
