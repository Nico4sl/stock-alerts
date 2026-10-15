import json, sys, urllib.request
sys.path.insert(0, "engine")
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
H={"User-Agent":UA,"Accept":"application/json, text/plain, */*","Accept-Language":"en-US,en;q=0.9","Origin":"https://www.nasdaq.com","Referer":"https://www.nasdaq.com/"}
def get(u, h=H):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30) as r:
            b=r.read().decode("utf-8","replace"); return f"{r.status} len={len(b)} :: {b[:3000]}"
    except Exception as e: return f"ERR {e}"
tests = {}
for s in ["_SPX","_DJX","_RUT","_VIX","_NDX","_XSP","_DJI"]:
    tests["cboe "+s]=f"https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/{s}.json"
tests["cboe quote _SPX"]="https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json"
tests["cboe vix csv"]="https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
tests["buba 10y"]="https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?format=csv&lastNObservations=3"
tests["brk.b"]="https://api.nasdaq.com/api/quote/BRK.B/historical?assetclass=stocks&fromdate=2026-10-01&limit=2"
tests["brk/b"]="https://api.nasdaq.com/api/quote/BRK%25sB/historical?assetclass=stocks&fromdate=2026-10-01&limit=2"
tests["idx screener all"]="https://api.nasdaq.com/api/screener/index?tableonly=true&limit=100"
for k,u in tests.items():
    h = H if "nasdaq.com" in u else {"User-Agent":UA}
    r=get(u,h); print("=="*3, k, "\n", r if "screener" not in k else r[:3000], flush=True)
