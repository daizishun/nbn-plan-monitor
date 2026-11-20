// Standalone replacement for the server surface of `@hatch/space-sdk`
// (a Muse-internal package that is not on npm and must not be vendored).
//
// The app only used three things from the SDK on the server:
//   - `defineAction` + `z` (zod) — an action's request/response schemas
//     and its handler;
//   - `Ctx` — the per-request context: `ctx.db()` returns the drizzle
//     database, `ctx.invalidateQueries()` asked the Muse host to refetch
//     client queries (a no-op here — the browser invalidates its own
//     react-query cache after every mutation).
//   - `ctx.agent.spawnTask` (used by the old `refreshPrices` action to
//     run a background price re-check) — there is no agent in the
//     standalone build, so that action now reports that it cannot run;
//     see `actions.ts`.
//
// Only public npm packages are needed here: `zod` and `drizzle-orm`.

import { z } from "zod";
import type { BatchItem } from "drizzle-orm/batch";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export { z };

// The drizzle database, plus the `batch()` helper the actions use.
//
// In the Muse host the database was libsql-backed, whose drizzle driver
// has a native `db.batch()` that runs a list of prepared statements in
// order. The standalone build uses bun:sqlite, whose drizzle driver has
// no `batch()` — so the local `db` (see `db.ts`) adds one that simply
// executes the statements sequentially via each builder's `.execute()`.
export type Db<S extends Record<string, unknown>> =
  BunSQLiteDatabase<S> & {
    batch: (items: BatchItem<"sqlite">[]) => Promise<unknown[]>;
  };

export interface Ctx {
  db: <S extends Record<string, unknown>>() => Db<S>;
  invalidateQueries: () => void;
}

export interface ActionDef<
  Req extends z.ZodTypeAny,
  Res extends z.ZodTypeAny,
> {
  description?: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export function defineAction<
  Req extends z.ZodTypeAny,
  Res extends z.ZodTypeAny,
>(def: ActionDef<Req, Res>): ActionDef<Req, Res> {
  return def;
}

export type ActionsModule = Record<
  string,
  ActionDef<z.ZodTypeAny, z.ZodTypeAny>
>;
