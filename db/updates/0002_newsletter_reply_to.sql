ALTER TABLE newsletters ADD COLUMN reply_to_address TEXT;
ALTER TABLE newsletters ADD COLUMN reply_to_author INTEGER NOT NULL DEFAULT 0 CHECK (reply_to_author IN (0,1));
ALTER TABLE campaigns ADD COLUMN reply_to_address TEXT;
