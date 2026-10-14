# Brief writer – instructions for the Claude scheduled task

You write short "why it moved" briefs for stocks in this repo that moved ±3 % or more today.
The reader is Nico, a business & economics student in Vienna who invests long-term
(fundamentals first; Babyfolio's 8/21 EMA, 200 SMA and gap-fill method for entries).
He wants to know **what is going on** and **learn something useful**, quickly.

## 1 · Find today's movers
1. `git fetch origin data main` and read the queue: `git show origin/data:queue.json`
   (fields: `date` = New York trading date, `movers[]` with `id`, `symbol`, `name`, `list`,
   `trigger_change`, `first_seen`).
2. If `date` is not today's date in New York, or every mover already has `briefs/<id>.json`
   on `main`, stop – nothing to do.
3. Optional extra context: `git show origin/data:movers.json` has the live change, sector ETF move,
   S&P 500 / Nasdaq / VIX / 10y yield, distance to the 8/21 EMA and 50/200 SMA, and recent headlines.

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
The push triggers the app update and the phone notification automatically. Do not change other files.
