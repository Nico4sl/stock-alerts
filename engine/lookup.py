#!/usr/bin/env python3
"""
Search support for the app.

1. build_directory()  – a compact list of everything the search box can find:
   US stocks & ADRs, ETFs (Nasdaq screener), indices (Cboe + Nasdaq),
   US Treasury and German Bund yields, major crypto. Rebuilt once a day by check.py.
2. CLI `python3 engine/lookup.py SYMBOL --out DIR` – run by the "Lookup" workflow when you
   open a symbol from search: fetches the data, computes the same EMAs/SMAs/gaps as for your
   lists and writes DIR/<SAFE>.json. Nothing is added to config.json and no alerts are sent.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check as ck  # noqa: E402
import movers as mv  # noqa: E402

SYMBOL_RE = re.compile(r"^[A-Z0-9.^\-]{1,15}$")

# type codes used in symbols.json: S stock · E ETF · I index · B bond yield · C crypto
STATIC = [
    ["^SPX", "S&P 500", "I"], ["^NDX", "Nasdaq 100", "I"], ["^DJI", "Dow Jones Industrial Average", "I"],
    ["^COMP", "Nasdaq Composite", "I"], ["^RUT", "Russell 2000", "I"], ["^VIX", "Cboe Volatility Index (VIX)", "I"],
    ["^SOX", "PHLX Semiconductor Index", "I"],
    ["US3M", "US Treasury 3-month yield", "B"], ["US6M", "US Treasury 6-month yield", "B"],
    ["US1Y", "US Treasury 1-year yield", "B"], ["US2Y", "US Treasury 2-year yield", "B"],
    ["US5Y", "US Treasury 5-year yield", "B"], ["US7Y", "US Treasury 7-year yield", "B"],
    ["US10Y", "US Treasury 10-year yield", "B"], ["US20Y", "US Treasury 20-year yield", "B"],
    ["US30Y", "US Treasury 30-year yield", "B"],
    ["DE2Y", "German Bund 2-year yield", "B"], ["DE5Y", "German Bund 5-year yield", "B"],
    ["DE10Y", "German Bund 10-year yield", "B"], ["DE30Y", "German Bund 30-year yield", "B"],
    ["BTC-USD", "Bitcoin", "C"], ["ETH-USD", "Ethereum", "C"], ["SOL-USD", "Solana", "C"],
    ["XRP-USD", "XRP", "C"], ["ADA-USD", "Cardano", "C"], ["DOGE-USD", "Dogecoin", "C"],
    ["LINK-USD", "Chainlink", "C"], ["DOT-USD", "Polkadot", "C"], ["AVAX-USD", "Avalanche", "C"],
    ["LTC-USD", "Litecoin", "C"], ["BTC-EUR", "Bitcoin (EUR)", "C"], ["ETH-EUR", "Ethereum (EUR)", "C"],
]
STATIC_RANK = 10_000_000          # indices/yields/crypto rank above everything else
POPULAR_ETF = set("""SPY VOO IVV VTI QQQ QQQM DIA IWM VEA VWO EFA EEM VXUS ACWI VT TLT IEF SHY BND AGG
HYG LQD TIP GOVT SGOV BIL VGIT VGLT EMB GLD IAU SLV USO SMH SOXX XLK XLF XLE XLV XLY XLP XLI XLB XLU
XLRE XLC IGV ARKK SCHD VIG VYM IBIT FBTC ETHA RSP MTUM QUAL USMV VNQ IEMG IJH IJR""".split())
NAME_TRIM = re.compile(r"\s+(Class [A-C] )?(Common Stock|Ordinary Shares|Common Shares|Capital Stock)"
                       r"(\s*\(.*\))?$|,?\s+Inc\.?$|\s+(Trust )?Units?$", re.I)


def _rows(raw):
    d = raw.get("data") or {}
    if "rows" in d:
        return d.get("rows") or []
    for key in ("data", "table"):
        inner = d.get(key) or {}
        if isinstance(inner, dict) and inner.get("rows"):
            return inner["rows"]
    rec = (d.get("records") or {}).get("data") or {}
    return rec.get("rows") or []


def _nasdaq_json(path):
    return json.loads(ck.http_get(f"https://api.nasdaq.com/api/{path}", timeout=45, headers=ck.NASDAQ_HEADERS))


def _mcap(x):
    try:
        return int(float(str(x).replace(",", "")) / 1e6)
    except (TypeError, ValueError):
        return 0


def build_directory(log=print):
    items, seen = [], set()

    def add(sym, name, t, rank=0):
        sym = (sym or "").strip().upper()
        if not sym or sym in seen or not SYMBOL_RE.match(sym):
            return
        seen.add(sym)
        name = NAME_TRIM.sub("", (name or sym).strip()).strip() or sym
        items.append([sym, name[:70], t, rank])

    for sym, name, t in STATIC:
        add(sym, name, t, STATIC_RANK)
    try:
        for r in _rows(_nasdaq_json("screener/index?tableonly=true&limit=200")):
            add("^" + (r.get("symbol") or ""), r.get("companyName"), "I", STATIC_RANK // 10)
    except Exception as e:  # noqa: BLE001
        log(f"  ! index list: {e}")
    n_stocks = 0
    try:
        for r in _rows(_nasdaq_json("screener/stocks?tableonly=true&download=true")):
            sym = (r.get("symbol") or "").replace("/", ".").strip()
            if "^" in sym:          # preferred shares
                continue
            add(sym, r.get("name"), "S", _mcap(r.get("marketCap")))
            n_stocks += 1
    except Exception as e:  # noqa: BLE001
        log(f"  ! stock list: {e}")
    try:
        for r in _rows(_nasdaq_json("screener/etf?tableonly=true&download=true")):
            sym = (r.get("symbol") or "").strip()
            add(sym, r.get("companyName"), "E", 2_000_000 if sym in POPULAR_ETF else 1)
    except Exception as e:  # noqa: BLE001
        log(f"  ! ETF list: {e}")
    items.sort(key=lambda x: -x[3])          # biggest first: the app keeps this order
    log(f"  symbol directory: {len(items)} entries ({n_stocks} stocks)")
    if n_stocks < 1000:
        raise RuntimeError("stock list looks incomplete")
    return [x[:3] for x in items]


def ensure_directory(state_dir, out_dir, today, log=print):
    """Rebuild symbols.json at most once a day; always copy the last good one to the site."""
    path = os.path.join(state_dir, "symbols.json")
    cur = ck.load_json(path, None)
    if not cur or cur.get("date") != today:
        try:
            cur = {"date": today, "items": build_directory(log)}
            ck.save_json(path, cur, compact=True)
        except Exception as e:  # noqa: BLE001
            log(f"  ! symbol directory not rebuilt: {e}")
    if cur:
        ck.save_json(os.path.join(out_dir, "data", "symbols.json"), cur, compact=True)


def lookup(symbol, out_dir, name=""):
    symbol = symbol.strip().upper()
    if not SYMBOL_RE.match(symbol):
        raise SystemExit(f"invalid symbol: {symbol!r}")
    config = ck.load_json(os.path.join(ck.ROOT, "config.json"), {})
    settings = config.get("settings", {})
    names = {s[0]: s[1] for s in STATIC}
    name = re.sub(r"[^\w .,&()'/+-]", "", name or "")[:70].strip()
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = {"symbol": symbol, "generated": stamp}
    try:
        data = ck.fetch_daily(symbol)
        stock = {"symbol": symbol, "name": name or names.get(symbol, symbol), "list": "lookup", "levels": []}
        silent = ck.Alerts({}, seeding=True)      # compute everything, alert nothing
        summary, detail = ck.analyse(stock, data, settings, silent, "")
        summary["close_only"] = detail["close_only"] = bool(data.get("close_only"))
        out.update({"summary": summary, "detail": detail})
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:300]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{mv.SAFE(symbol)}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)
    print(("ERROR " + out["error"]) if "error" in out else f"wrote {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("--name", default="")
    ap.add_argument("--out", default="lookup-out")
    a = ap.parse_args()
    lookup(a.symbol, a.out, a.name)
