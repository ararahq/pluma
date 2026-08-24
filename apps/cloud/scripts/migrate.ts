import { resolve } from "node:path";
import { Database } from "../src/server/db/database.js";
import { migrate } from "../src/server/db/migrate.js";
import { loadDatabaseTlsConfig } from "../src/server/config.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const poolSize = Number(process.env.PLUMA_DATABASE_POOL_SIZE ?? 2);
if (!Number.isSafeInteger(poolSize) || poolSize < 1 || poolSize > 50) {
  throw new Error("PLUMA_DATABASE_POOL_SIZE must be an integer between 1 and 50");
}
const database = new Database({
  databaseUrl,
  databasePoolSize: poolSize,
  environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
  ...loadDatabaseTlsConfig(process.env),
});
try {
  const migrationsDirectory = resolve(process.env.PLUMA_MIGRATIONS_DIR?.trim() || resolve(process.cwd(), "migrations"));
  const applied = await migrate(database, migrationsDirectory);
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
} finally {
  await database.close();
}
