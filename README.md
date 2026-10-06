# Wevest Rates Monitor

Branding: replace `site/logo.svg` with the official Wevest Asset Management logo (or point the `<img>` in `site/index.html` at a PNG). Theme colours are the tokens at the top of `site/styles.css`.

A dashboard of **central bank base rates**, **10-year government bond yields** and
**commercial real estate cap rates** across 18 markets. It has a dark sidebar, a
card view of current numbers and a timeline chart, and you can filter it by region.

| Section | What it shows | Source | Refresh |
|---|---|---|---|
| **Base Rates** | Central bank policy rates, last move, 1-year change | [BIS central bank policy rates](https://data.bis.org/topics/CBPOL) (daily) | Automatic, twice daily |
| **Interest Rates** | 10-year government bond yields, curve (10Y − base), cap-rate spread | OECD Main Economic Indicators via [FRED](https://fred.stlouisfed.org/) (monthly averages) | Automatic, twice daily |
| **Cap Rates** | Cap rates / prime yields by property type | Broker surveys (CBRE, Knight Frank, Cushman & Wakefield) | **Manual**: edit `site/data/cap-rates.json` |

Each region filter (Americas, Europe, Asia-Pacific, Middle East & Africa) applies
to every page. Click a market card, table row or chip to add it to the timeline
(up to 8 at once). The chart has 1Y / 5Y / 10Y / Max ranges and a hover readout.

## How the data stays current

`scripts/fetch-rates.mjs` downloads the data and writes `site/data/rates.json`.
The **Update rates data** GitHub Action runs it twice a day, commits the result
and redeploys the site. An open browser tab re-checks for new data every 30 minutes.

If a source is unreachable, the script keeps the last good series for that source
and marks it `stale`, which the UI shows. It never replaces good data with nothing.
If no source can be refreshed at all, the job fails and the existing file is left
untouched.

### Why cap rates are manual

No free, licence-clean live feed exists for cap rates. Brokers publish them in
quarterly or semi-annual surveys. When a new survey comes out, update the
market's entry in `site/data/cap-rates.json`: replace `segments`, change `asOf`
and add the headline reading to `history`. The timeline builds up from those
entries. Definitions vary (average vs prime yields), and each card names its measure and source.

## Setup

1. **Enable GitHub Pages**: Settings → Pages → *Source: GitHub Actions*.
2. **Run the data job once**: Actions → *Update rates data* → *Run workflow*.
   It also runs automatically on every push that touches the site or scripts.
3. *(Optional)* Add a free [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html)
   as the repository secret `FRED_API_KEY`. Downloads then use the FRED API,
   which is more reliable than the keyless CSV endpoint.

Scheduled runs happen only on the repository's default branch.

## Local development

```bash
node scripts/fetch-rates.mjs   # fetch live data (Node 20+, no dependencies)
npm run serve                  # http://localhost:8000
npm test                       # parser + pipeline tests (offline, mocked HTTP)
```

## Adding a market

Add an entry to `scripts/markets.mjs` with its BIS `REF_AREA` code and, if one
exists, the FRED series id for its 10-year yield. Then re-run the fetch.

## Layout

```
site/                 static site (no build step)
  index.html  styles.css  app.js
  vendor/             Chart.js 4 + date-fns adapter (MIT)
  data/rates.json     generated: policy rates + 10Y yields
  data/cap-rates.json curated: cap rate survey readings
scripts/              data pipeline (Node, no dependencies)
tests/                node:test suites, mocked network
.github/workflows/    scheduled refresh + Pages deploy
```
