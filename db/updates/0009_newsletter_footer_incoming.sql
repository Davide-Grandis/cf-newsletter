ALTER TABLE newsletters ADD COLUMN footer_incoming INTEGER NOT NULL DEFAULT 0 CHECK (footer_incoming IN (0,1));
