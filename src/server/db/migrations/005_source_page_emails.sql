-- Emails are extracted from the HTML (mailto links, Cloudflare data-cfemail, JSON-LD), not from
-- the visible text we store. Re-deriving them from `text` on a cache hit therefore loses every
-- address that was never written in the page body - which is most of them on a protected site.
ALTER TABLE source_page ADD COLUMN emails TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(emails));
ALTER TABLE source_page ADD COLUMN has_form INTEGER NOT NULL DEFAULT 0 CHECK (has_form IN (0,1));
