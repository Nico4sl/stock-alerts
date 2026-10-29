"""
Upcoming dates that can move a stock: earnings, ex-dividend dates, company events and
US macro releases (FOMC, CPI, jobs report, PCE, GDP).

Sources (no keys):
  - Nasdaq.com: next earnings date per symbol (+ its earnings calendar for the next three
    weeks, which carries before-open / after-close timing) and dividend dates
  - fed.json: FOMC meeting calendar (kept current by the Claude brief task)
  - events.json (repo root): macro release dates and hand-picked company events
    (investor days, drug approval decisions, product events …), kept current by the
    Claude brief task – see BRIEF_TASK.md step 6

Fetched once per New York day and cached in .state/events.json, so the 5-minute checks
don't call Nasdaq every time. Standard library only.
"""
import datetime as dt
import json
import os
import re
import time

HORIZON_DAYS = 120       # company events shown per stock
MACRO_DAYS = 60          # macro events kept in the summary
CAL_DAYS = 21            # Nasdaq earnings calendar scanned this far ahead

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _date(text):
    """First date in a string: 12/10/2026, 2026-12-10 or Dec 10, 2026 -> '2026-12-10'."""
    if not text:
        return None
    text = str(text)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        return m.group(0)
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", text)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    m = re.search(r"\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})", text)
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    return None


def _timing(text):
    t = (text or "").lower()
    if "after" in t and ("close" in t or "hours" in t):
        return "AMC"
    if "before" in t or "pre-market" in t or "pre market" in t or "premarket" in t:
        return "BMO"
    return None


def _is_stock(sym):
    """Indices (^…), crypto (BTC-USD) and yields (US10Y, DE10Y) have no earnings or dividends."""
    return not (sym.startswith("^") or ("-" in sym and sym.split("-")[1] in ("USD", "EUR", "USDT")) or re.fullmatch(r"(US|DE)\d+[MY]", sym))


def fetch_earnings(get_json, sym):
    d = (get_json(f"https://api.nasdaq.com/api/analyst/{sym}/earnings-date") or {}).get("data") or {}
    text = " ".join(str(d.get(k) or "") for k in ("announcement", "reportText"))
    date = _date(d.get("reportText")) or _date(d.get("announcement"))
    if not date:
        return None, text[:200]
    return {"date": date, "time": _timing(text),
            "confirmed": "estimated" not in text.lower() and "projected" not in text.lower()}, None


def fetch_dividend(get_json, sym, today):
    d = (get_json(f"https://api.nasdaq.com/api/quote/{sym}/dividends?assetclass=stocks") or {}).get("data") or {}
    rows = ((d.get("dividends") or {}).get("rows")) or []
    for r in rows[:2]:
        ex = _date(r.get("exOrEffDate"))
        if ex and ex >= today:
            return {"date": ex, "amount": r.get("amount"), "pay": _date(r.get("paymentDate"))}
    ex = _date(d.get("exDividendDate"))
    if ex and ex >= today:
        return {"date": ex, "amount": None, "pay": _date(d.get("dividendPaymentDate"))}
    return None


def scan_calendar(get_json, today, days=CAL_DAYS):
    """Nasdaq's earnings calendar for the coming weeks: {symbol: {date, time}}."""
    out = {}
    start = dt.date.fromisoformat(today)
    for i in range(days + 1):
        day = start + dt.timedelta(days=i)
        if day.weekday() >= 5:
            continue
        d = (get_json(f"https://api.nasdaq.com/api/calendar/earnings?date={day.isoformat()}") or {}).get("data") or {}
        for r in d.get("rows") or []:
            sym = (r.get("symbol") or "").upper()
            if sym and sym not in out:
                out[sym] = {"date": day.isoformat(), "time": _timing(r.get("time"))}
        time.sleep(0.2)
    return out


def refresh(symbols, get_json, today, log):
    """Fetch earnings + dividends for every stock symbol. Returns the cache dict."""
    cache = {"day": today, "symbols": {}, "debug": []}
    stocks = [s for s in symbols if _is_stock(s)]
    try:
        cal = scan_calendar(get_json, today)
    except Exception as e:  # noqa: BLE001
        cal = {}
        cache["debug"].append(f"calendar: {str(e)[:120]}")
    for sym in stocks:
        rec = {}
        q = sym.replace("-", ".")
        try:
            e, raw = fetch_earnings(get_json, q)
            if e:
                rec["earnings"] = e
            elif raw:
                cache["debug"].append(f"{sym} earnings unparsed: {raw[:120]}")
        except Exception as ex:  # noqa: BLE001
            cache["debug"].append(f"{sym} earnings: {str(ex)[:120]}")
        c = cal.get(sym)
        if c and c["date"] >= today:
            # the calendar is the firmer source for the next few weeks
            prev = rec.get("earnings") or {}
            rec["earnings"] = {"date": c["date"], "time": c["time"] or (prev.get("time") if prev.get("date") == c["date"] else None),
                               "confirmed": True}
        try:
            dv = fetch_dividend(get_json, q, today)
            if dv:
                rec["dividend"] = dv
        except Exception as ex:  # noqa: BLE001
            cache["debug"].append(f"{sym} dividend: {str(ex)[:120]}")
        cache["symbols"][sym] = rec
        time.sleep(0.25)
    found = sum(1 for r in cache["symbols"].values() if r.get("earnings"))
    log(f"  events: earnings dates for {found}/{len(stocks)} stocks"
        + (f" ({len(cache['debug'])} note(s))" if cache["debug"] else ""))
    return cache


def load(state_dir, symbols, get_json, today, log, fixtures=None):
    """Cached per New York day; refetched when the day changes or a symbol is new."""
    path = os.path.join(state_dir, "events.json")
    if fixtures:
        try:
            with open(os.path.join(fixtures, "_events.json"), encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            return {"day": today, "symbols": {}}
    try:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    missing = [s for s in symbols if _is_stock(s) and s not in cache.get("symbols", {})]
    if cache.get("day") == today and not missing:
        return cache
    if cache.get("day") == today and missing:
        new = refresh(missing, get_json, today, log)
        cache["symbols"].update(new["symbols"])
        cache.setdefault("debug", []).extend(new["debug"])
    else:
        try:
            cache = refresh(symbols, get_json, today, log)
        except Exception as e:  # noqa: BLE001
            log(f"  ! events: {e}")
            if not cache:
                return {"day": None, "symbols": {}}
            return cache          # keep yesterday's dates rather than none
    os.makedirs(state_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    return cache


def _curated(root):
    try:
        with open(os.path.join(root, "events.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def macro_events(root, today):
    """FOMC decisions (fed.json) + macro releases (events.json), next MACRO_DAYS days."""
    end = (dt.date.fromisoformat(today) + dt.timedelta(days=MACRO_DAYS)).isoformat()
    out = []
    try:
        with open(os.path.join(root, "fed.json"), encoding="utf-8") as f:
            fed = json.load(f)
        for m in fed.get("meetings", []):
            d = m.get("end")
            if d and today <= d <= end:
                out.append({"date": d, "time": "14:00 ET", "kind": "fomc",
                            "title": "Fed rate decision (FOMC)" + (" + projections" if m.get("sep") else ""),
                            "title_de": "Fed-Zinsentscheid (FOMC)" + (" + Projektionen" if m.get("sep") else "")})
    except (OSError, ValueError):
        pass
    for e in _curated(root).get("macro", []):
        d = e.get("date")
        if d and today <= d <= end:
            out.append({k: e[k] for k in ("date", "time", "kind", "title", "title_de") if e.get(k)})
    return sorted(out, key=lambda e: (e["date"], e.get("time") or ""))


def stock_events(sym, cache, root, today):
    """Company-specific dates for one stock (earnings, ex-dividend, curated), sorted."""
    end = (dt.date.fromisoformat(today) + dt.timedelta(days=HORIZON_DAYS)).isoformat()
    rec = (cache.get("symbols") or {}).get(sym) or {}
    out = []
    e = rec.get("earnings")
    if e and today <= e["date"] <= end:
        out.append({"date": e["date"], "kind": "earnings", "time": e.get("time"),
                    "confirmed": e.get("confirmed", False),
                    "title": "Earnings report", "title_de": "Quartalszahlen"})
    dv = rec.get("dividend")
    if dv and today <= dv["date"] <= end:
        amt = f" ({dv['amount']})" if dv.get("amount") else ""
        out.append({"date": dv["date"], "kind": "dividend",
                    "title": f"Ex-dividend date{amt}", "title_de": f"Ex-Dividenden-Tag{amt}"})
    for c in (_curated(root).get("companies") or {}).get(sym, []):
        d = c.get("date")
        if d and today <= d <= end:
            item = {k: c[k] for k in ("date", "time", "kind", "title", "title_de", "note", "note_de") if c.get(k)}
            item.setdefault("kind", "company")
            # a curated earnings date wins only if Nasdaq has none
            if item["kind"] == "earnings" and any(x["kind"] == "earnings" for x in out):
                continue
            out.append(item)
    return sorted(out, key=lambda x: x["date"])


def next_earnings(events):
    return next(({"date": e["date"], "time": e.get("time"), "confirmed": e.get("confirmed", True)}
                 for e in events if e["kind"] == "earnings"), None)
