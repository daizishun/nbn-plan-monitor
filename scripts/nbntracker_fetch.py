#!/usr/bin/env python3
"""Pull nbntracker-data (GitHub), compare with the tool's seed, and emit a
reviewable diff + a safe saveRefreshedPlans payload.

Source: https://github.com/springupsoftware/nbntracker-data — the plan
database behind https://nbntracker.au. Public repo, CC BY-SA 4.0, scraped
daily (~02:05 UTC). Data is CUE files: one <slug>_plans.cue per provider
plus a schema.cue. Plans carry name / speed_tier / download+upload Mbps /
monthly_price / optional promo {price, months, end_date} / optional
data_cap_gb / technology / cis_url (link to the provider's CIS document).

Scope: residential fixed-line only, the tool's 8 tiers
(25/50/100/250/500/750/1000/2000). Excluded: technology satellite /
nbn-fw / 5g / 4g, plan names containing "Business", tiers NBN12/NBN400.

Parsing warning: do NOT strip // comments with a regex. cis_url values
contain "https://", and stripping from // to end-of-line eats the closing
quote and breaks all brace counting after it (this silently dropped most
rows in the first attempt). This script uses a brace-balanced,
string-aware struct splitter instead (see extract_structs).

Usage (from the repo root):
  python3 scripts/nbntracker_fetch.py [--seed server/src/seed.ts]
      [--repo /tmp/nbntracker-data] [--out nbntracker-out/]
The repo is cloned to --repo on first run and git-pulled on later runs;
if the pull fails (e.g. offline) the script continues with the local copy
and says so.
Outputs in --out (default: ./nbntracker-out/):
  nbntracker_plans.json      all live rows (detailed, in-scope only)
  nbntracker_diff.json       changed / unchanged / seed-missing / live-new /
                             rename-candidate lists vs the seed
  nbntracker_payload_partN.json  saveRefreshedPlans payloads (<=120 plans
                             each) containing ONLY rows that match the seed
                             by (provider, plan_name, tier) -- safe to POST
                             as-is. Everything else needs manual review
                             first: nbntracker's plan names differ from the
                             seed's (e.g. "100/20Mbps" vs "NBN 100"), so
                             posting unmatched live rows would insert
                             duplicates instead of updating.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
from datetime import date

REPO_URL = "https://github.com/springupsoftware/nbntracker-data.git"
REPO_PAGE = "https://github.com/springupsoftware/nbntracker-data"
TIERS = [25, 50, 100, 250, 500, 750, 1000, 2000]
MAX_PER_CALL = 120
# nbntracker's <slug>.cue display names that differ from the seed's
# provider spelling (matching only; payloads always use the seed's spelling).
PROVIDER_ALIASES = {
    "tangerine telecom": "tangerine",
    "more telecom": "more",
    "origin energy": "origin",
}


def sync_repo(repo_dir):
    """Clone the repo if missing, else pull. Returns the HEAD sha (or None)."""
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        print(f"cloning {REPO_URL} into {repo_dir} ...")
        r = subprocess.run(["git", "clone", "-q", REPO_URL, repo_dir],
                           capture_output=True, timeout=300)
        if r.returncode != 0:
            raise RuntimeError("git clone failed: "
                               + r.stderr.decode("utf-8", errors="ignore"))
    else:
        r = subprocess.run(["git", "-C", repo_dir, "pull", "--ff-only", "-q"],
                           capture_output=True, timeout=300)
        if r.returncode != 0:
            print("WARNING: git pull failed ("
                  + r.stderr.decode("utf-8", errors="ignore").strip()
                  + "); continuing with the local copy", file=sys.stderr)
    r = subprocess.run(["git", "-C", repo_dir, "rev-parse", "HEAD"],
                       capture_output=True, timeout=30)
    return r.stdout.decode().strip() or None


def extract_structs(body):
    """Yield top-level {...} blocks (brace-balanced, string-aware).

    Do NOT pre-strip // comments: cis_url values contain "https://",
    and stripping from // to end-of-line eats the closing quote, which
    flips the in-string state and silently drops every row after it.
    """
    structs, i, n = [], 0, len(body)
    while i < n:
        if body[i] == "{":
            depth, j, in_str = 0, i, False
            while j < n:
                ch = body[j]
                if ch == '"' and body[j - 1] != "\\":
                    in_str = not in_str
                if not in_str:
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            structs.append(body[i:j + 1])
                            i = j
                            break
                j += 1
        i += 1
    return structs


def parse_plans_file(path, provider_name):
    slug = os.path.basename(path).replace("_plans.cue", "")
    text = open(path, encoding="utf-8").read()
    m = re.search(re.escape(slug) + r"\s*:\s*\[", text)
    if not m:
        return []
    body = text[m.end():]
    plans = []
    for s in extract_structs(body):
        def f(pat):
            r = re.search(pat, s)
            return r.group(1) if r else None
        name = f(r'name:\s*"([^"]+)"')
        tier = f(r'speed_tier:\s*"(NBN\d+)"')
        price = f(r'monthly_price:\s*([0-9.]+)')
        if not name or not tier or not price:
            continue
        tier_n = int(tier.replace("NBN", ""))
        if tier_n not in TIERS:
            continue  # NBN12 / NBN400 are outside the tool's 8 tiers
        tech = f(r'technology:\s*"([^"]+)"')
        if tech is not None and tech != "nbn":
            continue  # satellite / fixed-wireless / 5g / 4g
        if "business" in name.lower():
            continue  # business plans, not residential
        promo = {}
        pm = re.search(r"promo:\s*\{([^{}]*)\}", s)
        if pm:
            pb = pm.group(1)
            pm_price = re.search(r"price:\s*([0-9.]+)", pb)
            pm_months = re.search(r"months:\s*(\d+)", pb)
            pm_end = re.search(r'end_date:\s*"([^"]+)"', pb)
            promo["price"] = float(pm_price.group(1)) if pm_price else None
            promo["months"] = int(pm_months.group(1)) if pm_months else None
            promo["end_date"] = pm_end.group(1) if pm_end else None
        down = f(r"download_mbps:\s*(\d+)")
        up = f(r"upload_mbps:\s*(\d+)")
        cap = f(r"data_cap_gb:\s*(\d+)")
        cis = f(r'cis_url:\s*"([^"]+)"')
        plans.append({
            "provider": provider_name,
            "plan_name": name,
            "tier": tier_n,
            "intro_price": promo.get("price"),
            "intro_months": promo.get("months") or 0,
            "ongoing_price": float(price),
            "promo_end": promo.get("end_date"),
            "tes_down": int(down) if down else None,
            "tes_up": int(up) if up else None,
            "max_speed": int(down) if down else None,
            "data": f"{cap}GB" if cap else "Unlimited",
            "cis_url": cis,
        })
    return plans


def load_provider_names(repo_dir):
    names = {}
    for path in sorted(glob.glob(os.path.join(repo_dir, "*.cue"))):
        base = os.path.basename(path)
        if base.endswith("_plans.cue") or base == "schema.cue":
            continue
        text = open(path, encoding="utf-8").read()
        m = re.search(r'name:\s*"([^"]+)"', text)
        if m:
            names[base[:-4]] = m.group(1)
    return names


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


def norm_key(provider, plan_name, tier):
    # Case-insensitive, with provider aliases so nbntracker's display
    # names ("Tangerine Telecom") match the seed's ("Tangerine").
    # Payloads always use the SEED's spelling, so saveRefreshedPlans
    # matches the existing row.
    p = provider.strip().lower()
    p = PROVIDER_ALIASES.get(p, p)
    return (p, plan_name.strip().lower(), tier)


def to_payload_row(r, stamp_source=True):
    # saveRefreshedPlans expects tier as a STRING ("50"), like the seed.
    # Every row is stamped with its source so the page can show (and
    # link to) where each price came from: the plan's CIS document when
    # the scraper recorded one, else the data repo itself.
    # Known-exception rows (stamp_source=False) carry no source fields:
    # their price was NOT verified by this source, so the existing source
    # must stay untouched (saveRefreshedPlans keeps it when omitted).
    row = {
        "provider": r["provider"],
        "plan_name": r["plan_name"],
        "tier": str(r["tier"]),
        "ongoing_price": r["ongoing_price"],
    }
    # Flat plans (no promo) omit intro_price/intro_months entirely: the
    # zod schema's .optional() accepts a missing key but rejects an
    # explicit null, and the handler stores a missing intro as NULL
    # (the seed's flat-plan representation).
    if r["intro_price"] is not None:
        row["intro_price"] = r["intro_price"]
        row["intro_months"] = r["intro_months"] or 0
    if stamp_source:
        row["source"] = "nbntracker-data"
        row["source_url"] = r["cis_url"] or REPO_PAGE
    # NOTE: no tes here on purpose. nbntracker's download/upload_mbps are
    # the plan's MAX speeds, but the seed's tes is the TYPICAL EVENING
    # speed -- different quantities. Writing max speeds into tes would
    # corrupt it (e.g. Optus Fast "500/43 Mbps" would become "500/100
    # Mbps") and would also flag rows "updated" for a tes-only difference
    # even though no price changed. The live speeds stay in
    # nbntracker_plans.json for reference; saveRefreshedPlans keeps the
    # stored tes when the payload omits it.
    # promo_end only for rows this source actually verified: a known
    # exception's live end_date belongs to the standard promo, not to the
    # seed's (different) promo price, so it must not be applied to it.
    if stamp_source and r.get("promo_end"):
        row["promo_end"] = r["promo_end"]
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="server/src/seed.ts")
    ap.add_argument("--repo", default="/tmp/nbntracker-data")
    ap.add_argument("--out", default="nbntracker-out")
    args = ap.parse_args()

    head = sync_repo(args.repo)
    names = load_provider_names(args.repo)
    rows, problems = [], []
    for path in sorted(glob.glob(os.path.join(args.repo, "*_plans.cue"))):
        slug = os.path.basename(path).replace("_plans.cue", "")
        rows.extend(parse_plans_file(path, names.get(slug, slug)))
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
        # seed rows without introPrice are flat plans: intro == ongoing, 0 months.
        # Same for live rows: a missing promo means flat (intro == ongoing).
        s_intro = s["intro_price"] if s["intro_price"] is not None else s["ongoing_price"]
        def v_price(v):
            v_intro = v["intro_price"] if v["intro_price"] is not None else v["ongoing_price"]
            return (v_intro, v["intro_months"] or 0, v["ongoing_price"])
        exact = [v for v in variants
                 if v_price(v) == (s_intro, s["intro_months"], s["ongoing_price"])]
        if exact:
            unchanged.append(seed_key)
        elif len(variants) == 1:
            v = variants[0]
            v_intro, v_months, v_ongoing = v_price(v)
            # Known exception (verified 2026-11-21): DODO's intro prices in
            # the tool are WhistleOut-exclusive and ~$4 below nbntracker's
            # standard intro. Same months + same ongoing price means the
            # plan did not change -- keep the seed's intro, do not overwrite.
            if (seed_key[0].lower() == "dodo"
                    and v_months == s["intro_months"]
                    and v_ongoing == s["ongoing_price"]):
                known_exceptions.append({
                    "key": list(seed_key), "seed": s,
                    "live": {"intro_price": v_intro, "intro_months": v_months,
                             "ongoing_price": v_ongoing},
                    "note": "WhistleOut-exclusive intro price (tool is correct); "
                            "do not overwrite with the standard intro.",
                })
                unchanged.append(seed_key)
                keep_seed_price.add(nkey)
                continue
            # Known exception: the live source lists this plan flat while
            # the seed carries a promo (e.g. a Black Friday price the
            # scraper does not capture). Same ongoing price means the plan
            # did not change -- the promo is missing from the live source,
            # not ended. Keep the seed's promo, do not overwrite.
            if (v["intro_price"] is None
                    and s["intro_price"] is not None
                    and s["intro_price"] != s["ongoing_price"]
                    and v_ongoing == s["ongoing_price"]):
                known_exceptions.append({
                    "key": list(seed_key), "seed": s,
                    "live": {"intro_price": v_intro, "intro_months": v_months,
                             "ongoing_price": v_ongoing},
                    "note": "Live source lists this plan flat; the seed's promo "
                            "is not in the live data (not necessarily ended). "
                            "Keep the seed's promo, do not overwrite.",
                })
                unchanged.append(seed_key)
                keep_seed_price.add(nkey)
                continue
            changed.append({"key": list(seed_key), "seed": s,
                            "live": {"intro_price": v_intro, "intro_months": v_months,
                                     "ongoing_price": v_ongoing}})
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
    # (same plan under a different name, e.g. the tool's "NBN 100" vs
    # nbntracker's "100/20Mbps"). Provider comparison is case-insensitive
    # (with the aliases above) and uses the seed's spelling for the target.
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
    with open(os.path.join(args.out, "nbntracker_plans.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    diff = {
        "checked_date": today,
        "repo_head": head,
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
    with open(os.path.join(args.out, "nbntracker_diff.json"), "w", encoding="utf-8") as f:
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
        def v_price(v):
            v_intro = v["intro_price"] if v["intro_price"] is not None else v["ongoing_price"]
            return (v_intro, v["intro_months"] or 0, v["ongoing_price"])
        exact = [v for v in variants
                 if v_price(v) == (s_intro, s["intro_months"], s["ongoing_price"])]
        pick = exact[0] if exact else (variants[0] if len(variants) == 1 else None)
        if pick is None:
            continue
        row = dict(pick)
        row["provider"], row["plan_name"] = seed_key[0], seed_key[1]
        if nkey in keep_seed_price:
            # known exception: keep the seed's (correct) intro price, and
            # do NOT stamp this source on the row (its price was not
            # verified by this source) -- to_payload_row omits the source
            # fields, so saveRefreshedPlans keeps the existing ones.
            row["intro_price"] = s_intro
            row["intro_months"] = s["intro_months"]
            row["ongoing_price"] = s["ongoing_price"]
            row["_stamp_source"] = False
        matched_rows.append(row)
    for i in range(0, len(matched_rows), MAX_PER_CALL):
        part = matched_rows[i:i + MAX_PER_CALL]
        payload = {"checked_date": today,
                   "plans": [to_payload_row(r, stamp_source=r.pop("_stamp_source", True))
                             for r in part]}
        with open(os.path.join(args.out, f"nbntracker_payload_part{i // MAX_PER_CALL + 1}.json"),
                  "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"repo head: {head}, live rows: {len(rows)}, seed rows: {len(seed)}")
    print(f"matched: {len(changed) + len(unchanged)} "
          f"(changed: {len(changed)}, known_exceptions: {len(known_exceptions)}, "
          f"variant_mismatch: {len(variant_mismatch)}, "
          f"unchanged: {len(unchanged)})")
    print(f"seed rows not in live data: {len(seed_missing)}")
    print(f"live rows not in seed: {len(live_new)} "
          f"(rename candidates: {len(rename_candidates)})")
    print(f"parse problems: {len(problems)}")
    for c in changed:
        print("  CHANGED:", c["key"], "seed", c["seed"], "-> live", c["live"])
    for c in known_exceptions:
        print("  KNOWN EXCEPTION:", c["key"], "seed", c["seed"],
              "-> live", c["live"], "-", c["note"])
    for c in variant_mismatch:
        print("  VARIANT MISMATCH:", c["key"], "seed", c["seed"],
              "-> live", c["live_variants"])
    print(f"wrote {args.out}/nbntracker_plans.json, nbntracker_diff.json, "
          f"nbntracker_payload_part*.json "
          f"({(len(matched_rows) + MAX_PER_CALL - 1) // MAX_PER_CALL} parts)")


if __name__ == "__main__":
    main()
