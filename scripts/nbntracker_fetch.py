#!/usr/bin/env python3
"""Pull nbntracker-data (GitHub), compare with the tool's seed, and emit a
reviewable diff + an updated seed candidate (seed_new.ts).

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
                             rename-candidate lists vs the seed, plus the
                             seed-candidate summary (which rows the candidate
                             updates/adds, which it leaves alone)
  seed_new.ts                updated seed CANDIDATE (same format as
                             server/src/seed.ts): verified price changes,
                             new rows, promoEnd fills, source/source_url and
                             checked dates. Known exceptions, multi-variant
                             mismatches and rename candidates are NOT
                             applied -- they are flagged in
                             nbntracker_diff.json and keep their seed values.
                             Review the diff, then replace server/src/seed.ts
                             with this file and push.
  --verify runs a two-stage temp-DB check of the candidate (current seed
  into a fresh DB, then the candidate into the same DB -- the weekly
  update path): planCount, updated prices + "updated" stamps, new rows
  and provider website URLs.
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
# nbntracker's <slug>.cue display names that differ from the seed's
# provider spelling (matching only; candidate updates always use the seed's spelling).
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
        if "fixed wireless" in name.lower():
            continue  # fixed-wireless plans, not fixed-line residential.
            # The technology field is missing for some providers
            # (SpinTel, IT'S FUBAR), so the name is the backstop.
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
    # Candidate updates always use the SEED's spelling, so they match
    # the existing row.
    p = provider.strip().lower()
    p = PROVIDER_ALIASES.get(p, p)
    return (p, plan_name.strip().lower(), tier)


# ---- seed candidate generation -------------------------------------------
# The standalone tool has no price-update interfaces: the seed file
# (server/src/seed.ts) is the only data source. This script therefore
# outputs an updated seed CANDIDATE (seed_new.ts, same format as seed.ts)
# plus a diff report. The maintainer reviews the diff report, then
# replaces server/src/seed.ts with the candidate and pushes to GitHub.
# Doubtful prices are NEVER overwritten in the candidate: known
# exceptions, multi-variant mismatches and rename candidates are flagged
# in the diff report and keep their seed values.

SEED_FIELD_ORDER = ["provider", "planName", "tier", "speedDown", "speedUp",
    "introPrice", "introMonths", "ongoingPrice", "tes", "dataAllowance",
    "contract", "category", "source", "sourceUrl", "checkedDate", "promoEnd", "note"]
SEED_STRING_FIELDS = {"provider", "planName", "tier", "tes", "dataAllowance",
    "contract", "category", "source", "sourceUrl", "checkedDate", "promoEnd", "note"}
SEED_NUM_FIELDS = {"speedDown", "speedUp", "introPrice", "introMonths", "ongoingPrice"}


def unescape_ts(s):
    """Undo TS double-quoted escapes (only needed for comparing names)."""
    return (s.replace("\\'", "'").replace('\\"', '"')
             .replace("\\\\", "\\"))


def ts_str(s):
    """Escape a plain string for a TS double-quoted literal (same style as
    the seed file: backslash and single quote escaped)."""
    return s.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')


def parse_seed_row(text):
    """Parse one seed row literal into a dict. String values are kept raw
    (with their TS escapes intact, e.g. IT\\'S FUBAR) so re-emitting is
    lossless; numeric values become int/float."""
    row = {}
    for f in SEED_STRING_FIELDS:
        m = re.search(rf'{f}:\s*"((?:[^"\\]|\\.)*)"', text)
        if m:
            row[f] = m.group(1)
    for f in SEED_NUM_FIELDS:
        m = re.search(rf'{f}:\s*([0-9.]+|null)', text)
        if m:
            row[f] = None if m.group(1) == "null" else (
                float(m.group(1)) if "." in m.group(1) else int(m.group(1)))
    return row


def fmt_num(v):
    return repr(v) if isinstance(v, float) else str(v)


def emit_seed_row(row):
    """Emit a seed row literal in the canonical field order. Fields that
    are None/absent are omitted (flat plans omit introPrice/introMonths,
    like the seed file). String values must already be file-ready
    (raw from parse_seed_row, or escaped with ts_str for new rows)."""
    parts = []
    for f in SEED_FIELD_ORDER:
        if f not in row or row[f] is None:
            continue
        v = row[f]
        if f in SEED_STRING_FIELDS:
            parts.append(f'{f}: "{v}"')
        else:
            parts.append(f'{f}: {fmt_num(v)}')
    return "{ " + ", ".join(parts) + " }"


def seed_plans_rows(text):
    """Parse the SEED_PLANS array of a seed file into row dicts, using the
    array's own [ ... ]; bounds -- not a text split on SEED_HISTORY, which
    would also catch the SeedHistory interface sitting between the two."""
    plans_kw = text.index("SEED_PLANS")
    arr_start = text.index("[", plans_kw)
    arr_end = text.index("];", arr_start)
    sec = text[arr_start:arr_end]
    return [parse_seed_row(m.group(0)) for m in
            re.finditer(r"\{[^{}]*provider:[^{}]*\}", sec)]


def build_seed_candidate(seed_path, updates, new_rows, today, script_name):
    """Apply updates and new rows to the seed file and write the candidate.

    updates: dict (provider, plan_name, tier) -> dict of seed-field
        overrides (seed field names; string values already file-ready).
        Keys use the SEED's provider/plan spelling, tier as int.
    new_rows: list of full seed-row dicts (file-ready strings).
    Returns (candidate_text, stats) where stats has row counts.
    The candidate is returned as text; the caller writes it to seed_new.ts.
    """
    # Normalise update keys the same way row_key does below (unescaped,
    # lowercased provider/plan, int tier) -- the scripts pass seed-spelling
    # keys, which would otherwise never match a parsed row.
    updates = {(unescape_ts(p).strip().lower(),
                unescape_ts(n).strip().lower(), int(t)): v
               for (p, n, t), v in updates.items()}
    src = open(seed_path, encoding="utf-8").read()
    plans_kw = src.index("SEED_PLANS")
    arr_start = src.index("[", plans_kw)
    arr_end = src.index("];", arr_start)
    sec = src[arr_start:arr_end]
    rows = []
    for m in re.finditer(r"\{[^{}]*provider:[^{}]*\}", sec):
        rows.append({"span": (m.start(), m.end()),
                     "dict": parse_seed_row(m.group(0))})

    def row_key(d):
        return (unescape_ts(d.get("provider", "")).strip().lower(),
                unescape_ts(d.get("planName", "")).strip().lower(),
                int(d["tier"]) if "tier" in d else None)

    # Edits on the section text, applied last-to-first so offsets stay valid.
    # (offset, length, replacement)
    edits = []
    updated_count = 0
    for r in rows:
        k = row_key(r["dict"])
        if k in updates:
            d = dict(r["dict"])
            d.update(updates[k])
            edits.append((r["span"][0], r["span"][1] - r["span"][0],
                          emit_seed_row(d)))
            updated_count += 1
    # New rows: append after the last row of their tier.
    by_tier = {}
    for r in rows:
        by_tier.setdefault(int(r["dict"]["tier"]), []).append(r)
    # line end offset for a span end inside the section
    def line_end(pos):
        nl = sec.find("\n", pos)
        return len(sec) if nl == -1 else nl
    added_count = 0
    for d in new_rows:
        tier = int(d["tier"])
        lines = ["  " + emit_seed_row(d) + ","]
        if tier in by_tier:
            last = by_tier[tier][-1]
            edits.append((line_end(last["span"][1]), 0, "\n" + "\n".join(lines)))
        else:
            # tier with no rows yet: insert just before the closing "];"
            edits.append((len(sec.rstrip()), 0, "\n" + "\n".join(lines)))
        added_count += 1
    for off, length, rep in sorted(edits, reverse=True):
        sec = sec[:off] + rep + sec[off + length:]
    out = src[:arr_start] + sec + src[arr_end:]
    # New seed version (the date this candidate was generated) and counts.
    out = re.sub(r'(export const SEED_VERSION = )"[^"]+"',
                 rf'\g<1>"{today}"', out, count=1)
    total_rows = len(rows) + added_count
    provs = set()
    for r in rows:
        provs.add(unescape_ts(r["dict"].get("provider", "")).strip().lower())
    for d in new_rows:
        provs.add(unescape_ts(d["provider"]).strip().lower())
    out = re.sub(r"(\d+) plans, (\d+) providers",
                 f"{total_rows} plans, {len(provs)} providers", out, count=1)
    notice = (f"// CANDIDATE SEED — generated by scripts/{script_name} on "
              f"{today}. Review the diff report before replacing "
              f"server/src/seed.ts with this file.\n")
    out = notice + out
    stats = {"seed_rows": len(rows), "updated": updated_count,
             "added": added_count, "candidate_rows": total_rows,
             "candidate_providers": len(provs)}
    return out, stats


def filter_new_rows(seed, live_rows, provider_norm):
    """Drop live rows the server's dedupePlans would remove: a row whose
    (normalised provider, tier, intro, months, ongoing) matches an
    existing seed row is the same plan under a different name, not a new
    plan -- adding it would only be deleted again on seed. Returns
    (kept, dropped). live_rows are dicts with provider/tier/intro_price/
    intro_months/ongoing_price."""
    def key(provider, tier, intro, months, ongoing):
        if intro is None or (intro == ongoing and not months):
            intro_k, months_k = "flat", 0
        else:
            intro_k, months_k = intro, months or 0
        return (provider_norm(provider), str(tier), intro_k, months_k, ongoing)
    seed_keys = {key(p, t, s["intro_price"], s["intro_months"], s["ongoing_price"])
                 for (p, n, t), s in seed.items()}
    kept, dropped, seen = [], [], set()
    for v in live_rows:
        k = key(v["provider"], v["tier"], v["intro_price"],
                v["intro_months"], v["ongoing_price"])
        if k in seed_keys or k in seen:
            dropped.append(v)
        else:
            seen.add(k)
            kept.append(v)
    return kept, dropped


def norm_provider_key(name):
    """Same rule as the server's normProviderKey (actions.ts)."""
    return re.sub(r"\s+(internet|telecom|mobile|broadband)$", "",
                  re.sub(r"\s+", " ", name.strip().lower()))


def expected_plan_count(seed_row_dicts):
    """Simulate the server's dedupePlans: rows that share brand (normalised),
    tier and every price figure are stored once. Returns the planCount
    seedPlans would report for the given seed rows."""
    seen = set()
    for d in seed_row_dicts:
        intro = d.get("introPrice")
        key = (norm_provider_key(unescape_ts(d.get("provider", ""))),
               str(d["tier"]),
               "flat" if intro is None else intro,
               d.get("introMonths") or 0,
               d.get("ongoingPrice"))
        seen.add(key)
    return len(seen)


def call_action(port, action, args):
    """POST one action to a running server; returns the parsed JSON."""
    import urllib.request
    import urllib.error
    body = json.dumps({"action": action, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/actions", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{action} -> HTTP {e.code}: "
                           + e.read().decode("utf-8", errors="ignore"))
    if "error" in body:
        raise RuntimeError(f"{action} -> error: {body['error']}")
    # /actions wraps the handler result in {"data": ...}
    return body.get("data", body)


def verify_candidate(seed_path, candidate_path, updates, new_rows, today):
    """Two-stage temp-DB verification of a seed candidate:
    1. copy the repo to a temp dir, start the server with the CURRENT seed,
       seedPlans (fresh DB) -> baseline;
    2. swap in the candidate, seedPlans again -> the weekly-update path:
       changed rows must carry the new prices and be stamped "updated",
       new rows must be present, planCount must match the dedupe
       simulation, every plan provider must have a websiteUrl.
    Returns a dict of check results (raises on failure)."""
    import shutil
    import tempfile
    import time
    seed_abs = os.path.abspath(seed_path)
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(seed_abs)))
    tmp = tempfile.mkdtemp(prefix="nbn-verify-")
    port = 31981 + (os.getpid() % 100)
    proc = None
    try:
        shutil.copytree(repo_root, tmp, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(
                            ".git", "node_modules", "*-out", "server/dist",
                            "client/dist", "app.db", "__pycache__",
                            ".DS_Store"))
        os.symlink(os.path.join(repo_root, "node_modules"),
                   os.path.join(tmp, "node_modules"))
        env = dict(os.environ, PORT=str(port),
                   DATABASE_PATH=os.path.join(tmp, "verify.db"))

        def start_server():
            p = subprocess.Popen(
                ["bun", "server/src/index.ts"], cwd=tmp, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.time() + 60
            while True:
                try:
                    import urllib.request
                    with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}/health", timeout=2) as r:
                        if r.status == 200:
                            return p
                except Exception:
                    if time.time() > deadline:
                        raise RuntimeError("server did not come up in 60s")
                    time.sleep(0.5)

        def stop_server(p):
            if p is None:
                return
            p.terminate()
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()

        # Stage 1: current seed into a fresh DB.
        proc = start_server()
        s1 = call_action(port, "seedPlans", {})
        # Stage 2: candidate seed, same DB (the weekly-update path). Bun
        # loads seed.ts once at startup, so the server must be RESTARTED
        # with the candidate -- a redeploy, not a file swap under a live
        # process.
        stop_server(proc)
        shutil.copyfile(candidate_path,
                        os.path.join(tmp, "server/src/seed.ts"))
        proc = start_server()
        s2 = call_action(port, "seedPlans", {})
        state = call_action(port, "getState", {})
        # Expected counts from the candidate file itself.
        cand_rows = seed_plans_rows(
            open(candidate_path, encoding="utf-8").read())
        expected = expected_plan_count(cand_rows)
        by_key = {}
        for p in state["plans"]:
            by_key[(p["provider"].strip().lower(),
                    p["planName"].strip().lower(), int(p["tier"]))] = p
        checks = {"stage1_planCount": s1.get("planCount"),
                  "stage2_planCount": s2.get("planCount"),
                  "expected_planCount": expected,
                  "updated_ok": 0, "updated_bad": [],
                  "added_ok": 0, "added_missing": [],
                  "providers_without_url": []}
        for (prov, name, tier), ov in updates.items():
            p = by_key.get((prov.strip().lower(), name.strip().lower(), tier))
            if p is not None:
                ok = True
                if "introPrice" in ov and p["introPrice"] != ov["introPrice"]:
                    ok = False
                if "introMonths" in ov and p["introMonths"] != ov["introMonths"]:
                    ok = False
                if "ongoingPrice" in ov and p["ongoingPrice"] != ov["ongoingPrice"]:
                    ok = False
                if ok and p["lastRefreshStatus"] != "updated":
                    ok = False
                if ok:
                    checks["updated_ok"] += 1
                    continue
                checks["updated_bad"].append(
                    [prov, name, tier, p["introPrice"], p["introMonths"],
                     p["ongoingPrice"], p["lastRefreshStatus"]])
                continue
            # Not found by name: the update may have made this row identical
            # (brand+tier+prices) to another seed row, so the server's
            # dedupe kept the other name. The price change still counts if
            # some row for the same brand+tier now carries the new prices
            # (the displayed price was already that value via the other
            # row, so its "unchanged" status is correct).
            want_intro = ov.get("introPrice")
            want_months = ov.get("introMonths") or 0
            want_ongoing = ov.get("ongoingPrice")
            found = None
            for q in state["plans"]:
                if (norm_provider_key(q["provider"]) == norm_provider_key(prov)
                        and int(q["tier"]) == tier
                        and q["introPrice"] == want_intro
                        and (q["introMonths"] or 0) == want_months
                        and q["ongoingPrice"] == want_ongoing):
                    found = q
                    break
            if found is not None:
                checks.setdefault("updated_via_dedupe", []).append(
                    [prov, name, tier, "kept as", found["planName"]])
                checks["updated_ok"] += 1
            else:
                checks["updated_bad"].append([prov, name, tier, "missing"])
        for d in new_rows:
            p = by_key.get((unescape_ts(d["provider"]).strip().lower(),
                            unescape_ts(d["planName"]).strip().lower(),
                            int(d["tier"])))
            if p is None:
                checks["added_missing"].append(
                    [d["provider"], d["planName"], d["tier"]])
            else:
                checks["added_ok"] += 1
        # Same normalisation as the client's providerUrl lookup
        # (normProviderKey): "Kogan Internet" matches "Kogan", "Moose"
        # matches "Moose Mobile", etc. -- an exact name match is too strict.
        url_by_name = {norm_provider_key(p["name"]): p["websiteUrl"]
                       for p in state["providers"]}
        for p in state["plans"]:
            if not url_by_name.get(norm_provider_key(p["provider"])):
                checks["providers_without_url"].append(p["provider"])
        checks["providers_without_url"] = sorted(set(checks["providers_without_url"]))
        if (s2.get("planCount") != expected or checks["updated_bad"]
                or checks["added_missing"] or checks["providers_without_url"]):
            raise RuntimeError("verification failed: " + json.dumps(checks))
        return checks
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="server/src/seed.ts")
    ap.add_argument("--repo", default="/tmp/nbntracker-data")
    ap.add_argument("--out", default="nbntracker-out")
    ap.add_argument("--verify", action="store_true",
                    help="two-stage temp-DB check of the seed candidate")
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
    # Seed candidate: verified price changes only (single-variant rows
    # whose live price differs from the seed). Known exceptions, multi-
    # variant mismatches and rename candidates are NOT applied -- they
    # keep their seed values and are flagged in the diff report.
    # New live rows are added as candidate rows (review before applying).
    prov_spelling = {}
    for (p, n, ti) in seed:
        prov_spelling.setdefault(p.strip().lower(), p)
    updates = {}
    for c in changed:
        prov, name, tier = c["key"]
        v = live_by_key[norm_key(prov, name, tier)][0]
        ov = {
            "ongoingPrice": v["ongoing_price"],
            "source": "nbntracker-data",
            "sourceUrl": v["cis_url"] or REPO_PAGE,
            "checkedDate": today,
        }
        if v["intro_price"] is None:
            ov["introPrice"] = None
            ov["introMonths"] = None
        else:
            ov["introPrice"] = v["intro_price"]
            ov["introMonths"] = v["intro_months"] or 0
        # promo_end only when this source actually verified it (a known
        # exception's live end_date belongs to the standard promo, not to
        # the seed's different promo price -- those rows are not in
        # `changed`, so they never reach here).
        if v.get("promo_end"):
            ov["promoEnd"] = v["promo_end"]
        updates[(prov, name, tier)] = ov
    # Rows that duplicate an existing seed row's brand+tier+prices
    # (different name only) are not new plans -- the server's dedupe
    # would delete them again. They are flagged, not added.
    live_new_rows = [live_by_key[norm_key(*e)][0] for e in live_new]
    kept_new, dropped_new = filter_new_rows(
        seed, live_new_rows,
        lambda p: norm_provider_key(
            PROVIDER_ALIASES.get(p.strip().lower(), p.strip().lower())))
    new_rows = []
    for v in kept_new:
        lp = PROVIDER_ALIASES.get(v["provider"].strip().lower(),
                                  v["provider"].strip().lower())
        prov = prov_spelling.get(lp) or ts_str(v["provider"])
        row = {
            "provider": prov,
            "planName": ts_str(v["plan_name"]),
            "tier": str(v["tier"]),
            "speedDown": v["tes_down"] or v["tier"],
            "category": "cheapest",
            "source": "nbntracker-data",
            "sourceUrl": v["cis_url"] or REPO_PAGE,
            "checkedDate": today,
        }
        # tes_down/tes_up here are the plan's MAX speeds (not typical
        # evening speed): speedUp is the max upload, and tes is left
        # unset -- writing max speeds into tes would corrupt it.
        if v["tes_up"] is not None:
            row["speedUp"] = v["tes_up"]
        if v["intro_price"] is not None:
            row["introPrice"] = v["intro_price"]
            row["introMonths"] = v["intro_months"] or 0
        row["ongoingPrice"] = v["ongoing_price"]
        if v["data"] and v["data"] != "Unlimited":
            row["dataAllowance"] = v["data"].replace(" ", "") + "/月"
        if v.get("promo_end"):
            row["promoEnd"] = v["promo_end"]
        new_rows.append(row)
    candidate_text, cand_stats = build_seed_candidate(
        args.seed, updates, new_rows, today, "nbntracker_fetch.py")
    cand_path = os.path.join(args.out, "seed_new.ts")
    with open(cand_path, "w", encoding="utf-8") as f:
        f.write(candidate_text)
    diff["seed_candidate"] = {
        "file": "seed_new.ts",
        "updated": [list(c["key"]) for c in changed],
        "added": [[v["provider"], v["plan_name"], v["tier"]] for v in kept_new],
        "duplicate_of_seed": [[v["provider"], v["plan_name"], v["tier"]]
                              for v in dropped_new],
        "not_updated": {
            "known_exceptions": [list(c["key"]) for c in known_exceptions],
            "variant_mismatch": [list(c["key"]) for c in variant_mismatch],
            "rename_candidates": rename_candidates,
        },
        "stats": cand_stats,
    }
    with open(os.path.join(args.out, "nbntracker_diff.json"), "w", encoding="utf-8") as f:
        json.dump(diff, f, ensure_ascii=False, indent=1)

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
          f"seed_new.ts (candidate: {cand_stats['updated']} updated, "
          f"{cand_stats['added']} added, {cand_stats['candidate_rows']} rows)")
    if args.verify:
        checks = verify_candidate(args.seed, cand_path, updates, new_rows, today)
        print("verify OK:", json.dumps(checks, ensure_ascii=False))


if __name__ == "__main__":
    main()
