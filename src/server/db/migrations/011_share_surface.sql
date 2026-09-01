-- Two surfaces, one database.
--
-- The local surface (127.0.0.1) is the owner's: mailbox credentials, models, the product
-- interview, the never-contact list. The shared surface is a Cloudflare tunnel URL handed to
-- someone else - a co-founder who runs campaigns and sends the mail - and it must never be
-- able to read a key or change how the machine sends.
--
-- Access is proved by a session cookie, and a session is only ever created by redeeming an
-- invite the owner generated. Both are stored as SHA-256 digests, never as the value handed
-- out: a stolen coldcall.db must not be a working login to the tunnel.

CREATE TABLE share_invite (
  id           TEXT PRIMARY KEY,
  -- sha256 of the token in the invite link. The token itself is shown once and never stored.
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'sender' CHECK (role IN ('sender')),
  expires_at   INTEGER,
  revoked_at   INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE share_session (
  id           TEXT PRIMARY KEY,
  invite_id    TEXT REFERENCES share_invite(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'sender' CHECK (role IN ('sender')),
  label        TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX share_session_invite_idx ON share_session(invite_id);
CREATE INDEX share_session_live_idx   ON share_session(revoked_at, expires_at);
