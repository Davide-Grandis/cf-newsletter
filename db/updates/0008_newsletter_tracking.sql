ALTER TABLE newsletters ADD COLUMN tracking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tracking_enabled IN (0,1));
