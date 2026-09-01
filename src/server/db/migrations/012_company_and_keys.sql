-- The local surface sets up two things that had nowhere to live.
--
-- 1. Your own company. Until now the only record of who is sending was three columns on the
--    product row - sender_name, sender_title, sender_company - which are about signing an
--    email, not about the business. An identifiable sender is what UK PECR expects, and the
--    footer that provides it had to be typed out by hand every time because nothing knew the
--    trading address or the company number.
--
-- 2. Keys other than the mailbox password. There was exactly one secret in the system and it
--    was hard-coded as `smtp.password`. Anything else - a tunnel token, a provider key - had
--    no home, so it would have ended up in the settings row in plaintext, which is the exact
--    failure this schema already had to clean up once.
--
-- Values in `credential` are AES-256-GCM ciphertext. The key is a file outside the database
-- (~/.coldcall/vault.key, mode 0600), so coldcall.db on its own is still what it has always
-- been: safe to back up and safe to attach to a bug report.

CREATE TABLE company_profile (
  id             INTEGER PRIMARY KEY CHECK (id = 1),   -- exactly one row, ever
  legal_name     TEXT NOT NULL DEFAULT '',
  trading_name   TEXT NOT NULL DEFAULT '',
  website        TEXT NOT NULL DEFAULT '',
  contact_email  TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  company_number TEXT NOT NULL DEFAULT '',
  vat_number     TEXT NOT NULL DEFAULT '',
  -- Who signs the mail. Mirrors product.sender_* but belongs to the business, not to a brief.
  sender_name    TEXT NOT NULL DEFAULT '',
  sender_title   TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE credential (
  name          TEXT PRIMARY KEY,           -- 'smtp.password', 'cloudflare.token', ...
  label         TEXT NOT NULL DEFAULT '',   -- what a person calls it
  -- AES-256-GCM. iv:tag:ciphertext, all base64. Never returned to any client, ever.
  ciphertext    TEXT NOT NULL,
  -- Enough to recognise a key without revealing it: 'sk-...9f2a'.
  hint          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'api_key'
                CHECK (kind IN ('api_key','password','token','other')),
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
