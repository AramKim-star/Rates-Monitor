#!/usr/bin/env node
// Fetches central bank policy rates (BIS) and 10-year government bond yields
// (FRED / OECD) for every market in markets.mjs and writes site/data/rates.json.
//
// Run: node scripts/fetch-rates.mjs
// Optional env: FRED_API_KEY – use the FRED JSON API instead of the keyless CSV.
//
// A source that fails keeps its previously published series (flagged stale) so a
// transient outage never blanks the dashboard.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETS, REGIONS } from './markets.mjs';
import {
  parseSdmxCsv, parseSdmxJson, parseFredCsv, parseFredApiJson,
  compressSteps, roundSeries, validateSeries,
} from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.RATES_OUT || join(ROOT, 'site', 'data', 'rates.json');
const START = '2000-01-01';
const UA = 'rates-monitor/1.0 (+https://github.com/aramkim-star/rates-monitor)';

async function fetchText(url, headers = {}, { retries = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${lastErr.message}`);
}

// ---------- BIS central bank policy rates ----------

async function fetchBisPolicyRates() {
  const areas = MARKETS.map((m) => m.bis).join('+');
  const base = `https://stats.bis.org/api/v1/data/WS_CBPOL/D.${areas}/all?startPeriod=${START}&detail=dataonly`;
  const attempts = [
    { url: base, headers: { Accept: 'application/vnd.sdmx.data+csv;version=1.0.0' }, parse: parseSdmxCsv },
    { url: `${base}&format=csv`, headers: {}, parse: parseSdmxCsv },
    { url: base, headers: { Accept: 'application/vnd.sdmx.data+json;version=1.0.0' }, parse: (t) => parseSdmxJson(JSON.parse(t)) },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const text = await fetchText(a.url, a.headers, { retries: 1 });
      const parsed = a.parse(text);
      if (Object.keys(parsed).length) return parsed;
      errors.push('empty response');
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`BIS policy rates unavailable: ${errors.join(' | ')}`);
}

// ---------- FRED 10-year government bond yields ----------

async function fetchFredSeries(id) {
  const key = process.env.FRED_API_KEY;
  if (key) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}`
      + `&observation_start=${START}&file_type=json&api_key=${encodeURIComponent(key)}`;
    return parseFredApiJson(JSON.parse(await fetchText(url)));
  }
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${START}`;
  return parseFredCsv(await fetchText(url));
}

// ---------- assemble ----------

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

function seriesEntry(points, meta) {
  return { ...meta, lastObservation: points[points.length - 1][0], points };
}

async function main() {
  const prev = await loadPrevious();
  const now = new Date().toISOString();
  const errors = [];
  const policy = {};
  const yield10y = {};
  let freshCount = 0;

  // Policy rates
  let bis = null;
  try {
    bis = await fetchBisPolicyRates();
  } catch (err) {
    errors.push({ dataset: 'policy', market: '*', message: err.message });
  }
  for (const m of MARKETS) {
    const meta = {
      source: 'BIS central bank policy rates (WS_CBPOL)',
      seriesId: `WS_CBPOL/D.${m.bis}`,
      sourceUrl: 'https://data.bis.org/topics/CBPOL',
      frequency: 'daily (change points)',
    };
    const raw = bis?.[m.bis];
    const problem = raw ? validateSeries(raw) : 'missing from BIS response';
    if (!problem) {
      policy[m.id] = { ...seriesEntry(compressSteps(raw), meta), fetchedAt: now };
      freshCount++;
    } else {
      if (bis) errors.push({ dataset: 'policy', market: m.id, message: problem });
      if (prev?.series?.policy?.[m.id]) policy[m.id] = { ...prev.series.policy[m.id], stale: true };
    }
  }

  // 10-year yields (sequential – FRED rate-limits bursts)
  for (const m of MARKETS) {
    if (!m.fred) continue;
    const meta = {
      source: `FRED ${m.fred} (OECD Main Economic Indicators)`,
      seriesId: m.fred,
      sourceUrl: `https://fred.stlouisfed.org/series/${m.fred}`,
      frequency: 'monthly average',
    };
    try {
      const pts = roundSeries(await fetchFredSeries(m.fred), 3);
      const problem = validateSeries(pts);
      if (problem) throw new Error(problem);
      yield10y[m.id] = { ...seriesEntry(pts, meta), fetchedAt: now };
      freshCount++;
    } catch (err) {
      errors.push({ dataset: 'yield10y', market: m.id, message: err.message });
      if (prev?.series?.yield10y?.[m.id]) yield10y[m.id] = { ...prev.series.yield10y[m.id], stale: true };
    }
  }

  if (freshCount === 0) {
    console.error('No series could be refreshed; leaving existing data untouched.');
    for (const e of errors) console.error(`  [${e.dataset}] ${e.market}: ${e.message}`);
    process.exit(1);
  }

  const output = {
    generatedAt: now,
    regions: REGIONS,
    markets: MARKETS.map(({ id, name, region, bank }) => ({ id, name, region, bank })),
    series: { policy, yield10y },
    errors,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(output) + '\n');

  console.log(`Wrote ${OUT}`);
  console.log(`  policy rates: ${Object.keys(policy).length}/${MARKETS.length}`);
  console.log(`  10y yields:   ${Object.keys(yield10y).length}/${MARKETS.filter((m) => m.fred).length}`);
  for (const e of errors) console.warn(`  warn [${e.dataset}] ${e.market}: ${e.message}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
