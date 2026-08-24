CREATE TABLE IF NOT EXISTS pluma_auth_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pluma_auth_sessions (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES pluma_auth_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pluma_auth_sessions_user_id ON pluma_auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS pluma_auth_identities (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES pluma_auth_users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider_id, identity_id),
  UNIQUE(issuer, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_pluma_auth_identities_user_id ON pluma_auth_identities(user_id);

CREATE TABLE IF NOT EXISTS pluma_auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pluma_auth_verifications_identifier ON pluma_auth_verifications(identifier);

CREATE TABLE IF NOT EXISTS pluma_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE REFERENCES pluma_auth_users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'developer', 'pro', 'scale')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_status TEXT,
  provider_updated_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pluma_api_keys (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  scopes TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pluma_api_keys_prefix ON pluma_api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_pluma_api_keys_account_created ON pluma_api_keys(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pluma_requests (
  request_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  units INTEGER NOT NULL CHECK (units >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  warning_codes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pluma_requests_account_created ON pluma_requests(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pluma_usage_monthly (
  account_id UUID NOT NULL REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  used_units BIGINT NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  reserved_units BIGINT NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  operation_totals JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, month)
);

CREATE TABLE IF NOT EXISTS pluma_usage_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  operation TEXT NOT NULL,
  maximum_units INTEGER NOT NULL CHECK (maximum_units > 0),
  final_units INTEGER CHECK (final_units >= 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'charged', 'refunded')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pluma_reservations_account_state ON pluma_usage_reservations(account_id, state, expires_at);

CREATE TABLE IF NOT EXISTS pluma_idempotency (
  account_id UUID NOT NULL REFERENCES pluma_accounts(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed', 'failed')),
  reservation_id UUID REFERENCES pluma_usage_reservations(id),
  encrypted_response BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, route, key_digest)
);
CREATE INDEX IF NOT EXISTS idx_pluma_idempotency_expiry ON pluma_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS pluma_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_created_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'completed')),
  lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pluma_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
