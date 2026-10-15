import sys, json
sys.path.insert(0, "engine")
import lookup as lk, check as ck
for s in ["DE10Y","DE2Y","DE30Y","^NDX","^COMP"]:
    lk.lookup(s, "out", "")
    d = json.load(open(f"out/{lk.mv.SAFE(s)}.json"))
    if "error" in d: print(s, "ERROR", d["error"]); continue
    sm = d["summary"]; print(s, sm["price"], sm["change_pct"], len(d["detail"]["t"]), d["detail"]["t"][-1])
try:
    t = ck.http_get("https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?format=csv&lastNObservations=800", timeout=45)
    print(len(t)); print(t[:800]); print(t[-300:])
except Exception as e: print("ERR", e)
