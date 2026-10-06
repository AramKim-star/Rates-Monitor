// Parsers and helpers for the rates data pipeline. Pure functions so they can be
// unit-tested without network access.

/** Minimal RFC 4180 CSV parser (handles quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Normalise a period string to an ISO date (YYYY-MM-DD). Monthly periods map to the 1st. */
export function normaliseDate(period) {
  const p = String(period).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  if (/^\d{4}-\d{2}$/.test(p)) return `${p}-01`;
  if (/^\d{4}-M\d{2}$/.test(p)) return `${p.slice(0, 4)}-${p.slice(6, 8)}-01`;
  return null;
}

function toNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === '.' || s.toUpperCase() === 'NAN' || s.toUpperCase() === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function sortPoints(points) {
  return points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Parse an SDMX-CSV response (as served by the BIS statistics API).
 * Header cells may be plain ids ("REF_AREA") or "id:label" pairs; both work.
 * Returns { [refArea]: [[isoDate, value], ...] } sorted by date.
 */
export function parseSdmxCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('SDMX-CSV: no data rows');
  const header = rows[0].map((h) => h.split(':')[0].trim().toUpperCase());
  const iArea = header.indexOf('REF_AREA');
  const iTime = header.indexOf('TIME_PERIOD');
  const iValue = header.indexOf('OBS_VALUE');
  if (iArea < 0 || iTime < 0 || iValue < 0) {
    throw new Error(`SDMX-CSV: missing columns (got ${header.join(',')})`);
  }
  const out = {};
  for (const r of rows.slice(1)) {
    const area = (r[iArea] || '').split(':')[0].trim();
    const date = normaliseDate(r[iTime]);
    const value = toNumber(r[iValue]);
    if (!area || !date || value === null) continue;
    (out[area] ||= []).push([date, value]);
  }
  for (const k of Object.keys(out)) sortPoints(out[k]);
  return out;
}

/** Parse an SDMX-JSON 1.0 data message. Same return shape as parseSdmxCsv. */
export function parseSdmxJson(json) {
  const data = json.data || json;
  const structure = data.structure || json.structure;
  const dataSet = (data.dataSets || json.dataSets || [])[0];
  if (!structure || !dataSet) throw new Error('SDMX-JSON: missing structure or dataSets');
  const seriesDims = structure.dimensions.series;
  const timeDim = structure.dimensions.observation.find((d) => d.id === 'TIME_PERIOD')
    || structure.dimensions.observation[0];
  const areaPos = seriesDims.findIndex((d) => d.id === 'REF_AREA');
  if (areaPos < 0) throw new Error('SDMX-JSON: no REF_AREA dimension');
  const out = {};
  for (const [key, series] of Object.entries(dataSet.series || {})) {
    const idx = key.split(':').map(Number);
    const area = seriesDims[areaPos].values[idx[areaPos]].id;
    for (const [obsKey, obs] of Object.entries(series.observations || {})) {
      const date = normaliseDate(timeDim.values[Number(obsKey)].id);
      const value = toNumber(Array.isArray(obs) ? obs[0] : obs);
      if (!date || value === null) continue;
      (out[area] ||= []).push([date, value]);
    }
  }
  for (const k of Object.keys(out)) sortPoints(out[k]);
  return out;
}

/** Parse FRED's keyless fredgraph.csv download. Returns [[isoDate, value], ...]. */
export function parseFredCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('FRED CSV: no data rows');
  const head = rows[0][0].trim().toUpperCase();
  if (head !== 'DATE' && head !== 'OBSERVATION_DATE') {
    throw new Error(`FRED CSV: unexpected header "${rows[0].join(',')}"`);
  }
  const points = [];
  for (const r of rows.slice(1)) {
    const date = normaliseDate(r[0]);
    const value = toNumber(r[1]);
    if (date && value !== null) points.push([date, value]);
  }
  return sortPoints(points);
}

/** Parse a FRED API (api.stlouisfed.org/fred/series/observations) JSON response. */
export function parseFredApiJson(json) {
  if (!Array.isArray(json.observations)) throw new Error('FRED API: no observations');
  const points = [];
  for (const o of json.observations) {
    const date = normaliseDate(o.date);
    const value = toNumber(o.value);
    if (date && value !== null) points.push([date, value]);
  }
  return sortPoints(points);
}

/**
 * Collapse a daily step series (policy rates change only on decision dates) to
 * its change points, keeping the final observation so the line reaches the
 * latest date. Values are rounded to 4 dp to drop float noise.
 */
export function compressSteps(points) {
  const out = [];
  for (const [d, v] of points) {
    const val = Math.round(v * 1e4) / 1e4;
    if (!out.length || out[out.length - 1][1] !== val) out.push([d, val]);
  }
  const last = points[points.length - 1];
  if (last && out[out.length - 1][0] !== last[0]) {
    out.push([last[0], Math.round(last[1] * 1e4) / 1e4]);
  }
  return out;
}

/** Round all values in a series to `dp` decimal places. */
export function roundSeries(points, dp = 3) {
  const f = 10 ** dp;
  return points.map(([d, v]) => [d, Math.round(v * f) / f]);
}

/** Basic sanity check: rates must be finite and within a plausible band. */
export function validateSeries(points, { min = -5, max = 100 } = {}) {
  if (!points.length) return 'empty series';
  const bad = points.find(([, v]) => v < min || v > max);
  if (bad) return `implausible value ${bad[1]} on ${bad[0]}`;
  return null;
}
