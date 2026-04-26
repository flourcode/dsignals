// ============================================================================
// card-renderer.js — Skill-specific card layouts for SEC EDGAR
// ============================================================================
//
// Card kinds for SEC EDGAR Mo:
//
//   1. company_filings    — single-company filing history
//                            Special: SPV trail mode when 10+ filings from
//                            different filers (the killer Anthropic demo)
//
//   2. filings_list       — sector / form-type / date-filtered search results
//                            Top filings sorted by relevance + date
//
//   3. no_data            — search returned nothing
//
// Visual goals:
//   - Inline density: filer, form, date, amount visible at a glance
//   - Hierarchy: when grouped, group headers stand out above individual rows
//   - Mobile-first: works on a 360px-wide screen without horizontal scroll
//   - Verifiable: every row links to the actual EDGAR filing
// ============================================================================

(function () {
  'use strict';

  // ── HTML helpers ──────────────────────────────────────────────────────────

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

  const fmtDate = (d) => {
    if (!d) return '';
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };

  // ── Public entry ──────────────────────────────────────────────────────────

  function render(card) {
    if (!card) return renderError('No card data');
    switch (card.kind) {
      case 'company_filings': return renderCompanyFilings(card);
      case 'filings_list':    return renderFilingsList(card);
      case 'no_data':         return renderNoData(card);
      default:                return renderError(`Unknown card kind: ${card.kind}`);
    }
  }

  // ── Company filings ───────────────────────────────────────────────────────

  function renderCompanyFilings(card) {
    if (card.is_spv_trail && card.groups && card.groups.length > 0) {
      return renderSpvTrail(card);
    }
    return renderFlatFilings(card);
  }

  function renderSpvTrail(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;
    const groupCount = card.groups.length;

    const groupsHtml = card.groups.map(g => {
      const totalAmt = g.total_amount > 0 ? fmtMoney(g.total_amount) : null;
      const dateRange = g.first_filed && g.latest_filed && g.first_filed !== g.latest_filed
        ? `${fmtDate(g.first_filed)} → ${fmtDate(g.latest_filed)}`
        : fmtDate(g.latest_filed);
      const formsList = (g.forms || []).slice(0, 4).join(', ');

      return html`
        <div class="sec-group">
          <div class="sec-group-head">
            <div class="sec-group-name">${g.family_name}</div>
            <div class="sec-group-meta">
              <span class="sec-group-count">${g.count} filing${g.count === 1 ? '' : 's'}</span>
              ${safe(totalAmt ? `<span class="sec-group-amount">${escapeHtml(totalAmt)}</span>` : '')}
            </div>
          </div>
          <div class="sec-group-detail">
            <span>${formsList}</span>
            <span class="sec-group-dates">${dateRange}</span>
          </div>
        </div>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card sec-card-spv">
        <div class="sec-card-head">
          <h3 class="sec-card-title">${company}</h3>
          <div class="sec-card-summary">
            <span class="sec-pill-label">SPV trail</span>
            <span>${total} filing${total === 1 ? '' : 's'} across ${groupCount} filer ${groupCount === 1 ? 'family' : 'families'}</span>
          </div>
        </div>

        <div class="sec-groups">${safe(groupsHtml)}</div>

        <div class="sec-card-foot">
          <span>Source: SEC EDGAR</span>
          <span class="sec-card-foot-note">${total > card.shown ? `Showing top ${card.shown} of ${total}` : `All ${total} filings shown`}</span>
        </div>
      </div>
    `);
  }

  function renderFlatFilings(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const filterChips = buildFilterChips(card.filters);

    const rowsHtml = rows.slice(0, 30).map(r => {
      const amtHtml = r.amount
        ? `<span class="sec-row-amount">${escapeHtml(fmtMoney(r.amount))}</span>`
        : '<span class="sec-row-amount sec-row-amount-empty">—</span>';
      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="sec-row">
          <div class="sec-row-form">${r.form_type || '?'}</div>
          <div class="sec-row-main">
            <div class="sec-row-filer">${r.filer_name || ''}</div>
            <div class="sec-row-meta">${fmtDate(r.filed_date)}${r.state_of_inc ? ` · ${r.state_of_inc}` : ''}</div>
          </div>
          ${safe(amtHtml)}
        </a>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <div class="sec-card-head">
          <h3 class="sec-card-title">${company}</h3>
          <div class="sec-card-summary">
            <span>${total} filing${total === 1 ? '' : 's'}</span>
            ${safe(filterChips)}
          </div>
        </div>

        <div class="sec-rows">${safe(rowsHtml)}</div>

        <div class="sec-card-foot">
          <span>Source: SEC EDGAR</span>
          <span class="sec-card-foot-note">${rows.length < total ? `Showing top ${rows.length} of ${total}` : `All ${total} shown`}</span>
        </div>
      </div>
    `);
  }

  // ── Filings list (sector / search results) ────────────────────────────────

  function renderFilingsList(card) {
    const summary = card.query_summary || 'Filings';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const filterChips = buildFilterChips(card.filters);

    const rowsHtml = rows.slice(0, 30).map(r => {
      const amtHtml = r.amount
        ? `<span class="sec-row-amount">${escapeHtml(fmtMoney(r.amount))}</span>`
        : '<span class="sec-row-amount sec-row-amount-empty">—</span>';
      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="sec-row">
          <div class="sec-row-form">${r.form_type || '?'}</div>
          <div class="sec-row-main">
            <div class="sec-row-filer">${r.filer_name || 'Unknown filer'}</div>
            <div class="sec-row-meta">${fmtDate(r.filed_date)}${r.state_of_inc ? ` · ${r.state_of_inc}` : ''}</div>
          </div>
          ${safe(amtHtml)}
        </a>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <div class="sec-card-head">
          <h3 class="sec-card-title">${summary}</h3>
          <div class="sec-card-summary">
            <span>${total} filing${total === 1 ? '' : 's'}</span>
            ${safe(filterChips)}
          </div>
        </div>

        <div class="sec-rows">${safe(rowsHtml)}</div>

        <div class="sec-card-foot">
          <span>Source: SEC EDGAR</span>
          <span class="sec-card-foot-note">${rows.length < total ? `Showing top ${rows.length} of ${total}` : `All ${total} shown`}</span>
        </div>
      </div>
    `);
  }

  // ── Filter chips ──────────────────────────────────────────────────────────

  function buildFilterChips(filters) {
    if (!filters) return '';
    const chips = [];
    if (filters.sector?.display) chips.push(filters.sector.display);
    if (filters.form_type) chips.push(`Form ${filters.form_type}`);
    if (filters.min_amount) chips.push(`≥ $${(filters.min_amount / 1_000_000).toFixed(0)}M`);
    if (filters.state) chips.push(filters.state);
    if (filters.date_after && filters.date_before) chips.push(`${filters.date_after} → ${filters.date_before}`);
    else if (filters.date_after) chips.push(`Since ${filters.date_after}`);
    else if (filters.date_before) chips.push(`Through ${filters.date_before}`);

    if (chips.length === 0) return '';
    return chips.map(c => `<span class="sec-filter-chip">${escapeHtml(c)}</span>`).join('');
  }

  // ── No data ───────────────────────────────────────────────────────────────

  function renderNoData(card) {
    return fromHtml(html`
      <div class="sec-card sec-card-empty">
        <svg class="sec-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          <line x1="11" y1="8" x2="11" y2="11"/>
          <line x1="11" y1="14" x2="11.01" y2="14"/>
        </svg>
        <div class="sec-empty-title">No filings found</div>
        ${safe(card.query_summary ? `<div class="sec-empty-summary">${escapeHtml(card.query_summary)}</div>` : '')}
        <div class="sec-empty-message">${escapeHtml(card.message || 'No matches for that query.')}</div>
      </div>
    `);
  }

  // ── Error fallback ────────────────────────────────────────────────────────

  function renderError(msg) {
    return fromHtml(html`<div class="mo-error">${msg}</div>`);
  }

  window.CardRenderer = { render };

})();
