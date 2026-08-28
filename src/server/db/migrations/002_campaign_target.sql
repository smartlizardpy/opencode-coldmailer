-- A product can run several campaigns aimed at completely different groups: customers,
-- partners, content sources, press. Scoring discovery against the PRODUCT's signals alone
-- means a "find small news sites" campaign gets judged on "does this look like a sports
-- academy?" - which is exactly how a news-site search returned tennis academies at fit 95.
--
-- target_description is what THIS campaign is looking for, and it overrides the product
-- signals for discovery and judging when set.
ALTER TABLE campaign ADD COLUMN target_description TEXT NOT NULL DEFAULT '';

-- Set when a company is rejected after we fetched its site and found it was not what the
-- search result implied. Kept rather than deleted so the UI can show what was filtered out.
ALTER TABLE campaign_company ADD COLUMN rejected_reason TEXT;
