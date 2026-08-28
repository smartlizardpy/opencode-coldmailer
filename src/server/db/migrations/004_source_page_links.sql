-- Cached pages returned no links, so a second crawl of the same company saw only the homepage
-- and never revisited the contact page it had already found. Store the same-domain candidate
-- links alongside the text so a cache hit is as useful as a fresh fetch.
ALTER TABLE source_page ADD COLUMN links TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links));
