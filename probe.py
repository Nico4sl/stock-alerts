import subprocess, sys, json, os
sys.path.insert(0, "engine")
import lookup as lk
for s in ["AAPL","BRK.B","TLT","^SPX","^DJI","^NDX","^VIX","^RUT","US10Y","US2Y","DE10Y","ETH-USD","NVO"]:
    lk.lookup(s, "out")
    d = json.load(open(f"out/{lk.mv.SAFE(s)}.json"))
    if "error" in d: print(s, "ERROR", d["error"]); continue
    sm = d["summary"]; dt_ = d["detail"]
    print(s, sm["name"], sm["price"], sm["change_pct"], "bars", len(dt_["t"]), dt_["t"][0], dt_["t"][-1], "gaps", sm["open_gap_count"], "src", sm["source"], "size", os.path.getsize(f"out/{lk.mv.SAFE(s)}.json"))
items = lk.build_directory()
print("dir", len(items), "bytes", len(json.dumps(items, separators=(",",":"))))
for q in ["AAPL","NVO","SPY","BRK.B","^NDX","^SOX"]: print([i for i in items if i[0]==q])
print(items[:5], items[40:45], [i for i in items if i[2]=="E"][:5])
