# Brief writer – instructions for the Claude scheduled task

You write short "why it moved" briefs for stocks in this repo that moved ±3 % or more today.
The reader is Nico, a business & economics student in Vienna who invests long-term
(fundamentals first; Babyfolio's 8/21 EMA, 200 SMA and gap-fill method for entries).
He wants to know **what is going on** and **learn something useful**, quickly.

## 0 · Keep the price checks running (backup, takes seconds)
GitHub's cron is unreliable, so the "Check prices" workflow restarts itself every ~5 min during
the trading day. If GitHub never starts it, nothing runs – so check once per run.
(The Actions API is blocked from Claude sessions; the commit check-runs API and a push both work.)
1. Latest check start:
   `gh api "repos/Nico4sl/stock-alerts/commits/main/check-runs?filter=all&per_page=1" --jq '.check_runs[0] | .status + " " + .started_at'`
2. If it is not `in_progress`/`queued` and started more than 15 minutes ago, restart the checks by
   pushing a heartbeat (a push to `heartbeat.txt` starts a run, which restarts the chain):
   `cd /home/claude/stock-alerts && git fetch origin main && git rebase origin/main && echo "$(date -u +%FT%TZ)" >> heartbeat.txt && tail -n 50 heartbeat.txt > h && mv h heartbeat.txt && git add heartbeat.txt && git commit -m "Heartbeat: restart price checks" && git push origin main`
3. If this fails, just continue with the briefs – do not retry.

## 1 · Find today's movers
1. `git fetch origin data main` and read the queue: `git show origin/data:queue.json`
   (fields: `date` = New York trading date, `movers[]` with `id`, `symbol`, `name`, `list`,
   `trigger_change`, `first_seen`).
2. If `date` is not today's date in New York, or every mover already has `briefs/<id>.json`
   on `main`, skip to step 5 (no briefs to write).
3. Optional extra context: `git show origin/data:movers.json` has the live change, sector ETF move,
   S&P 500 / Nasdaq 100 / long-Treasury ETF (TLT), distance to the 8/21 EMA and 50/200 SMA, and recent headlines.

## 2 · Research each mover without a brief (max 6 per run, biggest moves first)
- Use web search. Prefer primary or reputable sources: company press release / 8-K / earnings
  release, Reuters, Bloomberg, CNBC, WSJ, FT, Barron's, MarketWatch, Yahoo Finance, Investopedia
  for concepts. Check the news is from **today or the last trading day**.
- Decide the driver: `company` (earnings, guidance, deal, product, management, legal, analyst
  call), `sector` (peer news, supply chain, sector rotation), `macro` (CPI, jobs, Fed, yields,
  tariffs, geopolitics), `mixed`, or `unclear`.
- Compare with the market: if the stock moved roughly with its sector ETF / the Nasdaq, say so.
- If there is no clear catalyst, say that honestly (e.g. "no company news; the move tracks the
  semiconductor sector") – never invent a reason.
- Bitcoin (`BTC-USD`): think ETF flows, macro/liquidity, regulation, large liquidations.

## 3 · Write the brief – `briefs/<id>.json`
English and German, same content (German written naturally, not word-for-word; keep
ticker symbols and standard terms like "Guidance" where Germans use them).

```json
{
  "id": "2026-10-14-NVDA",
  "symbol": "NVDA",
  "name": "Nvidia",
  "date": "2026-10-14",
  "change_pct": -4.2,
  "price": 181.30,
  "written_at": "2026-10-14T15:55:00Z",
  "driver": "company",
  "en": {
    "title": "One line naming the catalyst (max ~70 characters)",
    "tldr": "1–2 sentences: what happened and why the stock reacted.",
    "what_happened": "One paragraph with the facts and key numbers (e.g. revenue vs. consensus, guidance, size of a deal, what the Fed said).",
    "why_it_moved": "One paragraph: why the market cares – expectations vs. reality, read-through to growth/margins/valuation, positioning.",
    "context": "1–3 sentences: market and sector that day (S&P/Nasdaq/sector ETF moves), and where price now sits vs. the 8/21 EMA and 200 SMA or an open gap if relevant – no buy/sell advice.",
    "learn": { "term": "A concept from this event (e.g. 'Forward guidance', 'Export controls', 'Real yields')", "text": "2–4 sentences explaining it simply, tied to this case." },
    "watch": "1 sentence: what to watch next (date of next earnings, a regulatory decision, the next CPI print …)."
  },
  "de": { "title": "…", "tldr": "…", "what_happened": "…", "why_it_moved": "…", "context": "…", "learn": { "term": "…", "text": "…" }, "watch": "…" },
  "sources": [
    { "title": "Headline", "publisher": "Reuters", "url": "https://…" }
  ]
}
```

Rules
- 180–300 words per language in total. Plain language, concrete numbers, no hype, no filler.
- Every factual claim must come from a source you list (2–5 sources). No fabricated quotes or numbers.
- Neutral and informative: **no buy/sell recommendations, no price targets of your own.**
  Analyst actions may be reported as facts ("Morgan Stanley cut its target to $X").
- `change_pct` = the move at the time of writing (from movers.json or your research), one decimal.
- Valid JSON, UTF-8, one file per mover, file name exactly `<id>.json`.

## 4 · Publish
Commit only new files in `briefs/` to `main` with the message `Briefs <date>: SYM1, SYM2` and push.
The push triggers the app update and the phone notification automatically. Do not change other files
(except `heartbeat.txt` in step 0, `fed.json` in step 5 and `events.json` in step 6).

## 5 · Fed screen – keep `fed.json` current (do this even when there are no movers)
`fed.json` (repo root) is the written part of the app's Fed screen. The live target range, effective
rate and meeting countdown are added automatically – you only maintain the text and key facts.
Update it when **any** of these is true (New York time):
- today is the last day of an FOMC meeting (see `meetings`), it is 14:30 or later, and
  `last_decision.date` is not today → write up today's decision;
- `as_of` is 7 or more days old → refresh focus, data and market expectations;
- the Fed has published next year's meeting calendar and it is missing from `meetings`.
Otherwise skip this step.

How:
- Research with web search: the FOMC statement and implementation note (federalreserve.gov), the
  chair's press conference, the Summary of Economic Projections (Mar/Jun/Sep/Dec meetings), minutes
  (published 3 weeks after each meeting), latest CPI/PCE and jobs data, CME FedWatch-based reporting
  for the next meeting, and the latest balance-sheet operations (QT, reserve management purchases).
- Keep the exact schema and keys. Update: `as_of` (today), `chair`, `rate` (lower/upper/iorb),
  `last_decision` (date, change_bp: +25 / −25 / 0, vote), `stance` (`tightening` | `hold` | `easing` –
  the direction of policy, e.g. `hold` after a pause that follows cuts), `balance_sheet_mode`
  (`qt` | `qe` | `stable`), `projections` (only after an SEP meeting), `expectations`
  (as_of + `hold_pct` = market-implied probability of no change at the next meeting, or omit if unknown),
  `en` / `de` texts, `sources` (3–6 real links), `meetings`.
- Texts: `headline` (≤ 70 chars), `summary` (2–4 sentences), `focus` (3–4 items: inflation, jobs,
  growth, next steps – each 1–3 sentences with concrete numbers and their month), `balance_sheet`
  (2–4 sentences: QT/QE/neither, monthly amounts, size), `learn` (one concept tied to the current
  situation, 2–4 sentences). German written naturally, same content. Plain language, neutral,
  no investment advice, no invented numbers – every figure must come from a source you list.
- Validate (`python3 -m json.tool fed.json`), commit only `fed.json` with message
  `Fed summary <date>` (rebase on `origin/main` first) and push. The push updates the app.

## 6 · Upcoming dates – keep `events.json` current (do this even when there are no movers)
`events.json` (repo root) feeds the "Upcoming dates" card on each stock page. Earnings and
ex-dividend dates come from Nasdaq automatically and FOMC dates from `fed.json` – **don't add those**.
Update it when `as_of` is 7 or more days old (otherwise skip this step).

How:
- `macro`: US releases that move the whole market – jobs report, CPI, PCE (+ GDP when released the
  same day). Keep at least the next 3 months listed; take dates only from the official schedules
  (bls.gov/schedule, bea.gov/news/schedule). Drop past entries. Keys: `date` (YYYY-MM-DD), `time`
  ("08:30 ET"), `kind` (`jobs` | `cpi` | `pce` | `gdp` | `other`), `title`, `title_de`.
- `companies`: for each tracked stock in `config.json` (not crypto), search for **confirmed, dated**
  events in the next 120 days that could clearly move the stock or say something about the
  company's health: investor/capital markets day, drug approval (FDA PDUFA) or trial readout date,
  major product launch event, shareholder vote, lock-up expiry, index inclusion, court or regulatory
  ruling date. Skip anything vague ("later this year"), routine conferences and earnings.
  Format: `"NVO": [{"date": "2026-12-03", "kind": "company", "title": "…", "title_de": "…",
  "note": "one sentence: why it matters", "note_de": "…"}]`. Drop past entries.
- Set `as_of` to today, list 3–8 real `sources`. No invented dates – if unsure, leave it out.
- Validate (`python3 -m json.tool events.json`), commit only `events.json` with message
  `Upcoming dates <date>` (rebase on `origin/main` first) and push.
