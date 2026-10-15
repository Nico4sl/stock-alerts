import json, sys, urllib.request
sys.path.insert(0, "engine")
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
H={"User-Agent":UA,"Accept":"application/json, text/plain, */*","Accept-Language":"en-US,en;q=0.9","Origin":"https://www.nasdaq.com","Referer":"https://www.nasdaq.com/"}
def get(u, h=H):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30) as r:
            b=r.read().decode("utf-8","replace"); return f"{r.status} len={len(b)} :: {b[:400]}"
    except Exception as e: return f"ERR {e}"
tests = {}
for s in ["SPX","NDX","COMP","DJIA","INDU","RUT","VIX","NYA","SOX","DAX","N225","FTSE"]:
    tests[f"idx-hist {s}"] = f"https://api.nasdaq.com/api/quote/{s}/historical?assetclass=index&fromdate=2026-09-01&limit=3"
tests["idx-chart SPX"]="https://api.nasdaq.com/api/quote/SPX/chart?assetclass=index"
tests["etf-screener"]="https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=3&download=true"
tests["stock-screener"]="https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=3&download=true"
tests["index-screener"]="https://api.nasdaq.com/api/screener/index?tableonly=true&limit=3"
tests["autocomplete"]="https://api.nasdaq.com/api/autocomplete/slookup/10?search=s%26p"
tests["nasdaqtrader"]="https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt"
tests["treasury"]="https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv"
tests["fred"]="https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"
tests["ecb-bund"]="https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?format=csvdata&lastNObservations=3"
tests["tlt-hist"]="https://api.nasdaq.com/api/quote/TLT/historical?assetclass=etf&fromdate=2026-09-01&limit=3"
for k,u in tests.items():
    h = H if "nasdaq.com" in u else {"User-Agent":UA}
    print("=="*3, k, "\n", get(u,h), flush=True)
