ALTER TABLE subscribers ADD COLUMN first_name TEXT;
ALTER TABLE subscribers ADD COLUMN last_name TEXT;
ALTER TABLE subscribers ADD COLUMN full_name TEXT GENERATED ALWAYS AS (NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')) VIRTUAL;
ALTER TABLE subscribers ADD COLUMN tracking_consent INTEGER NOT NULL DEFAULT 0 CHECK (tracking_consent IN (0,1));
ALTER TABLE subscribers ADD COLUMN tracking_consent_at TEXT;
UPDATE subscribers SET
  first_name = CASE WHEN instr(TRIM(name), ' ') > 0 THEN substr(TRIM(name), 1, instr(TRIM(name), ' ') - 1) ELSE NULLIF(TRIM(name), '') END,
  last_name = CASE WHEN instr(TRIM(name), ' ') > 0 THEN NULLIF(TRIM(substr(TRIM(name), instr(TRIM(name), ' ') + 1)), '') END
WHERE name IS NOT NULL;
UPDATE newsletters SET
  mail_merge_html = REPLACE(REPLACE(mail_merge_html, '{{subscriber_name}}', '{{full_name}}'), '{{ subscriber_name }}', '{{full_name}}'),
  mail_merge_text = REPLACE(REPLACE(mail_merge_text, '{{subscriber_name}}', '{{full_name}}'), '{{ subscriber_name }}', '{{full_name}}');
