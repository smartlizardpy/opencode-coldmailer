/**
 * Message-level scoring only. The DNS side of this module is deliberately untested here:
 * it asserts things about the live internet, and a test that fails on a flaky resolver
 * teaches you to ignore the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMessage } from "../../src/server/mail/deliverability.ts";

const ids = (subject: string, body: string) =>
  scoreMessage(subject, body).checks.filter((c) => c.severity !== "ok").map((c) => c.id);

const GOOD_SUBJECT = "quick question about your feed";
const GOOD_BODY = `Saw your match reports go out every morning during the season.

We run a shared sports feed for small outlets. Would a look at it be useful?

Ozan`;

test("a genuine one-to-one note scores clean", () => {
  const r = scoreMessage(GOOD_SUBJECT, GOOD_BODY);
  assert.equal(r.score, 100);
  assert.deepEqual(ids(GOOD_SUBJECT, GOOD_BODY), []);
});

test("ordinary sales vocabulary is not flagged", () => {
  // Flagging "free" or "price" in a message that is legitimately about pricing produces
  // noise, and a reviewer who learns to dismiss the box stops reading the real hits.
  const body = "You mentioned pricing on your about page. Ours is free for the first month.\n\nWorth a look?\n\nOzan";
  assert.deepEqual(ids("about your pricing", body), []);
});

test("the phrases filters actually weight are flagged", () => {
  assert.ok(ids("hello", "Act now - this is a limited time offer.").includes("phrases"));
  assert.ok(ids("hello", "Hemen tıkla, son fırsat.").includes("phrases"));
});

test("two trigger phrases is worse than one", () => {
  const one = scoreMessage("hi", "Click here for details.");
  const two = scoreMessage("hi", "Click here and buy now.");
  assert.equal(one.checks.find((c) => c.id === "phrases")!.severity, "warning");
  assert.equal(two.checks.find((c) => c.id === "phrases")!.severity, "critical");
  assert.ok(two.score < one.score);
});

test("links are counted, and one is fine", () => {
  assert.equal(scoreMessage("hi", "See https://a.com").links, 1);
  assert.deepEqual(ids("hi there", "See https://a.com\n\nOzan"), []);
  assert.ok(ids("hi there", "https://a.com https://b.com https://c.com").includes("links"));
});

test("a shouted subject is caught", () => {
  assert.ok(ids("URGENT reply needed", "hello there friend, a normal body here").includes("caps"));
  // An acronym under four letters is not shouting.
  assert.deepEqual(ids("your RSS feed question", "hello there friend, a normal body here"), []);
});

test("a subject that truncates on a phone is flagged", () => {
  assert.ok(ids("a rather long subject line that will certainly be cut off", GOOD_BODY).includes("subject"));
  assert.ok(ids("", GOOD_BODY).includes("subject"));
});

test("HTML in a plain-text send is critical", () => {
  const r = scoreMessage(GOOD_SUBJECT, "<p>Hello</p>");
  assert.equal(r.checks.find((c) => c.id === "html")!.severity, "critical");
});

test("an over-long body is flagged but a short one is not", () => {
  assert.ok(ids(GOOD_SUBJECT, "word ".repeat(200)).includes("length"));
  assert.ok(!ids(GOOD_SUBJECT, GOOD_BODY).includes("length"));
});

test("the score never leaves 0-100", () => {
  const worst = scoreMessage("", "");
  assert.ok(worst.score >= 0 && worst.score <= 100, String(worst.score));
  const awful = scoreMessage("ACT NOW BUY NOW WINNER!!!", "<b>click here</b> https://a.com https://b.com https://c.com");
  assert.ok(awful.score >= 0 && awful.score <= 100, String(awful.score));
});

test("every failing check tells you what to do about it", () => {
  const r = scoreMessage("URGENT!!", "Click here to buy now https://a.com https://b.com <b>x</b>");
  for (const c of r.checks) {
    if (c.severity === "critical" || c.severity === "warning") {
      assert.ok(c.fix && c.fix.length > 10, `${c.id} has no fix`);
    }
  }
});

/* The offline path. Uses TEST-NET-3, which is reserved as unroutable, so every query times
   out rather than answering - the same shape as running this with no network. */
test("a DNS failure is reported as unknown, never as a missing record", async (t) => {
  const { auditSenderDomain, setResolverOptions } = await import("../../src/server/mail/deliverability.ts");
  setResolverOptions({ servers: ["203.0.113.99"], timeoutMs: 400 });
  t.after(() => setResolverOptions({}));

  const audit = await auditSenderDomain("me@stripe.com");
  for (const id of ["mx", "spf", "dmarc", "dkim"]) {
    const c = audit.checks.find((x) => x.id === id);
    assert.ok(c, `${id} missing`);
    assert.equal(c.severity, "info", `${id} should be inconclusive, not a finding`);
    assert.match(c.detail, /could not look up/i, `${id} should say it could not check`);
  }
  // A domain we simply could not reach must not be scored as broken.
  assert.equal(audit.score, 100);
});

/* Connection failures, in words the person setting this up can act on. */

test("a rejected login says an app password is what is needed", async () => {
  const { explainSmtpError } = await import("../../src/server/mail/smtp.ts");
  // Gmail's own text - "Username and Password not accepted" - is accurate and useless: it
  // does not say that the password you sign in with is never the right one here.
  const d = explainSmtpError("Invalid login: 535-5.7.8 Username and Password not accepted", "smtp.gmail.com");
  assert.match(d.message, /rejected the username or password/i);
  assert.match(d.fix!, /app password/i);
  assert.match(d.fix!, /2-Step/i);
  assert.match(d.raw, /535/, "the server's own words are kept");
});

test("534 is recognised as specifically asking for an app password", async () => {
  const { explainSmtpError } = await import("../../src/server/mail/smtp.ts");
  const d = explainSmtpError("534-5.7.9 Application-specific password required", "smtp.gmail.com");
  assert.match(d.message, /app password/i);
  assert.match(d.fix!, /App passwords/);
});

test("a non-Gmail host does not get told to open Google Account settings", async () => {
  const { explainSmtpError } = await import("../../src/server/mail/smtp.ts");
  const d = explainSmtpError("535 authentication failed", "smtp.fastmail.com");
  assert.doesNotMatch(d.fix ?? "", /Google|2-Step/);
});

test("connection-level failures name the actual cause", async () => {
  const { explainSmtpError } = await import("../../src/server/mail/smtp.ts");
  assert.match(explainSmtpError("getaddrinfo ENOTFOUND smtp.gmial.com", "smtp.gmial.com").message, /No server found/);
  assert.match(explainSmtpError("getaddrinfo ENOTFOUND smtp.gmial.com", "smtp.gmial.com").message, /smtp\.gmial\.com/);
  assert.match(explainSmtpError("connect ECONNREFUSED 1.2.3.4:465").fix!, /port/i);
  assert.match(explainSmtpError("Connection timeout").fix!, /firewall|587/i);
  assert.match(explainSmtpError("error:1408F10B:SSL routines:ssl3_get_record:wrong version number").message, /encryption/i);
  assert.match(explainSmtpError("421 4.7.0 Try again later").message, /temporarily/i);
});

test("an unrecognised error is passed through rather than guessed at", async () => {
  const { explainSmtpError } = await import("../../src/server/mail/smtp.ts");
  const d = explainSmtpError("something nobody has ever seen before", "smtp.example.com");
  assert.equal(d.message, "something nobody has ever seen before");
  assert.equal(d.fix, undefined, "no guess is better than a wrong one dressed up as an explanation");
});
