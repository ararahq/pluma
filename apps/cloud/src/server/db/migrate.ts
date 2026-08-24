import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Database } from "./database.js";

const MIGRATION_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;
export const REQUIRED_SCHEMA_VERSION = "004_operational_retention";

export async function migrate(database: Database, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((file) => MIGRATION_PATTERN.test(file)).sort();
  const migrations = await Promise.all(files.map(async (file) => ({
    version: basename(file, ".sql"),
    sql: await readFile(resolve(directory, file), "utf8"),
  })));
  return database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pluma_schema_migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS pluma_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const applied: string[] = [];
    for (const migration of migrations) {
      const exists = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pluma_schema_migrations WHERE version = $1) AS exists", [migration.version]);
      if (exists.rows[0]?.exists) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO pluma_schema_migrations(version) VALUES ($1)", [migration.version]);
      applied.push(migration.version);
    }
    return applied;
  });
}
