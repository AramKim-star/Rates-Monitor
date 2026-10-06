// Test-only preload: replaces global fetch with synthetic BIS/FRED responses so
// scripts/fetch-rates.mjs can be exercised end-to-end without network access.
// Values are SYNTHETIC and must never be published.
const FAIL = new Set((process.env.MOCK_FAIL || '').split(',').filter(Boolean));

function bisCsv(url) {
  const areas = url.match(/WS_CBPOL\/D\.([^/]+)\/all/)[1].split('+');
  const rows = ['DATAFLOW,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE'];
  areas.forEach((a, i) => {
    if (a === 'SA') return; // simulate a market missing from the response
    for (let t = Date.UTC(2015, 0, 1); t <= Date.UTC(2026, 9, 5); t += 86400000) {
      const y = new Date(t).getUTCFullYear() + new Date(t).getUTCMonth() / 12;
      const v = Math.max(0, Math.round((2 + i * 0.4 + 2 * Math.sin((y - 2015) / 2 + i)) * 4) / 4);
      rows.push(`BIS:WS_CBPOL(1.0),D,${a},${new Date(t).toISOString().slice(0, 10)},${v}`);
    }
  });
  return rows.join('\n');
}

function fredCsv(id, i) {
  const rows = [`observation_date,${id}`];
  for (let y = 2015; y <= 2026; y++) {
    for (let m = 1; m <= 12 && !(y === 2026 && m > 8); m++) {
      const v = (3 + (i % 5) * 0.5 + 1.5 * Math.sin((y - 2015 + m / 12) / 2 + i)).toFixed(2);
      rows.push(`${y}-${String(m).padStart(2, '0')}-01,${v}`);
    }
  }
  return rows.join('\n');
}

// WS_LONG_CPI: monthly, both y/y (771) and index (628) units. Japan only
// returns the index so the y/y-from-index fallback is exercised.
function bisCpiCsv(url) {
  const areas = url.match(/WS_LONG_CPI\/M\.([^/]+?)\.?\/all/)[1].split('+');
  const rows = ['FREQ,REF_AREA,UNIT_MEASURE,TIME_PERIOD,OBS_VALUE'];
  areas.forEach((a, i) => {
    let idx = 100;
    for (let y = 2010; y <= 2026; y++) {
      for (let m = 1; m <= 12 && !(y === 2026 && m > 8); m++) {
        const yoy = 2 + (i % 4) * 0.5 + 1.5 * Math.sin((y - 2010 + m / 12) / 1.5 + i);
        idx *= 1 + yoy / 1200;
        const p = `${y}-${String(m).padStart(2, '0')}`;
        if (a !== 'JP') rows.push(`M,${a},771,${p},${yoy.toFixed(2)}`);
        rows.push(`M,${a},628,${p},${idx.toFixed(3)}`);
      }
    }
  });
  return rows.join('\n');
}

let n = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const respond = (body, status = 200) => ({
    ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Error',
    text: async () => body,
  });
  if (u.includes('stats.bis.org')) {
    if (FAIL.has('bis')) return respond('down', 503);
    if (u.includes('WS_LONG_CPI')) return FAIL.has('cpi') ? respond('down', 503) : respond(bisCpiCsv(u));
    return respond(bisCsv(u));
  }
  if (u.includes('fred.stlouisfed.org')) {
    const id = u.match(/id=([^&]+)/)[1];
    if (FAIL.has(id)) return respond('<html>blocked</html>', 403);
    return respond(fredCsv(id, n++));
  }
  throw new Error(`unexpected URL ${u}`);
};
// Skip retry back-off delays in tests.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 1), ...a);
