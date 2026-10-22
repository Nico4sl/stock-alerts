# Pullback – levels & alerts

A personal chart and alert app for your watchlist and portfolio, based on Babyfolio's
["Technical Analysis: Keeping It Simple"](https://edelbridge.substack.com/p/technical-analysis-keeping-it-simple).

- **3 charts per stock:** 8/21 EMA · 50/100/150/200 SMA · open gaps (pan and pinch like TradingView)
- **Push alerts** while the NYSE is open (checks about every 5 min):
  - Entry 1: price within ±1.5 % of the **8 EMA**
  - Entry 2: price within ±1.5 % of the **21 EMA**
  - **200 SMA** zone for ★ high-conviction names (other SMAs can be switched on)
  - **Extended**: price 15 %+ above the 8 EMA (possible trim)
  - **Gaps**: approaching or filling an open gap, gap fully filled
  - **Your own levels**: support, resistance, price above or below
- **"Why it moved" briefs:** when a stock moves ±3 % in a day, you get a push with the top headline
  right away. Within about an hour Claude researches the catalyst (company, sector or macro) and writes a short read
  in English and German, with what happened, why the market cares, context, one concept to learn and sources.
  It pops up when you open the app.
- **Fed tab:** the current fed funds target range (live), a countdown to the next FOMC decision in your
  time zone, and a short read on where the Fed stands – rates, inflation focus, balance sheet (QT/QE),
  projections and upcoming meetings – in English or German. Claude refreshes it after every decision.
- **Search:** look up any US stock, ETF or ADR, the S&P 500 / Nasdaq 100 / Dow / Russell 2000 / VIX
  (and other Nasdaq indices), US Treasury and German Bund yields, and major crypto – same three charts,
  without adding it to a list. Tap **+ Watchlist** if you want alerts for it.
- Works on **Android** (home-screen app) and **Mac** (Dock app). Free: GitHub + ntfy, no other accounts.

---

## One-time setup (about 10 min)

### 1 · Notifications (phone)
1. Install **ntfy** from the Play Store. No sign-up is needed.
2. Make up a private topic: a long random name (30+ letters and digits). It works like a password –
   anyone who knows it can read your alerts or send fake ones – so **never write it into this repo**
   (the repo is public). Keep it only in the GitHub secret below and in the ntfy app.
3. In ntfy tap **+** and subscribe to that topic.
4. Android: allow ntfy notifications, and set battery use for ntfy to *Unrestricted* so alerts arrive instantly.

### 2 · GitHub
1. Upload these files to your repository `stock-alerts` (public, branch `main`).
2. **Settings → Secrets and variables → Actions → New repository secret**
   Name `NTFY_TOPIC`, value = your private topic.
3. **Settings → Pages → Source: GitHub Actions**.
4. **Actions** tab → enable workflows if asked → *Check prices* → **Run workflow** → tick
   *Send a test notification* → Run. Your phone should ping within about a minute.

The app is then live at `https://<your-username>.github.io/stock-alerts/`.

### 3 · Install the app
- **Android (Chrome):** open the link → ⋮ menu → **Add to Home screen / Install app**.
- **Mac (Chrome):** open the link → install icon in the address bar → it opens like an app and sits in the Dock.
  **Mac (Safari):** File → **Add to Dock**.
- **Mac notifications:** in the app → **Settings → Notifications** → tick *Show alerts as notifications on this device*.
  Works while the app is open (minimised is fine); right-click the Dock icon → Options → *Open at Login* to keep it running.

### 4 · "Why it moved" briefs (Claude)
1. In claude.ai → Settings → Connectors, connect **GitHub** and give it access to `stock-alerts`.
2. Tell Claude your GitHub username. It creates the scheduled task that runs Mon–Fri at :50 past each hour,
   9:50–16:50 New York time (15:50–22:50 Vienna). It follows `BRIEF_TASK.md`; edit that file to change tone or length.

How it flows: the price check flags movers → publishes `queue.json` to the `data` branch → Claude reads it,
researches, commits `briefs/<date>-<SYMBOL>.json` → the app updates and your phone gets a push.

### 5 · Let the app save your changes (once per device)
To edit lists, ★, levels and rules from the app, add a GitHub key:
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
- Repository access: *Only select repositories* → `stock-alerts`
- Permissions: **Contents** = Read and write, **Actions** = Read and write
- Copy it into the app → **Settings → Connection** → Save.

The key stays on that device only. Without it the app still shows everything; you can edit
`config.json` directly on GitHub instead.

---

## Using it
- **Search tab:** type a ticker or name. Opening a symbol that isn't on your lists starts the small
  *Lookup* job on GitHub (≈30–60 s the first time; cached and reused for 15 min). Needs the GitHub key
  from step 5. Non-US stocks and indices like the DAX aren't available from the free sources.
- **Portfolio / Watchlist:** open a stock → **+ Portfolio** moves it. Holdings get the "gap above = trim area" wording.
- **★ High conviction** turns on 200-day SMA alerts for that stock.
- **+ Add level** → pick a type, type a price or tap **Pick on chart**.
- **Zones ±1.5 %** shades the area around each line, because the article treats MAs as areas, not exact prices.
- Each setup alerts **once**. It re-arms after price moves away (more than 2× the band).
- The first run records the current state silently, so you won't get a flood of alerts on day one.

## Good to know
- Prices: Nasdaq.com (stocks, ADRs, ETFs; daily candles plus live intraday price) and Kraken (crypto). No API key needed.
- Checks: about every 5 min, 15:30–22:00 Vienna time on NYSE trading days. Outside those hours a
  run only refreshes the app (last official close) and never sends alerts. A level or a ±3 % move must show on
  two checks in a row (≈5 min) before it alerts, so a single bad quote can't trigger anything. GitHub can delay scheduled
  runs by a few minutes at busy times.
- GitHub pauses scheduled jobs in repos with **no changes for 60 days** and sends you an email first.
  Any edit, such as saving a level in the app, resets the clock.
- Privacy: the repo is public, so `config.json` (your lists and levels) is visible to anyone. Your ntfy topic
  and GitHub key are not in the repo. (A private repo would hide it, but GitHub Pages then needs a paid plan.)
- Tickers: US-listed stocks, ADRs and ETFs; crypto as `BTC-USD`. European listings are not covered by the free source.
- Novo Nordisk is tracked via its US ADR `NVO`.

## Files
| Path | What it is |
|---|---|
| `config.json` | Your stocks, lists, levels and alert rules |
| `BRIEF_TASK.md` | Instructions Claude follows when writing briefs |
| `briefs/` | The written briefs (one JSON per mover per day) |
| `engine/check.py` | Fetches prices, computes EMA/SMA/gaps, sends alerts |
| `engine/lookup.py` | Search: daily symbol list + on-demand charts for any symbol |
| `.github/workflows/lookup.yml` | Runs a lookup when you open a symbol from Search (writes to the `lookup` branch) |
| `engine/movers.py` | ±3 % movers, headlines, market context, publishes briefs |
| `app/` | The app (TradingView Lightweight Charts™) |
| `.github/workflows/check.yml` | Schedule plus deployment to GitHub Pages |

Not investment advice. Fundamentals first: the chart only helps choose the price.
