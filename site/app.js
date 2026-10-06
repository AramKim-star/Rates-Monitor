/* Rates Monitor – front end. Reads data/rates.json (generated daily by the
   GitHub Action) and data/cap-rates.json (curated survey readings). */
(() => {
  'use strict';

  const REFRESH_MS = 30 * 60 * 1000;
  const MAX_SERIES = 8;
  const DAY = 86400000;

  const METRICS = {
    policy: { label: 'Base rate', long: 'Central bank policy rate', stepped: true },
    yield10y: { label: '10Y yield', long: '10-year government bond yield (monthly avg.)', stepped: false },
    cap: { label: 'Cap rate', long: 'Cap rate / prime yield (headline segment)', stepped: false },
  };
  const RANGES = { '1Y': 1, '5Y': 5, '10Y': 10, Max: null };
  const ROUTES = {
    dashboard: { title: 'Dashboard', sub: 'Base rates, 10-year yields and cap rates at a glance' },
    policy: { title: 'Base Rates', sub: 'Central bank policy rates · source: BIS' },
    yields: { title: 'Interest Rates', sub: '10-year government bond yields · source: OECD via FRED' },
    caps: { title: 'Cap Rates', sub: 'Commercial real estate cap rates & prime yields · broker surveys' },
  };

  const state = {
    route: 'dashboard',
    region: load('region', 'all'),
    metric: 'policy',
    range: load('range', '5Y'),
    selected: [],
    slots: {}, // marketId -> colour slot index; follows the entity, never its rank
  };
  let rates = null;
  let caps = null;
  let loadError = null;
  let chart = null;
  let shellData = null;

  // ---------- utils ----------
  function load(k, d) { try { return localStorage.getItem('rm.' + k) || d; } catch { return d; } }
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
    return new Date(ts(d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  }
  function relTime(isoStr) {
    const mins = Math.round((Date.now() - Date.parse(isoStr)) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min ago`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
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
    document.querySelectorAll('.nav a[data-route]').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === state.route);
      a.setAttribute('aria-current', a.dataset.route === state.route ? 'page' : 'false');
    });
    const counts = {};
    markets().forEach((m) => { counts[m.region] = (counts[m.region] || 0) + 1; });
    const items = [{ id: 'all', name: 'All regions', n: markets().length }]
      .concat(regions().map((r) => ({ id: r.id, name: r.name, n: counts[r.id] || 0 })));
    $('#region-nav').innerHTML = items.map((r) => `
      <button data-region="${r.id}" class="${state.region === r.id ? 'active' : ''}">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>
        ${esc(r.name)}<span class="count">${r.n}</span>
      </button>`).join('');
    const r = ROUTES[state.route];
    $('#page-title').textContent = r.title;
    const regionName = state.region === 'all' ? 'All regions' : regions().find((x) => x.id === state.region)?.name;
    $('#page-sub').textContent = `${regionName || ''} · ${r.sub}`;
  }

  function renderStatus() {
    const dot = $('#status-dot');
    if (!rates) {
      dot.className = 'status-dot err';
      $('#status-title').textContent = 'No data yet';
      $('#status-sub').textContent = loadError || '';
      return;
    }
    const stale = Object.values(rates.series).some((s) => Object.values(s).some((x) => x.stale));
    const old = Date.now() - Date.parse(rates.generatedAt) > 2 * DAY;
    dot.className = 'status-dot ' + (stale || old ? 'warn' : 'ok');
    $('#status-title').textContent = `Updated ${relTime(rates.generatedAt)}`;
    $('#status-sub').textContent = stale ? 'Some sources stale' : 'Refreshes daily';
  }

  // ---------- views ----------
  function banner() {
    if (rates) return '';
    return `<div class="banner warn"><b>Live rate data hasn't been generated yet.</b><br>
      Run the <code>Update rates data</code> GitHub Action (or <code>node scripts/fetch-rates.mjs</code> locally)
      to fetch central bank rates and bond yields. ${loadError ? `<span class="muted">(${esc(loadError)})</span>` : ''}</div>`;
  }

  function marketCard(m) {
    const p = rates ? summary('policy', m.id) : null;
    const y = rates ? summary('yield10y', m.id) : null;
    const c = caps?.markets?.[m.id];
    const capSeg = c ? c.segments.find((s) => s.name === c.headline) || c.segments[0] : null;
    const sel = state.selected.includes(m.id);
    const stale = (p?.meta?.stale || y?.meta?.stale) ? '<span class="badge warn" title="Latest refresh failed; showing last good data">stale</span>' : '';
    return `
      <article class="card market-card ${sel ? 'selected' : ''}" data-market="${m.id}" tabindex="0" role="button" aria-pressed="${sel}"${sel ? ` style="outline-color:${slotColor(m.id)}"` : ''}>
        <div class="head">
          <div>
            <div class="name">${esc(m.name)}</div>
            <div class="sub">${esc(m.bank)}</div>
          </div>
          ${stale || `<span class="badge">${esc(regions().find((r) => r.id === m.region)?.name || '')}</span>`}
        </div>
        <div class="metrics">
          <div class="metric">
            <div class="label">Base rate</div>
            <div class="value ${p ? '' : 'na'}">${p ? fmtPct(p.value) : 'n/a'}</div>
            <div class="delta">${p ? deltaHtml(p.d1y, ' <span class="muted">1y</span>') : ''}</div>
          </div>
          <div class="metric">
            <div class="label">10Y yield</div>
            <div class="value ${y ? '' : 'na'}">${y ? fmtPct(y.value) : 'n/a'}</div>
            <div class="delta">${y ? deltaHtml(y.d1y, ' <span class="muted">1y</span>') : ''}</div>
          </div>
          <div class="metric">
            <div class="label">Cap rate</div>
            <div class="value ${capSeg ? '' : 'na'}">${capSeg ? fmtPct(capSeg.value) : 'n/a'}</div>
            <div class="delta muted" title="${capSeg ? esc(capSeg.name) : ''}">${capSeg ? esc(shorten(capSeg.name, 16)) : ''}</div>
          </div>
        </div>
        <div class="sub">
          ${p?.lastMove ? `Last move ${fmtBp(p.lastMove.delta)} on ${fmtDate(p.lastMove.date)}` : p ? 'No change in history window' : 'Policy rate unavailable'}
          ${y ? ` · 10Y as of ${fmtDate(y.date, true)}` : ''}
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
            <h3>${pickMetric ? 'Timeline' : esc(METRICS[metric].label) + ' over time'}</h3>
            <div class="sub">${esc(METRICS[metric].long)} · select up to ${MAX_SERIES} markets</div>
          </div>
          <div class="controls">
            ${pickMetric ? `<div class="seg" role="group" aria-label="Metric">${Object.entries(METRICS).map(([k, v]) =>
              `<button data-metric="${k}" class="${k === metric ? 'active' : ''}">${v.label}</button>`).join('')}</div>` : ''}
            <div class="seg" role="group" aria-label="Time range">${Object.keys(RANGES).map((k) =>
              `<button data-range="${k}" class="${k === state.range ? 'active' : ''}">${k}</button>`).join('')}</div>
          </div>
        </div>
        <div class="chips" role="group" aria-label="Markets">
          ${avail.map((m) => {
            const has = !!seriesPoints(metric, m.id);
            const on = state.selected.includes(m.id);
            return `<button class="chip ${on ? 'on' : ''}" data-chip="${m.id}" ${has ? '' : 'disabled title="No data for this metric"'} aria-pressed="${on}">
              <span class="sw" style="background:${on ? slotColor(m.id) : 'var(--axis)'}"></span>${esc(m.name)}</button>`;
          }).join('')}
        </div>
        <div class="chart-wrap"><canvas id="chart" aria-label="${esc(METRICS[metric].long)} timeline" role="img"></canvas><div class="chart-empty" id="chart-empty" hidden></div></div>
        <div class="legend" id="legend"></div>
        ${metric === 'cap' ? '<div class="sub" style="margin-top:8px">Cap rate history is built from survey releases (quarterly/semi-annual), so lines are sparse. Methodologies differ by source.</div>' : ''}
      </section>`;
  }

  function viewDashboard() {
    const ms = marketsInRegion();
    const gen = rates ? `Data refreshed ${relTime(rates.generatedAt)} · ${new Date(rates.generatedAt).toLocaleString()}` : '';
    return `${banner()}
      <div class="hello">
        <h2>Global rates at a glance</h2>
        <div class="tag">#baserates #10yyields #caprates ${gen ? '· ' + esc(gen) : ''}</div>
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
      if (state.region === 'all') out.push(`<tr class="region-row"><td colspan="${cols}">${esc(r.name)}</td></tr>`);
      inR.forEach((m) => out.push(rowFn(m)));
    }
    return out.join('');
  }

  function viewPolicy() {
    const rows = groupedRows((m) => {
      const p = rates && summary('policy', m.id);
      const y = rates && summary('yield10y', m.id);
      return `<tr data-row="${m.id}" class="${state.selected.includes(m.id) ? 'selected' : ''}" style="--row-color:${slotColor(m.id)}">
        <td><b>${esc(m.name)}</b>${p?.meta?.stale ? ' <span class="badge warn">stale</span>' : ''}</td>
        <td>${esc(m.bank)}</td>
        <td class="num"><b>${p ? fmtPct(p.value) : '—'}</b></td>
        <td class="num">${p?.lastMove ? deltaHtml(p.lastMove.delta) : '—'}</td>
        <td>${p?.lastMove ? fmtDate(p.lastMove.date) : '—'}</td>
        <td class="num">${p ? deltaHtml(p.d1y) : '—'}</td>
        <td class="num">${p && y ? fmtBp(y.value - p.value) : '—'}</td>
        <td class="muted">${p ? fmtDate(p.date) : '—'}</td>
      </tr>`;
    }, 8);
    return `${banner()}
      ${timelineSection('policy')}
      <section class="card section">
        <div class="section-head"><h3>Current base rates</h3><span class="source">Source: <a href="https://data.bis.org/topics/CBPOL" target="_blank" rel="noopener">BIS central bank policy rates</a></span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Market</th><th>Central bank</th><th class="num">Rate</th><th class="num">Last move</th><th>Move date</th><th class="num">1Y change</th><th class="num">10Y − base</th><th>As of</th></tr></thead>
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
        <td><b>${esc(m.name)}</b>${y?.meta?.stale ? ' <span class="badge warn">stale</span>' : ''}</td>
        <td class="num"><b>${y ? fmtPct(y.value) : '—'}</b></td>
        <td class="num">${y ? deltaHtml(y.dPrev) : '—'}</td>
        <td class="num">${y ? deltaHtml(y.d1y) : '—'}</td>
        <td class="num">${p ? fmtPct(p.value) : '—'}</td>
        <td class="num">${p && y ? fmtBp(y.value - p.value) : '—'}</td>
        <td class="num">${capSeg && y ? fmtBp(capSeg.value - y.value) : '—'}</td>
        <td class="muted">${y ? fmtDate(y.date, true) : 'not covered'}</td>
      </tr>`;
    }, 8);
    return `${banner()}
      ${timelineSection('yield10y')}
      <section class="card section">
        <div class="section-head"><h3>10-year government bond yields</h3><span class="source">Source: OECD Main Economic Indicators via <a href="https://fred.stlouisfed.org/" target="_blank" rel="noopener">FRED</a> · monthly averages</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Market</th><th class="num">10Y yield</th><th class="num">1M change</th><th class="num">1Y change</th><th class="num">Base rate</th><th class="num">Curve (10Y − base)</th><th class="num">Cap rate − 10Y</th><th>Month</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`;
  }

  function viewCaps() {
    const ms = marketsInRegion();
    const withCaps = ms.filter((m) => caps?.markets?.[m.id]);
    const without = ms.filter((m) => !caps?.markets?.[m.id]);
    const maxVal = Math.max(8, ...withCaps.flatMap((m) => caps.markets[m.id].segments.map((s) => (s.range ? s.range[1] : s.value))));
    const cards = withCaps.map((m) => {
      const c = caps.markets[m.id];
      const y = rates && summary('yield10y', m.id);
      const head = c.segments.find((s) => s.name === c.headline) || c.segments[0];
      const sel = state.selected.includes(m.id);
      return `<article class="card market-card ${sel ? 'selected' : ''}" data-market="${m.id}" tabindex="0" role="button" aria-pressed="${sel}"${sel ? ` style="outline-color:${slotColor(m.id)}"` : ''}>
        <div class="head">
          <div><div class="name">${esc(m.name)}</div><div class="sub">${esc(c.measure)}</div></div>
          <span class="badge">${fmtDate(c.asOf, true)}</span>
        </div>
        <div class="segments">${c.segments.map((s) => `
          <div class="segrow">
            <span>${esc(s.name)}</span>
            <b>${s.range ? `${s.range[0].toFixed(2)}–${s.range[1].toFixed(2)}%` : fmtPct(s.value)}</b>
            <div class="bar"><div style="width:${((s.range ? s.range[1] : s.value) / maxVal * 100).toFixed(1)}%"></div></div>
          </div>`).join('')}
        </div>
        ${y ? `<div class="sub">${esc(head.name)} spread over 10Y yield: <b style="color:var(--ink)">${fmtBp(head.value - y.value)}</b> <span class="muted">(10Y ${fmtPct(y.value)}, ${fmtDate(y.date, true)})</span></div>` : ''}
        ${c.note ? `<div class="sub">${esc(c.note)}</div>` : ''}
        <div class="source">Source: <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.source)}</a></div>
      </article>`;
    }).join('');
    return `${banner()}
      <div class="note">Cap rates aren't published as a free live feed: they come from periodic broker surveys (CBRE, Knight Frank, Cushman &amp; Wakefield…).
        Readings below are curated in <code>site/data/cap-rates.json</code> (last reviewed ${esc(caps?.updated || '—')}) and should be updated when new surveys are released.
        Definitions differ (average vs prime yields), so compare across markets with care.</div>
      <div class="grid section">${cards || '<div class="card">No cap rate readings for this region yet.</div>'}</div>
      ${without.length ? `<div class="sub section">No cap rate survey loaded for: ${without.map((m) => esc(m.name)).join(', ')}.</div>` : ''}
      ${timelineSection('cap')}`;
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
        label: marketById(id)?.name || id,
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
      empty.textContent = rates || metric === 'cap' ? 'Select one or more markets above to plot them.' : 'No data loaded yet.';
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
            ticks: { color: ink2, maxRotation: 0, autoSkipPadding: 24 },
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
    return { dashboard: state.metric, policy: 'policy', yields: 'yield10y', caps: 'cap' }[state.route];
  }

  function render() {
    renderNav();
    renderStatus();
    const html = { dashboard: viewDashboard, policy: viewPolicy, yields: viewYields, caps: viewCaps }[state.route]();
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

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-region],[data-metric],[data-range],[data-chip],[data-market],[data-row]');
    if (!t) return;
    if (t.dataset.region) {
      state.region = t.dataset.region; save('region', state.region);
      resetSelection(currentMetric()); closeMenu(); render();
    } else if (t.dataset.metric) {
      state.metric = t.dataset.metric; resetSelection(state.metric); render();
    } else if (t.dataset.range) {
      state.range = t.dataset.range; save('range', state.range); render();
    } else {
      toggleMarket(t.dataset.chip || t.dataset.market || t.dataset.row);
    }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-market]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleMarket(t.dataset.market); }
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
