-- findContacts produces the most useful diagnostics in the product - which addresses it
-- ignored and why, which names it had to skip for lack of an address - and threw all of them
-- away. Without them "no publishable address" is unarguable; with them it is checkable.
ALTER TABLE campaign_company ADD COLUMN contact_notes TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(contact_notes));
