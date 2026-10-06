import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, parseSdmxCsv, parseSdmxJson, parseFredCsv, parseFredApiJson,
  compressSteps, normaliseDate, validateSeries, yoyFromIndex,
} from '../scripts/lib.mjs';

test('parseCsv handles quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n1,2,3\r\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
});

test('normaliseDate accepts daily, monthly and SDMX monthly periods', () => {
  assert.equal(normaliseDate('2026-03-15'), '2026-03-15');
  assert.equal(normaliseDate('2026-03'), '2026-03-01');
  assert.equal(normaliseDate('2026-M03'), '2026-03-01');
  assert.equal(normaliseDate('2026-Q1'), null);
});

test('parseSdmxCsv reads plain and id:label headers, skips blanks', () => {
  const plain = 'DATAFLOW,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\n'
    + 'BIS:WS_CBPOL(1.0),D,GB,2026-01-02,4\n'
    + 'BIS:WS_CBPOL(1.0),D,GB,2026-01-01,4\n'
    + 'BIS:WS_CBPOL(1.0),D,US,2026-01-01,\n'
    + 'BIS:WS_CBPOL(1.0),D,US,2026-01-02,3.875\n';
  assert.deepEqual(parseSdmxCsv(plain), {
    GB: [['2026-01-01', 4], ['2026-01-02', 4]],
    US: [['2026-01-02', 3.875]],
  });
  const labelled = 'FREQ:Frequency,REF_AREA:Reference area,TIME_PERIOD:Time period,OBS_VALUE:Value\n'
    + 'D:Daily,JP:Japan,2026-01-05,0.75\n';
  assert.deepEqual(parseSdmxCsv(labelled), { JP: [['2026-01-05', 0.75]] });
  assert.throws(() => parseSdmxCsv('A,B\n1,2\n'), /missing columns/);
});

test('parseSdmxJson maps series keys and observation indexes', () => {
  const msg = {
    data: {
      structure: {
        dimensions: {
          series: [
            { id: 'FREQ', values: [{ id: 'D' }] },
            { id: 'REF_AREA', values: [{ id: 'US' }, { id: 'XM' }] },
          ],
          observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-01-01' }, { id: '2026-01-02' }] }],
        },
      },
      dataSets: [{ series: {
        '0:0': { observations: { 0: [3.875], 1: [3.875] } },
        '0:1': { observations: { 1: ['2.0'], 0: [null] } },
      } }],
    },
  };
  assert.deepEqual(parseSdmxJson(msg), {
    US: [['2026-01-01', 3.875], ['2026-01-02', 3.875]],
    XM: [['2026-01-02', 2]],
  });
});

test('parseFredCsv handles both header styles and missing values', () => {
  const csv = 'observation_date,IRLTLT01GBM156N\n2026-01-01,4.5\n2026-02-01,.\n2026-03-01,4.61\n';
  assert.deepEqual(parseFredCsv(csv), [['2026-01-01', 4.5], ['2026-03-01', 4.61]]);
  assert.deepEqual(parseFredCsv('DATE,X\n2025-12-01,4.4\n'), [['2025-12-01', 4.4]]);
  assert.throws(() => parseFredCsv('<html>error</html>\n<p>x</p>'), /unexpected header/);
});

test('parseFredApiJson', () => {
  const json = { observations: [{ date: '2026-01-01', value: '4.1' }, { date: '2026-02-01', value: '.' }] };
  assert.deepEqual(parseFredApiJson(json), [['2026-01-01', 4.1]]);
});

test('compressSteps keeps change points plus the final observation', () => {
  const daily = [['2026-01-01', 4], ['2026-01-02', 4], ['2026-02-05', 3.75], ['2026-02-06', 3.75], ['2026-03-01', 3.75]];
  assert.deepEqual(compressSteps(daily), [['2026-01-01', 4], ['2026-02-05', 3.75], ['2026-03-01', 3.75]]);
  assert.deepEqual(compressSteps([['2026-01-01', 1]]), [['2026-01-01', 1]]);
});

test('validateSeries flags empty and implausible series', () => {
  assert.equal(validateSeries([]), 'empty series');
  assert.match(validateSeries([['2026-01-01', 500]]), /implausible/);
  assert.equal(validateSeries([['2026-01-01', -0.75]]), null);
});

test('parseSdmxCsv can key by several dimensions', () => {
  const csv = 'FREQ,REF_AREA,UNIT_MEASURE,TIME_PERIOD,OBS_VALUE\nM,US,771,2026-07,2.9\nM,US,628,2026-07,160.1\n';
  assert.deepEqual(parseSdmxCsv(csv, { keyBy: ['REF_AREA', 'UNIT_MEASURE'] }), {
    'US|771': [['2026-07-01', 2.9]],
    'US|628': [['2026-07-01', 160.1]],
  });
});

test('yoyFromIndex compares each month with the same month a year earlier', () => {
  const idx = [['2025-01-01', 100], ['2025-02-01', 101], ['2026-01-01', 103], ['2026-02-01', 102.01]];
  assert.deepEqual(yoyFromIndex(idx), [['2026-01-01', 3], ['2026-02-01', 1]]);
});
