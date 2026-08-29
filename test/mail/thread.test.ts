/**
 * Matching an inbound message back to the send it answers.
 *
 * This is the whole reply mechanism. A Message-ID is generated before sending and compared
 * against In-Reply-To and References afterwards, so if this returns nothing for a real reply,
 * that reply is recorded as unmatched and nobody is ever shown it. There is no second chance
 * and no error - it simply does not appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadRefs } from "../../src/server/mail/imap.ts";

const SENT = "<mfk3n2.9a1c@sahafeed.com>";
const OLDER = "<mfk1aa.4b2d@sahafeed.com>";

test("In-Reply-To from the envelope is used", () => {
  assert.deepEqual(threadRefs("", SENT), [SENT]);
  assert.deepEqual(threadRefs("", [SENT]), [SENT]);
});

test("In-Reply-To is read from the raw headers when the envelope has none", () => {
  assert.deepEqual(threadRefs(`Subject: Re: pta\r\nIn-Reply-To: ${SENT}\r\n\r\n`), [SENT]);
});

test("References at the end of the block is still read", () => {
  // The terminator used to require a newline followed by a non-space, with no allowance for
  // the end of the input - so a References header that happened to be last matched NOTHING,
  // and the entire thread chain went with it.
  assert.deepEqual(threadRefs(`Subject: Re: pta\r\nReferences: ${OLDER} ${SENT}`), [OLDER, SENT]);
  assert.deepEqual(threadRefs(`Subject: Re: pta\r\nReferences: ${OLDER} ${SENT}\r\n\r\n`), [OLDER, SENT]);
});

test("References folded across lines is read whole", () => {
  // Long chains are folded by every mail system there is, and the ID we are looking for is
  // usually the last one - which is exactly the part a truncated capture loses.
  assert.deepEqual(threadRefs(`References: ${OLDER}\r\n ${SENT}\r\nDate: now\r\n\r\n`), [OLDER, SENT]);
  assert.deepEqual(threadRefs(`References: ${OLDER}\r\n\t${SENT}`), [OLDER, SENT]);
});

test("both headers are used, and the envelope comes first", () => {
  // The most specific answer is tried first: In-Reply-To names the exact message, References
  // is the whole chain.
  const refs = threadRefs(`In-Reply-To: ${SENT}\r\nReferences: ${OLDER} ${SENT}\r\n\r\n`, SENT);
  assert.equal(refs[0], SENT);
  assert.ok(refs.includes(OLDER));
});

test("a message that answers nothing yields nothing, rather than a bad guess", () => {
  assert.deepEqual(threadRefs("Subject: cold outreach\r\nFrom: someone@else.com\r\n\r\n"), []);
  assert.deepEqual(threadRefs(""), []);
});

test("a header that is not a Message-ID is not treated as one", () => {
  // idsFrom only takes <...> forms, so a mail system writing prose here cannot produce a
  // reference that matches some unrelated send.
  assert.deepEqual(threadRefs("References: none\r\n\r\n"), []);
});
