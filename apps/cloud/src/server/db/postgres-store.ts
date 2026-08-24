import type { PoolClient } from "pg";
import { AppError } from "../errors.js";
import { planLimits } from "../billing/plans.js";
import type { AccountStore, BillingMutations, IdempotencyStore, RequestMetadataStore, StripeBillingIdentifiers, UsageStore } from "../store.js";
import type { ApiKeyStore } from "../security/api-keys.js";
import type { Account, ApiKeyRecord, BillingState, IdempotencyClaim, Operation, Plan, Reservation, StoredResponse, UsageSnapshot } from "../types.js";
import { ReplayCipher, sha256 } from "../security/crypto.js";
import type { AppConfig } from "../config.js";
import { Database } from "./database.js";

interface AccountRow {
  id: string;
  user_id: string;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  provider_updated_at: Date | null;
  current_period_end: Date | null;
}

interface ReservationRow {
  id: string;
  account_id: string;
  month: string;
  operation: string;
  maximum_units: number;
  final_units: number | null;
  state: Reservation["state"];
  expires_at: Date;
}

function account(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id ?? undefined,
    stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
    subscriptionStatus: row.subscription_status ?? undefined,
    providerUpdatedAt: row.provider_updated_at ?? undefined,
    currentPeriodEnd: row.current_period_end ?? undefined,
  };
}

function reservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    accountId: row.account_id,
    month: row.month,
    maximumUnits: row.maximum_units,
    finalUnits: row.final_units ?? undefined,
    state: row.state,
    expiresAt: row.expires_at,
  };
}

export class PostgresStore implements UsageStore, IdempotencyStore, AccountStore, ApiKeyStore, RequestMetadataStore {
  private readonly quotaOverrides: AppConfig["quotas"];

  constructor(private readonly database: Database, private readonly replayCipher: ReplayCipher, config: Pick<AppConfig, "quotas">) {
    this.quotaOverrides = config.quotas;
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    return this.database.transaction(async (client) => {
      const refunded = await client.query<{ count: string }>(
        `WITH expired AS (
           UPDATE pluma_usage_reservations SET state = 'refunded', finalized_at = $1
           WHERE state = 'reserved' AND expires_at <= $1
           RETURNING account_id, month, maximum_units
         ), totals AS (
           SELECT account_id, month, SUM(maximum_units) AS units FROM expired GROUP BY account_id, month
         ), adjusted AS (
           UPDATE pluma_usage_monthly usage SET reserved_units = GREATEST(0, usage.reserved_units - totals.units), updated_at = $1
           FROM totals WHERE usage.account_id = totals.account_id AND usage.month = totals.month
         ) SELECT COUNT(*)::text AS count FROM expired`,
        [now],
      );
      await client.query("DELETE FROM pluma_idempotency WHERE expires_at <= $1", [now]);
      await client.query(
        `DELETE FROM pluma_requests requests USING pluma_accounts accounts
         WHERE requests.account_id = accounts.id AND requests.created_at < $1::timestamptz -
           CASE WHEN accounts.plan IN ('pro', 'scale') THEN interval '90 days' ELSE interval '30 days' END`,
        [now],
      );
      await client.query(
        `DELETE FROM pluma_checkout_sessions
         WHERE state = 'open' AND expires_at < $1::timestamptz - interval '1 day'`,
        [now],
      );
      await client.query(
        `DELETE FROM pluma_usage_reservations
         WHERE state IN ('charged', 'refunded')
           AND finalized_at < $1::timestamptz - interval '90 days'`,
        [now],
      );
      await client.query(
        `DELETE FROM pluma_webhook_events
         WHERE state = 'completed'
           AND processed_at < $1::timestamptz - interval '180 days'`,
        [now],
      );
      return Number(refunded.rows[0]?.count ?? 0);
    });
  }

  async insert(record: ApiKeyRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO pluma_api_keys(id, account_id, prefix, digest, name, scopes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [record.id, record.accountId, record.prefix, record.digest, record.name, record.scopes, record.createdAt],
    );
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord[]> {
    const result = await this.database.query<{
      id: string; account_id: string; prefix: string; digest: string; name: string; scopes: Operation[] | null;
      created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
    }>(`SELECT id, account_id, prefix, digest, name, scopes, created_at, last_used_at, revoked_at
        FROM pluma_api_keys WHERE prefix = $1`, [prefix]);
    return result.rows.map((row) => ({
      id: row.id, accountId: row.account_id, prefix: row.prefix, digest: row.digest, name: row.name,
      scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined, revokedAt: row.revoked_at ?? undefined,
    }));
  }

  async list(accountId: string): Promise<ApiKeyRecord[]> {
    const result = await this.database.query<{
      id: string; account_id: string; prefix: string; digest: string; name: string; scopes: Operation[] | null;
      created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
    }>(`SELECT id, account_id, prefix, digest, name, scopes, created_at, last_used_at, revoked_at
        FROM pluma_api_keys WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`, [accountId]);
    return result.rows.map((row) => ({
      id: row.id, accountId: row.account_id, prefix: row.prefix, digest: row.digest, name: row.name,
      scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined, revokedAt: row.revoked_at ?? undefined,
    }));
  }

  async revoke(accountId: string, keyId: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE pluma_api_keys SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL",
      [keyId, accountId],
    );
    return result.rowCount === 1;
  }

  async touch(keyId: string, now: Date): Promise<void> {
    await this.database.query(
      "UPDATE pluma_api_keys SET last_used_at = $2::timestamptz WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < ($2::timestamptz - interval '5 minutes'))",
      [keyId, now],
    );
  }

  async byId(id: string): Promise<Account | null> {
    const result = await this.database.query<AccountRow>("SELECT id, user_id, plan, stripe_customer_id, stripe_subscription_id, subscription_status, provider_updated_at, current_period_end FROM pluma_accounts WHERE id = $1", [id]);
    return result.rows[0] ? account(result.rows[0]) : null;
  }

  async byUserId(userId: string): Promise<Account | null> {
    const result = await this.database.query<AccountRow>("SELECT id, user_id, plan, stripe_customer_id, stripe_subscription_id, subscription_status, provider_updated_at, current_period_end FROM pluma_accounts WHERE user_id = $1", [userId]);
    return result.rows[0] ? account(result.rows[0]) : null;
  }

  async ensureForUser(userId: string): Promise<Account> {
    const result = await this.database.query<AccountRow>(
      `INSERT INTO pluma_accounts(user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = pluma_accounts.updated_at
       RETURNING id, user_id, plan, stripe_customer_id, stripe_subscription_id, subscription_status, provider_updated_at, current_period_end`,
      [userId],
    );
    return account(result.rows[0]!);
  }

  async applyBilling(state: BillingState, providerUpdatedAt: Date, stripe: StripeBillingIdentifiers): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE pluma_accounts SET plan = $2, subscription_status = $3, current_period_end = $4,
           provider_updated_at = $5, stripe_customer_id = COALESCE($6, stripe_customer_id),
           stripe_subscription_id = $7, updated_at = now()
         WHERE id = $1 AND (provider_updated_at IS NULL OR provider_updated_at <= $5)
           AND ($7::text IS NOT NULL OR stripe_subscription_id IS NULL OR stripe_subscription_id = $8)`,
        [state.accountId, state.plan, state.status, state.currentPeriodEnd, providerUpdatedAt, stripe.customerId, stripe.subscriptionId, stripe.sourceSubscriptionId],
      );
      if (result.rowCount === 1) {
        await client.query(
          "DELETE FROM pluma_checkout_sessions WHERE account_id = $1 AND created_at <= $2",
          [state.accountId, providerUpdatedAt],
        );
      }
      return result.rowCount === 1;
    });
  }

  async withBillingMutation<T>(accountId: string, work: (mutations: BillingMutations) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('pluma_billing_account'), hashtext($1))",
        [accountId],
      );
      return work({
        applyEvent: async (state, providerUpdatedAt, stripe) => {
          const result = await client.query(
            `UPDATE pluma_accounts SET plan = $2, subscription_status = $3, current_period_end = $4,
               provider_updated_at = $5, stripe_customer_id = COALESCE($6, stripe_customer_id),
               stripe_subscription_id = $7, updated_at = now()
             WHERE id = $1 AND (provider_updated_at IS NULL OR provider_updated_at <= $5)
               AND ($7::text IS NOT NULL OR stripe_subscription_id IS NULL OR stripe_subscription_id = $8)`,
            [state.accountId, state.plan, state.status, state.currentPeriodEnd, providerUpdatedAt, stripe.customerId, stripe.subscriptionId, stripe.sourceSubscriptionId],
          );
          if (result.rowCount === 1) {
            await client.query(
              "DELETE FROM pluma_checkout_sessions WHERE account_id = $1 AND created_at <= $2",
              [state.accountId, providerUpdatedAt],
            );
          }
          return result.rowCount === 1;
        },
        reconcile: async (state, stripe) => {
          const result = await client.query(
            `UPDATE pluma_accounts SET plan = $2, subscription_status = $3, current_period_end = $4,
               stripe_customer_id = COALESCE($5, stripe_customer_id),
               stripe_subscription_id = $6, updated_at = now()
             WHERE id = $1
               AND ($6::text IS NOT NULL OR stripe_subscription_id IS NULL OR stripe_subscription_id = $7)`,
            [state.accountId, state.plan, state.status, state.currentPeriodEnd, stripe.customerId, stripe.subscriptionId, stripe.sourceSubscriptionId],
          );
          if (result.rowCount === 1) {
            await client.query("DELETE FROM pluma_checkout_sessions WHERE account_id = $1", [state.accountId]);
          }
          return result.rowCount === 1;
        },
      });
    });
  }

  async reserve(input: { accountId: string; plan: Plan; maximumUnits: number; expiresAt: Date }): Promise<Reservation> {
    return this.database.transaction((client) => this.reserveInTransaction(client, input));
  }

  private async reserveInTransaction(client: PoolClient, input: { accountId: string; plan: Plan; maximumUnits: number; expiresAt: Date; operation?: string }): Promise<Reservation> {
    if (input.plan === "free") throw new AppError("quota_exceeded", "A paid plan is required for authenticated document operations", 429);
    const month = new Date().toISOString().slice(0, 7) + "-01";
    await client.query(
      `INSERT INTO pluma_usage_monthly(account_id, month) VALUES ($1, $2)
       ON CONFLICT (account_id, month) DO NOTHING`,
      [input.accountId, month],
    );
    const usage = await client.query<{ used_units: string; reserved_units: string }>(
      "SELECT used_units, reserved_units FROM pluma_usage_monthly WHERE account_id = $1 AND month = $2 FOR UPDATE",
      [input.accountId, month],
    );
    const used = Number(usage.rows[0]!.used_units);
    const reserved = Number(usage.rows[0]!.reserved_units);
    const included = planLimits(input.plan, this.quotaOverrides).includedUnits;
    const remaining = included - used - reserved;
    const allowsPartial = input.operation === "render" || input.operation === "read_pdf" || input.operation === "read_url";
    const reservableUnits = allowsPartial ? Math.min(input.maximumUnits, remaining) : input.maximumUnits;
    if (remaining <= 0 || reservableUnits > remaining) {
      throw new AppError("quota_exceeded", "Monthly page-unit quota exceeded", 429, { details: { used, reserved, included } });
    }
    const created = await client.query<ReservationRow>(
      `INSERT INTO pluma_usage_reservations(account_id, month, operation, maximum_units, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, account_id, month::text, operation, maximum_units, final_units, state, expires_at`,
      [input.accountId, month, input.operation ?? "unknown", reservableUnits, input.expiresAt],
    );
    await client.query(
      "UPDATE pluma_usage_monthly SET reserved_units = reserved_units + $3, updated_at = now() WHERE account_id = $1 AND month = $2",
      [input.accountId, month, reservableUnits],
    );
    return reservation(created.rows[0]!);
  }

  async finalize(reservationId: string, actualUnits: number): Promise<void> {
    await this.database.transaction(async (client) => {
      const locked = await client.query<ReservationRow>(
        "SELECT id, account_id, month::text, operation, maximum_units, final_units, state, expires_at FROM pluma_usage_reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      const current = locked.rows[0];
      if (!current || current.state !== "reserved") return;
      if (!Number.isSafeInteger(actualUnits) || actualUnits < 0 || actualUnits > current.maximum_units) {
        throw new AppError("internal_error", "Final units exceed the reserved amount", 500);
      }
      await client.query("UPDATE pluma_usage_reservations SET state = 'charged', final_units = $2, finalized_at = now() WHERE id = $1", [reservationId, actualUnits]);
      await client.query(
        `UPDATE pluma_usage_monthly SET reserved_units = reserved_units - $3,
         used_units = used_units + $4,
         operation_totals = jsonb_set(operation_totals, ARRAY[$5], to_jsonb(COALESCE((operation_totals->>$5)::bigint, 0) + $4), true),
         updated_at = now() WHERE account_id = $1 AND month = $2::date`,
        [current.account_id, current.month, current.maximum_units, actualUnits, current.operation],
      );
    });
  }

  async refund(reservationId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const locked = await client.query<ReservationRow>(
        "SELECT id, account_id, month::text, operation, maximum_units, final_units, state, expires_at FROM pluma_usage_reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      const current = locked.rows[0];
      if (!current || current.state !== "reserved") return;
      await client.query("UPDATE pluma_usage_reservations SET state = 'refunded', finalized_at = now() WHERE id = $1", [reservationId]);
      await client.query(
        "UPDATE pluma_usage_monthly SET reserved_units = GREATEST(0, reserved_units - $3), updated_at = now() WHERE account_id = $1 AND month = $2::date",
        [current.account_id, current.month, current.maximum_units],
      );
    });
  }

  async usage(accountId: string, plan: Plan, now: Date): Promise<UsageSnapshot> {
    const month = now.toISOString().slice(0, 7) + "-01";
    const result = await this.database.query<{ used_units: string; reserved_units: string; operation_totals: Record<string, number> }>(
      "SELECT used_units, reserved_units, operation_totals FROM pluma_usage_monthly WHERE account_id = $1 AND month = $2",
      [accountId, month],
    );
    return {
      month,
      usedUnits: Number(result.rows[0]?.used_units ?? 0),
      reservedUnits: Number(result.rows[0]?.reserved_units ?? 0),
      includedUnits: planLimits(plan, this.quotaOverrides).includedUnits,
      operationUnits: result.rows[0]?.operation_totals ?? {},
    };
  }

  async claim(input: { accountId: string; route: string; key: string; requestHash: string; maximumUnits: number; plan: Plan; expiresAt: Date }): Promise<IdempotencyClaim> {
    const keyDigest = sha256(input.key);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.accountId}|${input.route}|${keyDigest}`]);
      const existing = await client.query<{ request_hash: string; state: string; reservation_id: string | null; encrypted_response: Buffer | null; expires_at: Date }>(
        "SELECT request_hash, state, reservation_id, encrypted_response, expires_at FROM pluma_idempotency WHERE account_id = $1 AND route = $2 AND key_digest = $3",
        [input.accountId, input.route, keyDigest],
      );
      const row = existing.rows[0];
      if (row && row.request_hash !== input.requestHash) return { kind: "conflict" };
      if (row && row.state === "completed" && row.encrypted_response && row.expires_at > new Date()) {
        return { kind: "replay", response: this.replayCipher.decrypt(row.encrypted_response) };
      }
      if (row && row.state === "in_progress" && row.expires_at > new Date()) return { kind: "in_progress" };
      if (row) {
        if (row.reservation_id) await this.refundInTransaction(client, row.reservation_id, input.accountId);
        await client.query("DELETE FROM pluma_idempotency WHERE account_id = $1 AND route = $2 AND key_digest = $3", [input.accountId, input.route, keyDigest]);
      }
      const reserved = await this.reserveInTransaction(client, { ...input, operation: input.route.replace(/^\/v1\//, "").replaceAll("/", "_") });
      await client.query(
        `INSERT INTO pluma_idempotency(account_id, route, key_digest, request_hash, reservation_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.accountId, input.route, keyDigest, input.requestHash, reserved.id, input.expiresAt],
      );
      return { kind: "claimed", reservation: reserved };
    });
  }

  private async refundInTransaction(client: PoolClient, reservationId: string, accountId: string): Promise<void> {
    const locked = await client.query<ReservationRow>(
      "SELECT id, account_id, month::text, operation, maximum_units, final_units, state, expires_at FROM pluma_usage_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE",
      [reservationId, accountId],
    );
    const current = locked.rows[0];
    if (!current || current.state !== "reserved") return;
    await client.query("UPDATE pluma_usage_reservations SET state = 'refunded', finalized_at = now() WHERE id = $1", [reservationId]);
    await client.query(
      "UPDATE pluma_usage_monthly SET reserved_units = GREATEST(0, reserved_units - $3), updated_at = now() WHERE account_id = $1 AND month = $2::date",
      [current.account_id, current.month, current.maximum_units],
    );
  }

  async complete(accountId: string, route: string, key: string, reservationId: string, actualUnits: number, encryptedResponse: Uint8Array): Promise<void> {
    await this.database.transaction(async (client) => {
      const locked = await client.query<ReservationRow>(
        "SELECT id, account_id, month::text, operation, maximum_units, final_units, state, expires_at FROM pluma_usage_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE",
        [reservationId, accountId],
      );
      const current = locked.rows[0];
      if (!current || current.state !== "reserved" || actualUnits < 0 || actualUnits > current.maximum_units) {
        throw new AppError("internal_error", "Usage reservation cannot be completed", 500);
      }
      await client.query("UPDATE pluma_usage_reservations SET state = 'charged', final_units = $2, finalized_at = now() WHERE id = $1", [reservationId, actualUnits]);
      await client.query(
        `UPDATE pluma_usage_monthly SET reserved_units = reserved_units - $3,
         used_units = used_units + $4,
         operation_totals = jsonb_set(operation_totals, ARRAY[$5], to_jsonb(COALESCE((operation_totals->>$5)::bigint, 0) + $4), true),
         updated_at = now() WHERE account_id = $1 AND month = $2::date`,
        [current.account_id, current.month, current.maximum_units, actualUnits, current.operation],
      );
      const updated = await client.query(
        `UPDATE pluma_idempotency SET state = 'completed', encrypted_response = $4
         WHERE account_id = $1 AND route = $2 AND key_digest = $3 AND reservation_id = $5 AND state = 'in_progress'`,
        [accountId, route, sha256(key), Buffer.from(encryptedResponse), reservationId],
      );
      if (updated.rowCount !== 1) throw new AppError("internal_error", "Idempotency record cannot be completed", 500);
    });
  }

  async fail(accountId: string, route: string, key: string, reservationId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const locked = await client.query<ReservationRow>(
        "SELECT id, account_id, month::text, operation, maximum_units, final_units, state, expires_at FROM pluma_usage_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE",
        [reservationId, accountId],
      );
      const current = locked.rows[0];
      if (current?.state === "reserved") {
        await client.query("UPDATE pluma_usage_reservations SET state = 'refunded', finalized_at = now() WHERE id = $1", [reservationId]);
        await client.query(
          "UPDATE pluma_usage_monthly SET reserved_units = GREATEST(0, reserved_units - $3), updated_at = now() WHERE account_id = $1 AND month = $2::date",
          [current.account_id, current.month, current.maximum_units],
        );
      }
      await client.query(
        "UPDATE pluma_idempotency SET state = 'failed', encrypted_response = NULL WHERE account_id = $1 AND route = $2 AND key_digest = $3 AND reservation_id = $4",
        [accountId, route, sha256(key), reservationId],
      );
    });
  }

  decryptReplay(claim: IdempotencyClaim): StoredResponse | undefined {
    return claim.response;
  }

  async record(input: { requestId: string; accountId: string; operation: Operation; status: "succeeded" | "failed"; units: number; durationMs: number; warningCodes: string[] }): Promise<void> {
    await this.database.query(
      `INSERT INTO pluma_requests(request_id, account_id, operation, status, units, duration_ms, warning_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.requestId, input.accountId, input.operation, input.status, input.units, input.durationMs, input.warningCodes],
    );
  }

  async recent(accountId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query<{
      request_id: string; operation: string; status: string; units: number; duration_ms: number; warning_codes: string[]; created_at: Date;
    }>(`SELECT request_id, operation, status, units, duration_ms, warning_codes, created_at
        FROM pluma_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [accountId, Math.min(100, Math.max(1, limit))]);
    return result.rows.map((row) => ({
      request_id: row.request_id,
      operation: row.operation,
      status: row.status,
      units: row.units,
      duration_ms: row.duration_ms,
      warnings: row.warning_codes,
      created_at: row.created_at.toISOString(),
    }));
  }
}
