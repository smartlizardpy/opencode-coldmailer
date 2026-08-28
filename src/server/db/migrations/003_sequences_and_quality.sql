-- coldcall:no-foreign-keys  (this migration rebuilds email_draft)
-- Follow-ups. The single biggest functional gap in a cold-email tool: most replies come from
-- the second or third touch, not the first. A step is only ever sent if the contact has not
-- replied and has not been suppressed, both re-checked at send time.
CREATE TABLE sequence_step (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  step_number  INTEGER NOT NULL,          -- 1 = the first email, 2+ = follow-ups
  delay_days   INTEGER NOT NULL DEFAULT 4 CHECK (delay_days BETWEEN 1 AND 60),
  instruction  TEXT NOT NULL DEFAULT '',  -- how this touch should differ from the last
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (campaign_id, step_number)
);

-- email_draft carried UNIQUE (campaign_id, contact_id) as a TABLE constraint, which would
-- block every follow-up. SQLite cannot drop a table constraint, so the table is rebuilt with
-- the step number included in the key. This is why the file is marked no-foreign-keys above.
-- The view reads email_draft, so it has to go before the table can be dropped. Recreated
-- below with the new columns.
DROP VIEW IF EXISTS email_draft_current;

CREATE TABLE email_draft_new (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  campaign_company_id TEXT NOT NULL REFERENCES campaign_company(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','needs_review','approved','scheduled',
                                        'sent','failed','discarded')),
  step_number     INTEGER NOT NULL DEFAULT 1,
  follows_send_id TEXT REFERENCES send_log(id) ON DELETE SET NULL,
  due_at          INTEGER,
  approved_at     INTEGER,
  scheduled_for   INTEGER,
  error_code      TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (campaign_id, contact_id, step_number)
);
INSERT INTO email_draft_new
  (id, campaign_id, campaign_company_id, contact_id, status, step_number,
   approved_at, scheduled_for, error_code, error_message, created_at, updated_at)
SELECT id, campaign_id, campaign_company_id, contact_id, status, 1,
   approved_at, scheduled_for, error_code, error_message, created_at, updated_at
FROM email_draft;
DROP TABLE email_draft;
ALTER TABLE email_draft_new RENAME TO email_draft;
CREATE INDEX email_draft_status_idx ON email_draft(campaign_id, status);
CREATE INDEX email_draft_due_idx ON email_draft(status, due_at);

-- Quality flags computed when a draft is written, so review can surface the weak ones instead
-- of making the reader find them.
ALTER TABLE email_draft_version ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_draft_version ADD COLUMN quality_flags TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(quality_flags));

-- Saved filters on the companies and drafts views.
CREATE TABLE saved_view (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('companies','drafts')),
  name       TEXT NOT NULL,
  query      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(query)),
  created_at INTEGER NOT NULL
);

-- Rebuilt with the sequence and quality columns. Still MAX(version), never a cached pointer.
CREATE VIEW email_draft_current AS
SELECT d.id AS draft_id, d.campaign_id, d.campaign_company_id, d.contact_id, d.status,
       d.step_number, d.follows_send_id, d.due_at, d.approved_at, d.scheduled_for,
       v.id AS version_id, v.version, v.subject, v.body_text, v.personalization, v.author,
       v.word_count, v.quality_flags
FROM email_draft d
JOIN email_draft_version v ON v.draft_id = d.id
WHERE v.version = (SELECT MAX(v2.version) FROM email_draft_version v2 WHERE v2.draft_id = d.id);
