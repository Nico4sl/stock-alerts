"""
Big-mover detection and "why it moved" briefs.

- A stock that moves ±move_pct (default 3 %) vs. yesterday's close becomes a *mover*.
- For movers we collect recent headlines (Yahoo Finance + Google News) and market
  context (S&P 500, Nasdaq 100, long Treasuries, sector ETF) – shown instantly in the app.
- A Claude scheduled task reads brief-queue.json (published to the `data` branch),
  researches each mover and commits briefs/<date>-<SYMBOL>.json to the repo.
- Here we publish those briefs to the app and push a notification for new ones.
"""
import datetime as dt
import json
import os
import urllib.parse
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

MARKET = [("SPY", "S&P 500"), ("QQQ", "Nasdaq 100"), ("TLT", "Long Treasuries")]
SECTOR_ETF = {
    "AVGO": ("SMH", "Semiconductors"), "NVDA": ("SMH", "Semiconductors"), "AMAT": ("SMH", "Semiconductors"),
    "ANET": ("SMH", "Semiconductors"), "NBIS": ("IGV", "Software"), "CRWD": ("IGV", "Software"),
    "NOW": ("IGV", "Software"), "APP": ("IGV", "Software"), "META": ("XLC", "Communication"),
    "GOOG": ("XLC", "Communication"), "NFLX": ("XLC", "Communication"), "AMZN": ("XLY", "Consumer discr."),
    "MELI": ("XLY", "Consumer discr."), "AXON": ("XLI", "Industrials"), "UNH": ("XLV", "Health care"),
    "NVO": ("XLV", "Health care"), "SOFI": ("XLF", "Financials"),
}
SAFE = lambda s: "".join(ch if ch.isalnum() or ch in "-." else "_" for ch in s)  # noqa: E731


def brief_id(date, symbol):
    return f"{date}-{SAFE(symbol)}"


# ---------------------------------------------------------------- context data
def quote_change(fetch_daily, symbol):
    data = fetch_daily(symbol)
    c = data["candles"]
    if len(c) < 2:
        return None
    price = float(data["price"])
    prev = c[-2][4]
    return {"price": round(price, 2), "change_pct": round((price - prev) / prev * 100, 2)}


def market_context(fetch_daily, symbols, log):
    ctx = {}
    wanted = list(MARKET) + sorted({SECTOR_ETF[s] for s in symbols if s in SECTOR_ETF})
    for sym, name in wanted:
        try:
            q = quote_change(fetch_daily, sym)
            if q:
                ctx[sym] = {"name": name, **q}
        except Exception as e:  # noqa: BLE001
            log(f"  ! context {sym}: {e}")
    return ctx


def headlines(http_get, symbol, name, limit=8):
    items, seen = [], set()

    def add(title, publisher, url, ts):
        key = (title or "").strip().lower()[:80]
        if not title or key in seen:
            return
        seen.add(key)
        items.append({"title": title.strip(), "publisher": publisher or "", "url": url, "time": ts})

    try:  # Google News RSS (last 2 days)
        term = name if symbol.endswith("-USD") else f"{name} {symbol} stock"
        q = urllib.parse.quote(f"{term} when:2d")
        root = ET.fromstring(http_get(f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"))
        for it in root.iter("item"):
            title = it.findtext("title") or ""
            src = it.find("source")
            publisher = src.text if src is not None else ""
            if publisher and title.endswith(" - " + publisher):
                title = title[: -len(publisher) - 3]
            try:
                ts = parsedate_to_datetime(it.findtext("pubDate")).astimezone(dt.timezone.utc).isoformat()
            except Exception:  # noqa: BLE001
                ts = None
            add(title, publisher, it.findtext("link"), ts)
    except Exception:  # noqa: BLE001
        pass
    items.sort(key=lambda x: x["time"] or "", reverse=True)
    return items[:limit]


# ---------------------------------------------------------------- movers
def update_movers(rows, state, today, now_iso, settings, ctx_fn, news_fn, log):
    """Returns (movers_payload, queue_payload, new_movers)."""
    threshold = float(settings.get("move_pct", 3))
    if state.get("date") != today:
        state.clear()
        state.update({"date": today, "items": {}})
    items = state["items"]
    new = []
    for r in rows:
        if r.get("error") or r.get("change_pct") is None:
            continue
        sym, chg = r["symbol"], r["change_pct"]
        it = items.get(sym)
        if abs(chg) >= threshold and not it:
            it = items[sym] = {"first_seen": now_iso, "trigger_change": chg, "peak_change": chg}
            new.append(sym)
        if it and abs(chg) > abs(it["peak_change"]):
            it["peak_change"] = chg

    by_sym = {r["symbol"]: r for r in rows if not r.get("error")}
    movers = []
    ctx = ctx_fn(list(items)) if items else {}
    for sym, it in items.items():
        r = by_sym.get(sym)
        if not r:
            continue
        if sym in new or "headlines" not in it or it.get("news_at", "") < now_iso[:13]:
            it["headlines"] = news_fn(sym, r["name"])     # refresh at most once an hour
            it["news_at"] = now_iso[:13]
        sector = SECTOR_ETF.get(sym)
        movers.append({
            "symbol": sym, "name": r["name"], "list": r.get("list"), "price": r["price"],
            "prev_close": r.get("prev_close"), "change_pct": r["change_pct"],
            "trigger_change": it["trigger_change"], "peak_change": it["peak_change"],
            "first_seen": it["first_seen"],
            "sector": ({"etf": sector[0], "name": sector[1], **ctx.get(sector[0], {})} if sector else None),
            "chart": {k: r.get("dist", {}).get(k) for k in ("ema8", "ema21", "sma50", "sma200")}
                     | {"momentum": r.get("momentum")},
            "headlines": it.get("headlines", []),
            "brief": None,
        })
    movers.sort(key=lambda m: -abs(m["change_pct"]))
    market = {k: v for k, v in ctx.items() if k in dict(MARKET)}
    payload = {"date": today, "threshold": threshold, "updated": now_iso, "market": market, "movers": movers}
    queue = {"date": today, "threshold": threshold,
             "movers": [{"id": brief_id(today, m["symbol"]), "symbol": m["symbol"], "name": m["name"],
                         "list": m["list"], "trigger_change": m["trigger_change"], "first_seen": m["first_seen"]}
                        for m in sorted(movers, key=lambda m: m["first_seen"])]}
    return payload, queue, new


def mover_alert(m, app_url, link_fn):
    top = m["headlines"][0]["title"] if m["headlines"] else "No headline yet – brief follows."
    return {"symbol": m["symbol"], "name": m["name"], "kind": "mover",
            "title": f"{m['symbol']} {m['change_pct']:+.1f}% today",
            "message": f"{m['name']} is moving {m['change_pct']:+.1f}%. Top headline: {top} "
                       f"Claude's brief on the catalyst follows within ~1 h.",
            "tags": ["zap"], "priority": 4, "click": link_fn(m["symbol"]), "price": m["price"]}


# ---------------------------------------------------------------- briefs
def publish_briefs(root, out_dir, today, seen, seeding, lang, app_url, log):
    """Copy briefs/ into the site, build an index, return notifications for new briefs."""
    src = os.path.join(root, "briefs")
    dst = os.path.join(out_dir, "data", "briefs")
    os.makedirs(dst, exist_ok=True)
    briefs = []
    if os.path.isdir(src):
        for fn in sorted(os.listdir(src)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(src, fn), encoding="utf-8") as f:
                    b = json.load(f)
                assert b.get("symbol") and b.get("date") and b.get("en", {}).get("title")
            except Exception as e:  # noqa: BLE001
                log(f"  ! skipping brief {fn}: {e}")
                continue
            b["id"] = b.get("id") or fn[:-5]
            briefs.append(b)
            with open(os.path.join(dst, f"{b['id']}.json"), "w", encoding="utf-8") as f:
                json.dump(b, f, ensure_ascii=False, separators=(",", ":"))
    briefs.sort(key=lambda b: (b["date"], b.get("written_at", "")), reverse=True)
    index = [{
        "id": b["id"], "symbol": b["symbol"], "name": b.get("name", b["symbol"]), "date": b["date"],
        "change_pct": b.get("change_pct"), "driver": b.get("driver"), "written_at": b.get("written_at"),
        "en": {k: b.get("en", {}).get(k) for k in ("title", "tldr")},
        "de": {k: b.get("de", {}).get(k) for k in ("title", "tldr")},
    } for b in briefs[:150]]
    with open(os.path.join(dst, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    notes = []
    for b in briefs:
        if b["id"] in seen:
            continue
        seen.add(b["id"])
        if seeding or b["date"] < (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat():
            continue
        t = b.get(lang) or b["en"]
        chg = b.get("change_pct")
        notes.append({"symbol": b["symbol"], "name": b.get("name", b["symbol"]), "kind": "brief",
                      "title": f"Why {b['symbol']} moved {chg:+.1f}%" if chg is not None else f"{b['symbol']}: what's going on",
                      "message": f"{t.get('title', '')} – {t.get('tldr', '')}",
                      "tags": ["newspaper"], "priority": 4,
                      "click": f"{app_url}#/brief/{b['id']}" if app_url else None, "brief": b["id"]})
    return index, notes
