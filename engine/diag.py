import json, urllib.request, http.cookiejar, traceback, time
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
out = []
def get(name, url, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    try:
        r = op.open(urllib.request.Request(url, headers=h), timeout=20)
        body = r.read().decode("utf-8", "replace")
        out.append(f"== {name}: {r.status} len={len(body)}\n{body[:300]}\n")
        return body
    except urllib.error.HTTPError as e:
        out.append(f"== {name}: HTTP {e.code} {e.read()[:300]!r}\n")
    except Exception as e:
        out.append(f"== {name}: ERR {e!r}\n")
    return None
get("yahoo q1 plain", "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d")
get("yahoo q2 plain", "https://query2.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d")
get("fc.yahoo cookie", "https://fc.yahoo.com")
out.append(f"cookies: {[c.name for c in jar]}\n")
crumb = get("crumb", "https://query2.finance.yahoo.com/v1/test/getcrumb")
if crumb and len(crumb) < 40:
    get("yahoo with crumb", f"https://query2.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d&crumb={crumb}")
get("yahoo search news", "https://query2.finance.yahoo.com/v1/finance/search?q=NVDA&quotesCount=0&newsCount=3")
nh = {"Accept": "application/json, text/plain, */*", "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}
get("nasdaq hist stock", "https://api.nasdaq.com/api/quote/NVDA/historical?assetclass=stocks&fromdate=2026-09-01&limit=5", nh)
get("nasdaq info stock", "https://api.nasdaq.com/api/quote/NVDA/info?assetclass=stocks", nh)
get("nasdaq hist etf", "https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=2026-09-01&limit=3", nh)
get("kraken", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440")
get("coinbase", "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400")
get("stooq", "https://stooq.com/q/d/l/?s=nvda.us&i=d")
get("google news", "https://news.google.com/rss/search?q=Nvidia%20stock%20when:2d&hl=en-US&gl=US&ceid=US:en")
get("cnbc quote", "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=NVDA&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json")
open("diag.txt", "w").write("\n".join(out))
print("\n".join(out))
