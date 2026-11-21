import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
CartesianGrid,
Legend,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import {
  SafeAreaTopScrim,
  setFailureNoticeText,
} from "./local-sdk";
import { api, type ApiResponse } from "./api";

setFailureNoticeText((_error, message) => `操作没成功：${message}。请重试。`);

// 表单字段属性。原来由 @hatch/space-sdk 的 actionFields 宏在编译时从
// 服务端 zod schema 生成；独立版改为手写，取值与
// server/src/actions.ts 里 saveCurrentPlan 的校验一致
// （provider：1–60 字必填；monthlyPrice：0–1000 的数字必填）。
const FIELDS = {
  saveCurrentPlan: {
    provider: {
      name: "provider",
      minLength: 1,
      required: true,
      maxLength: 60,
    },
    monthlyPrice: {
      name: "monthlyPrice",
      type: "number" as const,
      step: "any" as const,
      required: true,
      min: 0,
      max: 1000,
    },
  },
};

type State = ApiResponse<typeof api, "getState">;
type Plan = State["plans"][number];

const TIERS = ["25", "50", "100", "250", "500", "750", "1000", "2000"] as const;
const TIER_COLORS: Record<string, string> = {
  "25": "#8a6d3b",
  "50": "#0e5a4d",
  "100": "#1d6fb8",
  "250": "#7a4fa3",
  "500": "#e86a17",
  "750": "#c2185b",
  "1000": "#b3540e",
  "2000": "#37474f",
};

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

// 比较基准：页面上所有「长期价」排名（每档最便宜标记、各档排序、
// 顶部推荐）按哪个平均算。默认 12 个月均价；切到 24 个月均价后
// 立即生效。每个套餐行上两个平均都显示，不受切换影响。
export type CompareBasis = "avg12" | "avg24";

// 长期价按 12 个月平均算：第一年总费用 ÷ 12。优惠价占头 n 个月就按
// n 个月算，剩下的月份按优惠结束后的价格算；没有优惠期的套餐，
// 12 个月平均就是固定价本身。
function avg12(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  if (p.introPrice == null) return p.ongoingPrice;
  const m = Math.min(Math.max(p.introMonths ?? 0, 0), 12);
  return (p.introPrice * m + p.ongoingPrice * (12 - m)) / 12;
}

// 24 个月平均：两年总费用 ÷ 24，和 avg12 同一算法，只是窗口从
// 12 个月拉长到 24 个月。优惠价占头 n 个月就按 n 个月算（n 超过
// 24 按 24 算），剩下的月份按优惠结束后的价格算；没有优惠期的
// 套餐，24 个月平均就是固定价本身。
export function avg24(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  if (p.introPrice == null) return p.ongoingPrice;
  const m = Math.min(Math.max(p.introMonths ?? 0, 0), 24);
  return (p.introPrice * m + p.ongoingPrice * (24 - m)) / 24;
}

// 按比较基准取一个套餐的平均月费。
function avgByBasis(
  p: {
    introPrice: number | null;
    introMonths: number | null;
    ongoingPrice: number;
  },
  basis: CompareBasis,
): number {
  return basis === "avg24" ? avg24(p) : avg12(p);
}

// 今天（悉尼日期），YYYY-MM-DD。
function todaySydney(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Australia/Sydney",
  });
}

// 优惠已过期：promoEnd 有值且早于今天。过期套餐不显示，数据保留在库里。
export function isPromoExpired(
  plan: { promoEnd: string | null },
  today: string,
): boolean {
  return plan.promoEnd != null && plan.promoEnd < today;
}

// 供应商名字归一化（和服务端 actions.ts 的 normProviderKey 同规则）：
// 小写、压缩空格、去掉末尾的 internet / telecom / mobile / broadband，
// 这样套餐行的 "SpinTel" 能对上供应商目录里的 "Spintel"，"Kogan Internet"
// 能对上 "Kogan"。用来把品牌名链到供应商官网。
function normProviderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(internet|telecom|mobile|broadband)$/, "");
}

// 按归一化后的供应商名建的官网地址表（来自 getState 的 providers）。
// 品牌名有对应网址时渲染成链接，没有时显示纯文字。
function buildProviderUrlMap(
  providers: { name: string; websiteUrl: string | null }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of providers) {
    if (p.websiteUrl) map.set(normProviderKey(p.name), p.websiteUrl);
  }
  return map;
}

// 同品牌同档位合并：一组 = 同一个品牌在同一档位的所有套餐，
// 只显示按当前比较基准（12 或 24 个月均价）最便宜的主行；其余
// 变体不显示，数据保留在库里。切比较基准后主行会跟着换。
export type BrandGroup = { provider: string; main: Plan; rest: Plan[] };
export function groupPlansByBrand(
  plans: Plan[],
  basis: CompareBasis = "avg12",
): BrandGroup[] {
  const by = new Map<string, Plan[]>();
  for (const p of plans) {
    const key = p.provider.toLowerCase();
    const g = by.get(key);
    if (g) g.push(p);
    else by.set(key, [p]);
  }
  const out: BrandGroup[] = [];
  for (const ps of by.values()) {
    const sorted = [...ps].sort(
      (a, b) =>
        avgByBasis(a, basis) - avgByBasis(b, basis) ||
        a.ongoingPrice - b.ongoingPrice,
    );
    const main = sorted.shift();
    if (!main) continue;
    out.push({ provider: main.provider, main, rest: sorted });
  }
  return out;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-CA", {
    timeZone: "Australia/Sydney",
  });
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

function daysUntil(dateStr: string): number {
  const today = new Date(
    new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }) +
      "T00:00:00",
  );
  const target = new Date(`${dateStr}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

type RefreshStatus = "updated" | "unchanged" | "failed";

const STATUS_LABELS: Record<RefreshStatus, string> = {
  updated: "有更新",
  unchanged: "没有更新",
  failed: "更新失败",
};

const STATUS_BADGE_COLORS: Record<RefreshStatus, string> = {
  updated: "#2f9e5f",
  unchanged: "#9aa5a0",
  failed: "#d32f2f",
};

const STATUS_BADGE_GLYPHS: Record<RefreshStatus, string> = {
  updated: "↑",
  unchanged: "－",
  failed: "!",
};

/**
 * Coloured circular status badge for the outcome of the most recent
 * refresh (second set chosen by the user): green ↑ = 有更新,
 * grey － = 没有更新, red ! = 更新失败. Shown only in three places —
 * the top recommendation, the per-tier cheapest table, and each plan
 * detail row — instead of a text pill repeated everywhere.
 */
function UpdateBadge({ status }: { status: RefreshStatus }) {
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center align-middle">
      <span
        role="img"
        aria-label={STATUS_LABELS[status]}
        title={STATUS_LABELS[status]}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold leading-none text-white shadow-sm ring-1 ring-black/10"
        style={{ background: STATUS_BADGE_COLORS[status] }}
      >
        <span aria-hidden="true">{STATUS_BADGE_GLYPHS[status]}</span>
      </span>
    </span>
  );
}

function firstYearTotal(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  return avg12(p) * 12;
}

function total24(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  return avg24(p) * 24;
}

function introMonthsClamped(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  if (p.introPrice == null) return 0;
  return Math.min(Math.max(p.introMonths ?? 0, 0), 12);
}

function introMonthsClamped24(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): number {
  if (p.introPrice == null) return 0;
  return Math.min(Math.max(p.introMonths ?? 0, 0), 24);
}

/** Full equation for a plan's first-year total, e.g.
 * "$39.00 × 6 个月 + $69.95 × 6 个月 = $653.70" or, for a flat plan,
 * "$80.00 × 12 个月 = $960.00". */
function calcEquation(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): string {
  const total = firstYearTotal(p);
  if (p.introPrice == null) {
    return `${money(p.ongoingPrice)} × 12 个月 = ${money(total)}`;
  }
  const m = introMonthsClamped(p);
  return `${money(p.introPrice)} × ${m} 个月 + ${money(p.ongoingPrice)} × ${12 - m} 个月 = ${money(total)}`;
}

/** Full equation for a plan's two-year total, e.g.
 * "$47.90 × 12 个月 + $70.90 × 12 个月 = $1425.60" or, for a flat plan,
 * "$80.00 × 24 个月 = $1920.00". */
function calcEquation24(p: {
  introPrice: number | null;
  introMonths: number | null;
  ongoingPrice: number;
}): string {
  const total = total24(p);
  if (p.introPrice == null) {
    return `${money(p.ongoingPrice)} × 24 个月 = ${money(total)}`;
  }
  const m = introMonthsClamped24(p);
  return `${money(p.introPrice)} × ${m} 个月 + ${money(p.ongoingPrice)} × ${24 - m} 个月 = ${money(total)}`;
}

/**
 * Inline 「计算过程」 toggle that sits directly behind (after) the
 * plan's annual total. Tapping it expands CalcPanel right under it.
 */
function CalcToggle({
  open,
  onToggle,
  planName,
}: {
  open: boolean;
  onToggle: () => void;
  planName: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${planName} 费用计算过程`}
      onClick={onToggle}
      className="ml-2 inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 align-middle text-xs font-medium whitespace-nowrap text-[var(--accent)]"
    >
      {open ? "计算过程 ▴" : "计算过程 ▾"}
    </button>
  );
}

/**
 * Expanded calculation for one plan's totals: the first-year total
 * (intro months at the intro price plus the remaining months at the
 * ongoing price, then the 12-month average) and the two-year total
 * (same idea over 24 months, then the 24-month average).
 */
function CalcPanel({
  plan,
}: {
  plan: {
    provider: string;
    planName: string;
    introPrice: number | null;
    introMonths: number | null;
    ongoingPrice: number;
  };
}) {
  const total = firstYearTotal(plan);
  const avg = avg12(plan);
  const m = introMonthsClamped(plan);
  return (
    <div className="mt-2 bg-[var(--surface-alt)] p-3" style={{ borderRadius: "var(--radius)" }}>
      <p className="text-xs font-medium text-[var(--text)]">
        第一年总费用 = 优惠期费用 + 优惠后费用
        <span className="ml-1 font-normal text-[var(--dim)]">
          （优惠价占头 {plan.introPrice == null ? 0 : m} 个月，其余月份按优惠结束后的价格算）
        </span>
      </p>
      {plan.introPrice != null ? (
        <ul className="mt-2 space-y-1.5">
          <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
            <span className="min-w-0 text-[var(--dim)]">
              优惠期：<span className="text-[var(--text)]">{money(plan.introPrice)}/月 × {m} 个月</span>
            </span>
            <span className="price shrink-0 font-medium text-[var(--text)]">{money(plan.introPrice * m)}</span>
          </li>
          <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
            <span className="min-w-0 text-[var(--dim)]">
              优惠后：<span className="text-[var(--text)]">{money(plan.ongoingPrice)}/月 × {12 - m} 个月</span>
            </span>
            <span className="price shrink-0 font-medium text-[var(--text)]">{money(plan.ongoingPrice * (12 - m))}</span>
          </li>
        </ul>
      ) : (
        <ul className="mt-2 space-y-1.5">
          <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
            <span className="min-w-0 text-[var(--dim)]">
              固定价：<span className="text-[var(--text)]">{money(plan.ongoingPrice)}/月 × 12 个月</span>
            </span>
            <span className="price shrink-0 font-medium text-[var(--text)]">{money(total)}</span>
          </li>
        </ul>
      )}
      <p className="price mt-2 border-t border-[var(--border)] pt-2 text-xs font-medium tabular-nums text-[var(--text)]">
        {calcEquation(plan)}
      </p>
      <p className="price mt-1 text-xs tabular-nums text-[var(--dim)]">
        12 个月平均 = {money(total)} ÷ 12 = {money(avg)}/月
      </p>
      <p className="mt-3 text-xs font-medium text-[var(--text)]">
        两年总费用 = 优惠期费用 + 优惠后费用
        <span className="ml-1 font-normal text-[var(--dim)]">
          （优惠价占头 {plan.introPrice == null ? 0 : introMonthsClamped24(plan)} 个月，其余月份按优惠结束后的价格算）
        </span>
      </p>
      <p className="price mt-2 border-t border-[var(--border)] pt-2 text-xs font-medium tabular-nums text-[var(--text)]">
        {calcEquation24(plan)}
      </p>
      <p className="price mt-1 text-xs tabular-nums text-[var(--dim)]">
        24 个月平均 = {money(total24(plan))} ÷ 24 = {money(avg24(plan))}/月
      </p>
    </div>
  );
}

// 套餐备注里提到 FTTP / FTTC / HFC 时，把这个词链到页面下方
// 「接入技术说明」一节（#tech-speed），那里写明了每种接入方式
// 对应的最高速度（FTTP 最高 2000，FTTC 一般最高 100，HFC 最高 2000）。
function linkTechTerms(text: string) {
  return text.split(/(FTTP|FTTC|HFC)/g).map((part, i) =>
    part === "FTTP" || part === "FTTC" || part === "HFC" ? (
      <a key={i} className="underline" href="#tech-speed">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function PlanRow({
  plan,
  rank,
  providerUrl,
  basis,
}: {
  plan: Plan;
  rank: number;
  providerUrl: string | null;
  basis: CompareBasis;
}) {
  const [calcOpen, setCalcOpen] = useState(false);
  const promoDays = plan.promoEnd ? daysUntil(plan.promoEnd) : null;
  return (
    <li className="border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="break-words text-base font-semibold text-[var(--text)]">
            {rank === 0 && (
              <span className="mr-2 inline-block bg-[var(--accent)] px-1.5 py-0.5 align-middle text-xs font-semibold text-[var(--accent-ink)]">
                {basis === "avg24" ? "24 个月平均最低" : "12 个月平均最低"}
              </span>
            )}
            {providerUrl ? (
              <a
                className="underline"
                href={providerUrl}
                target="_blank"
                rel="noreferrer"
              >
                {plan.provider}
              </a>
            ) : (
              plan.provider
            )}
            <span className="ml-2 font-normal text-[var(--dim)]">
              {plan.planName}
            </span>
            <UpdateBadge status={plan.lastRefreshStatus} />
          </p>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            {plan.speedDown}
            {plan.speedUp ? `/${plan.speedUp}` : ""} Mbps
            {plan.tes ? ` · 晚间典型速度 ${plan.tes}` : ""}
            {` · ${plan.dataAllowance}`}
            {plan.contract ? ` · ${plan.contract}` : ""}
          </p>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          {plan.introPrice != null ? (
            <>
              <p className="price text-lg font-semibold text-[var(--text)]">
                {money(plan.introPrice)}
                <span className="text-sm font-normal text-[var(--dim)]">/月</span>
              </p>
              <p className="price text-sm text-[var(--dim)]">
                前 {plan.introMonths ?? "—"} 个月 · 之后{" "}
                {money(plan.ongoingPrice)}/月
              </p>
              <p className="price flex flex-wrap items-center text-sm font-medium text-[var(--teal)] sm:justify-end">
                <span>
                  12 个月平均 {money(avg12(plan))}/月 · 第一年共{" "}
                  {money(firstYearTotal(plan))}
                </span>
                <CalcToggle
                  open={calcOpen}
                  onToggle={() => setCalcOpen((v) => !v)}
                  planName={`${plan.provider} ${plan.planName}`}
                />
              </p>
              <p className="price text-sm text-[var(--dim)] sm:text-right">
                24 个月平均 {money(avg24(plan))}/月 · 两年共{" "}
                {money(total24(plan))}
              </p>
            </>
          ) : (
            <>
              <p className="price text-lg font-semibold text-[var(--text)]">
                {money(plan.ongoingPrice)}
                <span className="text-sm font-normal text-[var(--dim)]">/月</span>
              </p>
              <p className="text-sm text-[var(--teal)]">固定价，无优惠期</p>
              <p className="price flex flex-wrap items-center text-sm font-medium text-[var(--teal)] sm:justify-end">
                <span>
                  12 个月平均 {money(avg12(plan))}/月 · 第一年共{" "}
                  {money(firstYearTotal(plan))}
                </span>
                <CalcToggle
                  open={calcOpen}
                  onToggle={() => setCalcOpen((v) => !v)}
                  planName={`${plan.provider} ${plan.planName}`}
                />
              </p>
              <p className="price text-sm text-[var(--dim)] sm:text-right">
                24 个月平均 {money(avg24(plan))}/月 · 两年共{" "}
                {money(total24(plan))}
              </p>
            </>
          )}
        </div>
      </div>
      {calcOpen && <CalcPanel plan={plan} />}
      {promoDays != null && promoDays >= 0 && promoDays <= 45 && (
        <p className="mt-1 text-sm font-medium text-[var(--warn)]">
          优惠 {plan.promoEnd} 结束（还剩 {promoDays} 天）
        </p>
      )}
      {plan.note && (
        <p className="mt-1 text-sm text-[var(--dim)]">{linkTechTerms(plan.note)}</p>
      )}
      <p className="mt-1 text-xs text-[var(--dim)]">
        来源：{plan.source} · 核对日期 {plan.checkedDate}
      </p>
    </li>
  );
}

// 一个品牌在一档里的整组只显示一行：按当前比较基准最便宜的主行。
// 其余变体不显示，数据保留在库里；主行备注里如果有重要变体价格信息
// （比如 Optus 标准价 $89 的说明）会保留在备注文字里。
function BrandGroupRow({
  group,
  bestAvg,
  providerUrl,
  basis,
}: {
  group: BrandGroup;
  bestAvg: number;
  providerUrl: string | null;
  basis: CompareBasis;
}) {
  const { main } = group;
  return (
    <PlanRow
      plan={main}
      rank={avgByBasis(main, basis) === bestAvg ? 0 : -1}
      providerUrl={providerUrl}
      basis={basis}
    />
  );
}

function CheapestTierRow({
  tier,
  plan,
  isFirst,
  providerUrl,
  basis,
}: {
  tier: string;
  plan: Plan;
  isFirst: boolean;
  providerUrl: string | null;
  basis: CompareBasis;
}) {
  const [calcOpen, setCalcOpen] = useState(false);
  return (
    <div className={isFirst ? "" : "border-t border-[var(--border)]"}>
      <div className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <span className="price font-semibold text-[var(--teal)]">{tier}M</span>
          <span className="ml-2 font-medium text-[var(--text)]">
            {providerUrl ? (
              <a
                className="underline"
                href={providerUrl}
                target="_blank"
                rel="noreferrer"
              >
                {plan.provider}
              </a>
            ) : (
              plan.provider
            )}
          </span>
          <span className="ml-1 hidden text-sm text-[var(--dim)] sm:inline">{plan.planName}</span>
          <UpdateBadge status={plan.lastRefreshStatus} />
        </div>
        <div className="price text-left text-[var(--text)] sm:shrink-0 sm:text-right">
          <span className="text-lg font-semibold">{money(avgByBasis(plan, basis))}</span>
          <span className="text-sm text-[var(--dim)]">/月 · {basis === "avg24" ? "24 个月平均" : "12 个月平均"}</span>
          <div className="flex flex-wrap items-center text-sm font-normal text-[var(--dim)] sm:justify-end">
            <span>
              {plan.introPrice != null ? (
                <>
                  优惠 {money(plan.introPrice)}×{plan.introMonths ?? "—"} 个月 · 之后 {money(plan.ongoingPrice)} · {basis === "avg24" ? <>两年共 {money(total24(plan))}</> : <>第一年共 {money(firstYearTotal(plan))}</>}
                </>
              ) : (
                <>固定价 · {basis === "avg24" ? <>两年共 {money(total24(plan))}</> : <>第一年共 {money(firstYearTotal(plan))}</>}</>
              )}
            </span>
            <CalcToggle
              open={calcOpen}
              onToggle={() => setCalcOpen((v) => !v)}
              planName={`${plan.provider} ${plan.planName}`}
            />
          </div>
        </div>
      </div>
      {calcOpen && (
        <div className="px-3 pb-3">
          <CalcPanel plan={plan} />
        </div>
      )}
    </div>
  );
}

/**
 * 比较基准切换（12 个月均价 / 24 个月均价）：「每档长期价最低」和
 * 「套餐明细」顶部各放一个，共用同一个 compareBasis 状态，两边同步。
 */
function BasisToggle({
  basis,
  onChange,
  label,
}: {
  basis: CompareBasis;
  onChange: (b: CompareBasis) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-sm text-[var(--dim)]">比较基准：</span>
      <button
        type="button"
        aria-label="按12个月平均价比较"
        aria-pressed={basis === "avg12"}
        onClick={() => onChange("avg12")}
        className={`px-3 py-1.5 text-sm font-medium ${basis === "avg12" ? "bg-[var(--teal)] text-white" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
        style={{ borderRadius: "var(--radius)" }}
      >
        12 个月均价
      </button>
      <button
        type="button"
        aria-label="按24个月平均价比较"
        aria-pressed={basis === "avg24"}
        onClick={() => onChange("avg24")}
        className={`px-3 py-1.5 text-sm font-medium ${basis === "avg24" ? "bg-[var(--teal)] text-white" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
        style={{ borderRadius: "var(--radius)" }}
      >
        24 个月均价
      </button>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"ongoing" | "intro">("ongoing");
  // 比较基准：默认 12 个月均价；切到 24 个月均价后，每档最便宜
  // 标记、各档排序和顶部推荐都按 24 个月均价算，立即生效。
  const [compareBasis, setCompareBasis] = useState<CompareBasis>("avg12");
  const [recCalcOpen, setRecCalcOpen] = useState(false);
  const seedTried = useRef(false);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
  });

  const seed = useMutation({
    mutationFn: async () => await api.seedPlans({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  useEffect(() => {
    // Runs once per page load: syncs the seed file into the database —
    // inserts missing plans/providers and updates stored rows whose seed
    // values changed (the seed is the only data source).
    if (state.data && !seedTried.current) {
      seedTried.current = true;
      seed.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data]);

  // 独立版页面上没有「立即刷新」按钮：独立版不提供更新数据的接口，
  // 数据由维护者每周用脚本更新 server/src/seed.ts 后推送到 GitHub，
  // 重新部署后种子数据进库，刷新页面即可看到更新后的数据。
  // 品牌名上的链接指向供应商官网，可自行核对最新价格。

  const data = state.data;

  const providerUrlMap = useMemo(
    () => (data ? buildProviderUrlMap(data.providers) : new Map<string, string>()),
    [data],
  );
  const providerUrl = useCallback(
    (provider: string) => providerUrlMap.get(normProviderKey(provider)) ?? null,
    [providerUrlMap],
  );

  // 今天（悉尼日期）：优惠过期的套餐不显示（数据保留在库里），
  // 每档最便宜、套餐列表和推荐都只按显示出来的行算。
  const todayStr = useMemo(() => todaySydney(), []);
  const displayPlans = useMemo(() => {
    if (!data) return [] as Plan[];
    return data.plans.filter((p) => !isPromoExpired(p, todayStr));
  }, [data, todayStr]);

  // 当前比较基准下的平均月费：排名（每档最便宜、各档排序、推荐）
  // 都按这个数算；切到 24 个月均价后立即生效。
  const avgBasis = useCallback(
    (p: Plan) => avgByBasis(p, compareBasis),
    [compareBasis],
  );
  // 比较基准的窗口月数和中文名，推荐语和总费用显示共用。
  const basisMonths = compareBasis === "avg24" ? 24 : 12;
  const basisLabel = compareBasis === "avg24" ? "24 个月" : "12 个月";
  const basisYearsLabel = compareBasis === "avg24" ? "两年" : "第一年";

  // 列表排序价：intro 档按优惠价排，其余按当前比较基准的平均排。
  const sortPrice = useCallback(
    (p: Plan) =>
      sortBy === "intro" ? (p.introPrice ?? p.ongoingPrice) : avgBasis(p),
    [sortBy, avgBasis],
  );

  // 每档长期价最低：长期价 = 当前比较基准的平均月费（见 avg12 /
  // avg24），同价时优惠结束后的月费更低的排前面。
  const cheapestByTier = useMemo(() => {
    const out: { tier: string; plan: Plan }[] = [];
    for (const tier of TIERS) {
      const inTier = displayPlans.filter((p) => p.tier === tier);
      if (inTier.length === 0) continue;
      const best = [...inTier].sort(
        (a, b) => avgBasis(a) - avgBasis(b) || a.ongoingPrice - b.ongoingPrice,
      )[0];
      if (best) out.push({ tier, plan: best });
    }
    return out;
  }, [displayPlans, avgBasis]);

  const visiblePlans = useMemo(() => {
    const list = displayPlans.filter(
      (p) => tierFilter === "all" || p.tier === tierFilter,
    );
    return [...list].sort((a, b) => {
      if (a.tier !== b.tier) return Number(a.tier) - Number(b.tier);
      return sortPrice(a) - sortPrice(b);
    });
  }, [displayPlans, tierFilter, sortPrice]);

  const chartData = useMemo(() => {
    if (!data) return [];
    const planTier = new Map(data.plans.map((p) => [p.id, p.tier]));
    const byDate = new Map<string, Map<string, number>>();
    for (const h of data.history) {
      const tier = planTier.get(h.planId);
      if (!tier) continue;
      let row = byDate.get(h.checkedDate);
      if (!row) {
        row = new Map();
        byDate.set(h.checkedDate, row);
      }
      const v = avg12(h);
      const cur = row.get(tier);
      if (cur == null || v < cur) row.set(tier, v);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, row]) => {
        const out: Record<string, string | number> = { date };
        for (const [tier, v] of row) out[tier] = v;
        return out;
      });
  }, [data]);

  // Current-plan form (local in-flight state only; saved values come from the query).
  const [cpProvider, setCpProvider] = useState("");
  const [cpTier, setCpTier] = useState("100");
  const [cpPrice, setCpPrice] = useState("");
  const [cpError, setCpError] = useState<string | null>(null);
  const cpSeeded = useRef(false);
  useEffect(() => {
    if (data?.currentPlan && !cpSeeded.current) {
      cpSeeded.current = true;
      setCpProvider(data.currentPlan.provider);
      setCpTier(data.currentPlan.tier);
      setCpPrice(String(data.currentPlan.monthlyPrice));
    }
  }, [data?.currentPlan]);

  const saveCp = useMutation({
    mutationFn: async () =>
      await api.saveCurrentPlan({
        provider: cpProvider.trim(),
        tier: cpTier,
        monthlyPrice: Number(cpPrice),
      }),
    onSuccess: () => {
      setCpError(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setCpError(`保存没成功：${e.message}`),
  });
  const clearCp = useMutation({
    mutationFn: async () => await api.clearCurrentPlan({}),
    onSuccess: () => {
      setCpProvider("");
      setCpPrice("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setCpError(`清除没成功：${e.message}`),
  });

  // Top recommendation, judged on the same basis as the rest of the
  // page (the active comparison basis: 12- or 24-month average):
  // every plan's long-term price is its average monthly cost on that
  // basis (avg12 / avg24). The user's own basis is their plan's
  // average on that basis when they're on a tracked intro price (the
  // step-up months are part of the window), otherwise the monthly fee
  // they entered. best is the lowest-average plan in their tier or
  // faster that beats that basis.
  // Separately, when their intro steps up past the basis, futureBest is
  // the cheapest first-year average against the stepped-up price — shown
  // only as a clearly-labelled after-the-promo note, never as a current
  // saving.
  const recommendation = useMemo(() => {
    if (!data?.currentPlan) return null;
    const cp = data.currentPlan;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const own =
      data.plans.find(
        (p) =>
          p.tier === cp.tier &&
          (norm(p.provider) === norm(cp.provider) ||
            norm(p.provider).includes(norm(cp.provider)) ||
            norm(cp.provider).includes(norm(p.provider))),
      ) ?? null;
    const onIntro =
      own?.introPrice != null &&
      Math.abs(cp.monthlyPrice - own.introPrice) < 0.01;
    const basis = own && onIntro ? avgBasis(own) : cp.monthlyPrice;
    const byValue = (a: Plan, b: Plan) =>
      avgBasis(a) - avgBasis(b) || Number(b.tier) - Number(a.tier);
    const best =
      [...displayPlans]
        .filter(
          (p) =>
            Number(p.tier) >= Number(cp.tier) &&
            avgBasis(p) < basis - 0.001 &&
            p.id !== own?.id,
        )
        .sort(byValue)[0] ?? null;
    // “以后换”只按优惠结束后的价格比：到那时再换，办到的多半已不是
    // 现在的优惠价（比如 Belong Fast 500 的 $70 只到 2026-11-30，
    // 而 Kogan 的优惠到 2027-07-01 才结束，到期后 Belong 是 $95，
    // 比 Kogan 涨价后的 $85.90 还贵）。用 ongoingPrice 比，才不会
    // 把一个到时办不到的优惠价算成“能省”。
    const futureBest =
      !best && own && own.ongoingPrice > basis + 0.001
        ? ([...displayPlans]
            .filter(
              (p) =>
                Number(p.tier) >= Number(cp.tier) &&
                p.ongoingPrice < own.ongoingPrice - 0.001 &&
                p.id !== own.id,
            )
            .sort(
              (a, b) =>
                a.ongoingPrice - b.ongoingPrice ||
                Number(b.tier) - Number(a.tier),
            )[0] ?? null)
        : null;
    return {
      own,
      onIntro,
      basis,
      best,
      saving: best ? basis - avgBasis(best) : 0,
      futureBest,
      futureSaving:
        futureBest && own ? own.ongoingPrice - futureBest.ongoingPrice : 0,
    };
  }, [data, displayPlans, avgBasis]);

  return (
    <div className="min-h-screen bg-[var(--bg)] font-sans">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto max-w-3xl px-4 pb-10">
        {/* Address strip */}
        <section className="pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-[var(--text)]">
                NBN 套餐监测
              </h1>
              <p className="mt-1 text-sm text-[var(--dim)]">
                接入技术按地址而定（
                <a className="underline" href="#tech-speed">
                  FTTP
                </a>
                {" / "}
                <a className="underline" href="#tech-speed">
                  FTTC
                </a>
                {" / "}
                <a className="underline" href="#tech-speed">
                  HFC
                </a>
                等），不同地址能办的最高档位不同，实际速度看套餐档位；下单前请让供应商按你的地址确认一次。
              </p>
              <p className="mt-0.5 text-sm text-[var(--dim)]">
                上次检查：
                {data?.lastAttemptAt
                  ? fmtTime(data.lastAttemptAt)
                  : (data?.lastChecked ?? "—")}
                {data?.lastAttemptStatus === "success" && "（检查成功）"}
                {data?.lastAttemptStatus === "started" && "（检查中…）"}
                {data?.lastAttemptStatus === "failed" &&
                  "（更新失败，刷新页面重试）"}
                {data?.lastSuccessAt &&
                  data.lastAttemptAt !== data.lastSuccessAt &&
                  ` · 上次成功更新：${fmtTime(data.lastSuccessAt)}`}
              </p>
            </div>
          </div>
          <p className="mt-2 text-sm text-[var(--dim)]">
            同一邮编内不同街道的接入技术可能不同（
            <a className="underline" href="#tech-speed">
              FTTP
            </a>
            {" 与 "}
            <a className="underline" href="#tech-speed">
              FTTC
            </a>
            混合很常见），技术按地址定，不能按邮编一概而论；
            <a className="underline" href="#tech-speed">
              FTTP
            </a>
            地址能办 500/750/1000 高速档，
            <a className="underline" href="#tech-speed">
              FTTC
            </a>
            地址最高一般只能到 100。
          </p>
        </section>

        {state.isPending && (
          <p className="py-10 text-center text-[var(--dim)]">正在加载套餐数据…</p>
        )}
        {state.error && (
          <p className="py-10 text-center text-[var(--warn)]">
            数据加载失败，请下拉重试。
          </p>
        )}

        {data && data.plans.length === 0 && (
          <section className="py-10 text-center">
            <p className="text-[var(--dim)]">暂时还没有套餐数据。</p>
            <button
              type="button"
              aria-label="载入套餐数据"
              onClick={() => seed.mutate()}
              className="mt-3 bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]"
              style={{ borderRadius: "var(--radius)" }}
            >
              载入套餐数据
            </button>
          </section>
        )}

        {data && data.plans.length > 0 && (
          <>
            {/* Top recommendation based on the user's current plan */}
            {data.currentPlan && recommendation && (
              <section
                aria-label="为你推荐的套餐"
                className="mt-6 border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-3"
                style={{ borderRadius: "var(--radius)" }}
              >
                {recommendation.best ? (
                  <>
                    <h2 className="text-lg font-bold text-[var(--text)]">
                      给你推荐的套餐
                    </h2>
                    <p className="mt-1 text-[var(--text)]">
                      <strong>
                        {providerUrl(recommendation.best.provider) ? (
                          <a
                            className="underline"
                            href={
                              providerUrl(recommendation.best.provider) as string
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            {recommendation.best.provider}
                          </a>
                        ) : (
                          recommendation.best.provider
                        )}{" "}
                        {recommendation.best.planName}
                      </strong>
                      <UpdateBadge
                        status={recommendation.best.lastRefreshStatus}
                      />{" "}
                      ·{" "}
                      <span className="price">
                        {recommendation.best.tier} Mbps
                      </span>
                      {recommendation.best.tier === data.currentPlan.tier
                        ? "，和你现在同档"
                        : `，比你现在的 ${data.currentPlan.tier}M 更快`}
                      {recommendation.best.tes
                        ? ` · 晚间典型速度 ${recommendation.best.tes}`
                        : ""}
                    </p>
                    <p className="price mt-1 text-[var(--text)]">
                      {recommendation.best.introPrice != null ? (
                        <>
                          前 {recommendation.best.introMonths ?? "—"} 个月{" "}
                          {money(recommendation.best.introPrice)}/月 · 之后{" "}
                          {money(recommendation.best.ongoingPrice)}/月
                        </>
                      ) : (
                        <>{money(recommendation.best.ongoingPrice)}/月固定价</>
                      )}
                    </p>
                    <p className="mt-1 text-[var(--text)]">
                      按 {basisLabel}平均算：你现在这个套餐平均{" "}
                      <span className="price">
                        {money(recommendation.basis)}/月
                      </span>
                      ，换过去平均{" "}
                      <span className="price">
                        {money(avgBasis(recommendation.best))}/月
                      </span>
                      ，每月平均省{" "}
                      <strong className="price text-[var(--accent)]">
                        {money(recommendation.saving)}
                      </strong>
                      ，{basisYearsLabel}共{" "}
                      <span className="price">{money(basisMonths === 24 ? total24(recommendation.best) : firstYearTotal(recommendation.best))}</span>
                      ，{basisYearsLabel}共省{" "}
                      <strong className="price text-[var(--accent)]">
                        {money(recommendation.saving * basisMonths)}
                      </strong>
                      。
                      <CalcToggle
                        open={recCalcOpen}
                        onToggle={() => setRecCalcOpen((v) => !v)}
                        planName={`${recommendation.best.provider} ${recommendation.best.planName}`}
                      />
                    </p>
                    {recCalcOpen && (
                      <div>
                        <CalcPanel plan={recommendation.best} />
                        <p className="price mt-1 text-xs text-[var(--dim)]">
                          省钱计算：你现在{basisYearsLabel} {money(recommendation.basis * basisMonths)} − 推荐套餐{basisYearsLabel} {money(basisMonths === 24 ? total24(recommendation.best) : firstYearTotal(recommendation.best))} = {money(recommendation.saving * basisMonths)}
                        </p>
                      </div>
                    )}
                    {recommendation.onIntro && recommendation.own && (
                      <p className="mt-1 text-sm text-[var(--dim)]">
                        你现在付的 {money(data.currentPlan.monthlyPrice)}{" "}
                        是 {recommendation.own.planName} 的优惠价（前{" "}
                        {recommendation.own.introMonths ?? "—"}{" "}
                        个月），之后涨到{" "}
                        {money(recommendation.own.ongoingPrice)}
                        /月——{basisLabel}平均下来是{" "}
                        {money(recommendation.basis)}
                        /月，上面的比较用的就是这个平均数。
                      </p>
                    )}
                    {recommendation.best.introPrice != null &&
                      recommendation.best.introPrice <
                        data.currentPlan.monthlyPrice && (
                        <p className="mt-1 text-sm text-[var(--dim)]">
                          而且它前{" "}
                          {recommendation.best.introMonths ?? "—"} 个月只要{" "}
                          {money(recommendation.best.introPrice)}
                          /月，比你现在付的还低{" "}
                          {money(
                            data.currentPlan.monthlyPrice -
                              recommendation.best.introPrice,
                          )}
                          /月。
                        </p>
                      )}
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      来源：{recommendation.best.source} · 核对日期{" "}
                      {recommendation.best.checkedDate}
                      {recommendation.best.sourceUrl && (
                        <>
                          {" · "}
                          <a
                            className="underline"
                            href={recommendation.best.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看来源页
                          </a>
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-bold text-[var(--text)]">
                      你已经用的是最便宜的
                    </h2>
                    <p className="mt-1 text-[var(--text)]">
                      把优惠期和涨价后的月份都算进去，你现在这个套餐{" "}
                      {basisLabel}平均{" "}
                      <span className="price">
                        {money(recommendation.basis)}/月
                      </span>
                      {recommendation.own && (
                        <>
                          ，{basisYearsLabel}共{" "}
                          <span className="price">{money(basisMonths === 24 ? total24(recommendation.own) : firstYearTotal(recommendation.own))}</span>
                        </>
                      )}
                      ；同档（{data.currentPlan.tier}M）或更快的套餐里，没有
                      {basisLabel}平均比这更低的了，不用换。
                    </p>
                    {recommendation.futureBest && recommendation.own && (
                      <>
                        <p className="mt-1 text-sm text-[var(--dim)]">
                          不过有个提醒：你现在付的{" "}
                          {money(data.currentPlan.monthlyPrice)} 是{" "}
                          {recommendation.own.planName} 的优惠价（前{" "}
                          {recommendation.own.introMonths ?? "—"}{" "}
                          个月），结束后涨到{" "}
                          {money(recommendation.own.ongoingPrice)}
                          /月。按优惠结束后的价格算，到那时换{" "}
                          {recommendation.futureBest.provider}{" "}
                          {recommendation.futureBest.planName}（
                          {money(recommendation.futureBest.ongoingPrice)}
                          /月），每月能省 {money(recommendation.futureSaving)}
                          、第一年 {money(recommendation.futureSaving * 12)}
                          ——等优惠快到期时再换就行，现在换反而更贵。到时请以当时的价格为准再比一次。
                        </p>
                      </>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Hero: cheapest per tier on the active comparison basis */}
            <section className="mt-6">
              <h2 className="text-lg font-bold text-[var(--text)]">
                每档长期价最低
              </h2>
              <div className="mt-2">
                <BasisToggle basis={compareBasis} onChange={setCompareBasis} label="比较基准" />
              </div>
              <p className="mt-2 text-sm text-[var(--dim)]">
                {compareBasis === "avg24" ? (
                  <>
                    长期价按 24 个月平均算：两年总费用 ÷
                    24。优惠价占头几个月就按几个月算（最多 24
                    个月），剩下的月份按优惠结束后的价格算——只便宜
                    6 个月的套餐，长期价会落在优惠价和优惠后价格之间。
                  </>
                ) : (
                  <>
                    长期价按 12 个月平均算：第一年总费用 ÷
                    12。优惠价占头几个月就按几个月算，剩下的月份按优惠结束后的价格算——只便宜
                    6 个月的套餐，长期价会落在优惠价和优惠后价格之间。
                  </>
                )}
              </p>
              <div className="mt-3 overflow-hidden border border-[var(--border)] bg-[var(--surface)]" style={{ borderRadius: "var(--radius)" }}>
                {cheapestByTier.map(({ tier, plan }, i) => (
                  <CheapestTierRow key={tier} tier={tier} plan={plan} isFirst={i === 0} providerUrl={providerUrl(plan.provider)} basis={compareBasis} />
                ))}
              </div>
            </section>

            {/* My current plan */}
            <section className="mt-8">
              <h2 className="text-lg font-bold text-[var(--text)]">我现在的套餐</h2>
              {data.currentPlan ? (
                <div className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-3" style={{ borderRadius: "var(--radius)" }}>
                  <p className="text-[var(--text)]">
                    {data.currentPlan.provider} · {data.currentPlan.tier} Mbps ·{" "}
                    <span className="price">{money(data.currentPlan.monthlyPrice)}/月</span>
                  </p>
                  {recommendation?.own && recommendation.onIntro && (
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      这是 {recommendation.own.planName} 的优惠价（前{" "}
                      {recommendation.own.introMonths ?? "—"} 个月），之后涨到{" "}
                      {money(recommendation.own.ongoingPrice)}/月。
                    </p>
                  )}
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    按你的档位和月费挑出的推荐套餐、能省多少钱，在页面顶部。
                  </p>
                  <button
                    type="button"
                    aria-label="清除我现在的套餐"
                    onClick={() => clearCp.mutate()}
                    className="mt-2 text-sm text-[var(--dim)] underline"
                  >
                    清除并重新填写
                  </button>
                </div>
              ) : (
                <form
                  className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
                  style={{ borderRadius: "var(--radius)" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!cpProvider.trim()) {
                      setCpError("请填写供应商名字。");
                      return;
                    }
                    const price = Number(cpPrice);
                    if (!cpPrice || Number.isNaN(price) || price <= 0) {
                      setCpError("请填写每月实际月费（数字）。");
                      return;
                    }
                    saveCp.mutate();
                  }}
                >
                  <div className="flex flex-wrap gap-3">
                    <label className="block min-w-36 flex-1">
                      <span className="text-sm text-[var(--dim)]">供应商</span>
                      <input
                        {...FIELDS.saveCurrentPlan.provider}
                        aria-label="当前套餐供应商"
                        value={cpProvider}
                        onChange={(e) => setCpProvider(e.target.value)}
                        placeholder="例如 Aussie Broadband"
                        className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[var(--text)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-sm text-[var(--dim)]">速度档位</span>
                      <select
                        aria-label="当前套餐速度档位"
                        value={cpTier}
                        onChange={(e) => setCpTier(e.target.value)}
                        className="mt-1 border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[var(--text)]"
                      >
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t} Mbps
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block w-32">
                      <span className="text-sm text-[var(--dim)]">每月月费 $</span>
                      <input
                        {...FIELDS.saveCurrentPlan.monthlyPrice}
                        aria-label="当前套餐每月月费"
                        inputMode="decimal"
                        value={cpPrice}
                        onChange={(e) => setCpPrice(e.target.value)}
                        placeholder="例如 99"
                        className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[var(--text)]"
                      />
                    </label>
                  </div>
                  {cpError && (
                    <p className="mt-2 text-sm text-[var(--warn)]">{cpError}</p>
                  )}
                  <button
                    type="submit"
                    aria-label="保存我现在的套餐"
                    disabled={saveCp.isPending}
                    className="mt-3 bg-[var(--teal)] px-4 py-2 font-semibold text-white disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {saveCp.isPending ? "保存中…" : "保存并比较"}
                  </button>
                </form>
              )}
            </section>

            {/* Plan list */}
            <section className="mt-8">
              <h2 className="text-lg font-bold text-[var(--text)]">套餐明细</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label="显示全部档位"
                  aria-pressed={tierFilter === "all"}
                  onClick={() => setTierFilter("all")}
                  className={`px-3 py-1.5 text-sm font-medium ${tierFilter === "all" ? "bg-[var(--teal)] text-white" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
                  style={{ borderRadius: "var(--radius)" }}
                >
                  全部
                </button>
                {TIERS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-label={`只看 ${t} Mbps 档位`}
                    aria-pressed={tierFilter === t}
                    onClick={() => setTierFilter(t)}
                    className={`px-3 py-1.5 text-sm font-medium ${tierFilter === t ? "bg-[var(--teal)] text-white" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {t}M
                  </button>
                ))}
                <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:inline-block" />
                <button
                  type="button"
                  aria-label={`按${basisLabel}平均价排序`}
                  aria-pressed={sortBy === "ongoing"}
                  onClick={() => setSortBy("ongoing")}
                  className={`px-3 py-1.5 text-sm font-medium ${sortBy === "ongoing" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
                  style={{ borderRadius: "var(--radius)" }}
                >
                  按 {basisLabel}均价
                </button>
                <button
                  type="button"
                  aria-label="按优惠价排序"
                  aria-pressed={sortBy === "intro"}
                  onClick={() => setSortBy("intro")}
                  className={`px-3 py-1.5 text-sm font-medium ${sortBy === "intro" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface-alt)] text-[var(--text)]"}`}
                  style={{ borderRadius: "var(--radius)" }}
                >
                  按优惠价
                </button>
                <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:inline-block" />
                <BasisToggle basis={compareBasis} onChange={setCompareBasis} label="比较基准" />
              </div>
              {tierFilter === "100" && (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  注意：在 FTTP/HFC 地址上，「100 档」自 2025 年 9 月起实际按 500
                  Mbps 交付；下面这些是 FTTN/FTTB/FTTC 的 100 档价格。FTTP
                  地址直接看 500 档更准。
                </p>
              )}
              {tierFilter === "250" && (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  250 档在 FTTP/HFC 上已被 750 档取代，很少有商家单独卖；要更快的看
                  750 档。
                </p>
              )}
              {tierFilter === "500" && (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  500 档只在 FTTP/HFC 地址能办，下单前请按地址确认。注意
                  Kogan 有两个价格一样的套餐：100 档的 Gold（晚间典型速度
                  98/17）和这里的 Gold Plus 500（晚间典型速度
                  500/42），下单时别选错。
                </p>
              )}
              {tierFilter === "2000" && (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  2000 档是 2025 年 9
                  月新推出的最高档，仅限 FTTP/HFC；晚间典型速度为供应商标称值。
                </p>
              )}
              {TIERS.filter(
                (t) => tierFilter === "all" || tierFilter === t,
              ).map((tier) => {
                const inTier = visiblePlans.filter((p) => p.tier === tier);
                if (inTier.length === 0) return null;
                // 同品牌同档位合并：每组只显示按当前比较基准最便宜
                // 的主行，其余变体不显示（数据保留在库里）；组按主行
                // 的排序价排；最便宜标记按显示的行、当前基准算。
                const groups = groupPlansByBrand(inTier, compareBasis);
                groups.sort((a, b) => sortPrice(a.main) - sortPrice(b.main));
                const bestAvg = Math.min(...inTier.map((p) => avgBasis(p)));
                return (
                  <div key={tier} className="mt-4">
                    <h3 className="price text-base font-bold text-[var(--teal)]">
                      {tier} Mbps
                    </h3>
                    <ul className="mt-1 border border-[var(--border)] bg-[var(--surface)] px-3" style={{ borderRadius: "var(--radius)" }}>
                      {groups.map((g) => (
                        <BrandGroupRow
                          key={g.provider}
                          group={g}
                          bestAvg={bestAvg}
                          providerUrl={providerUrl(g.provider)}
                          basis={compareBasis}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>

            {/* Price history chart */}
            <section className="mt-8">
              <h2 className="text-lg font-bold text-[var(--text)]">
                各档最低价走势（12 个月平均）
              </h2>
              <p className="mt-0.5 text-sm text-[var(--dim)]">
                种子数据更新、某档价格有变动时会留一个点：按当次的优惠价、优惠月数和优惠后价格算出的第一年平均月费，取每档最低。攒几次之后涨跌就看得出来了。数据始于{" "}
                {chartData[0]?.date ?? "—"}。
              </p>
              <div className="mt-3 border border-[var(--border)] bg-[var(--surface)] px-2 py-3" style={{ borderRadius: "var(--radius)" }}>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis
                      domain={["dataMin - 10", "dataMax + 10"]}
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v: number) => `$${v}`}
                    />
                    <Tooltip
                      formatter={(value: number | string) => [
                        typeof value === "number" ? money(value) : value,
                        "",
                      ]}
                    />
                    <Legend />
                    {TIERS.map((t) => (
                      <Line
                        key={t}
                        type="monotone"
                        dataKey={t}
                        name={`${t}M 最低价（12 个月平均）`}
                        stroke={TIER_COLORS[t]}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Technology notes */}
            <section id="tech-speed" className="mt-8">
              <h2 className="text-lg font-bold text-[var(--text)]">
                接入技术说明
              </h2>
              <div className="mt-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm leading-6 text-[var(--text)]" style={{ borderRadius: "var(--radius)" }}>
                <p>
                  同一邮编内不同街道的接入技术可能不同（FTTP 与 FTTC
                  混合很常见），下单前请以 nbnco 或供应商按地址查询的结果为准。
                </p>
                <ul className="mt-2 list-disc pl-5">
                  <li>FTTP：批发最高 2000 Mbps（2000/200），25–2000 各档都能办。</li>
                  <li>
                    FTTC：一般最高 100/40 Mbps；部分全国指南说 FTTC
                    可达 250 Mbps——这一点没有在本地核实，以 100 为准。FTTC
                    地址可申请免费升级 FTTP（Fibre Connect，2026 年 7 月 1
                    日起不再要求先订高速套餐）。
                  </li>
                  <li>
                    HFC：2025 年 9 月 14 日起与 FTTP 同档升级（原 100/20
                    升为 500/50），最高 2000 档。
                  </li>
                  <li>
                    2025 年 9 月 14 日起（仅 FTTP/HFC）：原 100/20 升为
                    500/50、250/25 升为 750/50、1000 档上传升到 100
                    Mbps，并新增 2000 档，批发价不变。FTTN/FTTC/FTTB
                    不在升级范围内，最高仍是 100。
                  </li>
                </ul>
                <p className="mt-2 text-[var(--dim)]">
                  来源：nbnco 供应商页与 Fibre Connect 文件；Econnex
                  速度升级说明（2026-08-31 更新）。均于 2026-11-19 核对。
                </p>
              </div>
            </section>

            {/* Awards */}
            <section className="mt-8">
              <h2 className="text-lg font-bold text-[var(--text)]">
                口碑与性价比评奖（2026）
              </h2>
              <ul className="mt-2 space-y-2">
                {[
                  {
                    title: "Canstar 最满意客户奖：Aussie Broadband",
                    body: "速度、可靠性、开通难易和客服得分最高，但性价比一项不算突出。Canstar 杰出价值奖另颁给 Moose Mobile（NBN）和 Superloop（高速 NBN）。",
                    src: "Canstar（canstar.com.au）",
                  },
                  {
                    title: "Finder 年度大奖：Superloop 年度供应商，Dodo 最佳平价",
                    body: "Superloop 拿下 Finder 2026 年度 NBN 供应商和极速类奖项；Dodo 获最佳平价供应商（Finder 评分 9.7）；Tangerine 在平价/日常/快速类获高度推荐。",
                    src: "Finder Awards 2026（2026-11-13 更新）",
                  },
                  {
                    title: "ACCC 实测：Dodo、TPG、Exetel 跑赢标称速度",
                    body: "ACCC 宽带实测最终报告（2026 年 6 月）中，Dodo、TPG、Exetel 在忙时达到标称速度的 100% 以上（Exetel 约 101.2–101.6%）；Superloop 约 101%，Aussie Broadband 约 95–97%（不同转述略有出入，作约数看）。",
                    src: "ACCC Measuring Broadband Australia 第 33 期（经 Finder / Tom's Guide / WhistleOut 转述）",
                  },
                  {
                    title: "TechRadar 澳洲 PC 大奖：Exetel 最佳 NBN 供应商",
                    body: "理由是 The One Plan $80/月固定价是当时市场上最便宜的 500 Mbps 套餐，也是唯一一个一年不到 $1,000 的。",
                    src: "TechRadar（2026-05-12）",
                  },
                ].map((a) => (
                  <li
                    key={a.title}
                    className="border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    <p className="font-semibold text-[var(--text)]">{a.title}</p>
                    <p className="mt-0.5 text-sm text-[var(--text)]">{a.body}</p>
                    <p className="mt-0.5 text-xs text-[var(--dim)]">来源：{a.src}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-[var(--dim)]">
                一句话总结：按 12 个月平均算，各档最便宜的一批是 Kogan、amaysim、Superloop、SpinTel、Belong、MATE；服务口碑最好的是 Aussie
                Broadband 和 Superloop，同档通常贵 $10–30/月；Telstra、Optus
                在九大供应商里最贵，靠黑五这类短期 5 折才拉近差距。
              </p>
            </section>

            <footer className="mt-10 border-t border-[var(--border)] pt-3 text-xs leading-5 text-[var(--dim)]">
              价格为 2026-11-21 核对的研究快照（来源逐项标注在每个套餐下）。数据来源：Canstar 为主，nbntracker-data 为第二来源/交叉核对，WhistleOut、Finder 和供应商官网/CIS 用于核对。独立运行版不提供更新数据的接口：数据由维护者每周用脚本更新种子文件并推送到 GitHub，重新部署后刷新页面即可看到更新后的数据。顶部推荐、每档最低表和套餐明细里的套餐旁会有一个小圆图标：绿色 ↑ 表示有更新，灰色 － 表示没有更新，红色 ! 表示更新失败。每个套餐费用后面都有「计算过程」，点开能看到第一年和两年总费用的等式（优惠价 × 月数 + 优惠后价 × 剩余月数）。NBN
              没有公开的价格数据接口；核对不到的套餐保留原价和原核对日期，不会用猜测的数字填充。长期价按 12 个月或 24 个月平均月费计算（「每档长期价最低」处可切换比较基准，默认 12 个月），签约前请以供应商 CIS 为准。
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
