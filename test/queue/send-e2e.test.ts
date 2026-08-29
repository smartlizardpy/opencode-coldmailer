/**
 * The send path, over a real socket, all the way to the wire.
 *
 * This was the one part of the product with no end-to-end test, on the grounds that testing it
 * needed a real mailbox and a real recipient. It needs neither: nodemailer only wants something
 * on the far end of a socket that speaks enough SMTP to say yes. test/fixtures/smtp-sink.ts is
 * that, and it has no upstream connection of any kind - nothing here can deliver mail.
 *
 * What these cover is everything between "you pressed approve" and the bytes on the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now, type Db } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { getSetting, seedDefaults, setSetting } from "../../src/server/db/settings.ts";
import { setSecret } from "../../src/server/mail/secrets.ts";
import { SendRunner, sendOne, suppress, unapproveDraft } from "../../src/server/queue/sendQueue.ts";
import { startSmtpSink, type SmtpSink } from "../fixtures/smtp-sink.ts";

function world(): { db: Db; ids: Record<string, string> } {
  const db = openDb(":memory:"); migrate(db); seedDefaults(db);
  setSetting(db, "sending", {
    dailyLimit: 30, minGapSeconds: 1, maxGapSeconds: 2, paused: false,
    footerEnabled: false, footerText: "",
  });
  const t = now();
  const ids = { p: ulid(), c: ulid(), co: ulid(), cc: ulid(), ct: ulid() };
  db.prepare("INSERT INTO product (id,name,sender_name,sender_title,sender_company,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ids.p, "Saha Feed", "Ozan Kaygusuz", "Kurucu", "Saha Feed", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.c, ids.p, "C", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.co, "haber.com.tr", "Haber", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(ids.cc, ids.c, ids.co, t, t);
  db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(ids.ct, ids.co, "editor@haber.com.tr", "https://haber.com.tr/kunye", "published", t, t);
  return { db, ids };
}

function approvedDraft(db: Db, ids: Record<string, string>, subject = "haftalık spor haber akışı",
                       body = "Merhaba,\n\nAnkara maçları için kısa bir sorum var.\n\nGörüşelim mi?"): string {
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,approved_at,created_at,updated_at) VALUES (?,?,?,?,'approved',1,?,?,?)")
    .run(d, ids.c, ids.cc, ids.ct, now(), now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,signature_mode,created_at) VALUES (?,?,?,?,?,'llm','rendered',?)")
    .run(v, d, 1, subject, body, now());
  return d;
}

const cfgFor = (sink: SmtpSink) => ({
  host: "127.0.0.1", port: sink.port, secure: false,
  user: "ozan@sahafeed.com", fromEmail: "ozan@sahafeed.com", fromName: "Ozan Kaygusuz",
});

async function withSink(fn: (sink: SmtpSink) => Promise<void>): Promise<void> {
  const sink = await startSmtpSink();
  try { await fn(sink); } finally { await sink.close(); }
}

test("an approved draft reaches the wire, and the wire gets what review showed", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "abcd efgh ijkl mnop");
    const draftId = approvedDraft(db, ids);

    const out = await sendOne(db, draftId, cfgFor(sink));
    assert.equal(out.sent, true, JSON.stringify(out));
    assert.equal(sink.messages.length, 1);

    const m = sink.messages[0];
    assert.deepEqual(m.to, ["editor@haber.com.tr"]);
    assert.equal(m.from, "ozan@sahafeed.com");
    assert.match(m.header("From") ?? "", /Ozan Kaygusuz/);
    // Plain text only: no HTML part, no images, nothing that could carry a tracking pixel.
    assert.match(m.header("Content-Type") ?? "", /^text\/plain/);
    assert.doesNotMatch(m.data, /text\/html/i);

    // The signature is rendered at send time, so it has to actually be in what leaves.
    assert.match(m.body(), /Ozan Kaygusuz/);
    assert.match(m.body(), /Saha Feed/);
  });
});

test("the Message-ID on the wire is the one recorded, so a reply can be matched", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);
    await sendOne(db, draftId, cfgFor(sink));

    const logged = db.prepare("SELECT message_id, status, to_email FROM send_log WHERE draft_id=?").get(draftId) as any;
    assert.equal(logged.status, "sent");
    assert.equal(logged.to_email, "editor@haber.com.tr");
    // This is the whole reply-matching mechanism: generated before sending, compared against
    // In-Reply-To afterwards. If they ever diverge, every reply becomes unmatched.
    assert.equal(sink.messages[0].header("Message-ID"), logged.message_id);
  });
});

test("a permanent rejection is recorded as failed, not retried forever", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);
    sink.failNext("550 5.1.1 No such user here");

    const out = await sendOne(db, draftId, cfgFor(sink));
    assert.equal(out.sent, false);
    assert.equal(sink.messages.length, 0, "nothing was accepted");

    const logged = db.prepare("SELECT status, error_message FROM send_log WHERE draft_id=?").get(draftId) as any;
    assert.equal(logged.status, "failed");
    assert.match(logged.error_message ?? "", /550/);
  });
});

test("the same draft cannot be sent twice", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);

    assert.equal((await sendOne(db, draftId, cfgFor(sink))).sent, true);
    const second = await sendOne(db, draftId, cfgFor(sink));

    assert.equal(second.sent, false, "the second attempt must not reach the wire");
    assert.equal(sink.messages.length, 1, "and the recipient must not get it twice");
  });
});

test("suppression is enforced against the socket, not just in the UI", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);
    suppress(db, "editor@haber.com.tr", "unsubscribe");   // added AFTER approval

    const out = await sendOne(db, draftId, cfgFor(sink));
    assert.equal((out as any).code, "SUPPRESSED");
    assert.equal(sink.messages.length, 0, "a suppressed address must never see a connection");
  });
});

test("nothing leaves outside the sending window", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);
    const hour = new Date().getHours();
    setSetting(db, "sending", {
      ...getSetting<any>(db, "sending", {}),
      window: { enabled: true, startHour: (hour + 2) % 24, endHour: (hour + 3) % 24, days: [0, 1, 2, 3, 4, 5, 6] },
    });

    const out = await sendOne(db, draftId, cfgFor(sink));
    assert.equal((out as any).code, "OUTSIDE_WINDOW");
    assert.equal(sink.messages.length, 0);
    assert.equal((db.prepare("SELECT status FROM email_draft WHERE id=?").get(draftId) as any).status, "approved",
      "still approved - it goes out when the window opens");
  });
});

test("the daily cap counts what actually left, and stops the next one", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), dailyLimit: 1 });

    assert.equal((await sendOne(db, approvedDraft(db, ids), cfgFor(sink))).sent, true);

    // A second contact, so nothing else can be what refuses it.
    const ct2 = ulid();
    db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ct2, ids.co, "spor@haber.com.tr", "https://haber.com.tr/kunye", "published", now(), now());
    const d2 = approvedDraft(db, { ...ids, ct: ct2 });

    const out = await sendOne(db, d2, cfgFor(sink));
    assert.equal((out as any).code, "DAILY_CAP");
    assert.equal(sink.messages.length, 1);
  });
});

test("a Turkish subject survives encoding intact", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    await sendOne(db, approvedDraft(db, ids, "haftalık spor haber akışı"), cfgFor(sink));

    // Non-ASCII headers are RFC 2047 encoded words, and a long one is split across several -
    // so the check is that it round-trips, not that it looks like the original on the wire.
    const decoded = (sink.messages[0].header("Subject") ?? "")
      .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_m, chunk: string) =>
        Buffer.from(chunk.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) =>
          String.fromCharCode(parseInt(h, 16))), "binary").toString("utf8"));
    assert.equal(decoded, "haftalık spor haber akışı");
    assert.match(sink.messages[0].body(), /Ankara maçları/);
  });
});

/* The drain loop - what actually runs when you press "Start sending". */

const settle = async (ms: number) => { await new Promise((r) => setTimeout(r, ms)); };

/** Drive the runner until `done()` or the deadline, so a stall fails fast instead of hanging. */
async function until(done: () => boolean, deadlineMs = 8000): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) { if (done()) return true; await settle(50); }
  return done();
}

test("the runner drains the queue one at a time and then goes quiet", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    // Gaps of zero, because the point here is the ordering and the stopping, not the pacing.
    // companyGapHours included: all three contacts are at one company, which the per-company
    // spacing would otherwise hold back on purpose. That behaviour has its own tests.
    setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), minGapSeconds: 0, maxGapSeconds: 0, companyGapHours: 0 });

    for (const local of ["a", "b", "c"]) {
      const ct = ulid();
      db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(ct, ids.co, `${local}@haber.com.tr`, "https://haber.com.tr/kunye", "published", now(), now());
      approvedDraft(db, { ...ids, ct });
    }

    const runner = new SendRunner(db, () => cfgFor(sink));
    runner.start();
    try {
      assert.ok(await until(() => sink.messages.length === 3), `only sent ${sink.messages.length}`);
      // Nothing approved is left, so it must stop sending rather than resend anything.
      await settle(400);
      assert.equal(sink.messages.length, 3);
      assert.equal(new Set(sink.messages.map((m) => m.to[0])).size, 3, "three different people");
    } finally { runner.stop(); }
  });
});

test("pausing stops the runner before the next send, not after the queue empties", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), minGapSeconds: 0, maxGapSeconds: 0, paused: true });
    approvedDraft(db, ids);

    const runner = new SendRunner(db, () => cfgFor(sink));
    runner.start();
    try {
      await settle(900);
      assert.equal(sink.messages.length, 0, "paused means paused");
      assert.match(runner.lastOutcome ?? "", /paused/);

      // Un-pausing is picked up on the next tick without restarting the runner. The UI does
      // not rely on this - Pause stops the loop and Start starts it - but the setting is the
      // thing the guard reads, so the two must not be able to disagree.
      setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), paused: false });
      assert.ok(await until(() => sink.messages.length === 1, 12_000), "did not resume after un-pausing");
    } finally { runner.stop(); }
  });
});

test("stopping the runner leaves nothing behind that could fire later", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), minGapSeconds: 0, maxGapSeconds: 0 });
    approvedDraft(db, ids);

    const runner = new SendRunner(db, () => cfgFor(sink));
    runner.start();
    runner.stop();
    await settle(700);

    assert.equal(runner.isRunning, false);
    assert.equal(runner.nextSendAt, undefined, "a pending timer would send after you stopped it");
    assert.equal(sink.messages.length, 0);
  });
});

test("the runner survives SMTP being unreachable and does not lose the draft", async () => {
  const { db, ids } = world();
  await setSecret(db, "smtp.password", "pw");
  setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), minGapSeconds: 0, maxGapSeconds: 0 });
  const draftId = approvedDraft(db, ids);

  // Port 1 refuses immediately: a mailbox that is down, not a message that is wrong.
  const runner = new SendRunner(db, () => ({
    host: "127.0.0.1", port: 1, secure: false,
    user: "ozan@sahafeed.com", fromEmail: "ozan@sahafeed.com", fromName: "Ozan",
  }));
  runner.start();
  try {
    await settle(1200);
    assert.ok((runner.lastOutcome ?? "").length > 0, "the runner should say what happened");
    // The draft must still be sendable once the mailbox comes back.
    const status = (db.prepare("SELECT status FROM email_draft WHERE id=?").get(draftId) as any).status;
    assert.ok(status === "approved" || status === "sent", `unexpected status ${status}`);
  } finally { runner.stop(); }
});

/* Taking an approval back. */

test("an approved draft can be put back in the review queue", async () => {
  const { db, ids } = world();
  const draftId = approvedDraft(db, ids);

  assert.deepEqual(unapproveDraft(db, draftId), { ok: true });
  const row = db.prepare("SELECT status, approved_at FROM email_draft WHERE id=?").get(draftId) as any;
  assert.equal(row.status, "needs_review");
  assert.equal(row.approved_at, null, "otherwise it still looks approved to anything reading that column");
});

test("an approval cannot be taken back once the message has left", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    const draftId = approvedDraft(db, ids);
    assert.equal((await sendOne(db, draftId, cfgFor(sink))).sent, true);

    // Undo here would be pretending a sent email can be recalled.
    const out = unapproveDraft(db, draftId);
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /already been sent/);
    assert.equal((db.prepare("SELECT status FROM email_draft WHERE id=?").get(draftId) as any).status, "sent");
  });
});

test("un-approving a draft nobody approved is refused, not silently accepted", () => {
  const { db, ids } = world();
  const d = ulid(), v = ulid();
  db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,status,step_number,created_at,updated_at) VALUES (?,?,?,?,'needs_review',1,?,?)")
    .run(d, ids.c, ids.cc, ids.ct, now(), now());
  db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,1,?,?,'llm',?)")
    .run(v, d, "s", "b", now());

  const out = unapproveDraft(db, d);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /not waiting to be sent/);
});

test("a draft put back in review does not get sent by the runner", async () => {
  await withSink(async (sink) => {
    const { db, ids } = world();
    await setSecret(db, "smtp.password", "pw");
    setSetting(db, "sending", { ...getSetting<any>(db, "sending", {}), minGapSeconds: 0, maxGapSeconds: 0 });
    const draftId = approvedDraft(db, ids);
    unapproveDraft(db, draftId);

    const runner = new SendRunner(db, () => cfgFor(sink));
    runner.start();
    try {
      await settle(900);
      assert.equal(sink.messages.length, 0, "undo has to hold against the thing that actually sends");
    } finally { runner.stop(); }
  });
});
