ALTER TABLE newsletters ADD COLUMN mail_merge_incoming INTEGER NOT NULL DEFAULT 1 CHECK (mail_merge_incoming IN (0,1));
