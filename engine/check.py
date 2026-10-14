#!/usr/bin/env python3
"""
Pullback – price checker and alert engine.

Runs on GitHub Actions every 10 minutes while the NYSE is open:
  1. fetches daily candles for every symbol in config.json (Yahoo Finance, no key)
  2. computes the Babyfolio toolkit: 8/21 EMA, 50/100/150/200 SMA, open gaps
  3. compares the live price with those levels and your manual levels
  4. pushes new alerts to your phone via ntfy
  5. writes the data files the app reads

Standard library only, so it needs no installs.
"""
import argparse
import datetime as dt
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import movers as mv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NY = ZoneInfo("America/New_York")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

EMA_LENGTHS = (8, 21)
SMA_LENGTHS = (50, 100, 150, 200)
MAX_LOG = 200          # alerts kept in the in-app log
BUNDLE_LIMIT = 6       # more alerts than this in one run -> one combined push

# NYSE full-day closures (early closes are treated as normal days)
NYSE_HOLIDAYS = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
    "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
}


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def log(*a):
    print(*a, flush=True)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, separators=(",", ":"), allow_nan=False)
        else:
            json.dump(data, f, indent=1, allow_nan=False)


def rnd(x, ref=None):
    """Round to a sensible number of decimals for prices."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    ref = abs(ref if ref is not None else x)
    d = 2 if ref >= 10 else 4 if ref >= 0.1 else 6
    return round(float(x), d)


def r1(x):
    return None if x is None else round(float(x), 1)


def pct(a, b):
    """% distance of a from b."""
    return (a - b) / b * 100.0 if b else None


def fmt(x):
    if x is None:
        return "–"
    if abs(x) >= 1000:
        return f"{x:,.0f}"
    return f"{x:,.2f}" if abs(x) >= 1 else f"{x:.4f}"


def market_status(now_utc):
    ny = now_utc.astimezone(NY)
    day = ny.strftime("%Y-%m-%d")
    if ny.weekday() >= 5 or day in NYSE_HOLIDAYS:
        return False, "closed (weekend/holiday)"
    minutes = ny.hour * 60 + ny.minute
    # 09:30 open … 16:00 close, plus one run shortly after to capture the close
    if 9 * 60 + 30 <= minutes <= 16 * 60 + 20:
        return True, "open"
    return False, "closed (outside 09:30–16:00 New York)"


# ----------------------------------------------------------------------------
# data
# ----------------------------------------------------------------------------
def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def fetch_yahoo(symbol, rng="3y", min_len=30):
    q = urllib.parse.quote(symbol)
    last_err = None
    for host in ("query1", "query2"):
        url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}"
               f"?range={rng}&interval=1d&includePrePost=false&events=div%2Csplit")
        for attempt in range(2):
            try:
                raw = json.loads(http_get(url))
                res = raw["chart"]["result"][0]
                meta = res["meta"]
                ts = res.get("timestamp") or []
                qd = res["indicators"]["quote"][0]
                off = meta.get("gmtoffset", 0)
                rows = {}
                for i, t in enumerate(ts):
                    o, h, l, c, v = (qd["open"][i], qd["high"][i], qd["low"][i],
                                     qd["close"][i], qd["volume"][i])
                    if None in (o, h, l, c):
                        continue
                    d = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).strftime("%Y-%m-%d")
                    rows[d] = [d, o, h, l, c, v or 0]
                candles = [rows[k] for k in sorted(rows)]
                price = meta.get("regularMarketPrice")
                if price and candles:
                    mt = meta.get("regularMarketTime")
                    mday = (dt.datetime.fromtimestamp(mt + off, dt.timezone.utc).strftime("%Y-%m-%d")
                            if mt else candles[-1][0])
                    last = candles[-1]
                    if mday == last[0]:
                        last[4] = price
                        last[2] = max(last[2], price)
                        last[3] = min(last[3], price)
                if len(candles) < min_len:
                    raise ValueError("too little history")
                return {
                    "candles": candles,
                    "price": price or candles[-1][4],
                    "currency": meta.get("currency", "USD"),
                    "market_time": meta.get("regularMarketTime"),
                    "source": "Yahoo Finance",
                }
            except Exception as e:  # noqa: BLE001
                last_err = e
                time.sleep(1.5)
    raise RuntimeError(f"Yahoo failed for {symbol}: {last_err}")


def fetch_stooq(symbol):
    s = symbol.lower()
    s = s.replace("-usd", "usd") if s.endswith("-usd") else f"{s.replace('.', '-')}.us"
    text = http_get(f"https://stooq.com/q/d/l/?s={s}&i=d")
    lines = [ln for ln in text.strip().splitlines()[1:] if ln and "," in ln]
    candles = []
    for ln in lines[-800:]:
        p = ln.split(",")
        if len(p) < 5:
            continue
        try:
            candles.append([p[0], float(p[1]), float(p[2]), float(p[3]), float(p[4]),
                            float(p[5]) if len(p) > 5 and p[5] else 0])
        except ValueError:
            continue
    if len(candles) < 30:
        raise RuntimeError(f"Stooq returned no data for {symbol}")
    return {"candles": candles, "price": candles[-1][4], "currency": "USD",
            "market_time": None, "source": "Stooq"}


def fetch(symbol):
    try:
        return fetch_yahoo(symbol)
    except Exception as e:  # noqa: BLE001
        log(f"  ! {e} – trying Stooq")
        return fetch_stooq(symbol)


# ----------------------------------------------------------------------------
# indicators
# ----------------------------------------------------------------------------
def sma(values, n):
    out, s = [None] * len(values), 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(values, n):
    """EMA seeded with the SMA of the first n values (same as TradingView)."""
    out = [None] * len(values)
    if len(values) < n:
        return out
    k = 2.0 / (n + 1)
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def find_gaps(candles, min_gap_pct):
    """
    Daily price gaps (Babyfolio / StockCharts definition):
      gap up   – today's low  > yesterday's high  -> zone [yesterday high, today low] (below price)
      gap down – today's high < yesterday's low   -> zone [today high, yesterday low] (above price)
    A gap is filled when price later trades back through the whole zone.
    """
    gaps = []
    n = len(candles)
    for i in range(1, n):
        ph, pl = candles[i - 1][2], candles[i - 1][3]
        h, l = candles[i][2], candles[i][3]
        if l > ph:
            direction, bottom, top = "up", ph, l
        elif h < pl:
            direction, bottom, top = "down", h, pl
        else:
            continue
        if (top - bottom) / bottom * 100 < min_gap_pct:
            continue
        g = {"id": candles[i][0], "start": candles[i][0], "dir": direction,
             "top": top, "bottom": bottom, "filled": False, "filled_date": None,
             "age": n - 1 - i}
        if direction == "up":
            low_since = math.inf
            for j in range(i + 1, n):
                low_since = min(low_since, candles[j][3])
                if low_since <= bottom:
                    g["filled"], g["filled_date"] = True, candles[j][0]
                    break
            edge = bottom if g["filled"] else min(top, low_since)
            g["open_top"], g["open_bottom"] = edge, bottom    # still-open part
            g["fill_pct"] = (top - edge) / (top - bottom) * 100
        else:
            high_since = -math.inf
            for j in range(i + 1, n):
                high_since = max(high_since, candles[j][2])
                if high_since >= top:
                    g["filled"], g["filled_date"] = True, candles[j][0]
                    break
            edge = top if g["filled"] else max(bottom, high_since)
            g["open_top"], g["open_bottom"] = top, edge
            g["fill_pct"] = (edge - bottom) / (top - bottom) * 100
        gaps.append(g)
    return gaps


# ----------------------------------------------------------------------------
# alert rules
# ----------------------------------------------------------------------------
class Alerts:
    """Edge-triggered alerts with re-arm hysteresis, so each setup pings once."""

    def __init__(self, state, seeding):
        self.state = state          # key -> {"on": bool}
        self.seeding = seeding
        self.fired = []
        self.seen = set()

    def check(self, key, triggered, rearm, alert):
        self.seen.add(key)
        s = self.state.setdefault(key, {"on": False})
        if triggered and not s["on"]:
            s["on"] = True
            s["since"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            if not self.seeding:
                self.fired.append(alert)
        elif s["on"] and rearm and not triggered:
            s["on"] = False

    def event(self, key, happened, alert):
        """One-off events (e.g. gap fully filled)."""
        self.seen.add(key)
        if happened and key not in self.state:
            self.state[key] = {"on": True, "event": True}
            if not self.seeding:
                self.fired.append(alert)


def analyse(stock, data, settings, alerts, app_url):
    sym = stock["symbol"]
    name = stock.get("name", sym)
    band = float(settings.get("band_pct", 1.5))
    ext = float(settings.get("extended_pct", 15))
    holding = stock.get("list") == "portfolio"
    hc = bool(stock.get("high_conviction"))
    link = f"{app_url}#/s/{urllib.parse.quote(sym)}" if app_url else None

    candles = data["candles"]
    closes = [c[4] for c in candles]
    price = float(data["price"])
    prev_close = closes[-2] if len(closes) > 1 else price
    change_pct = pct(price, prev_close)

    series = {f"ema{n}": ema(closes, n) for n in EMA_LENGTHS}
    series.update({f"sma{n}": sma(closes, n) for n in SMA_LENGTHS})
    lv = {k: v[-1] for k, v in series.items()}
    prev_lv = {k: (v[-2] if len(v) > 1 else None) for k, v in series.items()}
    momentum = (lv["ema8"] is not None and lv["ema21"] is not None and lv["ema8"] > lv["ema21"])

    def A(kind, title, body, tags, priority=3):
        return {"symbol": sym, "name": name, "kind": kind, "title": f"{sym} · {title}",
                "message": body, "tags": tags, "priority": priority, "click": link,
                "price": rnd(price)}

    def side(level_key):
        p = prev_lv.get(level_key)
        return "from above (pullback)" if (p and prev_close >= p) else "from below"

    in_zone = []

    # ---- 8 / 21 EMA: entry 1 and entry 2 ---------------------------------
    if settings.get("ema_alerts", True):
        for key, label, title, tag in (
            ("ema8", "8 EMA", "Entry 1 zone – 8 EMA", "large_blue_circle"),
            ("ema21", "21 EMA", "Entry 2 zone – 21 EMA", "yellow_circle"),
        ):
            level = lv[key]
            if level is None:
                continue
            d = pct(price, level)
            hit = abs(d) <= band
            if hit:
                in_zone.append(label)
            mom = "Momentum intact (8 EMA > 21 EMA)." if momentum else "Momentum weakening (8 EMA < 21 EMA)."
            role = ("First, smaller entry area." if key == "ema8" else "Second, heavier entry area.")
            alerts.check(f"{sym}:{key}", hit, abs(d) > band * 2, A(
                key, title,
                f"{name} at {fmt(price)} is {d:+.1f}% from the {label} ({fmt(level)}), "
                f"approached {side(key)}. {role} {mom}",
                ["chart_with_downwards_trend", tag], 4 if key == "ema21" else 3))

    # ---- SMAs (200 for high-conviction names by default) -----------------
    sma_set = set(settings.get("sma_alerts_all", []))
    if hc:
        sma_set |= set(settings.get("sma_alerts_high_conviction", [200]))
    for n in SMA_LENGTHS:
        level = lv[f"sma{n}"]
        if level is None:
            continue
        d = pct(price, level)
        hit = abs(d) <= band
        if hit:
            in_zone.append(f"{n} SMA")
        if n not in sma_set:
            continue
        extra = (" High-conviction name: a defended 200-day can be a major entry – check why it fell."
                 if n == 200 else "")
        alerts.check(f"{sym}:sma{n}", hit, abs(d) > band * 2, A(
            f"sma{n}", f"{n}-day SMA zone",
            f"{name} at {fmt(price)} is {d:+.1f}% from the {n} SMA ({fmt(level)}), "
            f"approached {side(f'sma{n}')}.{extra}",
            ["dart"], 5 if n == 200 else 4))

    # ---- extended above the 8 EMA (possible profit-taking) ---------------
    ext_now = pct(price, lv["ema8"]) if lv["ema8"] else None
    if ext_now is not None and ext > 0:
        alerts.check(f"{sym}:extended", ext_now >= ext, ext_now < ext / 2, A(
            "extended", f"Extended {ext_now:+.0f}% above 8 EMA",
            f"{name} at {fmt(price)} is {ext_now:.1f}% above its 8 EMA ({fmt(lv['ema8'])}). "
            f"If there is no material news, this stretch can be a reason to take some profit.",
            ["rocket"], 3))

    # ---- gaps -------------------------------------------------------------
    gaps = find_gaps(candles, float(settings.get("min_gap_pct", 0.5)))
    open_gaps = [g for g in gaps if not g["filled"]]
    for g in gaps:
        g["below"] = g["open_top"] <= price if not g["filled"] else g["top"] <= price
    if settings.get("gap_alerts", True):
        for g in open_gaps:
            if g["age"] < 1:
                continue      # a gap formed today is not an "approach"
            if g["below"]:
                edge = g["open_top"]
                d = pct(price, edge)
                inside = g["open_bottom"] <= price <= g["open_top"]
                near = inside or (0 <= d <= band)
                where = f"open gap below {fmt(g['open_bottom'])}–{fmt(g['open_top'])}"
                hint = "Possible entry area – gaps near a watched MA are more interesting."
                tag = "arrow_down"
            else:
                edge = g["open_bottom"]
                d = pct(edge, price)
                inside = g["open_bottom"] <= price <= g["open_top"]
                near = inside or (0 <= d <= band)
                where = f"open gap above {fmt(g['open_bottom'])}–{fmt(g['open_top'])}"
                hint = ("Holding: gap fill at the highs can be a trim area if your thesis/valuation says so."
                        if holding else "Overhead gap – acts as resistance until filled.")
                tag = "arrow_up"
            if inside:
                in_zone.append("Gap")
            alerts.check(f"{sym}:gap:{g['id']}", near, not near and abs(d) > band * 2, A(
                "gap", "Approaching gap fill" if not inside else "Filling gap",
                f"{name} at {fmt(price)} – {where} (gap from {g['start']}, "
                f"{g['fill_pct']:.0f}% filled). {hint}", [tag], 4))
        for g in gaps:
            if g["filled"] and g["filled_date"] == candles[-1][0]:
                alerts.event(f"{sym}:gapfilled:{g['id']}", True, A(
                    "gapfilled", "Gap filled",
                    f"{name} filled the {g['dir']}-gap from {g['start']} "
                    f"({fmt(g['bottom'])}–{fmt(g['top'])}). Price now {fmt(price)}.",
                    ["white_check_mark"], 4))

    # ---- manual levels ------------------------------------------------------
    manual = []
    for i, m in enumerate(stock.get("levels", [])):
        try:
            level = float(m["price"])
        except (KeyError, TypeError, ValueError):
            continue
        kind = m.get("type", "support")
        note = (m.get("note") or "").strip()
        d = pct(price, level)
        key = f"{sym}:lvl:{kind}:{level}"
        label = {"support": "Support", "resistance": "Resistance",
                 "above": "Price above", "below": "Price below"}.get(kind, kind)
        if kind in ("support", "resistance"):
            hit = abs(d) <= band
            rearm = abs(d) > band * 2
        elif kind == "above":
            hit, rearm = price >= level, price < level * (1 - band / 100)
        else:  # below
            hit, rearm = price <= level, price > level * (1 + band / 100)
        if hit and kind in ("support", "resistance"):
            in_zone.append(label)
        manual.append({"price": level, "type": kind, "note": note, "dist_pct": r1(d)})
        alerts.check(key, hit, rearm, A(
            "manual", f"{label} {fmt(level)}",
            f"{name} at {fmt(price)} ({d:+.1f}% vs {fmt(level)})." + (f" Note: {note}" if note else ""),
            ["bell"], 5))

    # ---- summary row for the app -------------------------------------------
    dist = {k: r1(pct(price, v)) for k, v in lv.items() if v}
    candidates = [(abs(v), k, v) for k, v in dist.items()]
    for g in open_gaps:
        e = g["open_top"] if g["below"] else g["open_bottom"]
        d = pct(price, e)
        candidates.append((abs(d), f"gap:{g['id']}", d))
    for m in manual:
        candidates.append((abs(m["dist_pct"]), f"lvl:{m['price']}", m["dist_pct"]))
    nearest = min(candidates) if candidates else None

    def nearest_label(k):
        if k.startswith("gap:"):
            return "Gap"
        if k.startswith("lvl:"):
            return f"Level {fmt(float(k[4:]))}"
        return k.replace("ema", "").replace("sma", "") + (" EMA" if k.startswith("ema") else " SMA")

    near_gaps = sorted(open_gaps, key=lambda g: abs(pct(price, g["open_top"] if g["below"] else g["open_bottom"])))[:4]

    summary = {
        "symbol": sym, "name": name, "list": stock.get("list", "watchlist"),
        "high_conviction": hc, "price": rnd(price), "prev_close": rnd(prev_close),
        "change_pct": r1(change_pct), "currency": data.get("currency", "USD"),
        "levels": {k: rnd(v, price) for k, v in lv.items()},
        "dist": dist, "momentum": momentum,
        "extended_pct": r1(ext_now),
        "in_zone": sorted(set(in_zone)),
        "nearest": ({"label": nearest_label(nearest[1]),
                     "dist_pct": r1(nearest[2])} if nearest else None),
        "gaps": [{"start": g["start"], "dir": g["dir"], "below": g["below"],
                  "top": rnd(g["open_top"], price), "bottom": rnd(g["open_bottom"], price),
                  "fill_pct": round(g["fill_pct"])} for g in near_gaps],
        "open_gap_count": len(open_gaps),
        "manual": manual, "source": data.get("source"), "last_bar": candles[-1][0],
        "spark": [rnd(c, price) for c in closes[-30:]],
    }

    detail = {
        "symbol": sym, "name": name, "source": data.get("source"),
        "t": [c[0] for c in candles],
        "o": [rnd(c[1], price) for c in candles],
        "h": [rnd(c[2], price) for c in candles],
        "l": [rnd(c[3], price) for c in candles],
        "c": [rnd(c[4], price) for c in candles],
        "v": [int(c[5] or 0) for c in candles],
        **{k: [rnd(x, price) for x in v] for k, v in series.items()},
        "gaps": [{"id": g["id"], "start": g["start"], "dir": g["dir"],
                  "top": rnd(g["top"], price), "bottom": rnd(g["bottom"], price),
                  "open_top": rnd(g["open_top"], price), "open_bottom": rnd(g["open_bottom"], price),
                  "filled": g["filled"], "filled_date": g["filled_date"],
                  "fill_pct": round(g["fill_pct"])}
                 for g in gaps if not g["filled"] or g["age"] <= 260],
    }
    return summary, detail


# ----------------------------------------------------------------------------
# notifications
# ----------------------------------------------------------------------------
def push(topic, server, alert):
    body = {"topic": topic, "title": alert["title"], "message": alert["message"],
            "tags": alert.get("tags", []), "priority": alert.get("priority", 3)}
    if alert.get("click"):
        body["click"] = alert["click"]
    req = urllib.request.Request(server.rstrip("/"), data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def deliver(alerts, topic, server, app_url):
    if not alerts:
        return
    if not topic:
        log("  (NTFY_TOPIC not set – alerts logged in the app only)")
        return
    try:
        if len(alerts) > BUNDLE_LIMIT:
            lines = "\n".join(f"• {a['title']}" for a in alerts)
            push(topic, server, {"title": f"{len(alerts)} new alerts", "message": lines,
                                 "tags": ["bell"], "priority": 4, "click": app_url})
        else:
            for a in alerts:
                push(topic, server, a)
                time.sleep(0.3)
        log(f"  pushed {len(alerts)} notification(s)")
    except Exception as e:  # noqa: BLE001
        log(f"  ! ntfy push failed: {e}")


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "_site"))
    ap.add_argument("--state", default=os.path.join(ROOT, ".state"))
    ap.add_argument("--app-url", default=os.environ.get("APP_URL", ""))
    ap.add_argument("--force", action="store_true", help="run even when the market is closed")
    ap.add_argument("--test-notification", action="store_true")
    ap.add_argument("--fixtures", help="folder with <SYMBOL>.json candles (offline testing)")
    args = ap.parse_args()

    topic = os.environ.get("NTFY_TOPIC", "").strip()
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").strip() or "https://ntfy.sh"
    now = dt.datetime.now(dt.timezone.utc)
    is_open, status = market_status(now)
    gh_out = os.environ.get("GITHUB_OUTPUT")

    if args.test_notification:
        if topic:
            push(topic, server, {"title": "Pullback · test notification",
                                 "message": "Alerts are set up correctly. You will be pinged when a stock reaches a level.",
                                 "tags": ["white_check_mark"], "priority": 4, "click": args.app_url})
            log("Test notification sent.")
        else:
            log("NTFY_TOPIC secret is missing – add it under Settings → Secrets → Actions.")

    if not is_open and not args.force:
        log(f"NYSE {status} – nothing to do.")
        if gh_out:
            with open(gh_out, "a") as f:
                f.write("ran=false\n")
        return

    config = load_json(os.path.join(ROOT, "config.json"), {})
    settings = config.get("settings", {})
    stocks = config.get("stocks", [])
    state_path = os.path.join(args.state, "state.json")
    log_path = os.path.join(args.state, "alerts.json")
    state = load_json(state_path, None)
    seeding = state is None
    state = state or {}
    history = load_json(log_path, [])
    alerts = Alerts(state, seeding)
    if seeding:
        log("First run: recording current levels silently (no notifications).")

    data_dir = os.path.join(args.out, "data")
    os.makedirs(data_dir, exist_ok=True)
    rows, errors = [], []
    for s in stocks:
        sym = s["symbol"].strip().upper()
        s["symbol"] = sym
        log(f"- {sym}")
        try:
            if args.fixtures:
                data = load_json(os.path.join(args.fixtures, f"{sym}.json"), None)
                if not data:
                    raise RuntimeError("no fixture")
            else:
                data = fetch(sym)
                time.sleep(0.25)
            summary, detail = analyse(s, data, settings, alerts, args.app_url)
            rows.append(summary)
            save_json(os.path.join(data_dir, f"{sym}.json"), detail, compact=True)
        except Exception as e:  # noqa: BLE001
            log(f"  ! {e}")
            errors.append({"symbol": sym, "error": str(e)[:200]})
            rows.append({"symbol": sym, "name": s.get("name", sym), "list": s.get("list", "watchlist"),
                         "high_conviction": bool(s.get("high_conviction")), "error": True})

    # ---- big movers (±move_pct) and Claude's briefs -------------------------
    today_ny = now.astimezone(NY).strftime("%Y-%m-%d")
    stamp = now.isoformat(timespec="seconds")
    link = lambda sym: f"{args.app_url}#/s/{urllib.parse.quote(sym)}" if args.app_url else None  # noqa: E731
    mstate_path = os.path.join(args.state, "movers.json")
    mstate = load_json(mstate_path, {})
    if args.fixtures:
        ctx_fn = lambda syms: load_json(os.path.join(args.fixtures, "_market.json"), {})  # noqa: E731
        news_fn = lambda sym, name: load_json(os.path.join(args.fixtures, "_news.json"), {}).get(sym, [])  # noqa: E731
    else:
        ctx_fn = lambda syms: mv.market_context(lambda x: fetch_yahoo(x, "5d", 2), syms, log)  # noqa: E731
        news_fn = lambda sym, name: mv.headlines(http_get, sym, name)  # noqa: E731
    movers_payload, queue, new_movers = mv.update_movers(rows, mstate, today_ny, stamp, settings, ctx_fn, news_fn, log)
    extra = []
    if settings.get("mover_push", True) and not seeding:
        extra += [mv.mover_alert(m, args.app_url, link) for m in movers_payload["movers"] if m["symbol"] in new_movers]
    seen_path = os.path.join(args.state, "briefs_seen.json")
    seen_list = load_json(seen_path, None)
    seen = set(seen_list or [])
    index, brief_notes = mv.publish_briefs(ROOT, args.out, today_ny, seen, seen_list is None,
                                           settings.get("brief_lang", "en"), args.app_url, log)
    ids = {b["id"] for b in index}
    for m in movers_payload["movers"]:
        bid = mv.brief_id(today_ny, m["symbol"])
        m["brief"] = bid if bid in ids else None
    extra += brief_notes
    alerts.fired += extra
    save_json(mstate_path, mstate)
    save_json(seen_path, sorted(seen))
    save_json(os.path.join(data_dir, "movers.json"), movers_payload)
    save_json(os.path.join(data_dir, "brief-queue.json"), queue)

    # forget state for alerts that no longer exist (removed levels, filled gaps …)
    for k in list(state):
        if k not in alerts.seen and not state[k].get("event"):
            del state[k]
    # cap the number of remembered one-off events
    if len(state) > 5000:
        for k in [k for k in state if state[k].get("event")][:1000]:
            del state[k]

    for a in alerts.fired:
        a["time"] = stamp
        log(f"  ALERT {a['title']}")
    deliver(alerts.fired, topic, server, args.app_url)
    history = (list(reversed(alerts.fired)) + history)[:MAX_LOG]

    save_json(state_path, state)
    save_json(log_path, history)
    save_json(os.path.join(data_dir, "summary.json"), {
        "generated": stamp, "market": status, "seeded": seeding,
        "settings": settings, "stocks": rows, "errors": errors,
    })
    save_json(os.path.join(data_dir, "alerts.json"), history)
    shutil.copy(os.path.join(ROOT, "config.json"), os.path.join(args.out, "config.json"))

    # app shell
    app_dir = os.path.join(ROOT, "app")
    for item in os.listdir(app_dir):
        src, dst = os.path.join(app_dir, item), os.path.join(args.out, item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy(src, dst)
    # cache-bust the service worker so phones pick up new data/app versions
    sw = os.path.join(args.out, "sw.js")
    if os.path.exists(sw):
        with open(sw, encoding="utf-8") as f:
            txt = f.read().replace("__BUILD__", now.strftime("%Y%m%d%H%M"))
        with open(sw, "w", encoding="utf-8") as f:
            f.write(txt)

    if gh_out:
        with open(gh_out, "a") as f:
            f.write("ran=true\n")
    log(f"Done: {len(rows) - len(errors)}/{len(rows)} symbols, {len(alerts.fired)} alert(s).")


if __name__ == "__main__":
    sys.exit(main())
