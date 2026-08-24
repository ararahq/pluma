CREATE TABLE IF NOT EXISTS pluma_checkout_sessions (
  account_id UUID PRIMARY KEY REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('developer', 'pro', 'scale')),
  state TEXT NOT NULL CHECK (state IN ('creating', 'open')),
  attempt_id UUID NOT NULL,
  previous_stripe_session_id TEXT,
  stripe_session_id TEXT UNIQUE,
  checkout_url TEXT,
  expires_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state = 'creating' AND stripe_session_id IS NULL AND checkout_url IS NULL AND expires_at IS NULL)
    OR
    (state = 'open' AND stripe_session_id IS NOT NULL AND checkout_url IS NOT NULL AND expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pluma_checkout_sessions_expiry
  ON pluma_checkout_sessions(expires_at)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS idx_pluma_checkout_sessions_stale_lease
  ON pluma_checkout_sessions(lease_expires_at)
  WHERE state = 'creating';
