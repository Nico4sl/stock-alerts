"""
Fed screen data.

- fed.json (repo root) holds the written summary – stance, focus, balance sheet, projections,
  meeting calendar – kept up to date by the Claude brief task after each FOMC decision.
- Here we add the live numbers (no API keys):
    * target range + its history and the effective fed funds rate: New York Fed API (EFFR records)
    * fallback for the history: FRED series DFEDTARU / DFEDTARL (fredgraph.csv; often slow from GitHub)
  and turn the meeting calendar into exact decision times (14:00 New York, summer time handled).
- Output: _site/data/fed.json for the app. Live numbers are cached in .state for 3 hours.
"""
import csv
import datetime as dt
import json
import os
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={ids}&cosd={start}"
EFFR = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json"
EFFR_SEARCH = "https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate={start}&endDate={end}"
CACHE_HOURS = 3


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _fred_history(http_get, start="2022-01-01"):
    """[[date, lower, upper], …] – only the days the target range changed, plus the latest day."""
    text = http_get(FRED.format(ids="DFEDTARL,DFEDTARU", start=start), timeout=30)
    rows = list(csv.reader(text.splitlines()))
    head = [h.strip().upper() for h in rows[0]]
    il, iu = head.index("DFEDTARL"), head.index("DFEDTARU")
    pts = []
    for r in rows[1:]:
        try:
            lo, up = float(r[il]), float(r[iu])
        except (ValueError, IndexError):
            continue          # "." = no value that day
        pts.append([r[0], lo, up])
    if not pts:
        raise RuntimeError("FRED returned no target-range data")
    return _steps(pts)


def _steps(pts):
    steps = [pts[0]]
    for p in pts[1:]:
        if p[1:] != steps[-1][1:]:
            steps.append(p)
    if steps[-1][0] != pts[-1][0]:
        steps.append(pts[-1])
    return steps


def _nyfed_history(http_get, today, start="2022-01-01"):
    """Fallback: the NY Fed's EFFR records carry the target range of each day."""
    raw = json.loads(http_get(EFFR_SEARCH.format(start=start, end=today), timeout=45))
    pts = []
    for r in raw.get("refRates") or []:
        try:
            pts.append([r["effectiveDate"], float(r["targetRateFrom"]), float(r["targetRateTo"])])
        except (KeyError, TypeError, ValueError):
            continue
    if not pts:
        raise RuntimeError("NY Fed returned no target-range data")
    return _steps(sorted(pts))


def _effr(http_get):
    raw = json.loads(http_get(EFFR, timeout=20))
    r = (raw.get("refRates") or [{}])[0]
    out = {"rate": float(r["percentRate"]), "date": r.get("effectiveDate")}
    if r.get("targetRateFrom") is not None and r.get("targetRateTo") is not None:
        out["range"] = [float(r["targetRateFrom"]), float(r["targetRateTo"])]
    return out


def live_numbers(http_get, state_dir, now, log):
    path = os.path.join(state_dir, "fed_live.json")
    cache = _load(path, {})
    # re-fetch every 3 h, or on the next run if the history or the effective rate is missing
    fresh = (cache.get("fetched") and cache.get("history") and cache.get("effr")
             and (now - dt.datetime.fromisoformat(cache["fetched"])) < dt.timedelta(hours=CACHE_HOURS))
    if fresh:
        return cache
    out = {"fetched": now.isoformat(timespec="seconds"), "errors": []}
    for name, fn in (("NY Fed", lambda: _nyfed_history(http_get, now.date().isoformat())),
                     ("FRED", lambda: _fred_history(http_get))):
        try:
            out["history"] = fn()
            out["history_source"] = name
            break
        except Exception as e:  # noqa: BLE001
            log(f"  ! Fed target range ({name}): {e}")
            out["errors"].append(f"history {name}: {str(e)[:160]}")
    else:
        if cache.get("history"):
            out["history"], out["history_source"] = cache["history"], cache.get("history_source")
    try:
        out["effr"] = _effr(http_get)
    except Exception as e:  # noqa: BLE001
        log(f"  ! Fed effective rate (NY Fed): {e}")
        out["errors"].append(f"effr: {str(e)[:160]}")
        if cache.get("effr"):
            out["effr"] = cache["effr"]
    os.makedirs(state_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    return out


def decision_time(day_iso):
    """FOMC statements come out at 14:00 New York time on the meeting's last day."""
    d = dt.date.fromisoformat(day_iso)
    return dt.datetime(d.year, d.month, d.day, 14, 0, tzinfo=NY).astimezone(dt.timezone.utc)


def build(root, out_dir, state_dir, http_get, log, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    summary = _load(os.path.join(root, "fed.json"), None)
    if not summary:
        return
    live = live_numbers(http_get, state_dir, now, log) if http_get else {}

    meetings = []
    for m in summary.get("meetings", []):
        t = decision_time(m["end"])
        meetings.append({**m, "decision_utc": t.isoformat().replace("+00:00", "Z"), "past": t <= now})
    upcoming = [m for m in meetings if not m["past"]]

    rate = dict(summary.get("rate", {}))
    rate["source"] = "summary"
    hist = live.get("history")
    effr = live.get("effr") or {}
    live_range = None
    if hist:
        live_range = (hist[-1][1], hist[-1][2])
        rate.update(as_of=hist[-1][0], source=f"{live.get('history_source') or 'FRED'} (live)")
    if effr.get("range") and (not hist or (effr.get("date") or "") >= hist[-1][0]):
        live_range = tuple(effr["range"])            # newest official reading wins
        rate.update(as_of=effr.get("date"), source="New York Fed (live)")
    if live_range:
        rate.update(lower=live_range[0], upper=live_range[1])
    if effr:
        rate["effective"] = effr["rate"]
        rate["effective_date"] = effr.get("date")
    s_rate = summary.get("rate", {})
    outdated = bool(live_range) and (s_rate.get("lower"), s_rate.get("upper")) != live_range

    data = {
        **{k: v for k, v in summary.items() if k not in ("meetings", "rate")},
        "rate": rate,
        "history": hist or [],
        "meetings": meetings,
        "next": upcoming[0] if upcoming else None,
        "summary_outdated": outdated,   # live rate changed since the text was written
        "live_errors": live.get("errors") or [],
        "generated": now.isoformat(timespec="seconds"),
    }
    os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
    with open(os.path.join(out_dir, "data", "fed.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log(f"  Fed: {rate.get('lower')}–{rate.get('upper')} % ({rate['source']}), "
        f"next decision {data['next']['end'] if data['next'] else '–'}")
