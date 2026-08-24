ALTER TABLE pluma_webhook_events ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE pluma_webhook_events ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

UPDATE pluma_webhook_events
SET lease_token = COALESCE(lease_token, gen_random_uuid()),
    lease_expires_at = COALESCE(lease_expires_at, now())
WHERE lease_token IS NULL OR lease_expires_at IS NULL;

ALTER TABLE pluma_webhook_events ALTER COLUMN lease_token SET DEFAULT gen_random_uuid();
ALTER TABLE pluma_webhook_events ALTER COLUMN lease_token SET NOT NULL;
ALTER TABLE pluma_webhook_events ALTER COLUMN lease_expires_at SET DEFAULT now() + interval '5 minutes';
ALTER TABLE pluma_webhook_events ALTER COLUMN lease_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pluma_webhook_events_stale_processing
  ON pluma_webhook_events(lease_expires_at)
  WHERE state = 'processing';
