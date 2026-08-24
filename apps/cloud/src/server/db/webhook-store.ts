import type { WebhookEventStore } from "../billing/stripe.js";
import type { Database } from "./database.js";
import { randomUUID } from "node:crypto";

export class PostgresWebhookEventStore implements WebhookEventStore {
  constructor(private readonly database: Database) {}

  async claim(eventId: string, eventType: string, providerCreatedAt: Date): ReturnType<WebhookEventStore["claim"]> {
    const leaseToken = randomUUID();
    const result = await this.database.query<{ lease_token: string }>(
      `INSERT INTO pluma_webhook_events(event_id, event_type, provider_created_at, state, lease_token, lease_expires_at)
       VALUES ($1, $2, $3, 'processing', $4, now() + interval '5 minutes')
       ON CONFLICT (event_id) DO UPDATE SET lease_token = EXCLUDED.lease_token,
         lease_expires_at = EXCLUDED.lease_expires_at
       WHERE pluma_webhook_events.state = 'processing'
         AND pluma_webhook_events.lease_expires_at <= now()
         AND pluma_webhook_events.event_type = EXCLUDED.event_type
         AND pluma_webhook_events.provider_created_at = EXCLUDED.provider_created_at
       RETURNING lease_token`,
      [eventId, eventType, providerCreatedAt, leaseToken],
    );
    const claimed = result.rows[0]?.lease_token;
    if (claimed) return { kind: "claimed", leaseToken: claimed };
    const existing = await this.database.query<{ state: "processing" | "completed"; event_type: string; provider_created_at: Date }>(
      "SELECT state, event_type, provider_created_at FROM pluma_webhook_events WHERE event_id = $1",
      [eventId],
    );
    const row = existing.rows[0];
    if (row?.state === "completed" && row.event_type === eventType && row.provider_created_at.getTime() === providerCreatedAt.getTime()) {
      return { kind: "completed" };
    }
    return { kind: "busy" };
  }

  async complete(eventId: string, leaseToken: string): Promise<void> {
    await this.database.query(
      "UPDATE pluma_webhook_events SET state = 'completed', processed_at = now() WHERE event_id = $1 AND state = 'processing' AND lease_token = $2",
      [eventId, leaseToken],
    );
  }

  async release(eventId: string, leaseToken: string): Promise<void> {
    await this.database.query("DELETE FROM pluma_webhook_events WHERE event_id = $1 AND state = 'processing' AND lease_token = $2", [eventId, leaseToken]);
  }
}
