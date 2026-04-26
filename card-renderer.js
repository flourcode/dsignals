// ============================================================================
// card-renderer.js — SEC EDGAR cards (Jobs/Lupton restraint version)
// ============================================================================
//
// Design philosophy:
//   - ONE finding per card. The headline does the work.
//   - Bar charts show proportionality. The eye gets the answer in 1 second.
//   - No filter chips, no stat blocks, no decorative pills.
//   - Every row links directly to its EDGAR filing.
//   - Cards build TRUST, not visual interest.
//
// Card kinds:
//   1. company_filings (SPV trail mode)  → headline + bar chart + insight + link out
//   2. company_filings (flat mode)       → headline + clean row list + link out
//   3. filings_list (sector search)      → same as flat mode but with sector subtitle
//   4. no_data                           → calm honest message
// ============================================================================

(function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────────────────────

  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const html = (strings, ...values) => {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i];
        out += (v && v.__safe) ? v.toString() : escapeHtml(String(v ?? ''));
      }
    }
    return out;
  };

  const safe = (str) => {
    const s = new String(str);
    s.__safe = true;
    return s;
  };

  const fromHtml = (htmlStr) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = htmlStr.trim();
    return tpl.content.firstChild;
  };

  const fmtMoney = (amount) => {
    if (!amount && amount !== 0) return null;
    if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
    if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
    if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
    return `$${amount.toLocaleString()}`;
  };

  // Parse YYYY-MM-DD as local date (avoids timezone shift that turns
  // "2026-01-01" into "2025-12-31" in negative-UTC timezones)
  const parseLocalDate = (d) => {
    if (!d) return null;
    if (d instanceof Date) return d;
    const s = String(d);
    const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) {
      return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
    }
    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback;
  };

  const fmtDate = (d) => {
    const date = parseLocalDate(d);
    if (!date) return d || '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };

  const fmtDateShort = (d) => {
    const date = parseLocalDate(d);
    if (!date) return d || '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
  };

  // EDGAR company-filings page: gives the user the canonical "all filings" view
  const buildCompanyFilingsUrl = (cik) => {
    if (!cik) return null;
    const cikInt = parseInt(cik, 10);
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikInt}&type=&dateb=&owner=include&count=40`;
  };

  // Sparkline timeline: a horizontal SVG strip showing when each filing
  // happened across the data's date range. Each dot is one filing.
  // Mobile-first: 100% width, 36px tall, no chrome.
  function buildSparkline(timeline) {
    if (!timeline || !timeline.dates || timeline.dates.length < 2) return '';

    const dates = timeline.dates.map(d => parseLocalDate(d)).filter(Boolean);
    if (dates.length < 2) return '';

    const startDate = parseLocalDate(timeline.start);
    const endDate = parseLocalDate(timeline.end);
    if (!startDate || !endDate) return '';

    const startMs = startDate.getTime();
    const endMs = endDate.getTime();
    // Add 5% padding on each side so dots aren't flush against edges
    const span = Math.max(endMs - startMs, 86400000); // at least 1 day
    const padding = span * 0.04;
    const minMs = startMs - padding;
    const maxMs = endMs + padding;
    const totalSpan = maxMs - minMs;

    const W = 1000;     // viewBox width — scales to container
    const H = 36;       // viewBox height
    const dotRadius = 3.5;
    const lineY = 18;

    // Position each dot
    const dots = dates.map(d => {
      const x = ((d.getTime() - minMs) / totalSpan) * W;
      return `<circle cx="${x.toFixed(1)}" cy="${lineY}" r="${dotRadius}" />`;
    }).join('');

    // Compute month tick labels — pick 3-5 labels evenly spaced
    const monthsList = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startLabel = `${monthsList[startDate.getMonth()]} ${startDate.getFullYear()}`;
    const endLabel = `${monthsList[endDate.getMonth()]} ${endDate.getFullYear()}`;

    return `
      <div class="sec-sparkline">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sec-sparkline-svg" aria-hidden="true">
          <line x1="0" y1="${lineY}" x2="${W}" y2="${lineY}" class="sec-sparkline-axis" />
          <g class="sec-sparkline-dots">${dots}</g>
        </svg>
        <div class="sec-sparkline-labels">
          <span>${escapeHtml(startLabel)}</span>
          <span>${escapeHtml(endLabel)}</span>
        </div>
      </div>
    `;
  }

  // ── public entry ──────────────────────────────────────────────────────────

  function render(card) {
    if (!card) return renderError('No card data');
    switch (card.kind) {
      case 'company_filings': return renderCompanyFilings(card);
      case 'filings_list':    return renderFilingsList(card);
      case 'no_data':         return renderNoData(card);
      default:                return renderError(`Unknown card kind: ${card.kind}`);
    }
  }

  // ── company filings ───────────────────────────────────────────────────────

  function renderCompanyFilings(card) {
    if (card.is_spv_trail && card.groups && card.groups.length > 0) {
      return renderSpvTrail(card);
    }
    return renderFlatFilings(card);
  }

  // ── SPV trail: the killer demo ────────────────────────────────────────────
  // ONE finding per card. Bar chart shows dominance instantly.
  function renderSpvTrail(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;

    // Filter to the form-type subtitle line based on actual data
    const formType = card.filters?.form_type;
    const dateAfter = card.filters?.date_after;
    const dateBefore = card.filters?.date_before;
    const subtitleParts = [];
    subtitleParts.push(`${total} ${formType ? 'Form ' + formType + ' filing' : 'SPV filing'}${total === 1 ? '' : 's'}`);
    if (dateAfter && dateBefore) {
      subtitleParts.push(`${fmtDateShort(dateAfter)} – ${fmtDate(dateBefore)}`);
    } else if (dateAfter) {
      subtitleParts.push(`since ${fmtDate(dateAfter)}`);
    } else if (dateBefore) {
      subtitleParts.push(`through ${fmtDate(dateBefore)}`);
    }

    // Bar chart: families sorted by count, widths proportional to max
    const groups = card.groups.slice(0, 8); // top 8 max for readability
    const maxCount = Math.max(...groups.map(g => g.count));

    const barsHtml = groups.map(g => {
      const pct = (g.count / maxCount) * 100;
      const totalAmtStr = g.total_amount > 0 ? fmtMoney(g.total_amount) : '';
      return html`
        <div class="sec-bar-row">
          <div class="sec-bar-label">${g.family_name}</div>
          <div class="sec-bar-track">
            <div class="sec-bar-fill" style="width: ${pct}%"></div>
          </div>
          <div class="sec-bar-count">${g.count}</div>
        </div>
      `;
    }).join('');

    // Insight line: the headline finding from the data
    const dominantPct = Math.round((groups[0].count / total) * 100);
    const dominantName = groups[0].family_name;
    const latestDate = groups[0].latest_filed;
    let insight;
    if (dominantPct >= 60) {
      insight = `${dominantName} filed ${dominantPct}% of all filings.`;
    } else if (dominantPct >= 40) {
      insight = `${dominantName} ran the largest share at ${dominantPct}%.`;
    } else {
      insight = `Activity spread across ${groups.length} filer families.`;
    }
    if (latestDate) {
      insight += ` Most recent: ${fmtDate(latestDate)}.`;
    }

    // Sparkline: timeline of when filings happened across the date range.
    // Reveals acceleration patterns the bar chart can't show.
    const sparklineHtml = card.timeline ? buildSparkline(card.timeline) : '';

    // Link out: company filings page on EDGAR
    const cikForLink = card.rows?.[0]?.cik;
    const allFilingsUrl = buildCompanyFilingsUrl(cikForLink);

    return fromHtml(html`
      <div class="sec-card">
        <h3 class="sec-headline">${company}</h3>
        <div class="sec-subhead">${subtitleParts.join(' · ')}</div>

        <div class="sec-bars">${safe(barsHtml)}</div>

        ${safe(sparklineHtml)}

        <div class="sec-insight">${insight}</div>

        ${safe(allFilingsUrl ? `<a href="${escapeHtml(allFilingsUrl)}" target="_blank" rel="noopener" class="sec-link-out">View all ${total} filings on EDGAR →</a>` : '')}
      </div>
    `);
  }

  // ── Flat filings: clean row list, every row links ─────────────────────────
  function renderFlatFilings(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const formType = card.filters?.form_type;
    const dateAfter = card.filters?.date_after;
    const dateBefore = card.filters?.date_before;

    const subtitleParts = [];
    subtitleParts.push(`${total} ${formType ? 'Form ' + formType + ' filing' : 'filing'}${total === 1 ? '' : 's'}`);
    if (dateAfter && dateBefore) {
      subtitleParts.push(`${fmtDateShort(dateAfter)} – ${fmtDate(dateBefore)}`);
    } else if (dateAfter) {
      subtitleParts.push(`since ${fmtDate(dateAfter)}`);
    } else if (dateBefore) {
      subtitleParts.push(`through ${fmtDate(dateBefore)}`);
    }

    // Row list: date — form — link
    const rowsHtml = rows.slice(0, 12).map(r => {
      const amtText = r.amount ? fmtMoney(r.amount) : '';
      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="sec-row">
          <span class="sec-row-date">${fmtDate(r.filed_date)}</span>
          <span class="sec-row-form">${r.form_type || '?'}</span>
          ${amtText ? `<span class="sec-row-amount">${escapeHtml(amtText)}</span>` : ''}
          <span class="sec-row-arrow">→</span>
        </a>
      `;
    }).join('');

    const remaining = total - Math.min(rows.length, 12);
    const cikForLink = card.rows?.[0]?.cik;
    const allFilingsUrl = buildCompanyFilingsUrl(cikForLink);

    return fromHtml(html`
      <div class="sec-card">
        <h3 class="sec-headline">${company}</h3>
        <div class="sec-subhead">${subtitleParts.join(' · ')}</div>

        <div class="sec-rows">${safe(rowsHtml)}</div>

        ${safe(remaining > 0 && allFilingsUrl
          ? `<a href="${escapeHtml(allFilingsUrl)}" target="_blank" rel="noopener" class="sec-link-out">View all ${total} filings on EDGAR →</a>`
          : '')}
      </div>
    `);
  }

  // ── Filings list (sector / search results) ────────────────────────────────
  function renderFilingsList(card) {
    const summary = card.query_summary || 'Filings';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const totalDisplay = card.total_capped ? `${total}+` : `${total}`;

    const rowsHtml = rows.slice(0, 12).map(r => {
      const amtText = r.amount ? fmtMoney(r.amount) : '';
      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="sec-row sec-row-tall">
          <div class="sec-row-main">
            <div class="sec-row-filer">${r.filer_name || 'Unknown filer'}</div>
            <div class="sec-row-meta">
              ${fmtDate(r.filed_date)} · ${escapeHtml(r.form_type || '?')}${r.state_of_inc ? ' · ' + escapeHtml(r.state_of_inc) : ''}
            </div>
          </div>
          ${amtText ? `<span class="sec-row-amount">${escapeHtml(amtText)}</span>` : ''}
          <span class="sec-row-arrow">→</span>
        </a>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <h3 class="sec-headline">${summary}</h3>
        <div class="sec-subhead">${totalDisplay} filing${total === 1 ? '' : 's'}${card.total_capped ? ' (search capped)' : ''}</div>

        <div class="sec-rows">${safe(rowsHtml)}</div>

        ${safe(rows.length > 12 ? `<div class="sec-foot-note">Top 12 of ${totalDisplay} shown</div>` : '')}
      </div>
    `);
  }

  // ── No data: calm, honest, useful ─────────────────────────────────────────
  function renderNoData(card) {
    return fromHtml(html`
      <div class="sec-card sec-card-empty">
        <div class="sec-empty-headline">Nothing matched.</div>
        ${safe(card.query_summary ? `<div class="sec-empty-query">${escapeHtml(card.query_summary)}</div>` : '')}
        <div class="sec-empty-message">${escapeHtml(card.message || 'No matches for that query.')}</div>
      </div>
    `);
  }

  function renderError(msg) {
    return fromHtml(html`<div class="mo-error">${escapeHtml(msg)}</div>`);
  }

  window.CardRenderer = { render };

})();
