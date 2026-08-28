-- The signature and the opt-out footer were baked into body_text when the draft was written,
-- so changing your name in the brief, or switching the footer on, only affected drafts written
-- afterwards. The footer in particular is a compliance setting: someone who turns it on
-- reasonably expects it to apply to everything they have not yet sent.
--
-- New versions store the message alone and the signature is rendered when the email is shown
-- and when it is sent. Existing rows already contain it, so they are marked 'baked' and are
-- left exactly as they are - re-rendering them would duplicate the signature.
ALTER TABLE email_draft_version ADD COLUMN signature_mode TEXT NOT NULL DEFAULT 'baked'
  CHECK (signature_mode IN ('baked','rendered'));

DROP VIEW IF EXISTS email_draft_current;
CREATE VIEW email_draft_current AS
SELECT d.id AS draft_id, d.campaign_id, d.campaign_company_id, d.contact_id, d.status,
       d.step_number, d.follows_send_id, d.due_at, d.approved_at, d.scheduled_for,
       v.id AS version_id, v.version, v.subject, v.body_text, v.personalization, v.author,
       v.word_count, v.quality_flags, v.signature_mode
FROM email_draft d
JOIN email_draft_version v ON v.draft_id = d.id
WHERE v.version = (SELECT MAX(v2.version) FROM email_draft_version v2 WHERE v2.draft_id = d.id);
