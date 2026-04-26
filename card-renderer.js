// ============================================================================
// card-renderer.js — SEC EDGAR card layouts (matching fedmo visual language)
// ============================================================================
//
// Three card kinds:
//   1. company_filings  — single-company filing history
//                          With SPV trail mode for grouped filer families
//   2. filings_list     — sector / form / date search results
//   3. no_data          — empty state
//
// Visual language follows fedmo:
//   - No tinted backgrounds inside cards
//   - No left-border decoration on group blocks
//   - No badge pills on form types
//   - Hierarchy through typography weight and white space
//   - Rows separated by hairline border-bottom only
//   - Group headers use the .mo-comp-head pattern (title left, meta right)
// ============================================================================

(function () {
  'use strict';

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

  // SPV trail: stat row at top + grouped filer families below
  // Matches fedmo's mo-stat-row + mo-comp-head + mo-list rhythm
  function renderSpvTrail(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;
    const groupCount = card.groups.length;

    // Compute aggregate stats for the top row
    let totalAmount = 0;
    let earliestDate = null;
    let latestDate = null;
    for (const g of card.groups) {
      if (g.total_amount) totalAmount += g.total_amount;
      if (!earliestDate || (g.first_filed && g.first_filed < earliestDate)) earliestDate = g.first_filed;
      if (!latestDate || (g.latest_filed && g.latest_filed > latestDate)) latestDate = g.latest_filed;
    }

    const dateSpan = earliestDate && latestDate
      ? (earliestDate === latestDate ? fmtDate(latestDate) : `${fmtDate(earliestDate).split(',')[0]} → ${fmtDate(latestDate)}`)
      : '';

    // Stats row: total filings, filer families, aggregate amount
    const statsHtml = `
      <div class="mo-stat-row">
        <div class="mo-stat">
          <div class="mo-stat-value">${total.toLocaleString()}</div>
          <div class="mo-stat-label">Filings</div>
        </div>
        <div class="mo-stat">
          <div class="mo-stat-value">${groupCount.toLocaleString()}</div>
          <div class="mo-stat-label">Filer families</div>
        </div>
        ${totalAmount > 0 ? `
        <div class="mo-stat">
          <div class="mo-stat-value">${escapeHtml(fmtMoney(totalAmount))}</div>
          <div class="mo-stat-label">Aggregate</div>
        </div>` : ''}
      </div>
    `;

    // Each group rendered as comp-head + sample rows (top 1-2 from the group)
    // Top filers get a list. Smaller filers collapse to a name-only row.
    const groupsHtml = card.groups.map(g => {
      const totalAmt = g.total_amount > 0 ? fmtMoney(g.total_amount) : null;
      const meta = [
        `${g.count} filing${g.count === 1 ? '' : 's'}`,
        totalAmt,
      ].filter(Boolean).join(' · ');

      const dateRange = g.first_filed && g.latest_filed && g.first_filed !== g.latest_filed
        ? `${fmtDate(g.first_filed).split(',')[0]} → ${fmtDate(g.latest_filed)}`
        : fmtDate(g.latest_filed);

      const formsList = (g.forms || []).slice(0, 4).join(', ');

      return html`
        <div class="mo-comp-head">
          <div class="mo-comp-title">${g.family_name}</div>
          <div class="mo-comp-meta">${meta}</div>
        </div>
        <div class="mo-row" style="border-bottom: none; padding-top: 0;">
          <div class="mo-row-name" style="color: var(--text-faint); font-size: 13px;">
            ${formsList} · ${dateRange}
          </div>
        </div>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <div class="card-title">${company}</div>
        <div class="card-subtitle">SPV trail · SEC EDGAR full-text search</div>
        ${safe(statsHtml)}
        ${safe(groupsHtml)}
        <div class="card-footer">Source: SEC EDGAR · ${total > card.shown ? `Top ${card.shown} of ${total}` : `All ${total} filings`}</div>
      </div>
    `);
  }

  // Flat filings list — single company, simple rows
  function renderFlatFilings(card) {
    const company = card.company || 'Company';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const filterLine = buildFilterLine(card.filters);

    const rowsHtml = rows.slice(0, 30).map(r => {
      const amtText = r.amount ? fmtMoney(r.amount) : '';
      const metaLine = [
        r.form_type,
        fmtDate(r.filed_date),
        r.state_of_inc,
      ].filter(Boolean).join(' · ');

      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="mo-row-2line">
          <div class="mo-row-2line-top">
            <div class="mo-row-name">${r.filer_name || ''}</div>
            ${amtText ? `<div class="mo-row-amount">${escapeHtml(amtText)}</div>` : ''}
          </div>
          <div class="mo-row-2line-meta">${metaLine}</div>
        </a>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <div class="card-title">${company}</div>
        <div class="card-subtitle">${total} filing${total === 1 ? '' : 's'}${filterLine ? ` · ${filterLine}` : ''}</div>
        <div class="mo-list">${safe(rowsHtml)}</div>
        <div class="card-footer">Source: SEC EDGAR · ${rows.length < total ? `Top ${rows.length} of ${total}` : `All ${total}`}</div>
      </div>
    `);
  }

  // ── Filings list (sector / search results) ────────────────────────────────

  function renderFilingsList(card) {
    const summary = card.query_summary || 'Filings';
    const total = card.total || card.shown || 0;
    const rows = card.rows || [];

    const filterLine = buildFilterLine(card.filters);

    const rowsHtml = rows.slice(0, 30).map(r => {
      const amtText = r.amount ? fmtMoney(r.amount) : '';
      const metaLine = [
        r.form_type,
        fmtDate(r.filed_date),
        r.state_of_inc,
      ].filter(Boolean).join(' · ');

      return html`
        <a href="${escapeHtml(r.doc_link || '#')}" target="_blank" rel="noopener" class="mo-row-2line">
          <div class="mo-row-2line-top">
            <div class="mo-row-name">${r.filer_name || 'Unknown filer'}</div>
            ${amtText ? `<div class="mo-row-amount">${escapeHtml(amtText)}</div>` : ''}
          </div>
          <div class="mo-row-2line-meta">${metaLine}</div>
        </a>
      `;
    }).join('');

    return fromHtml(html`
      <div class="sec-card">
        <div class="card-title">${summary}</div>
        <div class="card-subtitle">${total} filing${total === 1 ? '' : 's'}${filterLine ? ` · ${filterLine}` : ''}</div>
        <div class="mo-list">${safe(rowsHtml)}</div>
        <div class="card-footer">Source: SEC EDGAR · ${rows.length < total ? `Top ${rows.length} of ${total}` : `All ${total}`}</div>
      </div>
    `);
  }

  function buildFilterLine(filters) {
    if (!filters) return '';
    const chips = [];
    if (filters.sector?.display) chips.push(filters.sector.display);
    if (filters.form_type) chips.push(`Form ${filters.form_type}`);
    if (filters.min_amount) chips.push(`≥ $${(filters.min_amount / 1_000_000).toFixed(0)}M`);
    if (filters.state) chips.push(filters.state);
    if (filters.date_after && filters.date_before) chips.push(`${filters.date_after} to ${filters.date_before}`);
    else if (filters.date_after) chips.push(`since ${filters.date_after}`);
    else if (filters.date_before) chips.push(`through ${filters.date_before}`);
    return chips.join(' · ');
  }

  // ── No data ───────────────────────────────────────────────────────────────

  function renderNoData(card) {
    return fromHtml(html`
      <div class="card-no-data">
        <div class="card-no-data-message">${card.message || 'No matches for that query.'}</div>
      </div>
    `);
  }

  function renderError(msg) {
    return fromHtml(html`<div class="mo-error">${msg}</div>`);
  }

  window.CardRenderer = { render };

})();
