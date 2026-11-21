#!/usr/bin/env python3
"""Fetch all Canstar NBN plans in one request, compare with the tool's seed,
and emit a reviewable diff + an updated seed candidate (seed_new.ts).

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
                            rename-candidate lists vs the seed, plus the
                            seed-candidate summary (which rows the candidate
                            updates/adds, which it leaves alone)
  seed_new.ts               updated seed CANDIDATE (same format as
                            server/src/seed.ts): verified price changes,
                            new rows, source/source_url and checked dates.
                            Known exceptions, multi-variant mismatches and
                            rename candidates are NOT applied -- they are
                            flagged in canstar_diff.json and keep their seed
                            values. Review the diff, then replace
                            server/src/seed.ts with this file and push.
  --verify runs a two-stage temp-DB check of the candidate (current seed
  into a fresh DB, then the candidate into the same DB -- the weekly
  update path): planCount, updated prices + "updated" stamps, new rows
  and provider website URLs.
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
# Canstar display names that differ from the seed's provider spelling
# (matching and new-row spelling; the seed uses "Origin").
PROVIDER_ALIASES = {
    "origin energy": "origin",
}


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
        if "fixed wireless" in row["plan_name"].lower():
            continue  # fixed-wireless plans, not fixed-line residential
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


def norm_key(provider, plan_name, tier):
    # Case-insensitive, with provider aliases so Canstar's display names
    # ("DODO" / "Amaysim" / "Origin Energy") match the seed's ("Dodo" /
    # "amaysim" / "Origin"). Candidate updates use the seed's spelling so
    # they match the existing row.
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
    ap.add_argument("--out", default="canstar-out")
    ap.add_argument("--verify", action="store_true",
                    help="two-stage temp-DB check of the seed candidate")
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
                continue
            # Known exception (verified 2026-11-21): Canstar lists SpinTel
            # NBN 100 at $69x6, but the seed keeps $76x6 -- nbntracker-data
            # (scraped 2026-11-21 02:05 UTC) also lists $76x6 -> $89.95,
            # so the $69 is not applied. Same months + same ongoing price
            # means the plan did not change -- keep the seed's $76.
            if (seed_key[0].lower() == "spintel"
                    and seed_key[1].lower() == "nbn 100"
                    and v["intro_price"] == 69
                    and s_intro == 76
                    and v["intro_months"] == s["intro_months"]
                    and v["ongoing_price"] == s["ongoing_price"]):
                known_exceptions.append({
                    "key": list(seed_key), "seed": s,
                    "live": {k: v[k] for k in
                             ("intro_price", "intro_months", "ongoing_price")},
                    "note": "Canstar lists $69x6; the seed keeps $76x6 "
                            "(confirmed by nbntracker-data). Do not overwrite.",
                })
                unchanged.append(seed_key)
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
    # Seed candidate: verified price changes only (single-variant rows
    # whose live price differs from the seed). Known exceptions, multi-
    # variant mismatches and rename candidates are NOT applied -- they
    # keep their seed values and are flagged in the diff report.
    # New live rows are added as candidate rows (review before applying).
    prov_spelling = {p.strip().lower(): p for (p, n, ti) in seed}
    updates = {}
    for c in changed:
        prov, name, tier = c["key"]
        v = live_by_key[norm_key(prov, name, tier)][0]
        ov = {
            "ongoingPrice": v["ongoing_price"],
            "source": "Canstar",
            "sourceUrl": "https://www.canstar.com.au/internet/nbn-plans/",
            "checkedDate": today,
        }
        if v["intro_price"] == v["ongoing_price"] and not v["intro_months"]:
            ov["introPrice"] = None
            ov["introMonths"] = None
        else:
            ov["introPrice"] = v["intro_price"]
            ov["introMonths"] = v["intro_months"]
        # TES comes from the same source as the seed's, so a changed row
        # carries its fresh TES along (price-unchanged rows keep theirs).
        if v["tes_down"] is not None:
            ov["tes"] = (f"{v['tes_down']}/{v['tes_up']} Mbps"
                         if v["tes_up"] is not None
                         else f"{v['tes_down']} Mbps")
        updates[(prov, name, tier)] = ov
    # Rows that duplicate an existing seed row's brand+tier+prices
    # (different name only) are not new plans -- the server's dedupe
    # would delete them again. They are flagged, not added.
    live_new_rows = [live_by_key[norm_key(*e)][0] for e in live_new]
    kept_new, dropped_new = filter_new_rows(
        seed, live_new_rows, lambda p: norm_provider_key(p))
    new_rows = []
    for v in kept_new:
        lp = PROVIDER_ALIASES.get(v["provider"].strip().lower(),
                                  v["provider"].strip().lower())
        prov = prov_spelling.get(lp) or ts_str(v["provider"])
        row = {
            "provider": prov,
            "planName": ts_str(v["plan_name"]),
            "tier": str(v["tier"]),
            "speedDown": v["tier"],
            "category": "cheapest",
            "source": "Canstar",
            "sourceUrl": "https://www.canstar.com.au/internet/nbn-plans/",
            "checkedDate": today,
        }
        if v["intro_price"] != v["ongoing_price"] or v["intro_months"]:
            row["introPrice"] = v["intro_price"]
            row["introMonths"] = v["intro_months"]
        row["ongoingPrice"] = v["ongoing_price"]
        if v["tes_down"] is not None:
            row["tes"] = (f"{v['tes_down']}/{v['tes_up']} Mbps"
                          if v["tes_up"] is not None
                          else f"{v['tes_down']} Mbps")
        if v["data"] and v["data"] != "Unlimited":
            cap = v["data"].replace(" ", "")
            row["dataAllowance"] = cap + "/月"
            row["note"] = f"每月限量 {cap}。"
        new_rows.append(row)
    candidate_text, cand_stats = build_seed_candidate(
        args.seed, updates, new_rows, today, "canstar_fetch.py")
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
    with open(os.path.join(args.out, "canstar_diff.json"), "w", encoding="utf-8") as f:
        json.dump(diff, f, ensure_ascii=False, indent=1)

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
          f"seed_new.ts (candidate: {cand_stats['updated']} updated, "
          f"{cand_stats['added']} added, {cand_stats['candidate_rows']} rows)")
    if args.verify:
        checks = verify_candidate(args.seed, cand_path, updates, new_rows, today)
        print("verify OK:", json.dumps(checks, ensure_ascii=False))


if __name__ == "__main__":
    main()
