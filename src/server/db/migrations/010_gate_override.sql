-- An escape hatch for the qualification gate.
--
-- The gate was just made stricter (009), which makes a wrong rejection more likely, not less.
-- `retry` is not an override: it clears the rejection, drops the cached pages and re-runs the
-- same gate, which reaches the same verdict. This is the human overrule - keep the enrichment,
-- keep the recorded reason, and proceed anyway.
--
-- Recorded rather than just flipping status back so the funnel can tell "the gate passed it"
-- apart from "a person overruled the gate", which are different facts about a campaign.
ALTER TABLE campaign_company ADD COLUMN gate_override INTEGER NOT NULL DEFAULT 0
  CHECK (gate_override IN (0,1));
