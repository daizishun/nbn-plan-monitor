import { defineAction, z, type ActionsModule, type Ctx } from "./sdk";
import { asc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { CHECKED, SEED_PLANS, SEED_PROVIDERS } from "./seed";

const planOut = z.object({
  id: z.number(),
  provider: z.string(),
  planName: z.string(),
  tier: z.string(),
  speedDown: z.number(),
  speedUp: z.number().nullable(),
  introPrice: z.number().nullable(),
  introMonths: z.number().nullable(),
  ongoingPrice: z.number(),
  tes: z.string().nullable(),
  dataAllowance: z.string(),
  contract: z.string().nullable(),
  category: z.string(),
  source: z.string(),
  sourceUrl: z.string().nullable(),
  checkedDate: z.string(),
  promoEnd: z.string().nullable(),
  note: z.string().nullable(),
  lastRefreshStatus: z.enum(["updated", "unchanged", "failed"]),
  lastRefreshAt: z.string().nullable(),
});

const stateResponse = z.object({
  plans: z.array(planOut),
  history: z.array(
    z.object({
      planId: z.number(),
      checkedDate: z.string(),
      introPrice: z.number().nullable(),
      introMonths: z.number().nullable(),
      ongoingPrice: z.number(),
    }),
  ),
  providers: z.array(
    z.object({ name: z.string(), websiteUrl: z.string().nullable() }),
  ),
  lastChecked: z.string().nullable(),
  refreshRequestedAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastAttemptStatus: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  currentPlan: z
    .object({
      provider: z.string(),
      tier: z.string(),
      monthlyPrice: z.number(),
    })
    .nullable(),
});

type StateOut = z.infer<typeof stateResponse>;

async function readMeta(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta);
  return new Map(rows.map((r) => [r.key, r.value]));
}

// Upserts key/value rows in the meta table (check timestamps, refresh
// status, the saved current plan all live there).
async function setMeta(ctx: Ctx, entries: Record<string, string>) {
  const db = ctx.db<typeof schema>();
  const statements: BatchItem<"sqlite">[] = Object.entries(entries).map(
    ([k, v]) =>
      db
        .insert(schema.meta)
        .values({ key: k, value: v })
        .onConflictDoUpdate({
          target: schema.meta.key,
          set: { value: v },
        }),
  );
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

// --- Duplicate plans -------------------------------------------------------
// Refresh runs have re-inserted plans that were already tracked under a
// slightly different plan or provider name ("nbn25 Unlimited" vs
// "nbn25 Unlimited Plan", "Kogan" vs "Kogan Internet", "Moose" vs
// "Moose Mobile"). Two rows are the same plan when the brand
// (normalised), the speed tier and every price figure match — those are
// shown and stored once. Same brand and prices in a *different* tier
// (Kogan Gold 100 vs Gold Plus 500) are different plans and stay.

type PlanRow = typeof schema.plans.$inferSelect;

function normProviderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(internet|telecom|mobile|broadband)$/, "");
}

function planDupKey(p: {
  provider: string;
  tier: string;
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): string {
  return [
    normProviderKey(p.provider),
    p.tier,
    p.introPrice == null ? "flat" : String(p.introPrice),
    p.introMonths == null ? "" : String(p.introMonths),
    String(p.ongoingPrice),
  ].join("|");
}

const REFRESH_RANK: Record<string, number> = {
  unchanged: 0,
  updated: 1,
  failed: 2,
};

type RefreshStatusValue = "updated" | "unchanged" | "failed";

/**
 * Removes duplicate plan rows (same normalised brand + tier + identical
 * intro/ongoing prices), keeping the earliest — curated — row of each
 * group. Before a duplicate is deleted, any detail it has that the
 * keeper lacks (evening speed, upload speed, contract, source link,
 * promo end, note) is copied over, and the keeper takes the group's
 * most notable refresh outcome, so nothing verified is lost. Returns
 * how many rows were removed.
 */
async function dedupePlans(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.plans)
    .orderBy(asc(schema.plans.id));
  const groups = new Map<string, PlanRow[]>();
  for (const r of rows) {
    const k = planDupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  let removed = 0;
  const statements: BatchItem<"sqlite">[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [keeper, ...dups] = g;
    if (!keeper) continue;
    const patch: {
      speedUp?: number;
      tes?: string;
      contract?: string;
      sourceUrl?: string;
      promoEnd?: string;
      note?: string;
      lastRefreshStatus?: RefreshStatusValue;
      lastRefreshAt?: string | null;
    } = {};
    if (keeper.speedUp == null) {
      const v = dups.find((d) => d.speedUp != null)?.speedUp;
      if (v != null) patch.speedUp = v;
    }
    if (keeper.tes == null) {
      const v = dups.find((d) => d.tes != null)?.tes;
      if (v != null) patch.tes = v;
    }
    if (keeper.contract == null) {
      const v = dups.find((d) => d.contract != null)?.contract;
      if (v != null) patch.contract = v;
    }
    if (keeper.sourceUrl == null) {
      const v = dups.find((d) => d.sourceUrl != null)?.sourceUrl;
      if (v != null) patch.sourceUrl = v;
    }
    if (keeper.promoEnd == null) {
      const v = dups.find((d) => d.promoEnd != null)?.promoEnd;
      if (v != null) patch.promoEnd = v;
    }
    if (keeper.note == null) {
      const v = dups.find((d) => d.note != null)?.note;
      if (v != null) patch.note = v;
    }
    let status: RefreshStatusValue =
      (keeper.lastRefreshStatus as RefreshStatusValue | null) ?? "unchanged";
    let statusAt = keeper.lastRefreshAt;
    for (const d of dups) {
      const ds = (d.lastRefreshStatus as RefreshStatusValue | null) ??
        "unchanged";
      if ((REFRESH_RANK[ds] ?? 0) > (REFRESH_RANK[status] ?? 0)) {
        status = ds;
        statusAt = d.lastRefreshAt;
      }
    }
    if (status !== (keeper.lastRefreshStatus ?? "unchanged")) {
      patch.lastRefreshStatus = status;
      patch.lastRefreshAt = statusAt;
    }
    if (Object.keys(patch).length > 0) {
      statements.push(
        db
          .update(schema.plans)
          .set(patch)
          .where(eq(schema.plans.id, keeper.id)),
      );
    }
    const dupIds = dups.map((d) => d.id);
    statements.push(
      db
        .delete(schema.priceHistory)
        .where(inArray(schema.priceHistory.planId, dupIds)),
    );
    statements.push(
      db.delete(schema.plans).where(inArray(schema.plans.id, dupIds)),
    );
    removed += dupIds.length;
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return removed;
}

export const Actions = {
  getState: defineAction({
    description:
      "Returns all monitored NBN plans, price history, the nbnco provider directory, and the saved current plan.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<StateOut> {
      const db = ctx.db<typeof schema>();
      const [planRows, historyRows, providerRows, metaMap] = await Promise.all([
        db.select().from(schema.plans).orderBy(asc(schema.plans.id)),
        db
          .select()
          .from(schema.priceHistory)
          .orderBy(asc(schema.priceHistory.checkedDate)),
        db.select().from(schema.providers).orderBy(asc(schema.providers.name)),
        readMeta(ctx),
      ]);
      // Display-level dedupe (same rule as dedupePlans): even before the
      // stored cleanup runs, a plan that exists twice under slightly
      // different names with identical prices is returned only once —
      // the earliest row — and price history follows the kept rows.
      const seenDupKeys = new Set<string>();
      const dedupedPlanRows = planRows.filter((p) => {
        const k = planDupKey(p);
        if (seenDupKeys.has(k)) return false;
        seenDupKeys.add(k);
        return true;
      });
      const keptPlanIds = new Set(dedupedPlanRows.map((p) => p.id));
      const keptHistoryRows = historyRows.filter((h) =>
        keptPlanIds.has(h.planId),
      );
      const cpProvider = metaMap.get("cp_provider");
      const cpTier = metaMap.get("cp_tier");
      const cpPrice = metaMap.get("cp_price");
      const attemptStatus = metaMap.get("last_attempt_status") ?? null;
      const attemptAt = metaMap.get("last_attempt_at") ?? null;
      const successAt = metaMap.get("last_success_at") ?? null;
      // When the most recent refresh attempt failed (it is newer than
      // the last success), every plan shows 更新失败 for that attempt,
      // whatever its stored per-plan outcome from an earlier run was.
      const lastRunFailed =
        attemptStatus === "failed" &&
        (successAt == null ||
          attemptAt == null ||
          Date.parse(attemptAt) >= Date.parse(successAt));
      return {
        plans: dedupedPlanRows.map((p) => ({
          id: p.id,
          provider: p.provider,
          planName: p.planName,
          tier: p.tier,
          speedDown: p.speedDown,
          speedUp: p.speedUp,
          introPrice: p.introPrice,
          introMonths: p.introMonths,
          ongoingPrice: p.ongoingPrice,
          tes: p.tes,
          dataAllowance: p.dataAllowance,
          contract: p.contract,
          category: p.category,
          source: p.source,
          sourceUrl: p.sourceUrl,
          checkedDate: p.checkedDate,
          promoEnd: p.promoEnd,
          note: p.note,
          lastRefreshStatus: (lastRunFailed
            ? "failed"
            : (p.lastRefreshStatus ?? "unchanged")) as
            | "updated"
            | "unchanged"
            | "failed",
          lastRefreshAt: lastRunFailed
            ? (attemptAt ?? p.lastRefreshAt)
            : p.lastRefreshAt,
        })),
        history: keptHistoryRows.map((h) => ({
          planId: h.planId,
          checkedDate: h.checkedDate,
          introPrice: h.introPrice,
          introMonths: h.introMonths,
          ongoingPrice: h.ongoingPrice,
        })),
        providers: providerRows.map((p) => ({
          name: p.name,
          websiteUrl: p.websiteUrl,
        })),
        lastChecked: metaMap.get("last_checked") ?? null,
        refreshRequestedAt: metaMap.get("refresh_requested_at") ?? null,
        lastAttemptAt: metaMap.get("last_attempt_at") ?? null,
        lastAttemptStatus: metaMap.get("last_attempt_status") ?? null,
        lastSuccessAt: metaMap.get("last_success_at") ?? null,
        currentPlan:
          cpProvider && cpTier && cpPrice
            ? {
                provider: cpProvider,
                tier: cpTier,
                monthlyPrice: Number(cpPrice),
              }
            : null,
      };
    },
  }),

  seedPlans: defineAction({
    description:
      "Seeds any missing monitored NBN plans, price-history baselines, and nbnco provider directory rows from the 2026-11-19 research snapshot, and removes duplicate plan rows (same brand, tier and identical prices under slightly different names, left behind by earlier refreshes). Idempotent: existing rows are never overwritten, so refreshed prices and user edits survive. The user's own current plan is not seeded — it starts empty and is entered on the page.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean(), planCount: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = (provider: string, planName: string, tier: string) =>
        `${provider.toLowerCase()}|${planName.toLowerCase()}|${tier}`;
      const existingPlans = await db.select().from(schema.plans);
      const havePlan = new Set(
        existingPlans.map((p) => key(p.provider, p.planName, p.tier)),
      );
      const missingPlans = SEED_PLANS.filter(
        (p) => !havePlan.has(key(p.provider, p.planName, p.tier)),
      );
      const existingProviders = await db.select().from(schema.providers);
      const haveProvider = new Set(
        existingProviders.map((p) => p.name.toLowerCase()),
      );
      const missingProviders = SEED_PROVIDERS.filter(
        (p) => !haveProvider.has(p.name.toLowerCase()),
      );
      let changed = false;
      if (missingPlans.length > 0 || missingProviders.length > 0) {
        const statements: BatchItem<"sqlite">[] = [];
        for (const p of missingPlans) {
          statements.push(
            db.insert(schema.plans).values({
              provider: p.provider,
              planName: p.planName,
              tier: p.tier,
              speedDown: p.speedDown,
              speedUp: p.speedUp ?? null,
              introPrice: p.introPrice ?? null,
              introMonths: p.introMonths ?? null,
              ongoingPrice: p.ongoingPrice,
              tes: p.tes ?? null,
              contract: p.contract ?? null,
              category: p.category,
              source: p.source,
              sourceUrl: p.sourceUrl ?? null,
              checkedDate: CHECKED,
              promoEnd: p.promoEnd ?? null,
              note: p.note ?? null,
              lastRefreshStatus: "unchanged" as const,
            }),
          );
        }
        for (const p of missingProviders) {
          statements.push(
            db
              .insert(schema.providers)
              .values({ name: p.name, websiteUrl: p.websiteUrl ?? null }),
          );
        }
        statements.push(
          db
            .insert(schema.meta)
            .values({ key: "last_checked", value: CHECKED })
            .onConflictDoNothing(),
        );
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        changed = true;
      }
      if (missingPlans.length > 0) {
        // Baseline price-history point for each newly inserted plan only.
        const nowPlans = await db.select().from(schema.plans);
        const newRows = nowPlans.filter((p) =>
          missingPlans.some(
            (m) => key(m.provider, m.planName, m.tier) === key(p.provider, p.planName, p.tier),
          ),
        );
        const hist: BatchItem<"sqlite">[] = newRows.map((p) =>
          db.insert(schema.priceHistory).values({
            planId: p.id,
            checkedDate: CHECKED,
            introPrice: p.introPrice,
            introMonths: p.introMonths,
            ongoingPrice: p.ongoingPrice,
          }),
        );
        const [h0, ...hRest] = hist;
        if (h0) await db.batch([h0, ...hRest]);
      }
      // No default current plan is seeded: a fresh database starts with
      // no saved plan, and the user enters their own on the page
      // (saveCurrentPlan). Previously this block wrote a hardcoded
      // personal default here; it was removed for the standalone build.
      // Sync-refresh bookkeeping: databases created before check timestamps
      // existed get their last-success / last-attempt stamps backfilled from
      // the research check date, so the page-open auto-sync measures the
      // 24h interval from that check instead of firing immediately.
      const metaMap = await readMeta(ctx);
      if (!metaMap.get("last_success_at")) {
        const checkedDate = metaMap.get("last_checked") ?? CHECKED;
        const stamp = new Date(
          `${checkedDate}T00:00:00+11:00`,
        ).toISOString();
        const rows: BatchItem<"sqlite">[] = [
          db
            .insert(schema.meta)
            .values({ key: "last_success_at", value: stamp })
            .onConflictDoNothing(),
          db
            .insert(schema.meta)
            .values({ key: "last_attempt_at", value: stamp })
            .onConflictDoNothing(),
          db
            .insert(schema.meta)
            .values({ key: "last_attempt_status", value: "success" })
            .onConflictDoNothing(),
        ];
        const [first, ...rest] = rows;
        if (first) await db.batch([first, ...rest]);
        changed = true;
      }
      // Remove duplicate rows left by earlier refreshes (same brand,
      // tier and prices under a variant name). Runs on every call —
      // including when nothing was missing — so an already-populated
      // database is cleaned on the next page open, not just fresh ones.
      const removed = await dedupePlans(ctx);
      if (removed > 0) changed = true;
      if (changed) ctx.invalidateQueries();
      const all = await db.select({ id: schema.plans.id }).from(schema.plans);
      return { seeded: changed, planCount: all.length };
    },
  }),

  saveCurrentPlan: defineAction({
    description:
      "Saves the user's current NBN plan (provider, speed tier, monthly price) so the page can show what switching would save.",
    request: z.object({
      provider: z.string().trim().min(1).max(60),
      tier: z.string().trim().min(1).max(10),
      monthlyPrice: z.number().positive().max(1000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows: BatchItem<"sqlite">[] = [
        db
          .insert(schema.meta)
          .values({ key: "cp_provider", value: args.provider })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: args.provider },
          }),
        db
          .insert(schema.meta)
          .values({ key: "cp_tier", value: args.tier })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: args.tier },
          }),
        db
          .insert(schema.meta)
          .values({ key: "cp_price", value: String(args.monthlyPrice) })
          .onConflictDoUpdate({
            target: schema.meta.key,
            set: { value: String(args.monthlyPrice) },
          }),
      ];
      const [first, ...rest] = rows;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearCurrentPlan: defineAction({
    description: "Clears the saved current NBN plan.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.meta).where(eq(schema.meta.key, "cp_provider"));
      await db.delete(schema.meta).where(eq(schema.meta.key, "cp_tier"));
      await db.delete(schema.meta).where(eq(schema.meta.key, "cp_price"));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  refreshPrices: defineAction({
    description:
      "Standalone build: there is no background agent to re-check prices, so this action always reports that no check was started and does not touch any stored state. Prices can still be updated manually through saveRefreshedPlans (or a failed check recorded with markRefreshFailed).",
    request: z.object({}),
    response: z.object({ started: z.boolean(), message: z.string() }),
    async handler() {
      // 预留的自动核价触发接口（接口定义、参数和返回结构见上方的
      // request/response；完整约定见 README“自动核价预留接口”）：
      // 以后接自动核价后台服务时，在这里启动核价任务——启动成功
      // 返回 { started: true, ... }，核完的结果调 saveRefreshedPlans
      // 写入；前端的「立即刷新」按钮和数据结构不用改。
      // The Muse-hosted version spawned a background agent task here
      // (ctx.agent.spawnTask) that re-checked WhistleOut, Finder and
      // provider pages and saved the result via saveRefreshedPlans.
      // That agent does not exist outside the Muse host, so the
      // standalone server deliberately does nothing except explain —
      // stamping a failed attempt would wrongly mark every plan 更新失败.
      return {
        started: false,
        message:
          "独立运行版没有后台自动核价：价格为 2026-11-19 的研究快照，请以供应商官网/CIS 为准；如需更新，可自行核对 WhistleOut、Finder 或供应商官网后，通过 saveRefreshedPlans 接口录入复核结果。",
      };
    },
  }),

  markRefreshFailed: defineAction({
    description:
      "Records a failed NBN price refresh: stamps the attempt as failed in meta and marks every plan's last refresh status as failed, so each row on the page shows 更新失败. Called by the background refresh task when it could not verify any prices.",
    request: z.object({
      reason: z.string().trim().max(400).optional(),
    }),
    response: z.object({ ok: z.literal(true), marked: z.number() }),
    async handler(ctx): Promise<{ ok: true; marked: number }> {
      const db = ctx.db<typeof schema>();
      const nowIso = new Date().toISOString();
      await setMeta(ctx, {
        last_attempt_at: nowIso,
        last_attempt_status: "failed",
      });
      const rows = await db.select({ id: schema.plans.id }).from(schema.plans);
      if (rows.length > 0) {
        await db
          .update(schema.plans)
          .set({ lastRefreshStatus: "failed", lastRefreshAt: nowIso });
      }
      ctx.invalidateQueries();
      return { ok: true, marked: rows.length };
    },
  }),

  // 预留的自动核价结果录入接口：以后接自动核价后台服务时，后台
  // 服务核完价直接调这里写入结果（字段定义见 request schema 和
  // README“手动核价流程”第 3 步）；手动核价也走同一个接口，
  // 所以这个 action 的定义、参数和返回结构必须完整保留。
  saveRefreshedPlans: defineAction({
    description:
      "Saves re-verified NBN plan prices from a refresh task: upserts matching plans (including matches under a variant plan/provider name when brand, tier and all prices are identical, so no duplicate row is created), adds genuinely new plans, appends price-history points, removes any duplicate rows, stamps the check date plus the successful-check timestamp the refresh interval is measured from, and records each plan's refresh outcome (updated when a figure changed, unchanged when it did not or was not re-verified) so every row shows 有更新 / 没有更新 after the run.",
    request: z.object({
      checked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      plans: z
        .array(
          z.object({
            provider: z.string().trim().min(1).max(60),
            plan_name: z.string().trim().min(1).max(120),
            tier: z.string().trim().min(1).max(10),
            intro_price: z.number().positive().max(1000).optional(),
            intro_months: z.number().int().positive().max(36).optional(),
            ongoing_price: z.number().positive().max(1000),
            tes: z.string().trim().max(40).optional(),
            note: z.string().trim().max(400).optional(),
          }),
        )
        .min(1)
        .max(120),
    }),
    response: z.object({
      updated: z.number(),
      unchanged: z.number(),
      inserted: z.number(),
      checked_date: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.plans);
      const nowIso = new Date().toISOString();
      let updated = 0;
      let unchanged = 0;
      let inserted = 0;
      const touchedIds = new Set<number>();
      for (const p of args.plans) {
        const match =
          existing.find(
            (e) =>
              e.provider.toLowerCase() === p.provider.toLowerCase() &&
              e.planName.toLowerCase() === p.plan_name.toLowerCase() &&
              e.tier === p.tier,
          ) ??
          // Same plan reported under a variant name with identical
          // prices: update the tracked row instead of inserting a
          // duplicate copy of it.
          existing.find(
            (e) =>
              !touchedIds.has(e.id) &&
              planDupKey(e) ===
                planDupKey({
                  provider: p.provider,
                  tier: p.tier,
                  introPrice: p.intro_price ?? null,
                  introMonths: p.intro_months ?? null,
                  ongoingPrice: p.ongoing_price,
                }),
          );
        if (match) {
          touchedIds.add(match.id);
          const newTes = p.tes ?? match.tes;
          const changed =
            match.introPrice !== (p.intro_price ?? null) ||
            match.introMonths !== (p.intro_months ?? null) ||
            match.ongoingPrice !== p.ongoing_price ||
            match.tes !== newTes;
          await db
            .update(schema.plans)
            .set({
              introPrice: p.intro_price ?? null,
              introMonths: p.intro_months ?? null,
              ongoingPrice: p.ongoing_price,
              tes: newTes,
              checkedDate: args.checked_date,
              note: p.note ?? match.note,
              source: "刷新复核（WhistleOut / Finder / 供应商官网）",
              lastRefreshStatus: changed ? "updated" : "unchanged",
              lastRefreshAt: nowIso,
            })
            .where(eq(schema.plans.id, match.id));
          const already = await db
            .select()
            .from(schema.priceHistory)
            .where(eq(schema.priceHistory.planId, match.id));
          if (!already.some((h) => h.checkedDate === args.checked_date)) {
            await db.insert(schema.priceHistory).values({
              planId: match.id,
              checkedDate: args.checked_date,
              introPrice: p.intro_price ?? null,
              introMonths: p.intro_months ?? null,
              ongoingPrice: p.ongoing_price,
            });
          }
          if (changed) updated += 1;
          else unchanged += 1;
        } else {
          const down = Number.parseInt(p.tier, 10);
          const [row] = await db
            .insert(schema.plans)
            .values({
              provider: p.provider,
              planName: p.plan_name,
              tier: p.tier,
              speedDown: Number.isNaN(down) ? 0 : down,
              introPrice: p.intro_price ?? null,
              introMonths: p.intro_months ?? null,
              ongoingPrice: p.ongoing_price,
              tes: p.tes ?? null,
              category: "cheapest",
              source: "刷新复核（WhistleOut / Finder / 供应商官网）",
              checkedDate: args.checked_date,
              note: p.note ?? null,
              lastRefreshStatus: "updated",
              lastRefreshAt: nowIso,
            })
            .returning({ id: schema.plans.id });
          if (row) {
            touchedIds.add(row.id);
            await db.insert(schema.priceHistory).values({
              planId: row.id,
              checkedDate: args.checked_date,
              introPrice: p.intro_price ?? null,
              introMonths: p.intro_months ?? null,
              ongoingPrice: p.ongoing_price,
            });
            inserted += 1;
          }
        }
      }
      // Plans this refresh did not re-verify keep their old price, so
      // for this run they are 没有更新 — stamp that outcome on them too,
      // so every row on the page carries a status for the latest run.
      for (const e of existing) {
        if (!touchedIds.has(e.id)) {
          await db
            .update(schema.plans)
            .set({ lastRefreshStatus: "unchanged", lastRefreshAt: nowIso })
            .where(eq(schema.plans.id, e.id));
          unchanged += 1;
        }
      }
      // Final guard: if anything in this payload still landed as a
      // second copy of a tracked plan (variant name, identical prices),
      // collapse it back into the tracked row before closing the run.
      await dedupePlans(ctx);
      // A completed save is a successful check: stamp the success time the
      // 24h refresh interval is measured from, and close out the attempt.
      await setMeta(ctx, {
        last_checked: args.checked_date,
        last_attempt_at: nowIso,
        last_attempt_status: "success",
        last_success_at: nowIso,
      });
      ctx.invalidateQueries();
      return { updated, unchanged, inserted, checked_date: args.checked_date };
    },
  }),
} satisfies ActionsModule;
