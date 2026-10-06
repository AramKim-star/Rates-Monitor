import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (out, env = {}) => execFileSync(process.execPath,
  ['--import', join(ROOT, 'tests/mock-fetch.mjs'), join(ROOT, 'scripts/fetch-rates.mjs')],
  { env: { ...process.env, RATES_OUT: out, ...env }, stdio: 'pipe' });

test('writes policy and yield series for every covered market', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'rates-')), 'rates.json');
  run(out);
  const data = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(data.series.policy.US.points.length > 2);
  assert.equal(data.series.policy.SA, undefined);
  assert.ok(data.errors.some((e) => e.market === 'SA'));
  assert.equal(data.series.policy.US.lastObservation, '2026-10-05');
  assert.equal(data.series.yield10y.GB.lastObservation, '2026-08-01');
  assert.equal(data.series.yield10y.BR, undefined); // no FRED series configured
});

test('a failed source keeps previous data, flagged stale', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'rates-')), 'rates.json');
  run(out);
  run(out, { MOCK_FAIL: 'bis,IRLTLT01GBM156N' });
  const data = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(data.series.policy.US.stale, true);
  assert.equal(data.series.yield10y.GB.stale, true);
  assert.equal(data.series.yield10y.US.stale, undefined);
});

test('exits non-zero and leaves file untouched when nothing refreshes', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'rates-')), 'rates.json');
  writeFileSync(out, '{"keep":true}');
  const all = 'bis,IRLTLT01USM156N,IRLTLT01CAM156N,IRLTLT01MXM156N,IRLTLT01EZM156N,IRLTLT01GBM156N,IRLTLT01CHM156N,'
    + 'IRLTLT01SEM156N,IRLTLT01NOM156N,IRLTLT01JPM156N,INDIRLTLT01STM,IRLTLT01KRM156N,IRLTLT01AUM156N,IRLTLT01NZM156N,IRLTLT01ZAM156N';
  assert.throws(() => run(out, { MOCK_FAIL: all }));
  assert.equal(readFileSync(out, 'utf8'), '{"keep":true}');
});
