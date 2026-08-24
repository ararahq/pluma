CREATE INDEX IF NOT EXISTS idx_pluma_reservations_finalized_cleanup
  ON pluma_usage_reservations(finalized_at)
  WHERE state IN ('charged', 'refunded');

CREATE INDEX IF NOT EXISTS idx_pluma_webhook_events_completed_cleanup
  ON pluma_webhook_events(processed_at)
  WHERE state = 'completed';
