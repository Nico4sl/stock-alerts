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
import csv
import hashlib
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
HISTORY_YEARS = 15        # fetched for weekly/monthly charts; daily output + alerts use the last 3 years
DAILY_YEARS = 3
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
def http_get(url, timeout=20, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


NASDAQ_HEADERS = {"Accept": "application/json, text/plain, */*",
                  "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}


def _num(x):
    if x is None:
        return None
    x = str(x).replace("$", "").replace(",", "").strip()
    try:
        return float(x)
    except ValueError:
        return None


def _nasdaq(path):
    raw = json.loads(http_get(f"https://api.nasdaq.com/api/quote/{path}", headers=NASDAQ_HEADERS))
    return raw.get("data")


def fetch_nasdaq(symbol, years=HISTORY_YEARS, min_len=30, assets=("stocks", "etf")):
    """Daily candles from Nasdaq.com (stocks, ADRs, ETFs) + today's live candle.
    Asking for 15 years returns the maximum Nasdaq has (10 y for stocks, more for indices);
    if that ever comes back empty we fall back to 3 years."""
    q = urllib.parse.quote(symbol)
    hist, asset = None, None
    for yrs in (years, 3):
        start = (dt.date.today() - dt.timedelta(days=365 * yrs + 10)).isoformat()
        for asset in assets:
            hist = _nasdaq(f"{q}/historical?assetclass={asset}&fromdate={start}&limit=9999")
            if hist and (hist.get("tradesTable") or {}).get("rows"):
                break
            hist = None
        if hist:
            break
    if not hist:
        raise RuntimeError(f"Nasdaq has no data for {symbol}")
    rows = {}
    for r in hist["tradesTable"]["rows"]:
        try:
            d = dt.datetime.strptime(r["date"], "%m/%d/%Y").strftime("%Y-%m-%d")
        except (KeyError, ValueError):
            continue
        o, h, l, c = _num(r.get("open")), _num(r.get("high")), _num(r.get("low")), _num(r.get("close"))
        if None in (o, h, l, c) or c <= 0:
            continue
        rows[d] = [d, o or c, h or c, l or c, c, _num(r.get("volume")) or 0]
    candles = [rows[k] for k in sorted(rows)]
    if len(candles) < min_len:
        raise RuntimeError(f"Nasdaq returned too little history for {symbol}")

    price, market_time = candles[-1][4], None
    try:  # live price + today's candle from the intraday chart
        live = _nasdaq(f"{q}/chart?assetclass={asset}")
        last = _num(live.get("lastSalePrice"))
        asof = (live.get("timeAsOf") or "").replace(" ET", "")
        when = None
        for f in ("%b %d, %Y %I:%M %p", "%b %d, %Y"):
            try:
                when = dt.datetime.strptime(asof, f).replace(tzinfo=NY)
                break
            except ValueError:
                continue
        if last:
            price = last
        if when and last:
            market_time = int(when.timestamp())
            day = when.strftime("%Y-%m-%d")
            pts = []
            for p in live.get("chart") or []:
                t = dt.datetime.fromtimestamp(p["x"] / 1000, dt.timezone.utc)
                # Nasdaq's x is wall-clock New York time encoded as UTC
                mins = t.hour * 60 + t.minute
                if 9 * 60 + 30 <= mins <= 16 * 60 and p.get("y") is not None:
                    pts.append(float(p["y"]))
            if day > candles[-1][0] and pts:
                candles.append([day, pts[0], max(pts + [last]), min(pts + [last]), last,
                                _num(live.get("volume")) or 0])
            elif day == candles[-1][0]:
                bar = candles[-1]
                bar[4] = last
                bar[2], bar[3] = max(bar[2], last), min(bar[3], last)
    except Exception as e:  # noqa: BLE001
        log(f"  (live price unavailable for {symbol}: {e})")
    return {"candles": candles, "price": price, "currency": "USD",
            "market_time": market_time, "source": "Nasdaq"}


def fetch_crypto(symbol, min_len=30):
    """Daily candles for e.g. BTC-USD from Kraken (fallback Coinbase). No key needed."""
    base, quote = symbol.upper().split("-", 1)
    kbase = {"BTC": "XBT", "DOGE": "XDG"}.get(base, base)
    candles = []
    try:
        raw = json.loads(http_get(f"https://api.kraken.com/0/public/OHLC?pair={kbase}{quote}&interval=1440"))
        if raw.get("error"):
            raise RuntimeError(raw["error"])
        series = next(v for k, v in raw["result"].items() if k != "last")
        for t, o, h, l, c, _vw, v, _n in series:
            d = dt.datetime.fromtimestamp(int(t), dt.timezone.utc).strftime("%Y-%m-%d")
            candles.append([d, float(o), float(h), float(l), float(c), float(v)])
        source = "Kraken"
    except Exception as e:  # noqa: BLE001
        log(f"  ! Kraken: {e} – trying Coinbase")
        raw = json.loads(http_get(f"https://api.exchange.coinbase.com/products/{base}-{quote}/candles?granularity=86400"))
        for t, l, h, o, c, v in sorted(raw):
            d = dt.datetime.fromtimestamp(int(t), dt.timezone.utc).strftime("%Y-%m-%d")
            candles.append([d, float(o), float(h), float(l), float(c), float(v)])
        source = "Coinbase"
    if len(candles) < min_len:
        raise RuntimeError(f"no crypto data for {symbol}")
    return {"candles": candles, "price": candles[-1][4], "currency": quote,
            "market_time": None, "source": source}


# ---- indices (Cboe + Nasdaq) and government bond yields ---------------------
# App symbols: indices start with "^", yields look like US10Y / DE10Y.
CBOE_INDEX = {   # app symbol -> (Cboe symbol, scale, name)
    "^SPX": ("_SPX", 1, "S&P 500"),
    "^DJI": ("_DJX", 100, "Dow Jones Industrial Average"),
    "^RUT": ("_RUT", 1, "Russell 2000"),
    "^VIX": ("_VIX", 1, "Cboe Volatility Index (VIX)"),
}
US_YIELDS = {"US1M": "1 Mo", "US3M": "3 Mo", "US6M": "6 Mo", "US1Y": "1 Yr", "US2Y": "2 Yr",
             "US3Y": "3 Yr", "US5Y": "5 Yr", "US7Y": "7 Yr", "US10Y": "10 Yr", "US20Y": "20 Yr",
             "US30Y": "30 Yr"}
DE_YIELDS = {"DE2Y": "R02XX", "DE5Y": "R05XX", "DE10Y": "R10XX", "DE30Y": "R30XX"}


def _cut_years(candles, years=3):
    start = (dt.date.today() - dt.timedelta(days=365 * years + 10)).isoformat()
    return [c for c in candles if c[0] >= start]


def fetch_cboe(symbol, min_len=30):
    csym, scale, _ = CBOE_INDEX[symbol]
    raw = json.loads(http_get(f"https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/{csym}.json"))
    candles = []
    for r in raw.get("data", []):
        o, h, l, c = (_num(r.get(k)) for k in ("open", "high", "low", "close"))
        if not c:
            continue
        o = o or c
        h, l = max(h or c, o, c), min(l or c, o, c)
        candles.append([r["date"], o * scale, h * scale, l * scale, c * scale, 0])
    candles = _cut_years(sorted(candles), HISTORY_YEARS)
    price, market_time = candles[-1][4] if candles else None, None
    try:  # delayed live quote (~15 min) for today's candle
        q = json.loads(http_get(f"https://cdn.cboe.com/api/global/delayed_quotes/quotes/{csym}.json"))["data"]
        last = _num(q.get("current_price"))
        when = q.get("last_trade_time") or ""
        day = when[:10]
        if last and day:
            last *= scale
            price = last
            market_time = int(dt.datetime.fromisoformat(when).replace(tzinfo=NY).timestamp())
            if candles and day > candles[-1][0]:
                o = (_num(q.get("open")) or 0) * scale or last
                h = max((_num(q.get("high")) or 0) * scale, o, last)
                lo = min((_num(q.get("low")) or 0) * scale or last, o, last)
                candles.append([day, o, h, lo, last, 0])
            elif candles and day == candles[-1][0]:
                bar = candles[-1]
                bar[4] = last
                bar[2], bar[3] = max(bar[2], last), min(bar[3], last)
    except Exception as e:  # noqa: BLE001
        log(f"  (live quote unavailable for {symbol}: {e})")
    if len(candles) < min_len:
        raise RuntimeError(f"Cboe returned too little history for {symbol}")
    return {"candles": candles, "price": price, "currency": "pts", "market_time": market_time,
            "source": "Cboe (15 min delayed)"}


def fetch_nasdaq_index(symbol, min_len=30):
    d = fetch_nasdaq(symbol[1:], min_len=min_len, assets=("index",))
    d["currency"] = "pts"
    return d


def _close_only(points, source, min_len, symbol):
    candles = [[d, v, v, v, v, 0] for d, v in sorted(points.items())]
    candles = _cut_years(candles, HISTORY_YEARS)
    if len(candles) < min_len:
        raise RuntimeError(f"{source} returned too little history for {symbol}")
    return {"candles": candles, "price": candles[-1][4], "currency": "%", "market_time": None,
            "source": source, "close_only": True}


def fetch_us_yield(symbol, min_len=30):
    col = US_YIELDS[symbol]
    points = {}
    year = dt.date.today().year
    for y in range(year - 10, year + 1):
        try:
            text = http_get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
                            f"daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve"
                            f"&field_tdr_date_value={y}&page&_format=csv")
        except Exception as e:  # noqa: BLE001
            log(f"  ! Treasury {y}: {e}")
            continue
        rows = list(csv.reader(text.splitlines()))
        if not rows:
            continue
        head = [h.strip() for h in rows[0]]
        if col not in head:
            continue
        i = head.index(col)
        for r in rows[1:]:
            try:
                d = dt.datetime.strptime(r[0], "%m/%d/%Y").strftime("%Y-%m-%d")
                v = float(r[i])
            except (ValueError, IndexError):
                continue
            points[d] = v
    return _close_only(points, "U.S. Treasury (daily close)", min_len, symbol)


def fetch_de_yield(symbol, min_len=30):
    code = DE_YIELDS[symbol]
    text = http_get("https://api.statistiken.bundesbank.de/rest/data/BBSIS/"
                    f"D.I.ZST.ZI.EUR.S1311.B.A604.{code}.R.A.A._Z._Z.A?format=csv&lastNObservations=3700",
                    timeout=45)
    points = {}
    for ln in text.splitlines():
        p = ln.split(";") if ";" in ln else ln.split(",")    # German or English CSV
        if len(p) >= 2 and len(p[0]) == 10 and p[0][4] == "-":
            try:
                points[p[0]] = float(p[1].replace(",", "."))
            except ValueError:
                continue
    return _close_only(points, "Deutsche Bundesbank (daily)", min_len, symbol)


def fetch_daily(symbol, min_len=30):
    symbol = symbol.upper()
    if symbol in CBOE_INDEX:
        return fetch_cboe(symbol, min_len)
    if symbol.startswith("^"):
        return fetch_nasdaq_index(symbol, min_len)
    if symbol in US_YIELDS:
        return fetch_us_yield(symbol, min_len)
    if symbol in DE_YIELDS:
        return fetch_de_yield(symbol, min_len)
    if "-" in symbol and symbol.split("-")[1] in ("USD", "EUR", "USDT"):
        return fetch_crypto(symbol, min_len)
    try:
        return fetch_nasdaq(symbol, min_len=min_len)
    except Exception as e:  # noqa: BLE001
        log(f"  ! {e} – trying Yahoo")
        return fetch_yahoo(symbol, min_len=min_len)


def fetch_yahoo(symbol, rng="10y", min_len=30):
    """Last-resort fallback (Yahoo often blocks GitHub's servers)."""
    q = urllib.parse.quote(symbol)
    raw = json.loads(http_get(f"https://query2.finance.yahoo.com/v8/finance/chart/{q}?range={rng}&interval=1d"))
    res = raw["chart"]["result"][0]
    qd, off = res["indicators"]["quote"][0], res["meta"].get("gmtoffset", 0)
    rows = {}
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, c, v = (qd[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue
        d = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).strftime("%Y-%m-%d")
        rows[d] = [d, o, h, l, c, v or 0]
    candles = [rows[k] for k in sorted(rows)]
    if len(candles) < min_len:
        raise RuntimeError(f"no data for {symbol}")
    return {"candles": candles, "price": res["meta"].get("regularMarketPrice") or candles[-1][4],
            "currency": res["meta"].get("currency", "USD"), "market_time": None, "source": "Yahoo Finance"}


fetch = fetch_daily


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


def resample(candles, tf):
    """Daily candles -> weekly (Mon–Fri) or monthly candles, labelled with their first trading day."""
    out, key_prev = [], None
    for d, o, h, l, c, v in candles:
        day = dt.date.fromisoformat(d)
        key = (day - dt.timedelta(days=day.weekday())) if tf == "w" else (day.year, day.month)
        if key != key_prev:
            out.append([d, o, h, l, c, v or 0])
            key_prev = key
        else:
            bar = out[-1]
            bar[2], bar[3], bar[4] = max(bar[2], h), min(bar[3], l), c
            bar[5] += v or 0
    return out


def timeframe(full, tf, price):
    bars = resample(full, tf)
    closes = [b[4] for b in bars]
    ser = {f"ema{n}": ema(closes, n) for n in EMA_LENGTHS}
    ser.update({f"sma{n}": sma(closes, n) for n in SMA_LENGTHS})
    return {
        "t": [b[0] for b in bars],
        "o": [rnd(b[1], price) for b in bars], "h": [rnd(b[2], price) for b in bars],
        "l": [rnd(b[3], price) for b in bars], "c": [rnd(b[4], price) for b in bars],
        "v": [int(b[5]) for b in bars],
        **{key: [rnd(x, price) for x in v] for key, v in ser.items()},
    }


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

    full = data["candles"]
    full_closes = [c[4] for c in full]
    series_full = {f"ema{n}": ema(full_closes, n) for n in EMA_LENGTHS}
    series_full.update({f"sma{n}": sma(full_closes, n) for n in SMA_LENGTHS})
    cut = (dt.date.today() - dt.timedelta(days=365 * DAILY_YEARS + 10)).isoformat()
    k = next((i for i, c in enumerate(full) if c[0] >= cut), 0)
    candles = full[k:]
    closes = full_closes[k:]
    series = {key: v[k:] for key, v in series_full.items()}
    price = float(data["price"])
    prev_close = closes[-2] if len(closes) > 1 else price
    change_pct = pct(price, prev_close)
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
    # close-only series (bond yields) have no real highs/lows, so no gaps
    gaps = [] if data.get("close_only") else find_gaps(candles, float(settings.get("min_gap_pct", 0.5)))
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
        "close_only": bool(data.get("close_only")),
        "spark": [rnd(c, price) for c in closes[-30:]],
    }

    detail = {
        "symbol": sym, "name": name, "source": data.get("source"),
        "close_only": bool(data.get("close_only")), "currency": data.get("currency", "USD"),
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
        "w": timeframe(full, "w", price),
        "m": timeframe(full, "m", price),
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


PUSH_OFF_KINDS = {"ema8", "ema21"}   # in-app only unless settings.ema_push is true


def deliver(alerts, topic, server, app_url, settings=None):
    settings = settings or {}
    if not settings.get("ema_push", False):
        quiet = [a for a in alerts if a.get("kind") in PUSH_OFF_KINDS]
        if quiet:
            log(f"  {len(quiet)} EMA alert(s) kept in the app only (no push)")
        alerts = [a for a in alerts if a.get("kind") not in PUSH_OFF_KINDS]
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
        ctx_fn = lambda syms: mv.market_context(lambda x: fetch_daily(x, 2), syms, log)  # noqa: E731
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

    # ---- symbol directory for the app's search (rebuilt once a day) ----------
    if not args.fixtures:
        import lookup as lk  # noqa: PLC0415
        lk.ensure_directory(args.state, args.out, today_ny, log)

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
    deliver(alerts.fired, topic, server, args.app_url, settings)
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
    # version the service worker by the app code itself: phones update when the app
    # changes (and reload into it), not on every price check
    sw = os.path.join(args.out, "sw.js")
    if os.path.exists(sw):
        h = hashlib.sha1()
        for name in sorted(os.listdir(app_dir)):
            fp = os.path.join(app_dir, name)
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    h.update(name.encode() + f.read())
        with open(sw, encoding="utf-8") as f:
            txt = f.read().replace("__BUILD__", h.hexdigest()[:12])
        with open(sw, "w", encoding="utf-8") as f:
            f.write(txt)

    if gh_out:
        with open(gh_out, "a") as f:
            f.write("ran=true\n")
    log(f"Done: {len(rows) - len(errors)}/{len(rows)} symbols, {len(alerts.fired)} alert(s).")


if __name__ == "__main__":
    sys.exit(main())
