import { defineAction, z, type ActionsModule, type Ctx } from "./sdk";
import { asc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import {
  CHECKED,
  SEED_HISTORY,
  SEED_PLANS,
  SEED_PROVIDERS,
  SEED_VERSION,
  type SeedPlan,
} from "./seed";

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
      "Syncs the seed file (server/src/seed.ts) into the database: inserts missing monitored NBN plans, price-history points and nbnco provider directory rows, updates stored rows whose seed values changed (prices, speeds, source, checked date, promo end, notes and provider website URLs), and removes duplicate plan rows (same brand, tier and identical prices under slightly different names, left behind by earlier refreshes). The seed is the only data source — there are no price-update interfaces — so a weekly seed update flows into the stored rows here. Idempotent: a seed that matches the stored rows writes nothing. A price changed by the sync is stamped \"updated\" (green ↑) and gets a price-history point; rows whose price did not change are stamped \"unchanged\" when a new seed version arrives. The user's own current plan is not seeded — it starts empty and is entered on the page.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean(), planCount: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = (provider: string, planName: string, tier: string) =>
        `${provider.toLowerCase()}|${planName.toLowerCase()}|${tier}`;
      const nowIso = new Date().toISOString();
      const existingPlans = await db.select().from(schema.plans);
      const byKey = new Map(
        existingPlans.map((p) => [key(p.provider, p.planName, p.tier), p]),
      );
      const missingPlans = SEED_PLANS.filter(
        (p) => !byKey.has(key(p.provider, p.planName, p.tier)),
      );
      // The seed values a stored row is compared against, normalised the
      // same way the insert below stores them (null defaults, CHECKED).
      const seedValues = (p: SeedPlan) => ({
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
      });
      // Stored rows whose seed values changed: the seed is the only data
      // source, so these must be updated here — a weekly seed update would
      // otherwise never reach the page. A price change stamps the row
      // "updated"; any other change stamps it "unchanged".
      const updatedPlans: {
        seed: SeedPlan;
        row: PlanRow;
        priceChanged: boolean;
      }[] = [];
      for (const p of SEED_PLANS) {
        const row = byKey.get(key(p.provider, p.planName, p.tier));
        if (!row) continue;
        const sv = seedValues(p);
        const priceChanged =
          row.introPrice !== sv.introPrice ||
          row.introMonths !== sv.introMonths ||
          row.ongoingPrice !== sv.ongoingPrice;
        const anyChanged =
          priceChanged ||
          row.speedDown !== sv.speedDown ||
          row.speedUp !== sv.speedUp ||
          row.tes !== sv.tes ||
          row.dataAllowance !== sv.dataAllowance ||
          row.contract !== sv.contract ||
          row.category !== sv.category ||
          row.source !== sv.source ||
          row.sourceUrl !== sv.sourceUrl ||
          row.checkedDate !== sv.checkedDate ||
          row.promoEnd !== sv.promoEnd ||
          row.note !== sv.note;
        if (anyChanged) updatedPlans.push({ seed: p, row, priceChanged });
      }
      const existingProviders = await db.select().from(schema.providers);
      const providerByName = new Map(
        existingProviders.map((p) => [p.name.toLowerCase(), p]),
      );
      const missingProviders = SEED_PROVIDERS.filter(
        (p) => !providerByName.has(p.name.toLowerCase()),
      );
      // Provider website URLs are part of the seed too: a stored provider
      // whose URL changed in the seed (e.g. the URLs added 2026-11-21)
      // gets its URL updated, otherwise the brand links never appear.
      const updatedProviders: {
        seed: { name: string; websiteUrl?: string };
        row: typeof schema.providers.$inferSelect;
      }[] = [];
      for (const p of SEED_PROVIDERS) {
        const row = providerByName.get(p.name.toLowerCase());
        if (!row) continue;
        if ((row.websiteUrl ?? null) !== (p.websiteUrl ?? null)) {
          updatedProviders.push({ seed: p, row });
        }
      }
      // A new seed version (CHECKED moved) means the previous sync's green
      // ↑ flags are stale: rows whose price did not change in this sync go
      // back to "unchanged". Rows whose price did change are stamped
      // "updated" by the update below, which runs after this reset.
      // Rows the seed itself marks "updated" (price changed or added in
      // this seed version): stamp them green even when their stored values
      // already match the seed — a database created fresh from this seed
      // has no "before" price to compare against, so the price-change
      // comparison below would never flag them and every icon would stay
      // grey. This list is what makes the icons meaningful on a fresh
      // install.
      const seedMarkedUpdated: { seed: SeedPlan; row: PlanRow }[] = [];
      for (const p of SEED_PLANS) {
        if (p.lastRefreshStatus !== "updated") continue;
        const row = byKey.get(key(p.provider, p.planName, p.tier));
        if (!row) continue;
        if (row.lastRefreshStatus !== "updated") {
          seedMarkedUpdated.push({ seed: p, row });
        }
      }
      const seedKeys = new Set(
        SEED_PLANS.map((p) => key(p.provider, p.planName, p.tier)),
      );
      const metaMap0 = await readMeta(ctx);
      const newSeedVersion = metaMap0.get("last_seed_version") !== SEED_VERSION;
      let changed = false;
      if (
        missingPlans.length > 0 ||
        missingProviders.length > 0 ||
        updatedPlans.length > 0 ||
        updatedProviders.length > 0 ||
        seedMarkedUpdated.length > 0 ||
        newSeedVersion
      ) {
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
              lastRefreshStatus: p.lastRefreshStatus ?? "unchanged",
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
        if (newSeedVersion) {
          for (const row of existingPlans) {
            if (!seedKeys.has(key(row.provider, row.planName, row.tier)))
              continue;
            statements.push(
              db
                .update(schema.plans)
                .set({ lastRefreshStatus: "unchanged", lastRefreshAt: nowIso })
                .where(eq(schema.plans.id, row.id)),
            );
          }
        }
        // Seed-marked rows go green after the reset above (which runs
        // first in this batch), so they survive a fresh install.
        for (const { row } of seedMarkedUpdated) {
          statements.push(
            db
              .update(schema.plans)
              .set({ lastRefreshStatus: "updated", lastRefreshAt: nowIso })
              .where(eq(schema.plans.id, row.id)),
          );
        }
        for (const { seed: p, row, priceChanged } of updatedPlans) {
          const sv = seedValues(p);
          statements.push(
            db
              .update(schema.plans)
              .set({
                ...sv,
                lastRefreshStatus:
                  p.lastRefreshStatus ?? (priceChanged ? "updated" : "unchanged"),
                lastRefreshAt: nowIso,
              })
              .where(eq(schema.plans.id, row.id)),
          );
        }
        for (const { seed: p, row } of updatedProviders) {
          statements.push(
            db
              .update(schema.providers)
              .set({ websiteUrl: p.websiteUrl ?? null })
              .where(eq(schema.providers.id, row.id)),
          );
        }
        statements.push(
          db
            .insert(schema.meta)
            .values({ key: "last_checked", value: CHECKED })
            .onConflictDoNothing(),
        );
        statements.push(
          db
            .insert(schema.meta)
            .values({ key: "last_seed_version", value: SEED_VERSION })
            .onConflictDoUpdate({
              target: schema.meta.key,
              set: { value: SEED_VERSION },
            }),
        );
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        changed = true;
      }
      const priceChangedPlans = updatedPlans.filter((u) => u.priceChanged);
      if (missingPlans.length > 0 || priceChangedPlans.length > 0) {
        // Price-history points for each newly inserted plan only, taken
        // from SEED_HISTORY (the recorded history: one row per plan per
        // check date, 2026-11-19 / 2026-11-20 / 2026-11-21), so the
        // chart starts with real points instead of a single baseline.
        // A plan whose price changed in the sync gets one new point at
        // the seed's checked date with the new prices, so the chart shows
        // the change. Inserting only on an actual price change keeps the
        // sync idempotent: a second run with the same seed writes nothing.
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
        for (const { seed: p, row } of priceChangedPlans) {
          hist.push(
            db.insert(schema.priceHistory).values({
              planId: row.id,
              checkedDate: p.checkedDate ?? CHECKED,
              introPrice: p.introPrice ?? null,
              introMonths: p.introMonths ?? null,
              ongoingPrice: p.ongoingPrice,
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

} satisfies ActionsModule;
