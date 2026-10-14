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
        out.append(f"== {name}: {r.status} len={len(body)}\n{body[:1600]}\n")
        return body
    except urllib.error.HTTPError as e:
        out.append(f"== {name}: HTTP {e.code} {e.read()[:300]!r}\n")
    except Exception as e:
        out.append(f"== {name}: ERR {e!r}\n")
    return None
nh = {"Accept": "application/json, text/plain, */*", "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}
b = get("nasdaq chart", "https://api.nasdaq.com/api/quote/NVDA/chart?assetclass=stocks", nh)
if b:
    try:
        d = json.loads(b)["data"]; out.append("chart keys: %s; first pts: %s; last: %s\n" % (list(d.keys()), d["chart"][:2], d["chart"][-1:]))
    except Exception as e: out.append(f"chart parse {e!r}\n")
get("nasdaq summary", "https://api.nasdaq.com/api/quote/NVDA/summary?assetclass=stocks", nh)
get("nasdaq info full", "https://api.nasdaq.com/api/quote/NVDA/info?assetclass=stocks", nh)
get("nasdaq hist NVO", "https://api.nasdaq.com/api/quote/NVO/historical?assetclass=stocks&fromdate=2026-09-01&limit=2", nh)
get("nasdaq VIX index", "https://api.nasdaq.com/api/quote/VIX/info?assetclass=index", nh)
get("nasdaq hist 3y count", "https://api.nasdaq.com/api/quote/AVGO/historical?assetclass=stocks&fromdate=2023-10-01&limit=9999", nh)
open("diag.txt", "w").write("\n".join(out))
print("\n".join(out))
