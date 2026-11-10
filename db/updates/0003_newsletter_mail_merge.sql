ALTER TABLE newsletters ADD COLUMN mail_merge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mail_merge_enabled IN (0,1));
ALTER TABLE newsletters ADD COLUMN mail_merge_html TEXT;
ALTER TABLE newsletters ADD COLUMN mail_merge_text TEXT;
