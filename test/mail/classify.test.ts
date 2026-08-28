/**
 * Bounces, out-of-office replies, and people.
 *
 * Before this existed all three were recorded as "they replied", which marked the company as
 * having answered, stopped the sequence, pointed the reply drafter at MAILER-DAEMON, and -
 * the expensive one - never suppressed an address that had hard-bounced. The samples below
 * are the real shapes Gmail, Postfix, Exchange and Zimbra emit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInbound, bounceDetails, isAutoReply, isDeadMailbox, isPermanent } from "../../src/server/mail/classify.ts";

const GMAIL_DSN = {
  headers: [
    "Return-Path: <>",
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "Subject: Delivery Status Notification (Failure)",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="000000000000"',
    "",
  ].join("\r\n"),
  from: "mailer-daemon@googlemail.com",
  subject: "Delivery Status Notification (Failure)",
  body: [
    "Final-Recipient: rfc822; haber@yokboyleadres.com.tr",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
    " 550-5.1.1 Please try double-checking the recipient's email address.",
  ].join("\r\n"),
};

const HUMAN = {
  headers: "From: Ali Yilmaz <ali@haberankara.com.tr>\r\nSubject: Re: pta duyurulari\r\n\r\n",
  from: "ali@haberankara.com.tr",
  subject: "Re: pta duyurulari",
  body: "Merhaba Ozan, ilgileniyoruz. Detay gonderebilir misiniz?",
};

test("a Gmail delivery failure is a hard bounce, with the address and reason", () => {
  const v = classifyInbound(GMAIL_DSN);
  assert.equal(v.kind, "bounce_hard");
  assert.equal(v.recipient, "haber@yokboyleadres.com.tr");
  assert.equal(v.status, "5.1.1");
  assert.match(v.reason!, /does not exist/);
});

test("a person replying is a reply, and nothing else", () => {
  assert.deepEqual(classifyInbound(HUMAN), { kind: "reply" });
});

test("a person whose message mentions delivery is still a person", () => {
  // The daemon check is on the sender, not on words in the text. Someone writing "my last
  // email could not be delivered" must not be filed as a bounce and silently dropped.
  const v = classifyInbound({ ...HUMAN, body: "Onceki mailim could not be delivered, tekrar yaziyorum." });
  assert.equal(v.kind, "reply");
});

test("a 4.x.x report is a soft bounce and is never suppressed", () => {
  const v = classifyInbound({
    ...GMAIL_DSN,
    body: "Final-Recipient: rfc822; a@b.com\r\nAction: delayed\r\nStatus: 4.2.2\r\nDiagnostic-Code: smtp; 452 Mailbox full",
  });
  assert.equal(v.kind, "bounce_soft");
  assert.equal(isDeadMailbox(v.status), false);
  assert.equal(isPermanent(v.status), false);
});

test("a policy rejection bounces but does not suppress the address", () => {
  // 5.7.1 can be about the content or a temporary reputation block. Suppressing on it would
  // permanently discard a real lead over something that is not the recipient's fault.
  const v = classifyInbound({ ...GMAIL_DSN, body: "Final-Recipient: rfc822; a@b.com\r\nStatus: 5.7.1\r\nDiagnostic-Code: smtp; 550 Message rejected" });
  assert.equal(v.kind, "bounce_hard");
  assert.equal(isDeadMailbox(v.status), false, "5.7.1 must not suppress");
});

test("only dead-mailbox statuses suppress", () => {
  for (const s of ["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.4.4"]) assert.equal(isDeadMailbox(s), true, s);
  for (const s of ["5.7.1", "5.2.2", "4.2.2", "5.3.0", undefined]) assert.equal(isDeadMailbox(s), false, String(s));
});

test("a Postfix bounce with no report-type header is still caught", () => {
  const v = classifyInbound({
    headers: "Return-Path: <>\r\nFrom: MAILER-DAEMON@mail.example.com (Mail Delivery System)\r\nSubject: Undelivered Mail Returned to Sender\r\n\r\n",
    from: "MAILER-DAEMON@mail.example.com",
    subject: "Undelivered Mail Returned to Sender",
    body: "<kimse@yok.com>: host mx.yok.com said: 550 5.1.1 User unknown",
  });
  assert.equal(v.kind, "bounce_hard");
  assert.equal(v.status, "5.1.1");
  assert.equal(v.recipient, "kimse@yok.com");
});

test("a report with no parseable status is soft, so nothing is suppressed on a guess", () => {
  const v = classifyInbound({ ...GMAIL_DSN, body: "Something went wrong. No further detail." });
  assert.equal(v.kind, "bounce_soft");
  assert.equal(v.status, undefined);
});

test("an out-of-office is recognised by header, not by wording", () => {
  assert.equal(classifyInbound({ ...HUMAN, headers: HUMAN.headers + "Auto-Submitted: auto-replied\r\n" }).kind, "auto_reply");
  assert.equal(classifyInbound({ ...HUMAN, headers: HUMAN.headers + "X-Autoreply: yes\r\n" }).kind, "auto_reply");
  assert.equal(classifyInbound({ ...HUMAN, headers: HUMAN.headers + "Precedence: auto_reply\r\n" }).kind, "auto_reply");
  // A genuine reply that happens to say "I am away next week" must not be discarded.
  assert.equal(classifyInbound({ ...HUMAN, body: "I am away next week but yes, send it over." }).kind, "reply");
});

test("Auto-Submitted: no is what an ordinary message carries", () => {
  assert.equal(isAutoReply("Auto-Submitted: no\r\n"), false);
  assert.equal(classifyInbound({ ...HUMAN, headers: HUMAN.headers + "Auto-Submitted: no\r\n" }).kind, "reply");
});

test("a folded Diagnostic-Code is read whole", () => {
  const d = bounceDetails("Diagnostic-Code: smtp; 550-5.1.1 no such user\r\n 550-5.1.1 try again\r\nStatus: 5.1.1");
  assert.match(d.reason!, /no such user 550-5.1.1 try again/);
});

test("an empty body does not throw", () => {
  assert.deepEqual(bounceDetails(""), { recipient: undefined, status: undefined, reason: undefined });
});

test("a no-reply newsletter is not mistaken for a bounce", () => {
  // The local part looks like a daemon, but there is no null return path and no report,
  // so it stays an ordinary message rather than being filed as a delivery failure.
  const v = classifyInbound({
    headers: "From: no-reply@substack.com\r\nReturn-Path: <bounce@substack.com>\r\n\r\n",
    from: "no-reply@substack.com", subject: "Your weekly digest", body: "Here is what happened this week.",
  });
  assert.equal(v.kind, "reply");
});

test("a Content-Type folded across lines is still read whole", () => {
  // Exchange wraps this one routinely, and the report-type parameter - the thing that
  // identifies a bounce unambiguously - is what ends up on the continuation line.
  const v = classifyInbound({
    headers: [
      "From: postmaster@corp.example.com",
      "Content-Type: multipart/report;",
      '\treport-type=delivery-status;',
      '\tboundary="_000_"',
      "Subject: Undeliverable: quick question",
      "",
    ].join("\r\n"),
    from: "postmaster@corp.example.com",
    subject: "Undeliverable: quick question",
    body: "Final-Recipient: rfc822; gone@corp.example.com\r\nStatus: 5.1.1",
  });
  assert.equal(v.kind, "bounce_hard");
  assert.equal(v.recipient, "gone@corp.example.com");
});
