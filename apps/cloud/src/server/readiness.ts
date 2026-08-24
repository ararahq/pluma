import type { BillingProvider } from "./billing/stripe.js";
import type { Queryable } from "./db/database.js";
import { REQUIRED_SCHEMA_VERSION } from "./db/migrate.js";

export async function validateBillingCatalogAtStartup(
  billing: Pick<BillingProvider, "ready"> | undefined,
): Promise<void> {
  await billing?.ready?.();
}

export function createDatabaseReadinessCheck(database: Queryable): () => Promise<void> {
  return async () => {
    const result = await database.query<{ version: string }>(
      "SELECT version FROM pluma_schema_migrations WHERE version = $1",
      [REQUIRED_SCHEMA_VERSION],
    );
    if (result.rowCount !== 1) throw new Error("Required database migration is not applied");
  };
}
