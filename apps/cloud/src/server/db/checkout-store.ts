import { AppError } from "../errors.js";
import type { CheckoutClaim, CheckoutSessionStore, PaidPlan } from "../billing/stripe.js";
import { randomUUID } from "node:crypto";
import { Database } from "./database.js";

interface CheckoutRow {
  plan: PaidPlan;
  state: "creating" | "open";
  attempt_id: string;
  previous_stripe_session_id: string | null;
  stripe_session_id: string | null;
  checkout_url: string | null;
  expires_at: Date | null;
  lease_expires_at: Date;
}

const LEASE_MILLISECONDS = 60_000;

export class PostgresCheckoutSessionStore implements CheckoutSessionStore {
  constructor(private readonly database: Database) {}

  async claim(accountId: string, requestedPlan: PaidPlan, now: Date): Promise<CheckoutClaim> {
    return this.database.transaction(async (client) => {
      const account = await client.query<{ stripe_subscription_id: string | null }>(
        "SELECT stripe_subscription_id FROM pluma_accounts WHERE id = $1 FOR UPDATE",
        [accountId],
      );
      if (!account.rows[0]) throw new AppError("not_found", "Account not found", 404);
      if (account.rows[0].stripe_subscription_id) return { kind: "subscribed" };

      const current = await client.query<CheckoutRow>(
        `SELECT plan, state, attempt_id, previous_stripe_session_id, stripe_session_id,
                checkout_url, expires_at, lease_expires_at
         FROM pluma_checkout_sessions WHERE account_id = $1 FOR UPDATE`,
        [accountId],
      );
      const row = current.rows[0];

      if (row?.state === "open" && row.plan === requestedPlan && row.expires_at && row.expires_at > now && row.checkout_url) {
        return { kind: "ready", url: row.checkout_url };
      }

      if (row?.state === "creating") {
        if (row.lease_expires_at > now) return { kind: "busy", plan: row.plan };
        const leaseExpiresAt = new Date(now.getTime() + LEASE_MILLISECONDS);
        await client.query(
          "UPDATE pluma_checkout_sessions SET lease_expires_at = $3, updated_at = $2 WHERE account_id = $1 AND attempt_id = $4",
          [accountId, now, leaseExpiresAt, row.attempt_id],
        );
        // Recover the exact durable attempt first. Reusing its Stripe
        // idempotency key closes the crash window after the remote create.
        return {
          kind: "claimed",
          plan: row.plan,
          attemptId: row.attempt_id,
          previousSessionId: row.previous_stripe_session_id ?? undefined,
        };
      }

      const attemptId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MILLISECONDS);
      const previousSessionId = row?.stripe_session_id ?? undefined;
      if (row) {
        await client.query(
          `UPDATE pluma_checkout_sessions
           SET plan = $2, state = 'creating', attempt_id = $3,
               previous_stripe_session_id = $4, stripe_session_id = NULL,
               checkout_url = NULL, expires_at = NULL, lease_expires_at = $6, updated_at = $5
           WHERE account_id = $1`,
          [accountId, requestedPlan, attemptId, previousSessionId, now, leaseExpiresAt],
        );
      } else {
        await client.query(
          `INSERT INTO pluma_checkout_sessions(
             account_id, plan, state, attempt_id, previous_stripe_session_id, lease_expires_at, created_at, updated_at
           ) VALUES ($1, $2, 'creating', $3, NULL, $5, $4, $4)`,
          [accountId, requestedPlan, attemptId, now, leaseExpiresAt],
        );
      }
      return { kind: "claimed", plan: requestedPlan, attemptId, previousSessionId };
    });
  }

  async complete(input: {
    accountId: string;
    attemptId: string;
    stripeSessionId: string;
    url: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE pluma_checkout_sessions
       SET state = 'open', previous_stripe_session_id = NULL, stripe_session_id = $3,
           checkout_url = $4, expires_at = $5, lease_expires_at = $5, updated_at = $6
       WHERE account_id = $1 AND attempt_id = $2 AND state = 'creating'`,
      [input.accountId, input.attemptId, input.stripeSessionId, input.url, input.expiresAt, input.now],
    );
    return result.rowCount === 1;
  }

  async release(accountId: string, attemptId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE pluma_checkout_sessions SET lease_expires_at = $3, updated_at = $3
       WHERE account_id = $1 AND attempt_id = $2 AND state = 'creating'`,
      [accountId, attemptId, now],
    );
  }
}
