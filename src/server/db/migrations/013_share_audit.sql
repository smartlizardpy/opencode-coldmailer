-- What the shared surface did, on the machine it did it to.
--
-- Handing someone the link hands them your mailbox's reputation: they approve, and mail leaves
-- your domain under your name. "Who approved the one that bounced" and "who started sending at
-- 2am" are questions the send log alone cannot answer, because every row in it says the same
-- thing - that this machine sent it.
--
-- Every request from the shared surface already passes through one place, so this is recorded
-- there rather than at forty call sites. Reads are not logged: at one row per page render the
-- interesting rows would be buried inside a day. State changes are, and so are exports, which
-- are the only way data leaves through that link.

CREATE TABLE share_audit (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES share_session(id) ON DELETE SET NULL,
  -- Kept as plain text as well as a reference: revoking a session must not erase what was done
  -- with it, and that is exactly when someone wants to read this table.
  label        TEXT NOT NULL DEFAULT '',
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  -- A sentence a person can read, written at the time. Deriving it later would mean keeping
  -- every route's meaning in step with a historical log forever.
  action       TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',
  subject_type TEXT,
  subject_id   TEXT,
  status       INTEGER NOT NULL DEFAULT 200,
  ok           INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX share_audit_time_idx    ON share_audit(created_at DESC);
CREATE INDEX share_audit_session_idx ON share_audit(session_id);
