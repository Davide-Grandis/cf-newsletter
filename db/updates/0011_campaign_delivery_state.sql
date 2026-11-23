ALTER TABLE campaigns ADD COLUMN delivery_state TEXT CHECK (delivery_state IN ('sending','scheduled','paused'));
UPDATE campaigns SET delivery_state = CASE
  WHEN EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = campaigns.id AND s.status = 'pending' AND s.batch_id IS NOT NULL) THEN 'sending'
  WHEN EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = campaigns.id AND s.status = 'pending') THEN 'scheduled'
  ELSE 'sending' END
WHERE status = 'sending';
