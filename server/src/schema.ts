import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per monitored NBN plan. Intro and ongoing prices are separate
// fields on purpose: almost every cheap plan is a 4–12 month discount that
// steps up afterwards, so the two rankings differ.
export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  planName: text("plan_name").notNull(),
  tier: text("tier").notNull(), // "25" | "50" | "100" | "250" | "500" | "750" | "1000"
  speedDown: integer("speed_down").notNull(),
  speedUp: integer("speed_up"),
  introPrice: real("intro_price"),
  introMonths: integer("intro_months"),
  ongoingPrice: real("ongoing_price").notNull(),
  tes: text("tes"), // typical evening speed, as stated by the source
  dataAllowance: text("data_allowance").notNull().default("无限流量"),
  contract: text("contract"),
  category: text("category", { enum: ["cheapest", "headline"] })
    .notNull()
    .default("cheapest"),
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  checkedDate: text("checked_date").notNull(), // YYYY-MM-DD the figure was verified
  promoEnd: text("promo_end"), // YYYY-MM-DD when the intro offer ends, if known
  note: text("note"),
  // Outcome of the most recent refresh for this plan: "updated" when a
  // refresh changed any price/speed figure, "unchanged" when it was
  // re-checked (or not re-verified) and nothing changed, "failed" when
  // the last refresh attempt failed. Null only on rows predating the
  // column; getState maps null to "unchanged".
  lastRefreshStatus: text("last_refresh_status", {
    enum: ["updated", "unchanged", "failed"],
  }),
  lastRefreshAt: text("last_refresh_at"), // ISO instant of that refresh
});

// One row per plan per check date, so price movement can be charted.
// introMonths is stored alongside so each point can be expressed as the
// 12-month average monthly cost (the tool's long-term price), not just
// the post-promo price.
export const priceHistory = sqliteTable("price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id").notNull(),
  checkedDate: text("checked_date").notNull(),
  introPrice: real("intro_price"),
  introMonths: integer("intro_months"),
  ongoingPrice: real("ongoing_price").notNull(),
});

// nbnco-listed retail providers. Every provider with plans in the seed
// has a verified website URL (brand names on the page link to it); the
// rest link out via the nbnco directory page.
export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  websiteUrl: text("website_url"),
});

// Small key/value store: last_checked, refresh state, the user's current plan.
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
