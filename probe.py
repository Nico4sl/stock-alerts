import sys, json, datetime as dt
sys.path.insert(0, "engine")
import check as ck
for sym, asset in [("AAPL","stocks"),("SPY","etf"),("NBIS","stocks"),("NDX","index")]:
    for yrs in (10, 15, 20):
        start=(dt.date.today()-dt.timedelta(days=365*yrs)).isoformat()
        try:
            h=ck._nasdaq(f"{sym}/historical?assetclass={asset}&fromdate={start}&limit=9999")
            rows=h["tradesTable"]["rows"]; print(sym, yrs, len(rows), rows[-1]["date"], h.get("totalRecords"))
        except Exception as e: print(sym, yrs, "ERR", e)
import urllib.request
for iv in (10080, 21600):
    r=json.loads(ck.http_get(f"https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval={iv}"))
    s=next(v for k,v in r["result"].items() if k!="last"); print("kraken", iv, len(s), dt.datetime.utcfromtimestamp(s[0][0]).date(), dt.datetime.utcfromtimestamp(s[0][0]).strftime("%a"))
