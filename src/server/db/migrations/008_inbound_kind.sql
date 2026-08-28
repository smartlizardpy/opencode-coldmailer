-- Bounces and out-of-office replies were recorded as human replies.
--
-- Every inbound message that matched a thread was inserted into `reply` and treated as an
-- answer: the company was marked 'replied', the follow-up sequence stopped, and the reply
-- drafter was pointed at MAILER-DAEMON. The expensive half of the mistake is invisible - an
-- address that hard-bounced was never suppressed, so other campaigns kept mailing a mailbox
-- that does not exist, which is one of the fastest ways to lose a sending reputation.
--
-- Existing rows are left as 'reply'. We cannot re-classify them without the original headers,
-- and guessing from a stored subject line would mark real replies as bounces.
ALTER TABLE reply ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply'
  CHECK (kind IN ('reply','bounce_hard','bounce_soft','auto_reply'));

-- The address the report names, which is not always the address we sent to: a forwarding
-- alias bounces under its destination.
ALTER TABLE reply ADD COLUMN bounced_recipient TEXT;

-- RFC 3463 status, e.g. 5.1.1. Kept verbatim so the reason shown to the user is the mail
-- system's own words rather than our paraphrase of them.
ALTER TABLE reply ADD COLUMN bounce_status TEXT;

-- Only a genuine reply should stop a sequence, and only a genuine reply belongs in the
-- inbox count. Both queries filter on kind, so it is worth an index.
CREATE INDEX IF NOT EXISTS idx_reply_kind ON reply(kind, handled);
