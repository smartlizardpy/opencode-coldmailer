-- coldcall schema v1
--
-- Conventions:
--   ids        ULID in TEXT (lexicographically sortable, so ORDER BY id is chronological)
--   timestamps INTEGER epoch millis, never TEXT
--   booleans   INTEGER with CHECK (x IN (0,1))
--   json       TEXT with CHECK (json_valid(col))
--
-- Two invariants are enforced by the schema itself rather than by application discipline:
--   1. A contact cannot exist without a provenance URL (contact.source_url NOT NULL).
--   2. An email cannot be personalised with an unverified claim (trigger at the bottom).

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
);

-- Never stores a secret. Only where to find it.
CREATE TABLE secret_ref (
  name             TEXT PRIMARY KEY,
  storage          TEXT NOT NULL CHECK (storage IN ('keychain','file')),
  locator          TEXT NOT NULL,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE product (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  one_liner       TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  audience        TEXT NOT NULL DEFAULT '{}'  CHECK (json_valid(audience)),
  job_to_be_done  TEXT NOT NULL DEFAULT '',
  before_state    TEXT NOT NULL DEFAULT '',
  objections      TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(objections)),
  proof_points    TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(proof_points)),
  disqualifiers   TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(disqualifiers)),
  -- observable facts that mean a company is a fit; these drive discovery
  signals         TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(signals)),
  price_anchor    TEXT NOT NULL DEFAULT '',
  tone_sample     TEXT NOT NULL DEFAULT '',
  sender_name     TEXT NOT NULL DEFAULT '',
  sender_title    TEXT NOT NULL DEFAULT '',
  sender_company  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE interview_turn (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('assistant','user')),
  content    TEXT NOT NULL,
  field_hint TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (product_id, seq)
);

CREATE TABLE campaign (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  goal             TEXT NOT NULL DEFAULT '',
  -- explicit, so a degraded discovery mode is never implicit
  -- No paid APIs anywhere in this product. Discovery is opencode's free websearch, or a
  -- list you paste yourself. Nothing here can generate a bill.
  discovery_mode   TEXT NOT NULL DEFAULT 'opencode_search'
                   CHECK (discovery_mode IN ('opencode_search','manual')),
  search_brief     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(search_brief)),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','researching','ready','sending','paused','done','failed')),
  target_count     INTEGER NOT NULL DEFAULT 50,
  contacts_per_company INTEGER NOT NULL DEFAULT 3 CHECK (contacts_per_company BETWEEN 1 AND 5),
  allow_inferred_emails INTEGER NOT NULL DEFAULT 0 CHECK (allow_inferred_emails IN (0,1)),
  daily_send_limit INTEGER NOT NULL DEFAULT 30,
  min_gap_seconds  INTEGER NOT NULL DEFAULT 90,
  max_gap_seconds  INTEGER NOT NULL DEFAULT 180,
  error_code       TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX campaign_status_idx ON campaign(status);

CREATE TABLE company (
  id          TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,           -- normalized: lowercase, no www, no trailing dot
  name        TEXT NOT NULL,
  website_url TEXT,
  country     TEXT,
  region      TEXT,
  city        TEXT,
  industry    TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  enriched_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX company_domain_uidx ON company(domain);

CREATE TABLE campaign_company (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  company_id       TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'discovered'
                   CHECK (status IN ('discovered','enriching','qualified','rejected',
                                     'contacts_found','drafted','approved','sent',
                                     'replied','bounced','failed','skipped')),
  relevance_score  REAL CHECK (relevance_score IS NULL OR relevance_score BETWEEN 0 AND 1),
  relevance_reason TEXT,
  matched_signal   TEXT,
  discovered_via   TEXT,               -- the exact query that surfaced it
  discovered_url   TEXT,
  selected         INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  error_code       TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (campaign_id, company_id)
);
CREATE INDEX campaign_company_status_idx ON campaign_company(campaign_id, status);

CREATE TABLE source_page (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  url_hash     TEXT NOT NULL,          -- sha256 of the normalized url
  company_id   TEXT REFERENCES company(id) ON DELETE SET NULL,
  http_status  INTEGER,
  content_type TEXT,
  title        TEXT,
  text         TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER NOT NULL,
  error        TEXT
);
CREATE UNIQUE INDEX source_page_url_uidx ON source_page(url_hash);
CREATE INDEX source_page_company_idx ON source_page(company_id);

-- Every factual assertion about a company, with the page and quote it came from.
-- A JSON blob on `company` could not carry per-claim verification state or be enforced.
CREATE TABLE claim (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  campaign_company_id TEXT REFERENCES campaign_company(id) ON DELETE CASCADE,
  claim               TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  source_page_id      TEXT REFERENCES source_page(id) ON DELETE SET NULL,
  quote               TEXT NOT NULL,
  harvested           INTEGER NOT NULL DEFAULT 0 CHECK (harvested IN (0,1)),
  verified            INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verify_method       TEXT CHECK (verify_method IN ('exact','fuzzy','failed','not_attempted')),
  verify_score        REAL,
  verified_at         INTEGER,
  llm_call_id         TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX claim_company_verified_idx ON claim(company_id, verified);

CREATE TABLE contact (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  full_name       TEXT,
  first_name      TEXT,
  title           TEXT,
  email           TEXT NOT NULL,
  email_status    TEXT NOT NULL DEFAULT 'unverified'
                  CHECK (email_status IN ('unverified','syntax_ok','mx_ok','bounced','invalid')),
  -- REQUIRED. No contact may exist without provenance.
  source_url      TEXT NOT NULL,
  source_kind     TEXT NOT NULL
                  CHECK (source_kind IN ('published','generic','inferred','manual')),
  source_snippet  TEXT,
  source_page_id  TEXT REFERENCES source_page(id) ON DELETE SET NULL,
  confidence      REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  is_role_account INTEGER NOT NULL DEFAULT 0 CHECK (is_role_account IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX contact_company_email_uidx ON contact(company_id, lower(email));
CREATE INDEX contact_email_idx ON contact(lower(email));

CREATE TABLE llm_call (
  id                 TEXT PRIMARY KEY,
  task               TEXT NOT NULL,
  tool_policy        TEXT NOT NULL DEFAULT 'none',
  slot               TEXT NOT NULL DEFAULT 'writing',
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  session_id         TEXT,
  attempts           INTEGER NOT NULL DEFAULT 1,
  models_tried       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(models_tried)),
  repaired           INTEGER NOT NULL DEFAULT 0 CHECK (repaired IN (0,1)),
  search_calls       INTEGER NOT NULL DEFAULT 0,
  ok                 INTEGER NOT NULL CHECK (ok IN (0,1)),
  error_code         TEXT,
  error_message      TEXT,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  prompt_chars       INTEGER NOT NULL DEFAULT 0,
  response_text      TEXT,                  -- truncated
  subject_type       TEXT,
  subject_id         TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX llm_call_created_idx ON llm_call(created_at);
CREATE INDEX llm_call_subject_idx ON llm_call(subject_type, subject_id);
CREATE INDEX llm_call_failed_idx  ON llm_call(ok, created_at);

CREATE TABLE tool_call_log (
  id          TEXT PRIMARY KEY,
  llm_call_id TEXT NOT NULL REFERENCES llm_call(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  status      TEXT NOT NULL,
  input       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input)),
  output      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX tool_call_log_llm_idx ON tool_call_log(llm_call_id);

CREATE TABLE email_draft (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  campaign_company_id TEXT NOT NULL REFERENCES campaign_company(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','needs_review','approved','scheduled',
                                        'sent','failed','discarded')),
  approved_at   INTEGER,
  scheduled_for INTEGER,
  error_code    TEXT,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX email_draft_status_idx ON email_draft(campaign_id, status);

CREATE TABLE email_draft_version (
  id              TEXT PRIMARY KEY,
  draft_id        TEXT NOT NULL REFERENCES email_draft(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  subject         TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  author          TEXT NOT NULL CHECK (author IN ('llm','human')),
  llm_call_id     TEXT REFERENCES llm_call(id) ON DELETE SET NULL,
  edit_note       TEXT,
  -- [{claim_id, source_url}] - enforced against verified claims by the trigger below
  personalization TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(personalization)),
  created_at      INTEGER NOT NULL,
  UNIQUE (draft_id, version)
);

-- No denormalized current_version_id: a cached pointer that drifts from MAX(version)
-- is a silent "sent the wrong draft" bug.
CREATE VIEW email_draft_current AS
SELECT d.id AS draft_id, d.campaign_id, d.campaign_company_id, d.contact_id, d.status,
       d.approved_at, d.scheduled_for,
       v.id AS version_id, v.version, v.subject, v.body_text, v.personalization, v.author
FROM email_draft d
JOIN email_draft_version v ON v.draft_id = d.id
WHERE v.version = (SELECT MAX(v2.version) FROM email_draft_version v2 WHERE v2.draft_id = d.id);

CREATE TABLE send_log (
  id            TEXT PRIMARY KEY,
  draft_id      TEXT NOT NULL REFERENCES email_draft(id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES email_draft_version(id) ON DELETE RESTRICT,
  campaign_id   TEXT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL REFERENCES contact(id) ON DELETE RESTRICT,
  to_email      TEXT NOT NULL,
  from_email    TEXT NOT NULL,
  subject       TEXT NOT NULL,
  message_id    TEXT NOT NULL,       -- generated BEFORE sending, so replies can be matched
  smtp_response TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','bounced')),
  error_code    TEXT,
  error_message TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX send_log_message_id_uidx ON send_log(message_id);
-- At most one live send per draft, enforced by the DB rather than application luck.
CREATE UNIQUE INDEX send_log_one_live_idx
  ON send_log(draft_id) WHERE status IN ('queued','sending','sent');
CREATE INDEX send_log_campaign_sent_idx ON send_log(campaign_id, sent_at);
CREATE INDEX send_log_to_email_idx ON send_log(lower(to_email));

CREATE TABLE reply (
  id             TEXT PRIMARY KEY,
  send_log_id    TEXT REFERENCES send_log(id) ON DELETE SET NULL,
  campaign_id    TEXT REFERENCES campaign(id) ON DELETE SET NULL,
  contact_id     TEXT REFERENCES contact(id) ON DELETE SET NULL,
  from_email     TEXT NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',
  body_text      TEXT NOT NULL DEFAULT '',
  message_id     TEXT,
  in_reply_to    TEXT,
  received_at    INTEGER NOT NULL,
  classification TEXT CHECK (classification IN ('interested','not_interested','question',
                                                'unsubscribe','out_of_office','auto_reply',
                                                'bounce','other')),
  classification_confidence REAL,
  llm_call_id    TEXT REFERENCES llm_call(id) ON DELETE SET NULL,
  handled        INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1)),
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX reply_message_id_uidx ON reply(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX reply_campaign_idx ON reply(campaign_id, received_at);

CREATE TABLE suppression (
  id         TEXT PRIMARY KEY,
  pattern    TEXT NOT NULL,          -- 'a@b.com' or '@b.com'
  kind       TEXT NOT NULL CHECK (kind IN ('email','domain')),
  reason     TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','manual','competitor','customer')),
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX suppression_pattern_uidx ON suppression(lower(pattern));

CREATE TABLE job (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  campaign_id   TEXT REFERENCES campaign(id) ON DELETE CASCADE,
  subject_type  TEXT,
  subject_id    TEXT,
  payload       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed','blocked','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 100,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_after     INTEGER NOT NULL DEFAULT 0,
  locked_at     INTEGER,
  error_code    TEXT,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX job_claim_idx ON job(status, run_after, priority);
CREATE UNIQUE INDEX job_dedupe_idx
  ON job(kind, subject_type, subject_id) WHERE status IN ('pending','running');

-- An email may never lean on a claim we did not fetch and verify ourselves.
-- This is the anti-hallucination guarantee, enforced in the database.
CREATE TRIGGER email_draft_version_verified_claims_only
BEFORE INSERT ON email_draft_version
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.personalization) je
  LEFT JOIN claim c ON c.id = json_extract(je.value, '$.claim_id')
  WHERE c.id IS NULL OR c.verified = 0
)
BEGIN
  SELECT RAISE(ABORT, 'personalization references a missing or unverified claim');
END;
