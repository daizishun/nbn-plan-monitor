// SQLite database (drizzle + bun:sqlite) and the per-request `Ctx`
// handed to action handlers.
//
// The database file is created on first start: `migrateDb()` applies the
// SQL migrations in `drizzle/` (via drizzle-orm's bun-sqlite migrator),
// which creates the empty tables. Seed plan data is loaded later by the
// `seedPlans` action, not by the migration.

import { Database } from "bun:sqlite";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import * as schema from "./schema";
import type { Ctx, Db } from "./sdk";

export const DATABASE_PATH =
  process.env.DATABASE_PATH ?? join(process.cwd(), "app.db");

const sqlite = new Database(DATABASE_PATH);
sqlite.exec("PRAGMA journal_mode=WAL;");

// Local `batch()` (see sdk.ts): bun:sqlite's drizzle driver has none,
// so run the prepared statements in order via each builder's `.execute()`.
async function batch(items: BatchItem<"sqlite">[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const item of items) {
    results.push(
      await (item as unknown as { execute: () => Promise<unknown> }).execute(),
    );
  }
  return results;
}

export const db: Db<typeof schema> = Object.assign(
  drizzle(sqlite, { schema }),
  { batch },
);

/** Applies `drizzle/` migrations; safe to run on every start (idempotent). */
export function migrateDb(): void {
  migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
}

export function createCtx(): Ctx {
  return {
    db: <S extends Record<string, unknown>>() =>
      db as unknown as Db<S>,
    invalidateQueries: () => {},
  };
}
