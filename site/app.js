/* Rates Monitor – front end. Reads data/rates.json (generated daily by the
   GitHub Action) and data/cap-rates.json (curated survey readings). */
(() => {
  'use strict';

  const REFRESH_MS = 30 * 60 * 1000;
  const MAX_SERIES = 8;
  const DAY = 86400000;

  const METRICS = {
    policy: { stepped: true },
    yield10y: { stepped: false },
    cap: { stepped: false },
  };
  const RANGES = { '1Y': 1, '5Y': 5, '10Y': 10, Max: null };
  const ROUTES = { dashboard: {}, policy: {}, yields: {}, caps: {}, sources: {} };

  const state = {
    route: 'dashboard',
    region: load('region', 'all'),
    metric: 'policy',
    range: load('range', '5Y'),
    selected: [],
    slots: {}, // marketId -> colour slot index; follows the entity, never its rank
    lang: initialLang(),
  };
  let rates = null;
  let caps = null;
  let loadError = null;
  let chart = null;
  let shellData = null;

  // ---------- utils ----------
  function load(k, d) { try { return localStorage.getItem('rm.' + k) || d; } catch { return d; } }
  function initialLang() {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'ko' || q === 'en') return q;
    const saved = load('lang', '');
    return saved === 'ko' ? 'ko' : 'en';
  }

  // ---------- i18n (strings live in i18n.js) ----------
  const dict = () => window.I18N[state.lang] || window.I18N.en;
  /** Translate a key, filling {placeholders} from vars (values are inserted as-is). */
  function t(key, vars) {
    let str = dict()[key] ?? window.I18N.en[key] ?? key;
    if (vars) str = str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return str;
  }
  const locale = () => (state.lang === 'ko' ? 'ko-KR' : undefined);
  const mName = (m) => (state.lang === 'ko' && dict().markets?.[m.id]?.name) || m.name;
  const mBank = (m) => (state.lang === 'ko' && dict().markets?.[m.id]?.bank) || m.bank;
  const rName = (r) => (state.lang === 'ko' && dict().regions?.[r.id]) || r.name;
  const secName = (sec) => (state.lang === 'ko' && dict().sectors?.[sec.id]) || sec.name;
  /** Field of a curated record, preferring its `<field>_ko` variant in Korean. */
  const L = (obj, field) => (state.lang === 'ko' && obj[field + '_ko']) || obj[field];
  function save(k, v) { try { localStorage.setItem('rm.' + k, v); } catch { /* storage unavailable */ } }
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ts = (d) => Date.parse(d + 'T00:00:00Z');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);

  function fmtPct(v, dp = 2) { return v == null ? '—' : v.toFixed(dp) + '%'; }
  function fmtBp(d) {
    if (d == null) return '';
    const bp = Math.round(d * 100);
    return (bp > 0 ? '+' : bp < 0 ? '−' : '±') + Math.abs(bp) + ' bp';
  }
  function deltaHtml(d, suffix = '') {
    if (d == null) return '<span class="flat">—</span>';
    const bp = Math.round(d * 100);
    const cls = bp > 0 ? 'up' : bp < 0 ? 'down' : 'flat';
    const arrow = bp > 0 ? '▲' : bp < 0 ? '▼' : '■';
    return `<span class="${cls}">${arrow} ${fmtBp(d)}</span>${suffix}`;
  }
  function fmtDate(d, monthly = false) {
    if (!d) return '—';
    const opts = monthly ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return new Date(ts(d)).toLocaleDateString(locale(), { ...opts, timeZone: 'UTC' });
  }
  /** Badge for a series whose latest observation is old (source publishing lag). */
  function lagBadge(date) {
    const days = (Date.now() - ts(date)) / DAY;
    return days > 120 ? ` <span class="badge warn" title="${esc(t('badge.lagging.title', { n: Math.round(days / 30) }))}">${t('badge.lagging')}</span>` : '';
  }
  function relTime(isoStr) {
    const mins = Math.round((Date.now() - Date.parse(isoStr)) / 60000);
    if (mins < 60) return t('rel.min', { n: Math.max(mins, 0) });
    const h = Math.round(mins / 60);
    if (h < 48) return t('rel.h', { n: h });
    return t('rel.d', { n: Math.round(h / 24) });
  }

  /** Value in force on `t` (last observation at or before t). */
  function valueAt(points, t) {
    let lo = 0, hi = points.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts(points[mid][0]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans < 0 ? null : points[ans][1];
  }

  // ---------- data access ----------
  const markets = () => ((rates || shellData)?.markets || []);
  const regions = () => ((rates || shellData)?.regions || []);
  const marketsInRegion = () => markets().filter((m) => state.region === 'all' || m.region === state.region);
  const marketById = (id) => markets().find((m) => m.id === id);

  function seriesPoints(metric, id) {
    if (metric === 'cap') {
      const c = caps?.markets?.[id];
      return c ? c.history.map((h) => [h.date, h.value]) : null;
    }
    const s = rates?.series?.[metric]?.[id];
    return s && s.points.length ? s.points : null;
  }

  function summary(metric, id) {
    const pts = seriesPoints(metric, id);
    if (!pts) return null;
    const [date, value] = pts[pts.length - 1];
    const t = ts(date);
    const yearAgo = valueAt(pts, t - 365 * DAY);
    const prev = pts.length > 1 ? pts[pts.length - 2][1] : null;
    let lastMove = null;
    if (metric === 'policy') {
      for (let i = pts.length - 1; i > 0; i--) {
        if (pts[i][1] !== pts[i - 1][1]) { lastMove = { date: pts[i][0], delta: pts[i][1] - pts[i - 1][1] }; break; }
      }
    }
    const meta = metric === 'cap' ? caps.markets[id] : rates.series[metric][id];
    return {
      date, value,
      d1y: metric !== 'cap' && yearAgo != null ? value - yearAgo : null,
      dPrev: prev != null ? value - prev : null,
      lastMove, meta,
    };
  }

  // ---------- selection & colour ----------
  function slotColor(id) {
    const slot = state.slots[id];
    return slot == null ? css('--axis') : css(`--s${slot + 1}`);
  }
  function select(id, on) {
    const i = state.selected.indexOf(id);
    if (on && i < 0) {
      if (state.selected.length >= MAX_SERIES) return;
      const used = new Set(Object.values(state.slots));
      let slot = 0;
      while (used.has(slot)) slot++;
      state.slots[id] = slot;
      state.selected.push(id);
    } else if (!on && i >= 0) {
      state.selected.splice(i, 1);
      delete state.slots[id];
    }
  }
  function resetSelection(metric) {
    state.selected = [];
    state.slots = {};
    const avail = marketsInRegion().filter((m) => seriesPoints(metric, m.id));
    avail.slice(0, state.region === 'all' ? 5 : 6).forEach((m) => select(m.id, true));
  }

  // ---------- chrome ----------
  function renderNav() {
    document.documentElement.lang = state.lang;
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle));
    });
    document.querySelectorAll('[data-lang]').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === state.lang);
      b.setAttribute('aria-pressed', b.dataset.lang === state.lang);
    });
    document.querySelectorAll('.nav a[data-route]').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === state.route);
      a.setAttribute('aria-current', a.dataset.route === state.route ? 'page' : 'false');
    });
    const counts = {};
    markets().forEach((m) => { counts[m.region] = (counts[m.region] || 0) + 1; });
    const items = [{ id: 'all', name: t('region.all'), n: markets().length }]
      .concat(regions().map((r) => ({ id: r.id, name: rName(r), n: counts[r.id] || 0 })));
    $('#region-nav').innerHTML = items.map((r) => `
      <button data-region="${r.id}" class="${state.region === r.id ? 'active' : ''}">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>
        ${esc(r.name)}<span class="count">${r.n}</span>
      </button>`).join('');
    $('#page-title').textContent = t(`route.${state.route}.title`);
    const reg = regions().find((x) => x.id === state.region);
    const regionName = state.region === 'all' ? t('region.all') : reg ? rName(reg) : '';
    $('#page-sub').textContent = `${regionName} · ${t(`route.${state.route}.sub`)}`;
  }

  function renderStatus() {
    const dot = $('#status-dot');
    if (!rates) {
      dot.className = 'status-dot err';
      $('#status-title').textContent = t('status.nodata');
      $('#status-sub').textContent = loadError || '';
      return;
    }
    const stale = Object.values(rates.series).some((s) => Object.values(s).some((x) => x.stale));
    const old = Date.now() - Date.parse(rates.generatedAt) > 2 * DAY;
    dot.className = 'status-dot ' + (stale || old ? 'warn' : 'ok');
    $('#status-title').textContent = t('status.updated', { t: relTime(rates.generatedAt) });
    $('#status-sub').textContent = stale ? t('status.stale') : t('status.daily');
  }

  // ---------- views ----------
  function banner() {
    if (rates) return '';
    return `<div class="banner warn">${t('banner')} ${loadError ? `<span class="muted">(${esc(loadError)})</span>` : ''}</div>`;
  }

  function marketCard(m) {
    const p = rates ? summary('policy', m.id) : null;
    const y = rates ? summary('yield10y', m.id) : null;
    const c = caps?.markets?.[m.id];
    const capSeg = c ? c.segments.find((s) => s.name === c.headline) || c.segments[0] : null;
    const sel = state.selected.includes(m.id);
    const stale = (p?.meta?.stale || y?.meta?.stale) ? `<span class="badge warn" title="${esc(t('badge.stale.title'))}">${t('badge.stale')}</span>` : '';
    const na = t('card.na');
    const oneY = ` <span class="muted">${t('card.1y')}</span>`;
    return `
      <article class="card market-card ${sel ? 'selected' : ''}" data-market="${m.id}" tabindex="0" role="button" aria-pressed="${sel}"${sel ? ` style="outline-color:${slotColor(m.id)}"` : ''}>
        <div class="head">
          <div>
            <div class="name">${esc(mName(m))}</div>
            <div class="sub">${esc(mBank(m))}</div>
          </div>
          ${stale || `<span class="badge">${esc(rName(regions().find((r) => r.id === m.region) || { name: '' }))}</span>`}
        </div>
        <div class="metrics">
          <div class="metric">
            <div class="label">${t('card.base')}</div>
            <div class="value ${p ? '' : 'na'}">${p ? fmtPct(p.value) : na}</div>
            <div class="delta">${p ? deltaHtml(p.d1y, oneY) : ''}</div>
          </div>
          <div class="metric">
            <div class="label">${t('card.y10')}</div>
            <div class="value ${y ? '' : 'na'}">${y ? fmtPct(y.value) : na}</div>
            <div class="delta">${y ? deltaHtml(y.d1y, oneY) : ''}</div>
          </div>
          <div class="metric">
            <div class="label">${t('card.cap')}</div>
            <div class="value ${capSeg ? '' : 'na'}">${capSeg ? (c.approximate ? '≈' : '') + fmtPct(capSeg.value) : na}</div>
            <div class="delta muted" title="${capSeg ? esc(L(capSeg, 'name')) : ''}">${capSeg ? esc(shorten(L(capSeg, 'name'), 16)) : ''}</div>
          </div>
        </div>
        <div class="sub">
          ${p?.lastMove ? t('card.lastMove', { bp: fmtBp(p.lastMove.delta), date: fmtDate(p.lastMove.date) }) : p ? t('card.noChange') : t('card.policyNA')}
          ${y ? ` · ${t('card.y10asof', { date: fmtDate(y.date, true) })}${lagBadge(y.date)}` : ''}
        </div>
      </article>`;
  }
  function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function timelineSection(metric, { pickMetric = false } = {}) {
    const avail = marketsInRegion();
    return `
      <section class="card section" id="timeline">
        <div class="section-head">
          <div>
            <h3>${pickMetric ? t('tl.timeline') : t('tl.overTime', { label: t(`metric.${metric}.label`) })}</h3>
            <div class="sub">${t(`metric.${metric}.long`)} · ${t('tl.selectUpTo', { n: MAX_SERIES })}</div>
          </div>
          <div class="controls">
            ${pickMetric ? `<div class="seg" role="group" aria-label="Metric">${Object.keys(METRICS).map((k) =>
              `<button data-metric="${k}" class="${k === metric ? 'active' : ''}">${t(`metric.${k}.label`)}</button>`).join('')}</div>` : ''}
            <div class="seg" role="group" aria-label="Time range">${Object.keys(RANGES).map((k) =>
              `<button data-range="${k}" class="${k === state.range ? 'active' : ''}">${t('range.' + k)}</button>`).join('')}</div>
          </div>
        </div>
        <div class="chips" role="group" aria-label="Markets">
          ${avail.map((m) => {
            const has = !!seriesPoints(metric, m.id);
            const on = state.selected.includes(m.id);
            return `<button class="chip ${on ? 'on' : ''}" data-chip="${m.id}" ${has ? '' : `disabled title="${esc(t('tl.noData'))}"`} aria-pressed="${on}">
              <span class="sw" style="background:${on ? slotColor(m.id) : 'var(--axis)'}"></span>${esc(mName(m))}</button>`;
          }).join('')}
        </div>
        <div class="chart-wrap"><canvas id="chart" aria-label="${esc(t(`metric.${metric}.long`))}" role="img"></canvas><div class="chart-empty" id="chart-empty" hidden></div></div>
        <div class="legend" id="legend"></div>
        ${metric === 'cap' ? `<div class="sub" style="margin-top:8px">${t('tl.capNote')}</div>` : ''}
      </section>`;
  }

  function viewDashboard() {
    const ms = marketsInRegion();
    const gen = rates ? t('dash.refreshed', { rel: relTime(rates.generatedAt), abs: new Date(rates.generatedAt).toLocaleString(locale()) }) : '';
    return `${banner()}
      <div class="hello">
        <h2>${t('dash.hello')}</h2>
        <div class="tag">${t('dash.tags')} ${gen ? '· ' + esc(gen) : ''}</div>
      </div>
      <div class="grid">${ms.map(marketCard).join('')}</div>
      ${timelineSection(state.metric, { pickMetric: true })}`;
  }

  function groupedRows(rowFn, cols) {
    const ms = marketsInRegion();
    const out = [];
    for (const r of regions()) {
      const inR = ms.filter((m) => m.region === r.id);
      if (!inR.length) continue;
      if (state.region === 'all') out.push(`<tr class="region-row"><td colspan="${cols}">${esc(rName(r))}</td></tr>`);
      inR.forEach((m) => out.push(rowFn(m)));
    }
    return out.join('');
  }

  function viewPolicy() {
    const rows = groupedRows((m) => {
      const p = rates && summary('policy', m.id);
      const y = rates && summary('yield10y', m.id);
      return `<tr data-row="${m.id}" class="${state.selected.includes(m.id) ? 'selected' : ''}" style="--row-color:${slotColor(m.id)}">
        <td><b>${esc(mName(m))}</b>${p?.meta?.stale ? ` <span class="badge warn">${t('badge.stale')}</span>` : ''}</td>
        <td>${esc(mBank(m))}</td>
        <td class="num"><b>${p ? fmtPct(p.value) : '—'}</b></td>
        <td class="num">${p?.lastMove ? deltaHtml(p.lastMove.delta) : '—'}</td>
        <td>${p?.lastMove ? fmtDate(p.lastMove.date) : '—'}</td>
        <td class="num">${p ? deltaHtml(p.d1y) : '—'}</td>
        <td class="num">${p && y ? fmtBp(y.value - p.value) : '—'}</td>
        <td class="muted">${p ? fmtDate(p.date) + lagBadge(p.date) : '—'}</td>
      </tr>`;
    }, 8);
    return `${banner()}
      ${timelineSection('policy')}
      <section class="card section">
        <div class="section-head"><h3>${t('policy.current')}</h3><span class="source">${t('policy.source')}</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('th.market')}</th><th>${t('th.bank')}</th><th class="num">${t('th.rate')}</th><th class="num">${t('th.lastMove')}</th><th>${t('th.moveDate')}</th><th class="num">${t('th.chg1y')}</th><th class="num">${t('th.y10MinusBase')}</th><th>${t('th.asOf')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`;
  }

  function viewYields() {
    const rows = groupedRows((m) => {
      const y = rates && summary('yield10y', m.id);
      const p = rates && summary('policy', m.id);
      const c = caps?.markets?.[m.id];
      const capSeg = c ? c.segments.find((s) => s.name === c.headline) : null;
      return `<tr data-row="${m.id}" class="${state.selected.includes(m.id) ? 'selected' : ''}" style="--row-color:${slotColor(m.id)}">
        <td><b>${esc(mName(m))}</b>${y?.meta?.stale ? ` <span class="badge warn">${t('badge.stale')}</span>` : ''}</td>
        <td class="num"><b>${y ? fmtPct(y.value) : '—'}</b></td>
        <td class="num">${y ? deltaHtml(y.dPrev) : '—'}</td>
        <td class="num">${y ? deltaHtml(y.d1y) : '—'}</td>
        <td class="num">${p ? fmtPct(p.value) : '—'}</td>
        <td class="num">${p && y ? fmtBp(y.value - p.value) : '—'}</td>
        <td class="num">${capSeg && y ? fmtBp(capSeg.value - y.value) : '—'}</td>
        <td class="muted">${y ? fmtDate(y.date, true) + lagBadge(y.date) : t('notCovered')}</td>
      </tr>`;
    }, 8);
    return `${banner()}
      ${timelineSection('yield10y')}
      <section class="card section">
        <div class="section-head"><h3>${t('yields.title')}</h3><span class="source">${t('yields.source')}</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('th.market')}</th><th class="num">${t('th.y10')}</th><th class="num">${t('th.chg1m')}</th><th class="num">${t('th.chg1y')}</th><th class="num">${t('th.base')}</th><th class="num">${t('th.curve')}</th><th class="num">${t('th.capMinus10y')}</th><th>${t('th.month')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`;
  }

  const DEFAULT_SECTORS = [
    { id: 'office', name: 'Office' }, { id: 'industrial', name: 'Industrial / Logistics' },
    { id: 'retail', name: 'Retail' }, { id: 'residential', name: 'Residential / Multifamily' },
  ];
  const fmtSeg = (s, approx) => (s.range ? `${s.range[0].toFixed(2)}–${s.range[1].toFixed(2)}%` : (approx ? '≈ ' : '') + fmtPct(s.value));

  function viewCaps() {
    const ms = marketsInRegion();
    const sectors = caps?.sectors || DEFAULT_SECTORS;
    const withCaps = ms.filter((m) => caps?.markets?.[m.id]);
    const without = ms.filter((m) => !caps?.markets?.[m.id]);
    const maxVal = Math.max(8, ...withCaps.flatMap((m) => caps.markets[m.id].segments.map((s) => (s.range ? s.range[1] : s.value))));
    const segRow = (s, c, label) => `
      <div class="segrow">
        <span>${esc(label)}${L(s, 'name') !== label ? ` <span class="seg-detail">${esc(L(s, 'name'))}</span>` : ''}</span>
        <b>${fmtSeg(s, c.approximate)}</b>
        <div class="bar"><div style="width:${((s.range ? s.range[1] : s.value) / maxVal * 100).toFixed(1)}%"></div></div>
      </div>`;
    const cards = withCaps.map((m) => {
      const c = caps.markets[m.id];
      const y = rates && summary('yield10y', m.id);
      const head = c.segments.find((s) => s.name === c.headline) || c.segments[0];
      const sel = state.selected.includes(m.id);
      const all = c.segments.filter((s) => s.sector === 'all');
      const rows = all.map((s) => segRow(s, c, t('caps.allProperty'))).join('') + sectors.map((sec) => {
        const segs = c.segments.filter((s) => s.sector === sec.id);
        if (!segs.length) return `<div class="segrow missing"><span>${esc(secName(sec))}</span><span class="muted">${t('caps.notCovered')}</span></div>`;
        return segs.map((s) => segRow(s, c, secName(sec))).join('');
      }).join('');
      return `<article class="card market-card ${sel ? 'selected' : ''}" data-market="${m.id}" tabindex="0" role="button" aria-pressed="${sel}"${sel ? ` style="outline-color:${slotColor(m.id)}"` : ''}>
        <div class="head">
          <div><div class="name">${esc(mName(m))}</div><div class="sub">${esc(L(c, 'measure'))} · ${esc(L(c, 'scope'))}</div></div>
          <span class="badge">${fmtDate(c.asOf, true)}</span>
        </div>
        <div><span class="badge basis-${esc(c.basis)}">${t('basis.' + (c.basis === 'prime' ? 'prime' : 'average'))}</span>${c.approximate ? ` <span class="badge warn" title="${esc(t('badge.approx.title'))}">${t('badge.approx')}</span>` : ''}</div>
        <div class="segments">${rows}</div>
        ${y ? `<div class="sub">${t('caps.spread', { name: esc(L(head, 'name')), bp: fmtBp(head.value - y.value), y: fmtPct(y.value), date: fmtDate(y.date, true) })}</div>` : ''}
        ${c.note ? `<div class="sub">${esc(L(c, 'note'))}</div>` : ''}
        <div class="source">${t('caps.source')} <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.source)}</a> · <a href="#/sources">${t('caps.allSources')}</a></div>
      </article>`;
    }).join('');
    return `${banner()}
      <div class="note">${t('caps.note', { date: esc(fmtDate(caps?.updated)) })}</div>
      <div class="grid section">${cards || `<div class="card">${t('caps.none')}</div>`}</div>
      ${without.length ? `<div class="sub section">${t('caps.noneFor', { list: without.map((m) => esc(mName(m))).join(', ') })}</div>` : ''}
      ${timelineSection('cap')}`;
  }

  function viewSources() {
    const ms = marketsInRegion();
    const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
    const policyRows = ms.map((m) => {
      const s = rates?.series?.policy?.[m.id];
      return `<tr><td><b>${esc(mName(m))}</b></td><td>${esc(mBank(m) || '')}</td>
        <td>${s?.seriesId ? `<code>${esc(s.seriesId)}</code>` : t('src.policy.daily')}</td>
        <td>${s ? fmtDate(s.lastObservation) + lagBadge(s.lastObservation) : `<span class="muted">${t('src.notAvail')}</span>`}${s?.stale ? ` <span class="badge warn">${t('badge.stale')}</span>` : ''}</td></tr>`;
    }).join('');
    const yieldRows = ms.map((m) => {
      const s = rates?.series?.yield10y?.[m.id];
      if (!s) return `<tr><td><b>${esc(mName(m))}</b></td><td colspan="3" class="muted">${t('src.y.notCovered')}</td></tr>`;
      const id = s.seriesId || (s.sourceUrl || '').split('/').pop();
      return `<tr><td><b>${esc(mName(m))}</b></td><td>${link(s.sourceUrl, id)}</td><td>${s.frequency === 'monthly average' ? t('freq.monthly') : esc(s.frequency)}</td>
        <td>${fmtDate(s.lastObservation, true)}${lagBadge(s.lastObservation)}${s.stale ? ` <span class="badge warn">${t('badge.stale')}</span>` : ''}</td></tr>`;
    }).join('');
    const capRows = ms.map((m) => {
      const c = caps?.markets?.[m.id];
      if (!c) return `<tr><td><b>${esc(mName(m))}</b></td><td colspan="5" class="muted">${t('caps.notCovered')}</td></tr>`;
      const extra = [...new Map(c.segments.filter((s) => s.source).map((s) => [s.sourceUrl, s])).values()];
      return `<tr><td><b>${esc(mName(m))}</b></td><td>${esc(c.publisher)}</td>
        <td>${link(c.sourceUrl, c.source)}${extra.length ? `<div class="seg-sources">${extra.map((s) => `${link(s.sourceUrl, s.source)}: ${esc(c.segments.filter((x) => x.sourceUrl === s.sourceUrl).map((x) => L(x, 'name')).join(', '))}`).join('<br>')}</div>` : ''}</td>
        <td>${t('basis.' + (c.basis === 'prime' ? 'prime' : 'average'))}<div class="muted">${esc(L(c, 'scope'))}</div></td>
        <td>${fmtDate(c.asOf, true)}</td>
        <td>${c.approximate ? `<span class="badge warn">${t('badge.approx')}</span> ` : ''}${esc(L(c, 'note') || '')}</td></tr>`;
    }).join('');
    const th = (...keys) => `<thead><tr>${keys.map((k) => `<th>${t('th.' + k)}</th>`).join('')}</tr></thead>`;
    return `${banner()}
      <section class="card section sources">
        <h3>${t('src.policy.h')}</h3>
        <p>${t('src.policy.p')}</p>
        <div class="table-wrap"><table>${th('market', 'bank', 'bisSeries', 'latestObs')}<tbody>${policyRows}</tbody></table></div>
      </section>
      <section class="card section sources">
        <h3>${t('src.y.h')}</h3>
        <p>${t('src.y.p')}</p>
        <div class="table-wrap"><table>${th('market', 'fredSeries', 'freq', 'latestMonth')}<tbody>${yieldRows}</tbody></table></div>
      </section>
      <section class="card section sources">
        <h3>${t('src.cap.h')}</h3>
        <p>${t('src.cap.p', { date: esc(fmtDate(caps?.updated)) })}</p>
        <div class="table-wrap"><table>${th('market', 'publisher', 'report', 'basis', 'asOf', 'notes')}<tbody>${capRows}</tbody></table></div>
      </section>
      <section class="card section sources">
        <h3>${t('src.maint.h')}</h3>
        <ul>
          <li>${t('src.maint.li1')}</li>
          <li>${t('src.maint.li2')}</li>
          <li>${t('src.maint.li3')}</li>
          <li>${t('src.maint.li4')}</li>
        </ul>
      </section>`;
  }

  // ---------- chart ----------
  const crosshair = {
    id: 'crosshair',
    afterEvent(c, args) {
      const e = args.event;
      if (e.type === 'mouseout') { c._hoverX = null; hideTip(); }
      else if (e.type === 'mousemove' && c.chartArea && e.x >= c.chartArea.left && e.x <= c.chartArea.right) {
        c._hoverX = e.x;
        showTip(c, e);
      }
      args.changed = true;
    },
    afterDraw(c) {
      if (c._hoverX == null) return;
      const { ctx, chartArea: a } = c;
      ctx.save();
      ctx.strokeStyle = css('--muted');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(c._hoverX, a.top);
      ctx.lineTo(c._hoverX, a.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function showTip(c, e) {
    const t = c.scales.x.getValueForPixel(e.x);
    const metric = c._metric;
    const rows = c.data.datasets.map((ds) => {
      const pts = ds._points;
      if (ts(pts[0][0]) > t) return null;
      const v = valueAt(pts, t);
      return v == null ? null : { label: ds.label, color: ds.borderColor, v };
    }).filter(Boolean).sort((a, b) => b.v - a.v);
    const tip = $('#tooltip');
    if (!rows.length) { hideTip(); return; }
    tip.innerHTML = `<div class="t-date">${fmtDate(iso(t), metric !== 'policy')}</div>` + rows.map((r) =>
      `<div class="row"><span><i style="background:${r.color}"></i>${esc(r.label)}</span><b>${fmtPct(r.v)}</b></div>`).join('');
    const rect = c.canvas.getBoundingClientRect();
    const x = rect.left + e.x;
    const y = rect.top + e.y;
    tip.style.opacity = 1;
    const w = tip.offsetWidth;
    tip.style.left = (x + 16 + w > window.innerWidth ? x - w - 16 : x + 16) + 'px';
    tip.style.top = Math.max(8, y - tip.offsetHeight / 2) + 'px';
  }
  function hideTip() { $('#tooltip').style.opacity = 0; }

  function drawChart(metric) {
    if (chart) { chart.destroy(); chart = null; }
    const canvas = $('#chart');
    if (!canvas) return;
    const empty = $('#chart-empty');
    const years = RANGES[state.range];
    const ids = state.selected.filter((id) => seriesPoints(metric, id));
    let latest = 0;
    ids.forEach((id) => { const p = seriesPoints(metric, id); latest = Math.max(latest, ts(p[p.length - 1][0])); });
    const min = years && latest ? latest - years * 365.25 * DAY : null;

    const datasets = ids.map((id) => {
      const pts = seriesPoints(metric, id);
      let data = pts.map(([d, v]) => ({ x: ts(d), y: v }));
      if (min != null && metric !== 'cap') {
        const before = valueAt(pts, min);
        data = data.filter((p) => p.x >= min);
        if (before != null) data.unshift({ x: min, y: before });
      }
      return {
        label: marketById(id) ? mName(marketById(id)) : id,
        data,
        _points: pts,
        borderColor: slotColor(id),
        backgroundColor: slotColor(id),
        borderWidth: 2,
        stepped: METRICS[metric].stepped ? 'after' : false,
        tension: 0,
        pointRadius: metric === 'cap' ? 4 : 0,
        pointHoverRadius: metric === 'cap' ? 5 : 0,
        pointBorderColor: css('--card'),
        pointBorderWidth: 2,
      };
    });

    $('#legend').innerHTML = datasets.map((d) => `<span><i style="background:${d.borderColor}"></i>${esc(d.label)}</span>`).join('');
    if (!datasets.length) {
      empty.hidden = false;
      empty.textContent = rates || metric === 'cap' ? t('chart.select') : t('chart.nodata');
      return;
    }
    empty.hidden = true;

    const ink2 = css('--ink-2');
    const grid = css('--grid');
    chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        events: ['mousemove', 'mouseout'],
        interaction: { mode: 'nearest', intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: {
            type: 'time',
            min: metric === 'cap' ? undefined : min ?? undefined,
            max: metric === 'cap' ? undefined : latest || undefined,
            time: { tooltipFormat: 'PP' },
            grid: { display: false },
            border: { color: css('--axis') },
            ticks: {
              color: ink2, maxRotation: 0, autoSkipPadding: 24,
              // Format tick labels ourselves so they follow the selected language.
              callback(v) {
                const unit = this._unit;
                const opts = unit === 'year' ? { year: 'numeric' }
                  : unit === 'day' || unit === 'week' ? { month: 'short', day: 'numeric' }
                  : { month: 'short', year: 'numeric' };
                return new Date(v).toLocaleDateString(locale(), { ...opts, timeZone: 'UTC' });
              },
            },
          },
          y: {
            grid: { color: grid },
            border: { display: false },
            ticks: { color: ink2, callback: (v) => v.toFixed(Math.abs(v) < 10 ? 2 : 1).replace(/\.?0+$/, '') + '%' },
          },
        },
      },
      plugins: [crosshair],
    });
    chart._metric = metric;
  }

  // ---------- render & events ----------
  function currentMetric() {
    return { dashboard: state.metric, policy: 'policy', yields: 'yield10y', caps: 'cap', sources: null }[state.route];
  }

  function render() {
    renderNav();
    renderStatus();
    const html = { dashboard: viewDashboard, policy: viewPolicy, yields: viewYields, caps: viewCaps, sources: viewSources }[state.route]();
    $('#content').innerHTML = html;
    drawChart(currentMetric());
  }

  function setRoute() {
    const r = (location.hash.match(/^#\/(\w+)/) || [])[1];
    state.route = ROUTES[r] ? r : 'dashboard';
    resetSelection(currentMetric());
    closeMenu();
    render();
  }

  function toggleMarket(id) {
    const metric = currentMetric();
    if (!seriesPoints(metric, id)) return;
    select(id, !state.selected.includes(id));
    render();
  }

  function closeMenu() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

  function setLang(lang) {
    state.lang = lang; save('lang', lang);
    // Keep the address bar shareable: ?lang=ko opens the Korean version.
    const url = new URL(location.href);
    if (lang === 'ko') url.searchParams.set('lang', 'ko'); else url.searchParams.delete('lang');
    history.replaceState(null, '', url);
    render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-lang],[data-region],[data-metric],[data-range],[data-chip],[data-market],[data-row]');
    if (!el) return;
    if (el.dataset.lang) {
      setLang(el.dataset.lang);
    } else if (el.dataset.region) {
      state.region = el.dataset.region; save('region', state.region);
      resetSelection(currentMetric()); closeMenu(); render();
    } else if (el.dataset.metric) {
      state.metric = el.dataset.metric; resetSelection(state.metric); render();
    } else if (el.dataset.range) {
      state.range = el.dataset.range; save('range', state.range); render();
    } else {
      toggleMarket(el.dataset.chip || el.dataset.market || el.dataset.row);
    }
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('[data-market]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleMarket(el.dataset.market); }
  });
  $('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
  $('#scrim').addEventListener('click', closeMenu);
  $('#refresh-btn').addEventListener('click', () => loadData().then(render));
  window.addEventListener('hashchange', setRoute);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', render);

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  async function loadData() {
    const [r, c] = await Promise.allSettled([fetchJson('data/rates.json'), fetchJson('data/cap-rates.json')]);
    if (r.status === 'fulfilled') { rates = r.value; loadError = null; } else if (!rates) loadError = r.reason.message;
    if (c.status === 'fulfilled') caps = c.value;
  }

  // Before the first data run there is no rates.json; build a minimal market
  // list from the cap-rate file so the page still renders something useful.
  function buildShell() {
    const names = { US: 'United States', CA: 'Canada', GB: 'United Kingdom', EA: 'Euro Area', JP: 'Japan', AU: 'Australia' };
    const regionOf = { US: 'americas', CA: 'americas', GB: 'europe', EA: 'europe', JP: 'apac', AU: 'apac' };
    shellData = {
      regions: [{ id: 'americas', name: 'Americas' }, { id: 'europe', name: 'Europe' }, { id: 'apac', name: 'Asia-Pacific' }, { id: 'mea', name: 'Middle East & Africa' }],
      markets: Object.keys(caps?.markets || {}).map((id) => ({ id, name: names[id] || id, region: regionOf[id] || 'apac', bank: '' })),
    };
  }

  loadData().then(() => {
    if (!rates) buildShell();
    setRoute();
  });

  setInterval(() => loadData().then(render), REFRESH_MS);
})();
