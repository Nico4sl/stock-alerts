# Pullback – project notes for Claude

Nico's personal chart + alert app (not published or sold). Read this first in every new session.
Keep answers short, plain language, verdict first. Nico is a business/economics student, not a developer:
do the work (edit, test, push) instead of handing him code or terminal steps.

## What it is
- Web app (PWA) installed on **Android** (Chrome → home screen) and **Mac** (Dock app). One codebase: `app/`.
- Method: Babyfolio's "Technical Analysis: Keeping It Simple" – 8/21 EMA entries, 50/100/150/200 SMA,
  open gaps, ±1.5 % zones, "extended" 15 %+ above the 8 EMA. Four chart views per stock (EMA / SMA / Gaps / RSI 14),
  D/W/M candles. Earnings badge per stock (green ≤ 14 days, yellow ≤ 7 days) and an "Upcoming dates" card. Not investment advice – no buy/sell wording.
- Free stack only, no new accounts: GitHub (repo, Actions, Pages) + ntfy (phone push) + Claude scheduled task.

## How it runs
- `.github/workflows/check.yml` → `engine/check.py` about every 5 min, 09:30–16:20 New York, NYSE days only.
  Each run re-dispatches itself ~5 min later ("chain"); cron on odd minutes only starts the chain.
  It fetches prices, computes levels, sends alerts via ntfy, builds `_site/` and deploys GitHub Pages.
- Outside NYSE hours a run (e.g. after a push) is **quiet**: last official close, no alerts, no new movers.
- Alerts and ±3 % movers need **two checks in a row** to fire or re-arm (filters bad quotes).
- Alert memory lives in the Actions cache (`.state/`), not in git.
- Branches: `main` (code + config + briefs), `data` (queue.json / movers.json for the brief writer),
  `lookup` (on-demand charts from Search, via `lookup.yml`), `diag` (old diagnostics, ignore).
- "Why it moved" briefs: Claude scheduled task "Pullback – why it moved briefs", hourly at :50 (NY time)
  on trading days. Follows `BRIEF_TASK.md`, commits `briefs/<date>-<SYMBOL>.json` (EN + DE).
  It also restarts stalled checks by appending a timestamp to `heartbeat.txt` and pushing, and keeps
  `fed.json` (Fed tab) current – step 5 of `BRIEF_TASK.md`.
- Data sources (no keys): Nasdaq.com (stocks/ETFs/ADRs/Nasdaq indices), Cboe (^SPX ^DJI ^RUT ^VIX),
  Kraken/Coinbase (crypto), US Treasury + Bundesbank (yields). Yahoo is a last-resort fallback.

## Files
| Path | Role |
|---|---|
| `config.json` | Stocks, lists (portfolio/watchlist), ★ high conviction, manual levels, alert rules. The app edits it via the GitHub API (token stored on each device only). |
| `engine/check.py` | Fetch, indicators, alert rules, ntfy push, site build, holiday calendar |
| `engine/movers.py` | ±3 % movers, headlines, market context, brief publishing |
| `engine/lookup.py` | Search symbol directory + on-demand lookups |
| `engine/events.py` | Upcoming dates: Nasdaq earnings + ex-dividend dates (fetched once per NY day, cached in `.state/events.json`), FOMC from `fed.json`, macro + company events from `events.json` |
| `events.json` | Macro release dates (CPI, jobs, PCE) and hand-picked company events. Kept current by the brief task (step 6) |
| `engine/fed.py` | Fed screen: live target range, its history and the effective rate (NY Fed API; FRED fallback), FOMC decision times, writes `data/fed.json` |
| `fed.json` | Fed screen text (stance, focus, balance sheet, projections, meetings; EN + DE). Updated by the brief task after each FOMC decision and weekly |
| `app/app.js`, `app.css`, `sw.js` | The app (TradingView Lightweight Charts v4.2.3 in `app/vendor/`) |
| `BRIEF_TASK.md` | Instructions for the brief-writing scheduled task |

## Rules
- **Never write the ntfy topic or any token into the repo** – it is public. The topic lives only in the
  `NTFY_TOPIC` Actions secret and the ntfy app. (Old topic was leaked and retired on 2026-10-17.)
- Repo stays public (Pages on a private repo needs a paid plan) – `config.json` is visible; accepted.
- Python: standard library only. JS: no build step, no new libraries.
- EMA 8/21 alerts: in the app only, no phone push (unless `ema_push` is turned on). All other alerts push.
- Tracked: AVGO, NBIS, AXON, MELI, AMAT, NFLX, AMZN, NVDA, GOOG, META, ANET, CRWD, APP, NOW, NVO (Novo ADR),
  UNH, SOFI, BTC-USD. Non-US listings aren't available from the free sources.

## Working on it
- Claude sessions can't use the GitHub **Actions API** (blocked by the proxy). Use instead:
  `gh api repos/Nico4sl/stock-alerts/commits/<sha>/check-runs?filter=all` (run status),
  `.../deployments` (Pages deploys), and a push to start a run.
- A push to `config.json`, `briefs/`, `app/`, `engine/`, workflows, `heartbeat.txt`, `fed.json` or `events.json` starts a check run and redeploys.
  The app updates itself when it comes to the front (service worker versioned by a hash of `app/`).
- Test before pushing: `node --check app/app.js`, `python3 -m py_compile engine/*.py`, and run
  `engine/check.py --fixtures <dir> --force --out <dir> --state <dir>` with synthetic candles
  (dates must be ascending trading days). Headless Chromium is available via Playwright for UI checks.
- After pushing, confirm the deploy (new `sw.js` VERSION / deployment sha) before telling Nico it's live.
- Commit messages: plain English summary of the user-visible change.
