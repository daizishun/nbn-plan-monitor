#!/usr/bin/env python3
"""Fetch all Canstar NBN plans in one request, compare with the tool's seed,
and emit a reviewable diff + a safe saveRefreshedPlans payload.

Method (found 2026-11-21): the results page
  https://www.canstar.com.au/internet/nbn-plans/results/?tV=<base64>&returned=true
is server-rendered: one GET returns every plan (pageSize=500 covers the
full 458 with onlinePartner=false). The tV value is base64 of a query string:
  initialPageSize=500&pageSize=500&onlinePartner=false&sortBy=default
  &sortDir=desc&comparisonId=<any uuid>&nbnSpeed=nbnSpeed12PlusFlt
  &typeInternetPlan=NBN&isModemIncluded=skip&edit=true
A random comparisonId works; no login, no API key, no cookies needed.
nbnSpeed buckets: 12PlusFlt, 50PlusFlt, 100PlusFlt, 500PlusFlt, 750PlusFlt,
1000PlusFlt, 2000PlusFlt (cumulative "X and above", not exact tiers).

Plan cards are server-rendered HTML. This script strips <script>/<style>
(flight data), flattens tags to '|' separators, segments by plan title
("Company| | |Plan Name"), and parses each segment for prices/speeds.
Plan names have a trailing " BYO" stripped (tool convention: BYO/modem
variants are one plan). Variants are deduped on (provider, plan name,
intro price/months, ongoing price), matching the tool's dedup rule.
12 Mbps plans are excluded (user decision 2026-11-21: 12M tier not added).

Usage (from the repo root):
  python3 scripts/canstar_fetch.py [--seed server/src/seed.ts] [--out canstar-out/]
Outputs in --out (default: ./canstar-out/):
  canstar_plans.json        all live rows (detailed)
  canstar_diff.json         changed / unchanged / seed-missing / live-new /
                            rename-candidate lists vs the seed
  canstar_payload_partN.json  saveRefreshedPlans payloads (<=120 plans each)
                            containing ONLY rows that match the seed by
                            (provider, plan_name, tier) -- safe to POST as-is.
                            Everything else needs manual review first:
                            the seed's pre-Canstar rows use different names
                            (e.g. "Kogan Internet / Gold Plus 500"), so
                            posting unmatched live rows would insert
                            duplicates instead of updating.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import date

BASE = "https://www.canstar.com.au/internet/nbn-plans/results/?tV={tv}&returned=true"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
TIERS = [25, 50, 100, 250, 500, 750, 1000, 2000]
MAX_PER_CALL = 120


def build_tv(page_size=500, nbn_speed="nbnSpeed12PlusFlt"):
    state = (
        f"initialPageSize={page_size}&pageSize={page_size}"
        f"&onlinePartner=false&sortBy=default&sortDir=desc"
        f"&comparisonId={uuid.uuid4()}&nbnSpeed={nbn_speed}"
        f"&typeInternetPlan=NBN&isModemIncluded=skip&edit=true"
    )
    return base64.b64encode(state.encode()).decode()


def fetch_html(page_size=500):
    url = BASE.format(tv=build_tv(page_size))
    last_err = None
    for _ in range(3):
        try:
            out = subprocess.run(
                ["curl", "-s", "-m", "120", "-A", UA, url],
                capture_output=True, timeout=150,
            )
            html = out.stdout.decode("utf-8", errors="ignore")
            if len(html) > 1_000_000 and "product-title" in html:
                return html
            last_err = f"short/empty response ({len(html)} bytes)"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
    raise RuntimeError(f"fetch failed after 3 attempts: {last_err}")


def flatten(html):
    s = re.sub(r"<script[\s\S]*?</script>", " ", html)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s)
    s = re.sub(r"<[^>]+>", "|", s)
    return re.sub(r"\|+", "|", s)


TITLE_RE = re.compile(
    r"\|([A-Za-z0-9][A-Za-z0-9'&().+/\- ]{0,50})\| \| \|([A-Za-z0-9][^|]{0,80})\|"
)


def core_name(name):
    return re.sub(r"\s+BYO$", "", name.strip())


def parse_segment(company, name, seg):
    def find(pat):
        m = re.search(pat, seg)
        if not m:
            return None
        for g in m.groups():
            if g is not None:
                return g.strip()
        return None

    tes = find(r"(\d+/\d+)\|,\s*opens glossary for\s*\|typical-evening-download-upload-speed-mbps")
    max_speed = find(r"Max download speed (\d+)Mbps")
    adv = find(r"\$\|([\d.]+)\|,\s*opens glossary for\s*\|advertised-cost")
    adv_sub = find(r"advertised-cost\|Glossary\|([^|]{0,80})")
    equiv = find(r"\$\|([\d.]+)\|,\s*opens glossary for\s*\|equivalent-monthly-cost")
    data = find(r"(Unlimited|\d+\s*GB) data per month")
    contract = find(r"(No lock-in contract|No lock in contract|\d+\s*[- ]month contract)")
    modem = find(r"(Modem at additional cost[^|]{0,60}|Modem included[^|]{0,60})")
    offer = find(r"Go to site\|(?:DISCOUNT\|([^|]{0,160})|SPECIAL OFFER\|([^|]{0,160}))")

    intro_price, intro_months, ongoing = None, 0, None
    if adv is not None:
        intro_price = float(adv)
        ongoing = float(adv)
        if adv_sub:
            m = re.search(r"for (\d+) months?, then \$([\d.]+)/mth", adv_sub)
            if m:
                intro_months = int(m.group(1))
                ongoing = float(m.group(2))
    tes_down = tes_up = None
    if tes:
        tes_down, tes_up = tes.split("/")
    tier = int(max_speed) if max_speed else None
    return {
        "provider": company.strip(),
        "plan_name": core_name(name),
        "canstar_name": name.strip(),
        "tier": tier,
        "intro_price": intro_price,
        "intro_months": intro_months,
        "ongoing_price": ongoing,
        "equiv_monthly": float(equiv) if equiv else None,
        "tes_down": int(tes_down) if tes_down else None,
        "tes_up": int(tes_up) if tes_up else None,
        "max_speed": int(max_speed) if max_speed else None,
        "data": data,
        "contract": contract,
        "modem": modem,
        "offer": offer,
    }


def extract(html):
    text = flatten(html)
    matches = list(TITLE_RE.finditer(text))
    rows, problems = [], []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        row = parse_segment(m.group(1), m.group(2), text[m.start():end])
        if row["intro_price"] is None or row["tier"] is None:
            problems.append((row["provider"], row["plan_name"], "missing price/tier"))
            continue
        if row["tier"] == 12:
            continue  # 12 Mbps tier excluded by user decision
        if row["tier"] not in TIERS:
            problems.append((row["provider"], row["plan_name"], f"tier {row['tier']}"))
            continue
        rows.append(row)
    seen, out = set(), []
    for r in rows:
        key = (r["provider"], r["plan_name"], r["tier"], r["intro_price"],
               r["intro_months"], r["ongoing_price"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out, problems, len(matches)


def load_seed(path):
    """Parse the SEED_PLANS array of server/src/seed.ts, one object at a time."""
    src = open(path, encoding="utf-8").read()
    sec = src.split("SEED_PLANS", 1)[1].split("SEED_HISTORY", 1)[0]
    seed = {}
    for obj in re.finditer(r"\{[^{}]*provider:[^{}]*\}", sec):
        text = obj.group(0)
        def field(pat):
            m = re.search(pat, text)
            return m.group(1) if m else None
        provider = field(r'provider:\s*"([^"]+)"')
        name = field(r'planName:\s*"([^"]+)"')
        tier = field(r'tier:\s*"(\d+)"')
        if not (provider and name and tier):
            continue
        intro = field(r"introPrice:\s*([0-9.]+)")
        months = field(r"introMonths:\s*(\d+)")
        ongoing = field(r"ongoingPrice:\s*([0-9.]+)")
        if ongoing is None:
            continue
        key = (provider, name, int(tier))
        if key not in seed:
            seed[key] = {
                "intro_price": float(intro) if intro else None,
                "intro_months": int(months) if months else 0,
                "ongoing_price": float(ongoing),
            }
    return seed


def to_payload_row(r):
    # saveRefreshedPlans expects tier as a STRING ("50"), like the seed.
    # Every row is stamped with its source so the page can show (and
    # link to) where each price came from.
    row = {
        "provider": r["provider"],
        "plan_name": r["plan_name"],
        "tier": str(r["tier"]),
        "intro_price": r["intro_price"],
        "intro_months": r["intro_months"],
        "ongoing_price": r["ongoing_price"],
        "source": "Canstar",
        "source_url": "https://www.canstar.com.au/internet/nbn-plans/",
    }
    if r["tes_down"] is not None:
        row["tes"] = (f"{r['tes_down']}/{r['tes_up']} Mbps"
                      if r["tes_up"] is not None else f"{r['tes_down']} Mbps")
    note_parts = [p for p in (r["data"], r["contract"], r["modem"], r["offer"]) if p]
    if note_parts:
        row["note"] = "；".join(note_parts)
    return row


def norm_key(provider, plan_name, tier):
    # Case-insensitive: Canstar shows "DODO" / "Amaysim", the seed has
    # "Dodo" / "amaysim" for the same brands. Keep the seed's spelling
    # when posting back so saveRefreshedPlans matches the existing row.
    return (provider.strip().lower(), plan_name.strip().lower(), tier)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="server/src/seed.ts")
    ap.add_argument("--out", default="canstar-out")
    args = ap.parse_args()

    html = fetch_html(500)
    rows, problems, n_titles = extract(html)
    seed = load_seed(args.seed)
    today = date.today().isoformat()

    seed_norm = {norm_key(p, n, t): ((p, n, t), s)
                 for (p, n, t), s in seed.items()}
    live_by_key = {}
    for r in rows:
        live_by_key.setdefault(norm_key(r["provider"], r["plan_name"], r["tier"]),
                               []).append(r)
    changed, unchanged, variant_mismatch, known_exceptions = [], [], [], []
    keep_seed_price = set()
    for nkey, variants in live_by_key.items():
        if nkey not in seed_norm:
            continue
        (seed_key, s) = seed_norm[nkey]
        # seed rows without introPrice are flat plans: intro == ongoing, 0 months
        s_intro = s["intro_price"] if s["intro_price"] is not None else s["ongoing_price"]
        exact = [v for v in variants
                 if v["intro_price"] == s_intro
                 and v["intro_months"] == s["intro_months"]
                 and v["ongoing_price"] == s["ongoing_price"]]
        if exact:
            unchanged.append(seed_key)
        elif len(variants) == 1:
            v = variants[0]
            # Known exception (verified 2026-11-21): DODO's intro prices in
            # the tool are WhistleOut-exclusive and ~$4 below Canstar's
            # standard intro. Same months + same ongoing price means the
            # plan did not change -- keep the seed's intro, do not overwrite.
            if (seed_key[0].lower() == "dodo"
                    and v["intro_months"] == s["intro_months"]
                    and v["ongoing_price"] == s["ongoing_price"]):
                known_exceptions.append({
                    "key": list(seed_key), "seed": s,
                    "live": {k: v[k] for k in
                             ("intro_price", "intro_months", "ongoing_price")},
                    "note": "WhistleOut-exclusive intro price (tool is correct); "
                            "do not overwrite with Canstar's standard intro.",
                })
                unchanged.append(seed_key)
                keep_seed_price.add(nkey)
                continue
            changed.append({"key": list(seed_key), "seed": s,
                            "live": {k: v[k] for k in
                                     ("intro_price", "intro_months", "ongoing_price")}})
        else:
            variant_mismatch.append({
                "key": list(seed_key), "seed": s,
                "live_variants": [{k: v[k] for k in
                                   ("intro_price", "intro_months", "ongoing_price",
                                    "tes_down", "tes_up")} for v in variants],
            })
    seed_missing = sorted(set(seed) - {k for (k, _) in seed_norm.values()
                                       if norm_key(*k) in live_by_key})
    # Live variants vs seed rows that are themselves missing from the live
    # data: a rename candidate when provider+tier+prices match exactly
    # (same plan under a different name, e.g. the tool's "Kogan Internet /
    # Gold Plus 500" vs Canstar's display name, or a " BYO" seed row whose
    # live twin was stripped to the core name). Provider comparison is
    # case-insensitive ("Dodo" vs "DODO").
    seed_by_price_missing = {}
    for k in seed_missing:
        s = seed[k]
        s_intro = s["intro_price"] if s["intro_price"] is not None else s["ongoing_price"]
        seed_by_price_missing[(k[0].lower(), k[2], s_intro, s["intro_months"],
                               s["ongoing_price"])] = k
    rename_candidates, seen_rename = [], set()
    for nkey, variants in live_by_key.items():
        for v in variants:
            price_key = (v["provider"].lower(), v["tier"], v["intro_price"],
                         v["intro_months"], v["ongoing_price"])
            target = seed_by_price_missing.get(price_key)
            if target is not None and norm_key(*target) != nkey:
                pair = (nkey, norm_key(*target))
                if pair not in seen_rename:
                    seen_rename.add(pair)
                    rename_candidates.append({"live_key": list((v["provider"], v["plan_name"], v["tier"])),
                                              "seed_key": list(target)})
    renamed_live_keys = {norm_key(*c["live_key"]) for c in rename_candidates}
    live_new = [list((variants[0]["provider"], variants[0]["plan_name"],
                      variants[0]["tier"]))
                for nkey, variants in live_by_key.items()
                if nkey not in seed_norm and nkey not in renamed_live_keys]

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "canstar_plans.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    diff = {
        "checked_date": today,
        "live_rows": len(rows),
        "seed_rows": len(seed),
        "matched": len(changed) + len(unchanged),
        "changed": changed,
        "known_exceptions": known_exceptions,
        "variant_mismatch": variant_mismatch,
        "unchanged_count": len(unchanged),
        "seed_missing": [list(k) for k in seed_missing],
        "live_new": live_new,
        "rename_candidates": rename_candidates,
        "parse_problems": problems,
    }
    with open(os.path.join(args.out, "canstar_diff.json"), "w", encoding="utf-8") as f:
        json.dump(diff, f, ensure_ascii=False, indent=1)
    # Payload: matched rows only (unchanged + single-variant changes).
    # Multi-variant mismatches are left out for manual review.
    # Provider/plan names use the SEED's spelling so saveRefreshedPlans
    # matches the existing row.
    matched_rows = []
    for nkey, variants in live_by_key.items():
        if nkey not in seed_norm:
            continue
        (seed_key, s) = seed_norm[nkey]
        s_intro = s["intro_price"] if s["intro_price"] is not None else s["ongoing_price"]
        exact = [v for v in variants
                 if v["intro_price"] == s_intro
                 and v["intro_months"] == s["intro_months"]
                 and v["ongoing_price"] == s["ongoing_price"]]
        pick = exact[0] if exact else (variants[0] if len(variants) == 1 else None)
        if pick is None:
            continue
        row = dict(pick)
        row["provider"], row["plan_name"] = seed_key[0], seed_key[1]
        if nkey in keep_seed_price:
            # known exception: keep the seed's (correct) intro price
            row["intro_price"] = s_intro
            row["intro_months"] = s["intro_months"]
            row["ongoing_price"] = s["ongoing_price"]
        matched_rows.append(row)
    for i in range(0, len(matched_rows), MAX_PER_CALL):
        part = matched_rows[i:i + MAX_PER_CALL]
        payload = {"checked_date": today,
                   "plans": [to_payload_row(r) for r in part]}
        with open(os.path.join(args.out, f"canstar_payload_part{i // MAX_PER_CALL + 1}.json"),
                  "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)

    # verify 12-month averages against Canstar's equivalent monthly cost
    bad = sum(
        1 for r in rows if r["equiv_monthly"] is not None and abs(
            round((r["intro_price"] * r["intro_months"]
                   + r["ongoing_price"] * (12 - r["intro_months"])) / 12, 2)
            - r["equiv_monthly"]) > 0.51
    )
    print(f"titles: {n_titles}, live rows: {len(rows)}, seed rows: {len(seed)}")
    print(f"matched: {len(changed) + len(unchanged)} "
          f"(changed: {len(changed)}, known_exceptions: {len(known_exceptions)}, "
          f"variant_mismatch: {len(variant_mismatch)}, "
          f"unchanged: {len(unchanged)})")
    print(f"seed rows not in live data: {len(seed_missing)}")
    print(f"live rows not in seed: {len(live_new)} "
          f"(rename candidates: {len(rename_candidates)})")
    print(f"12-month-average mismatches: {bad}, parse problems: {len(problems)}")
    for c in changed:
        print("  CHANGED:", c["key"], "seed", c["seed"], "-> live", c["live"])
    for c in known_exceptions:
        print("  KNOWN EXCEPTION:", c["key"], "seed", c["seed"],
              "-> live", c["live"], "-", c["note"])
    for c in variant_mismatch:
        print("  VARIANT MISMATCH:", c["key"], "seed", c["seed"],
              "-> live", c["live_variants"])
    print(f"wrote {args.out}/canstar_plans.json, canstar_diff.json, "
          f"canstar_payload_part*.json "
          f"({(len(matched_rows) + MAX_PER_CALL - 1) // MAX_PER_CALL} parts)")


if __name__ == "__main__":
    main()
