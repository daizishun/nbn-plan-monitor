import { defineAction, z, type ActionsModule, type Ctx } from "./sdk";
import { asc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { CHECKED, SEED_HISTORY, SEED_PLANS, SEED_PROVIDERS } from "./seed";

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

// saveRefreshedPlans 的录入校验：档位白名单与“真日期”判定（正则只能
// 校验 YYYY-MM-DD 的形状，2026-02-30 这类不存在的日期要另外拦下）。
const TIERS = ["25", "50", "100", "250", "500", "750", "1000", "2000"] as const;

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
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
      "Seeds any missing monitored NBN plans, price-history points, and nbnco provider directory rows from the 2026-11-21 snapshot of the hosted tool's current data plus the 145 plans added from the 2026-11-21 Canstar comparison (https://www.canstar.com.au/internet/nbn-plans/), and removes duplicate plan rows (same brand, tier and identical prices under slightly different names, left behind by earlier refreshes). Idempotent: existing rows are never overwritten, so refreshed prices and user edits survive. The user's own current plan is not seeded — it starts empty and is entered on the page.",
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
              dataAllowance: p.dataAllowance ?? "无限流量",
              contract: p.contract ?? null,
              category: p.category,
              source: p.source,
              sourceUrl: p.sourceUrl ?? null,
              checkedDate: p.checkedDate ?? CHECKED,
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
        // Price-history points for each newly inserted plan only, taken
        // from SEED_HISTORY (the recorded history: one row per plan per
        // check date, 2026-11-19 / 2026-11-20 / 2026-11-21), so the
        // chart starts with real points instead of a single baseline.
        // Existing plans are never touched: their rows and history stay.
        const nowPlans = await db.select().from(schema.plans);
        const idByKey = new Map(
          nowPlans.map((p) => [key(p.provider, p.planName, p.tier), p.id]),
        );
        const newKeys = new Set(
          missingPlans.map((m) => key(m.provider, m.planName, m.tier)),
        );
        const hist: BatchItem<"sqlite">[] = [];
        for (const h of SEED_HISTORY) {
          const hk = key(h.provider, h.planName, h.tier);
          if (!newKeys.has(hk)) continue;
          const planId = idByKey.get(hk);
          if (planId == null) continue;
          hist.push(
            db.insert(schema.priceHistory).values({
              planId,
              checkedDate: h.checkedDate,
              introPrice: h.introPrice ?? null,
              introMonths: h.introMonths ?? null,
              ongoingPrice: h.ongoingPrice,
            }),
          );
        }
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
          "独立运行版没有后台自动核价：价格为 2026-11-21 的快照，请以供应商官网/CIS 为准；如需更新，可自行核对 WhistleOut、Finder 或供应商官网后，通过 saveRefreshedPlans 接口录入复核结果。",
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
  //
  // 录入语义（不是全量覆盖）：按供应商 + 套餐名 + 档位匹配，命中的
  // 行更新价格；没见过的新套餐新增一行；没放进 plans 数组的行保留
  // 原价和原核对日期（页面显示「没有更新」）。校验在写入之前一次
  // 性完成：任何一行不通过都返回 400，整批都不写入。

  saveRefreshedPlans: defineAction({
    description:
      "Saves re-verified NBN plan prices from a refresh task: upserts matching plans (including matches under a variant plan/provider name when brand, tier and all prices are identical, so no duplicate row is created), adds genuinely new plans, appends price-history points, removes any duplicate rows, stamps the check date plus the successful-check timestamp the refresh interval is measured from, and records each plan's refresh outcome (updated when a figure changed, unchanged when it did not or was not re-verified) so every row shows 有更新 / 没有更新 after the run. This is an upsert, not a full overwrite: plans left out of the payload keep their old price and check date. The payload is strictly validated before anything is written — a failed check returns HTTP 400 with per-row, per-field error details and nothing is written.",
    // 严格校验（全部在写入之前完成，见 index.ts 的 safeParse：任何
    // 一项不通过都返回 HTTP 400 + 逐行逐字段的错误说明，handler
    // 不运行，整批都不写入）：
    //   - 必填字段齐全：provider、plan_name、tier、ongoing_price、
    //     checked_date 缺一不可；
    //   - tier 必须是 25/50/100/250/500/750/1000/2000 其中之一；
    //   - 价格类字段（intro_price、ongoing_price）必须是数字且 >= 0；
    //   - intro_months 是 >= 0 的整数；大于 0 时 intro_price 必须有值；
    //   - checked_date 是真实存在的日期（YYYY-MM-DD）；
    //   - plans 数组非空且不超过 120 个。
    request: z
      .object({
        checked_date: z
          .string({ error: "checked_date 必填，格式 YYYY-MM-DD" })
          .regex(/^\d{4}-\d{2}-\d{2}$/, "checked_date 格式必须是 YYYY-MM-DD"),
        plans: z
          .array(
            z.object({
              provider: z
                .string({ error: "provider 必填，必须是字符串" })
                .trim()
                .min(1, "provider 不能为空")
                .max(60, "provider 最多 60 个字符"),
              plan_name: z
                .string({ error: "plan_name 必填，必须是字符串" })
                .trim()
                .min(1, "plan_name 不能为空")
                .max(120, "plan_name 最多 120 个字符"),
              tier: z
                .string({ error: "tier 必填，必须是字符串" })
                .trim()
                .min(1, "tier 不能为空")
                .max(10, "tier 最多 10 个字符"),
              intro_price: z
                .number({ error: "intro_price 必须是数字" })
                .min(0, "intro_price 不能小于 0")
                .max(1000, "intro_price 不能超过 1000")
                .optional(),
              intro_months: z
                .number({ error: "intro_months 必须是数字" })
                .int("intro_months 必须是整数")
                .min(0, "intro_months 不能小于 0")
                .max(36, "intro_months 不能超过 36")
                .optional(),
              ongoing_price: z
                .number({ error: "ongoing_price 必填，必须是数字" })
                .min(0, "ongoing_price 不能小于 0")
                .max(1000, "ongoing_price 不能超过 1000"),
              tes: z
                .string({ error: "tes 必须是字符串" })
                .trim()
                .max(40, "tes 最多 40 个字符")
                .optional(),
              note: z
                .string({ error: "note 必须是字符串" })
                .trim()
                .max(400, "note 最多 400 个字符")
                .optional(),
              promo_end: z
                .string({ error: "promo_end 必须是字符串" })
                .trim()
                .max(10, "promo_end 最多 10 个字符")
                .optional(),
            }),
          )
          .min(1, "plans 至少要包含 1 个套餐")
          .max(120, "plans 一次最多 120 个套餐"),
      })
      .superRefine((val, ctx) => {
        if (
          typeof val.checked_date === "string" &&
          !isRealDate(val.checked_date)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["checked_date"],
            message: "checked_date 不是合法日期（例如 2026-02-30 不存在）",
          });
        }
        if (!Array.isArray(val.plans)) return;
        val.plans.forEach((p, i) => {
          const row = i + 1;
          if (
            typeof p.tier === "string" &&
            !(TIERS as readonly string[]).includes(p.tier)
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["plans", i, "tier"],
              message: `第 ${row} 行 tier：档位必须是 25/50/100/250/500/750/1000/2000 其中之一`,
            });
          }
          if (
            p.intro_months != null &&
            p.intro_months > 0 &&
            p.intro_price == null
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["plans", i, "intro_price"],
              message: `第 ${row} 行 intro_price：优惠月数大于 0 时必须填写优惠价`,
            });
          }
          if (
            typeof p.promo_end === "string" &&
            p.promo_end !== "" &&
            !isRealDate(p.promo_end)
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["plans", i, "promo_end"],
              message: `第 ${row} 行 promo_end：不是合法日期（例如 2026-02-30 不存在）`,
            });
          }
        });
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
          // Stored NULL intro means "no intro" (flat plan): compare it
          // as intro == ongoing with 0 months. Otherwise every flat
          // plan looks "updated" the first time a refresh posts its
          // flat price explicitly (NULL !== price).
          const prevIntro = match.introPrice ?? match.ongoingPrice;
          const prevMonths = match.introMonths ?? 0;
          const nextIntro = p.intro_price ?? p.ongoing_price;
          const nextMonths = p.intro_months ?? 0;
          const changed =
            prevIntro !== nextIntro ||
            prevMonths !== nextMonths ||
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
              // promo_end 没提供时保留原来的截止日期；只在提供了
              // 合法日期时才更新（不参与“价格有没有变”的比较）。
              promoEnd:
                p.promo_end && p.promo_end.length > 0
                  ? p.promo_end
                  : match.promoEnd,
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
              promoEnd:
                p.promo_end && p.promo_end.length > 0 ? p.promo_end : null,
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
      // A full refresh is split into several calls (at most 120 plans
      // per call) that all share one checked_date: rows already stamped
      // by an earlier batch of this run carry that same checked_date,
      // so skip them here — otherwise each later batch would wipe the
      // "updated" flags the earlier batches just set, and only the last
      // batch's changes would ever show green.
      for (const e of existing) {
        if (!touchedIds.has(e.id) && e.checkedDate !== args.checked_date) {
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
