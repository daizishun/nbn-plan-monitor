// Seed data transcribed from the deep-research report
// (research_notes/nbn-plans-mill-park-20261119-0153/report.md), all figures
// checked 2026-11-19. Every value carries the report's source label; hedges
// and conflicts the report flags are kept in `note`, never silently resolved.

export const CHECKED = "2026-11-19";

const WO = "WhistleOut 价目表";
const WO_URL = "https://www.whistleout.com.au/Broadband/NBN-Plans-Price-Check-SLP";
const FINDER = "Finder 最便宜 NBN 套餐表（2026-11-17 更新）";
const FINDER_URL = "https://www.finder.com.au/broadband-plans/nbn/cheap-nbn-plans";
const FINDER1000 = "Finder NBN 1000 评测（2026-11）";
const FINDER1000_URL = "https://www.finder.com.au/broadband-plans/nbn/nbn-1000-gigabit-internet";
const OZBR = "OzBroadbandReview（2026-11-10~11）";
const SUPERLOOP_LIVE = "Superloop 官网（2026-11-19 实查）";
const SUPERLOOP_URL = "https://www.superloop.com/internet/nbn/";

export interface SeedPlan {
  provider: string;
  planName: string;
  tier: string;
  speedDown: number;
  speedUp?: number;
  introPrice?: number;
  introMonths?: number;
  ongoingPrice: number;
  tes?: string;
  contract?: string;
  category: "cheapest" | "headline";
  source: string;
  sourceUrl?: string;
  promoEnd?: string;
  note?: string;
}

export const SEED_PLANS: SeedPlan[] = [
  // ---- 25 Mbps (§3a) ----
  { provider: "SpinTel", planName: "Home Starter 25/10", tier: "25", speedDown: 25, speedUp: 10, introPrice: 39, introMonths: 6, ongoingPrice: 69.95, tes: "25/8 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "合约期未在摘录中注明，签约前查 CIS。" },
  { provider: "Dodo", planName: "nbn25 Unlimited", tier: "25", speedDown: 25, speedUp: 10, introPrice: 39.89, introMonths: 6, ongoingPrice: 73.99, tes: "25/10 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "WhistleOut 专享优惠价；标准优惠价为 $43.99/月×6。合约期未注明，查 CIS。" },
  { provider: "Tangerine", planName: "Value NBN 25/10", tier: "25", speedDown: 25, speedUp: 10, introPrice: 39.9, introMonths: 6, ongoingPrice: 72.9, tes: "25/8.5 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL, promoEnd: "2026-12-31", note: "价格 11 月内变动过：其他来源 11 月 10–11 日为 $42.90，8 月为 $47.90；此处用 11 月 19 日最新数字，下单前复核。" },
  { provider: "Moose Mobile", planName: "NBN 25/10 Value", tier: "25", speedDown: 25, speedUp: 10, introPrice: 44.8, introMonths: 6, ongoingPrice: 64.8, contract: "无合约绑定、无解约费", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "晚间典型速度未在摘录中注明。" },
  { provider: "Kogan Internet", planName: "Bronze Unlimited", tier: "25", speedDown: 25, speedUp: 10, introPrice: 47.9, introMonths: 12, ongoingPrice: 70.9, tes: "25/8 Mbps", contract: "按月付费", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, promoEnd: "2026-12-06" },
  { provider: "Flip", planName: "Unlimited Premium nbn25", tier: "25", speedDown: 25, introPrice: 48, introMonths: 12, ongoingPrice: 65.9, category: "cheapest", source: "研究报告 §3a（WhistleOut）", sourceUrl: WO_URL, note: "合约期未注明，查 CIS。" },

  // ---- 50 Mbps (§3b) ----
  { provider: "amaysim", planName: "NBN 50", tier: "50", speedDown: 50, introPrice: 45, introMonths: 6, ongoingPrice: 85, tes: "50 Mbps", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, note: "晚间典型速度未在 Finder 摘录中注明；合约期未注明，查 CIS。" },
  { provider: "Dodo", planName: "nbn50 Unlimited", tier: "50", speedDown: 50, speedUp: 20, introPrice: 53.89, introMonths: 6, ongoingPrice: 87.99, tes: "50/20 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "WhistleOut 专享优惠价；标准优惠价为 $57.99/月×6。合约期未注明，查 CIS。" },
  { provider: "Tangerine", planName: "Value Plus NBN 50/20", tier: "50", speedDown: 50, speedUp: 20, introPrice: 64.9, introMonths: 6, ongoingPrice: 89.9, tes: "50/17 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Flip", planName: "Unlimited Family nbn50", tier: "50", speedDown: 50, introPrice: 68, introMonths: 6, ongoingPrice: 84.9, tes: "50/17 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "合约期未注明，查 CIS。" },
  { provider: "Kogan Internet", planName: "Silver Unlimited", tier: "50", speedDown: 50, introPrice: 68.9, introMonths: 12, ongoingPrice: 80.9, tes: "50/17 Mbps", contract: "按月付费", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, note: "优惠结束后的月费 $80.90，是 50 档里最低的。" },

  // ---- 100 Mbps (§3c; on FTTP/HFC this tier is delivered as 500 Mbps since Sep 2025) ----
  { provider: "Dodo", planName: "nbn100 Unlimited", tier: "100", speedDown: 100, speedUp: 20, introPrice: 58.89, introMonths: 6, ongoingPrice: 92.99, tes: "100/20 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "WhistleOut 专享优惠价；标准优惠价为 $62.99/月×6。合约期未注明，查 CIS。" },
  { provider: "TPG", planName: "nbn Home Fast Unlimited", tier: "100", speedDown: 100, introPrice: 64.99, introMonths: 6, ongoingPrice: 94.99, tes: "99/17 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "另有促销版本 $74.99/月×12（OzBroadbandReview），以官网为准。" },
  { provider: "Tangerine", planName: "Speedy NBN 100/20", tier: "100", speedDown: 100, speedUp: 20, introPrice: 67.9, introMonths: 6, ongoingPrice: 92.9, tes: "100/17 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Kogan Internet", planName: "Gold Unlimited", tier: "100", speedDown: 100, introPrice: 68.9, introMonths: 12, ongoingPrice: 85.9, tes: "98/17 Mbps", contract: "按月付费", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, note: "100 Mbps 档里长期价最低的一家。" },
  { provider: "Superloop", planName: "Family nbn100/20", tier: "100", speedDown: 100, speedUp: 20, introPrice: 69, introMonths: 6, ongoingPrice: 99, tes: "95/17 Mbps", contract: "最短 1 个月", category: "cheapest", source: "Superloop CIS（2026-11-11）", sourceUrl: SUPERLOOP_URL },
  { provider: "Flip", planName: "Unlimited Turbo Boost nbn100", tier: "100", speedDown: 100, introPrice: 69, introMonths: 6, ongoingPrice: 88.9, tes: "100/17 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "合约期未注明，查 CIS。" },

  // ---- 250 Mbps (§3d — barely sold standalone since Sep 2025) ----
  { provider: "Superloop", planName: "Creator nbn250/100", tier: "250", speedDown: 250, speedUp: 100, introPrice: 82, introMonths: 6, ongoingPrice: 102, tes: "250/85 Mbps", contract: "最短 1 个月，$0 开通费", category: "cheapest", source: "Superloop CIS（2026-11-11）", sourceUrl: SUPERLOOP_URL, note: "仅限 FTTP 和部分 HFC 地址。250 档自 2025 年 9 月起在 FTTP/HFC 上已被 750 档取代，很少单独出售。" },
  { provider: "Leaptel", planName: "250/100", tier: "250", speedDown: 250, speedUp: 100, introPrice: 95, introMonths: 12, ongoingPrice: 110, category: "cheapest", source: "nbncompare.org 市场扫描（2026-08）", note: "2026 年 8 月的旧数据，11 月未复核，下单前务必查官网现价。" },

  // ---- 500 Mbps (successor to 100 on FTTP/HFC; drawn from §3d/§4) ----
  { provider: "Exetel", planName: "The One Plan 500/50", tier: "500", speedDown: 500, speedUp: 50, ongoingPrice: 80, tes: "500/45 Mbps", contract: "无合约绑定", category: "cheapest", source: "Exetel 官网 / WhistleOut 评测（研究报告 §4）", sourceUrl: "http://www.exetel.com.au/broadband/nbn", note: "固定价、不打折：$80/月就是长期价，优惠结束后的月费是 500 档最低。仅限 FTTP/HFC。另可 +$1/天临时升到 1000 Mbps（Warp Speed）。" },
  { provider: "Tangerine", planName: "NBN 500/50", tier: "500", speedDown: 500, speedUp: 50, introPrice: 59.9, introMonths: 6, ongoingPrice: 92.9, tes: "500/42.5 Mbps", contract: "无合约绑定", category: "cheapest", source: "研究报告 §4（各来源 2026-11-19 核对）", sourceUrl: "http://www.tangerinetelecom.com.au/nbn/nbn-broadband" },
  { provider: "SpinTel", planName: "NBN 500", tier: "500", speedDown: 500, introPrice: 69, introMonths: 6, ongoingPrice: 89.95, tes: "500 Mbps", category: "cheapest", source: "研究报告 §4", sourceUrl: "https://www.spintel.net.au/home-internet/nbn" },
  { provider: "Dodo", planName: "NBN 500", tier: "500", speedDown: 500, introPrice: 58.89, introMonths: 6, ongoingPrice: 92.99, category: "cheapest", source: "研究报告 §4", sourceUrl: "https://www.dodo.com/nbn?utm_source=nbncowebsite&utm_medium=referral&resellerid=nbnco" },
  { provider: "Aussie Broadband", planName: "NBN 500/50", tier: "500", speedDown: 500, speedUp: 50, introPrice: 79, introMonths: 6, ongoingPrice: 99, tes: "500 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.aussiebroadband.com.au/nbn-plans/?utm_source=nbnco&utm_medium=referral&utm_campaign=nbn_referral" },
  { provider: "Kogan Internet", planName: "Gold Plus 500", tier: "500", speedDown: 500, speedUp: 50, introPrice: 68.9, introMonths: 12, ongoingPrice: 85.9, tes: "500/42 Mbps", contract: "按月付费", category: "cheapest", source: "Finder 最便宜 NBN 套餐表 / Kogan 官网（2026-11-19 抓取）", sourceUrl: FINDER_URL, promoEnd: "2026-12-06", note: "Kogan 原生的 500/50 套餐，和 100 档的 Gold（晚间速度 98/17）是两个套餐，只是优惠价和长期价恰好相同。优惠活动 2026-12-06 结束。" },
  { provider: "Superloop", planName: "Family Max 500/50", tier: "500", speedDown: 500, speedUp: 50, introPrice: 69, introMonths: 6, ongoingPrice: 99, tes: "500/45 Mbps", contract: "最短 1 个月", category: "cheapest", source: SUPERLOOP_LIVE, sourceUrl: SUPERLOOP_URL, promoEnd: "2026-12-15", note: "促销活动 2026-12-15 结束。" },
  { provider: "TPG", planName: "NBN 500", tier: "500", speedDown: 500, speedUp: 50, ongoingPrice: 94.99, tes: "500/42 Mbps", contract: "无合约绑定", category: "cheapest", source: "TPG CIS（2026-07）", sourceUrl: "https://www.tpg.com.au/nbn", note: "CIS 只列长期价 $94.99/月，未列优惠期价格。" },
  { provider: "Belong", planName: "Fast 500", tier: "500", speedDown: 500, speedUp: 50, introPrice: 70, introMonths: 12, ongoingPrice: 95, tes: "500/40 Mbps", contract: "无合约", category: "cheapest", source: "Belong CIS（2026-07-01）/ belong.com.au", sourceUrl: "https://www.belong.com.au/go/internet", promoEnd: "2026-11-30", note: "优惠活动 2026-11-30 结束。" },
  { provider: "Telstra", planName: "NBN 500", tier: "500", speedDown: 500, speedUp: 50, introPrice: 49, introMonths: 4, ongoingPrice: 99, tes: "500/40 Mbps", category: "headline", source: "OzBargain Telstra 黑五活动（研究报告 §4）", promoEnd: "2026-11-30", note: "黑五 5 折优惠价，仅前 4 个月，2026-11-30 结束。" },
  { provider: "Optus", planName: "Fast 500", tier: "500", speedDown: 500, speedUp: 50, introPrice: 89, introMonths: 12, ongoingPrice: 99, tes: "500 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.optus.com.au/broadband-nbn/home-broadband/plans/shop" },

  // ---- 750 Mbps (successor to 250 on FTTP/HFC; §3d) ----
  { provider: "SpinTel", planName: "Home Turbofast 750/50", tier: "750", speedDown: 750, speedUp: 50, introPrice: 64, introMonths: 6, ongoingPrice: 94.95, tes: "750/42 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Dodo", planName: "Home Superfast 740/50", tier: "750", speedDown: 750, speedUp: 50, introPrice: 65.89, introMonths: 6, ongoingPrice: 99.99, tes: "740/50 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "TPG", planName: "Home Superfast", tier: "750", speedDown: 750, introPrice: 74.99, introMonths: 6, ongoingPrice: 104.99, tes: "740/42 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Superloop", planName: "Megaspeed 750/50", tier: "750", speedDown: 750, speedUp: 50, introPrice: 84, introMonths: 6, ongoingPrice: 109, tes: "750/45 Mbps", category: "cheapest", source: SUPERLOOP_LIVE, sourceUrl: SUPERLOOP_URL },
  { provider: "amaysim", planName: "NBN 750", tier: "750", speedDown: 750, speedUp: 50, introPrice: 60, introMonths: 6, ongoingPrice: 100, tes: "680 Mbps", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, note: "Finder 最便宜 750 档（表格 2026-11-17 更新）。合约期未注明，查 CIS。" },

  // ---- 1000 Mbps (§3e, FTTP/HFC only) ----
  { provider: "SpinTel", planName: "Home Ultrafast 1000/100", tier: "1000", speedDown: 1000, speedUp: 100, introPrice: 74, introMonths: 6, ongoingPrice: 104.95, tes: "850/82 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "优惠价有冲突：OzBroadbandReview 11 月 11 日列 $94/月×6，WhistleOut 为 $74，下单前查官网。合约期未注明，查 CIS。" },
  { provider: "Dodo", planName: "nbn Home Ultrafast", tier: "1000", speedDown: 1000, introPrice: 75.89, introMonths: 6, ongoingPrice: 109.99, tes: "800/100 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "WhistleOut 专享优惠价。合约期未注明，查 CIS。" },
  { provider: "TPG", planName: "nbn Home Ultrafast Unlimited", tier: "1000", speedDown: 1000, introPrice: 84.99, introMonths: 6, ongoingPrice: 114.99, tes: "850/85 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Belong", planName: "Ultrafast", tier: "1000", speedDown: 1000, introPrice: 85, introMonths: 12, ongoingPrice: 110, tes: "875/80 Mbps", contract: "无合约", category: "cheapest", source: FINDER1000, sourceUrl: FINDER1000_URL, promoEnd: "2026-11-30" },
  { provider: "Flip", planName: "Unlimited Ultra Speed nbn1000", tier: "1000", speedDown: 1000, introPrice: 89, introMonths: 4, ongoingPrice: 109.9, tes: "850/85 Mbps", category: "cheapest", source: WO, sourceUrl: WO_URL, note: "合约期未注明，查 CIS。" },
  { provider: "Tangerine", planName: "UltraSpeedy NBN 1000/100", tier: "1000", speedDown: 1000, speedUp: 100, introPrice: 89.9, introMonths: 6, ongoingPrice: 114.9, tes: "860/85 Mbps", contract: "无合约绑定", category: "cheapest", source: WO, sourceUrl: WO_URL },
  { provider: "Kogan Internet", planName: "Diamond", tier: "1000", speedDown: 1000, introPrice: 94.9, introMonths: 12, ongoingPrice: 108.9, tes: "850/85 Mbps", contract: "按月付费", category: "cheapest", source: FINDER1000, sourceUrl: FINDER1000_URL },
  { provider: "Superloop", planName: "Lightspeed 1000/100", tier: "1000", speedDown: 1000, speedUp: 100, ongoingPrice: 99, tes: "860/85 Mbps", category: "cheapest", source: SUPERLOOP_LIVE, sourceUrl: SUPERLOOP_URL, promoEnd: "2026-12-15", note: "固定价 $99/月，不分优惠期，优惠结束后的月费是 1000 档最低；促销活动 2026-12-15 结束。" },

  // ---- 2000 Mbps (FTTP/HFC only, launched Sep 2025; from notes/source-03) ----
  { provider: "MATE", planName: "NBN 2000", tier: "2000", speedDown: 2000, speedUp: 200, introPrice: 141, introMonths: 6, ongoingPrice: 166, tes: "1831 Mbps", category: "cheapest", source: FINDER, sourceUrl: FINDER_URL, note: "Finder 最便宜 2000 档（表格 2026-11-17 更新）。仅限 FTTP/HFC。合约期未注明，查 CIS。" },
  { provider: "Superloop", planName: "Hyperspeed 2000", tier: "2000", speedDown: 2000, speedUp: 200, introPrice: 148, introMonths: 6, ongoingPrice: 168, tes: "1700/170 Mbps", contract: "最短 1 个月", category: "cheapest", source: SUPERLOOP_LIVE, sourceUrl: SUPERLOOP_URL, promoEnd: "2026-12-15", note: "仅限 FTTP/HFC。促销活动 2026-12-15 结束。" },

  // ---- Headline prices for the nine named providers (§4) ----
  { provider: "Aussie Broadband", planName: "Basic Plus 25", tier: "25", speedDown: 25, introPrice: 58, introMonths: 6, ongoingPrice: 83, tes: "23 Mbps", category: "headline", source: OZBR, sourceUrl: "https://www.aussiebroadband.com.au/nbn-plans/?utm_source=nbnco&utm_medium=referral&utm_campaign=nbn_referral", note: "优惠价需用码 SPRING25。" },
  { provider: "Superloop", planName: "Everyday 25", tier: "25", speedDown: 25, introPrice: 58, introMonths: 6, ongoingPrice: 78, tes: "25/8.5 Mbps", category: "headline", source: SUPERLOOP_LIVE, sourceUrl: SUPERLOOP_URL },
  { provider: "Telstra", planName: "NBN 25", tier: "25", speedDown: 25, introPrice: 44, introMonths: 4, ongoingPrice: 89, tes: "25/4 Mbps", category: "headline", source: "OzBargain Telstra 黑五活动（研究报告 §4）", promoEnd: "2026-11-30", note: "黑五 5 折优惠价，仅前 4 个月，2026-11-30 结束。" },
  { provider: "Optus", planName: "NBN 25", tier: "25", speedDown: 25, introPrice: 73, introMonths: 12, ongoingPrice: 83, tes: "25 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.optus.com.au/broadband-nbn/home-broadband/plans/shop" },
  { provider: "Aussie Broadband", planName: "NBN 50", tier: "50", speedDown: 50, introPrice: 70, introMonths: 6, ongoingPrice: 95, tes: "47 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.aussiebroadband.com.au/nbn-plans/?utm_source=nbnco&utm_medium=referral&utm_campaign=nbn_referral" },
  { provider: "Superloop", planName: "Extra Value 50", tier: "50", speedDown: 50, introPrice: 69, introMonths: 6, ongoingPrice: 89, tes: "50/17 Mbps", contract: "最短 1 个月", category: "headline", source: "Superloop CIS（2026-11-11）", sourceUrl: SUPERLOOP_URL },
  { provider: "TPG", planName: "NBN50", tier: "50", speedDown: 50, introPrice: 69.99, introMonths: 6, ongoingPrice: 89.99, tes: "50/17 Mbps", category: "headline", source: "TPG CIS（2026-07）", sourceUrl: "https://www.tpg.com.au/nbn" },
  { provider: "Telstra", planName: "NBN 50", tier: "50", speedDown: 50, introPrice: 49, introMonths: 4, ongoingPrice: 99, tes: "50/17 Mbps", category: "headline", source: "OzBargain Telstra 黑五活动（研究报告 §4）", promoEnd: "2026-11-30", note: "黑五 5 折优惠价，仅前 4 个月，2026-11-30 结束。" },
  { provider: "Optus", planName: "NBN 50", tier: "50", speedDown: 50, introPrice: 87, introMonths: 12, ongoingPrice: 97, tes: "50 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.optus.com.au/broadband-nbn/home-broadband/plans/shop" },
  { provider: "Aussie Broadband", planName: "Fast 100/20", tier: "100", speedDown: 100, speedUp: 20, introPrice: 79, introMonths: 6, ongoingPrice: 99, tes: "94 Mbps", category: "headline", source: OZBR },
  { provider: "SpinTel", planName: "NBN 100", tier: "100", speedDown: 100, introPrice: 76, introMonths: 6, ongoingPrice: 89.95, tes: "约 100 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.spintel.net.au/home-internet/nbn" },
  { provider: "Telstra", planName: "NBN 100", tier: "100", speedDown: 100, introPrice: 49, introMonths: 4, ongoingPrice: 99, tes: "100/17 Mbps", category: "headline", source: "OzBargain Telstra 黑五活动（研究报告 §4）", promoEnd: "2026-11-30", note: "黑五 5 折优惠价，仅前 4 个月，2026-11-30 结束。" },
  { provider: "Aussie Broadband", planName: "Ultrafast Fibre 1000", tier: "1000", speedDown: 1000, introPrice: 99, introMonths: 6, ongoingPrice: 129, tes: "875 Mbps", category: "headline", source: "研究报告 §4", sourceUrl: "https://www.aussiebroadband.com.au/nbn-plans/?utm_source=nbnco&utm_medium=referral&utm_campaign=nbn_referral" },
  { provider: "Telstra", planName: "NBN 1000", tier: "1000", speedDown: 1000, introPrice: 64, introMonths: 4, ongoingPrice: 129, tes: "875/80 Mbps", category: "headline", source: "OzBargain Telstra 黑五活动（研究报告 §4）", promoEnd: "2026-11-30", note: "黑五 5 折优惠价，仅前 4 个月，2026-11-30 结束。" },
  { provider: "Optus", planName: "NBN 1000", tier: "1000", speedDown: 1000, introPrice: 109, introMonths: 12, ongoingPrice: 129, tes: "约 875 Mbps", category: "headline", source: WO, sourceUrl: WO_URL, note: "优惠价有冲突：另一来源列 $89/月×6（OzBroadbandReview），以官网为准。" },
];

// nbnco provider directory (§1): names as shown on
// https://www.nbnco.com.au/residential/service-providers (verified live
// 2026-11-19). Website URLs were verified for the 10 major providers only.
export const SEED_PROVIDERS: { name: string; websiteUrl?: string }[] = [
  { name: "Aussie Broadband", websiteUrl: "https://www.aussiebroadband.com.au/nbn-plans/?utm_source=nbnco&utm_medium=referral&utm_campaign=nbn_referral" },
  { name: "Superloop", websiteUrl: "https://superloop.com/consumer/home-broadband/nbn.html" },
  { name: "Exetel", websiteUrl: "http://www.exetel.com.au/broadband/nbn" },
  { name: "Tangerine Telecom", websiteUrl: "http://www.tangerinetelecom.com.au/nbn/nbn-broadband" },
  { name: "Spintel", websiteUrl: "https://www.spintel.net.au/home-internet/nbn" },
  { name: "Dodo", websiteUrl: "https://www.dodo.com/nbn?utm_source=nbncowebsite&utm_medium=referral&resellerid=nbnco" },
  { name: "TPG", websiteUrl: "https://www.tpg.com.au/nbn" },
  { name: "Telstra", websiteUrl: "https://www.telstra.com.au/internet/nbn" },
  { name: "Optus", websiteUrl: "https://www.optus.com.au/broadband-nbn/home-broadband/plans/shop" },
  { name: "Kogan", websiteUrl: "https://www.koganinternet.com.au/leads/location/?utm_source=nbn&utm_medium=web&utm_campaign=nbn_referral" },
  ...[
    "10mates", "1300easyisp", "1st Internet And Wifi", "2go Broadband", "2it Technology",
    "Accord With Officeworks", "Ace Internet", "Activ8me", "Adam Internet", "Adop Communications",
    "Advantage Communication & Data", "Agl Telecommunications", "Airtel", "Alpha Dot Net", "Alphacall",
    "Amaysim", "Aqua Mobile", "Ascensa Communications", "Aus Internet", "Australia Online",
    "Barefoot Telecom", "Beagle Internet", "Belong", "Bendigo Telco", "Best Telecom Australia",
    "Broadband Solutions", "Buddy Telco", "Buroserv", "Candour Communications", "Carbon Comms",
    "Central Coast Internet", "Central Connect Pty Ltd", "City Cable Australia", "Clear Networks",
    "Click Access", "Cmobile", "Connected Australia", "Cybertel Telecom", "Datalife",
    "Datawave", "Downstream", "E.tel Broadband", "Easynet", "Ecn",
    "Ehw Technology", "Escapenet", "Fairtel", "Fantel", "Fibremax",
    "Flip", "Foxtel", "Future Broadband", "Fuzenet", "Gennext",
    "Gippsland Broadband", "Go Troppo Internet", "Gointernet", "Goodtel", "Green Tree Frog",
    "Harbour Isp", "I.net.au", "If Telecom", "Iig", "Iinet",
    "Infinet Broadband", "Infinite Networks", "Inspired Broadband", "International Exchange", "Interphone",
    "Iprimus", "Ipstar", "It's Fubar Technology Services", "Kinetix", "Kloudphone",
    "Launtel", "Leaptel", "Lightning Ip", "Linear G", "Liva Telecom",
    "Lizzy Internet", "Mad Over Tech", "Mate", "Matilda", "Melbourne Phone Company Pty Ltd",
    "Mint Telecom", "Montimedia Internet", "Moose Mobile", "More", "Multiwave Connect",
    "Myown Tel", "Nelson Bay Online", "Neptune Internet", "New Sprout", "Next Business Telecom",
    "Nodeone", "Occom", "Oceandigi", "Onenet", "Onthenet",
    "Origin Broadband", "Peak Connect", "Pear", "Pentanet", "Pivotel",
    "Powercom Pacific", "Prime Telecom", "Quadnet", "Quokka Net", "Qured",
    "Real World Technology Solutions", "Roctel", "Skymesh", "Solitary Technology", "Southern Phone",
    "Splice Internet Pty Ltd", "Steele Technology Pty Ltd", "Switched On Australia", "Swoop Broadband", "Tablelands Communications",
    "Telair", "The George Baini Group", "The Internet Provider", "Tig Telecom", "Tomi",
    "Trikon", "Uniqaus", "Univox", "Url Networks", "Utelecom Australia Pty Ltd",
    "Veetel", "Vocal", "Vodafone", "Voipex", "Vonex Telecom",
    "X Integration", "Zettanet", "Zipfibre",
  ].map((name) => ({ name })),
];
