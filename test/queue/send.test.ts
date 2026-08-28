/**
 * The send path. Every guard here is a way a real person could receive an email they should
 * not have, or a good email could be silently dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now, type Db } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { seedDefaults, setSetting } from "../../src/server/db/settings.ts";
import { hasReplied, isTransientSmtpError, isSuppressed, sendGuards, sendOne, suppress, approveDraft } from "../../src/server/queue/sendQueue.ts";

const SMTP = { host: "127.0.0.1", port: 1, secure: false, user: "u", fromEmail: "me@me.com", fromName: "Me" };

function world() {
  const db = openDb(":memory:"); migrate(db); seedDefaults(db);
  setSetting(db, "sending", { dailyLimit: 30, minGapSeconds: 1, maxGapSeconds: 2, paused: false, footerEnabled: false, footerText: "" });
  const t = now();
  const ids = { p: ulid(), c: ulid(), co: ulid(), cc: ulid(), ct: ulid() };
  db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(ids.p, "P", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.c, ids.p, "C", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.co, "x.com", "X", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.cc, ids.c, ids.co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ids.ct, ids.co, "a@x.com", "https://x.com/contact", "published", t, t);
  return { db, ids };
}

function draft(db: Db, ids: any, status = "approved", step = 1) {
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(d, ids.c, ids.cc, ids.ct, status, step, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,'llm',?)")
    .run(v, d, 1, "subject", "body", now());
  return d;
}

test("a draft that is not approved is never sent", async () => {
  const { db, ids } = world();
  const out = await sendOne(db, draft(db, ids, "needs_review"), SMTP);
  assert.equal(out.sent, false);
  assert.equal((out as any).code, "NOT_APPROVED");
});

test("a suppressed address is refused at send time, not just at approval", async () => {
  const { db, ids } = world();
  const d = draft(db, ids);
  suppress(db, "a@x.com", "unsubscribe");            // added AFTER approval
  const out = await sendOne(db, d, SMTP);
  assert.equal((out as any).code, "SUPPRESSED");
  assert.equal((db.prepare("SELECT status FROM email_draft WHERE id=?").get(d) as any).status, "discarded");
});

test("a suppressed DOMAIN blocks the send too", async () => {
  const { db, ids } = world();
  const d = draft(db, ids);
  suppress(db, "@x.com", "manual");
  assert.equal((await sendOne(db, d, SMTP) as any).code, "SUPPRESSED");
});

test("someone who has replied never receives another email", async () => {
  const { db, ids } = world();
  const d = draft(db, ids, "approved", 2);           // an approved follow-up
  db.prepare("INSERT INTO reply (id,campaign_id,contact_id,from_email,received_at,created_at) VALUES (?,?,?,?,?,?)")
    .run(ulid(), ids.c, ids.ct, "a@x.com", now(), now());
  assert.ok(hasReplied(db, ids.ct));
  const out = await sendOne(db, d, SMTP);
  assert.equal((out as any).code, "ALREADY_REPLIED",
    "a reply can arrive between approving and sending - the guard has to hold here");
});

test("sending while paused is refused", async () => {
  const { db, ids } = world();
  setSetting(db, "sending", { ...(db.prepare("SELECT value FROM setting WHERE key='sending'").get() as any) && {}, dailyLimit: 30, paused: true });
  assert.equal((await sendOne(db, draft(db, ids), SMTP) as any).code, "PAUSED");
});

test("the daily cap is enforced from the send log, so a restart cannot get round it", async () => {
  const { db, ids } = world();
  setSetting(db, "sending", { dailyLimit: 1, minGapSeconds: 1, maxGapSeconds: 2, paused: false });
  // one already sent in the last 24h
  const d1 = draft(db, ids, "sent");
  const v1 = (db.prepare("SELECT id FROM email_draft_version WHERE draft_id=?").get(d1) as any).id;
  db.prepare("INSERT INTO send_log (id,draft_id,version_id,campaign_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?)")
    .run(ulid(), d1, v1, ids.c, ids.ct, "a@x.com", "me@me.com", "s", "<1@cc>", Date.now(), now());
  assert.equal(sendGuards(db).remaining, 0);
  // step 2, because one draft per contact per step is enforced by the schema
  assert.equal((await sendOne(db, draft(db, ids, "approved", 2), SMTP) as any).code, "DAILY_CAP");
});

test("a send with no stored password fails before touching the network", async () => {
  const { db, ids } = world();
  assert.equal((await sendOne(db, draft(db, ids), SMTP) as any).code, "NO_PASSWORD");
});

test("transient SMTP errors are retryable, permanent ones are not", () => {
  for (const e of [{ responseCode: 451 }, { responseCode: 421 }, new Error("connect ETIMEDOUT"), new Error("read ECONNRESET")]) {
    assert.equal(isTransientSmtpError(e), true, JSON.stringify(e));
  }
  for (const e of [{ responseCode: 550 }, { responseCode: 535 },
                   new Error("Invalid login: 535-5.7.8 Username and Password not accepted"),
                   new Error("550 5.1.1 The email account does not exist")]) {
    assert.equal(isTransientSmtpError(e), false, JSON.stringify(e));
  }
});

test("the guards run in an order that cannot leak an email", async () => {
  // Suppression and reply are both checked before anything opens a connection.
  const { db, ids } = world();
  const d = draft(db, ids);
  suppress(db, "a@x.com", "unsubscribe");
  db.prepare("INSERT INTO reply (id,campaign_id,contact_id,from_email,received_at,created_at) VALUES (?,?,?,?,?,?)")
    .run(ulid(), ids.c, ids.ct, "a@x.com", now(), now());
  const out = await sendOne(db, d, SMTP);
  assert.equal(out.sent, false);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM send_log").get() as any).c, 0,
    "nothing should even be claimed in the send log when a guard refuses");
});

test("approveDraft only promotes a draft that is actually reviewable", () => {
  const { db, ids } = world();
  const sent = draft(db, ids, "sent");
  approveDraft(db, sent);
  assert.equal((db.prepare("SELECT status FROM email_draft WHERE id=?").get(sent) as any).status, "sent",
    "an already-sent draft must not be re-approved back into the queue");
});
