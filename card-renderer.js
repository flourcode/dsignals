// ============================================================================
// card-renderer.js — Skill-specific card layouts for NOAA Weather
// ============================================================================
//
// THIS IS A SKILL-SPECIFIC FILE. When you fork this template to build a
// different Mo, you replace this file with one that knows how to render
// YOUR data source's card kinds.
//
// What this file must export:
//   - window.CardRenderer.render(card) → returns an HTMLElement
//
// What "card" looks like:
//   - Whatever your fetcher.mjs returned. Convention: { kind: '...', ... }
//   - kind switches between layout variants (forecast, current, alerts, no_data)
//
// The card body is yours. The card frame (border, shadow, padding) is in the
// shell's styles.css.
// ============================================================================

(function () {
  'use strict';

  const html = (strings, ...values) => {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i];
        // Auto-escape anything that isn't already marked as safe
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

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const fromHtml = (htmlStr) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = htmlStr.trim();
    return tpl.content.firstChild;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Public entry: render(card) → HTMLElement
  // ──────────────────────────────────────────────────────────────────────────

  function render(card) {
    if (!card) return renderError('No card data');
    switch (card.kind) {
      case 'forecast':         return renderForecast(card);
      case 'current':          return renderCurrent(card);
      case 'current_fallback': return renderForecast(card); // Fall through to forecast
      case 'alerts':           return renderAlerts(card);
      case 'no_data':          return renderNoData(card);
      default:                 return renderError(`Unknown card kind: ${card.kind}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Forecast (multi-day)
  // ──────────────────────────────────────────────────────────────────────────

  function renderForecast(card) {
    const loc = card.location || {};
    const where = loc.city && loc.state
      ? `${loc.city}, ${loc.state}`
      : (loc.query || 'Unknown');

    const periods = (card.periods || []).slice(0, 14);
    const now = periods[0];
    const dataSource = window.MO_CONFIG?.dataSource?.name || 'NOAA';

    const periodsHtml = periods.map(p => {
      const tempStr = `${p.temperature}°${p.temperature_unit || 'F'}`;
      const precip = p.precipitation_probability > 0
        ? ` · ${p.precipitation_probability}% rain`
        : '';
      return html`
        <div class="card-row">
          <div class="card-row-name">
            <div style="font-weight: 500;">${p.name}</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${p.short_forecast}${precip}</div>
          </div>
          <div class="card-row-detail" style="font-size: 16px; color: var(--text-title); font-weight: 500;">${tempStr}</div>
        </div>
      `;
    }).join('');

    return fromHtml(html`
      <div class="card-forecast">
        <h3 class="card-title">${where}</h3>
        <p class="card-subtitle">${periods.length}-period forecast · NOAA</p>

        ${safe(now ? html`
          <div class="card-stat-row">
            <div class="card-stat">
              <div class="card-stat-value">${now.temperature}°</div>
              <div class="card-stat-label">${now.name}</div>
            </div>
            <div class="card-stat">
              <div class="card-stat-value" style="font-size: 14px; font-weight: 500; color: var(--text-body); padding-top: 6px;">${now.short_forecast}</div>
              <div class="card-stat-label">Conditions</div>
            </div>
            <div class="card-stat">
              <div class="card-stat-value" style="font-size: 14px; font-weight: 500; color: var(--text-body); padding-top: 6px;">${now.wind_speed} ${now.wind_direction || ''}</div>
              <div class="card-stat-label">Wind</div>
            </div>
          </div>
        ` : '')}

        <div class="card-list">${safe(periodsHtml)}</div>

        <div class="card-footer">
          <span>Source: ${dataSource}</span>
          <span>Lat ${loc.lat?.toFixed(2)}, Lon ${loc.lon?.toFixed(2)}</span>
        </div>
      </div>
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Current conditions
  // ──────────────────────────────────────────────────────────────────────────

  function renderCurrent(card) {
    const loc = card.location || {};
    const where = loc.city && loc.state
      ? `${loc.city}, ${loc.state}`
      : (loc.query || 'Unknown');

    const tempC = card.temperature_c;
    const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
    const humidity = card.humidity_pct != null ? Math.round(card.humidity_pct) : null;
    const windKph = card.wind_speed_kph != null ? Math.round(card.wind_speed_kph) : null;
    const windMph = windKph != null ? Math.round(windKph * 0.621371) : null;
    const observedAt = card.observed_at ? new Date(card.observed_at).toLocaleString() : 'Unknown';
    const dataSource = window.MO_CONFIG?.dataSource?.name || 'NOAA';

    return fromHtml(html`
      <div class="card-current">
        <h3 class="card-title">${where}</h3>
        <p class="card-subtitle">Current conditions · ${card.description || 'Observed'}</p>

        <div class="card-stat-row">
          ${safe(tempF != null ? html`
            <div class="card-stat">
              <div class="card-stat-value">${tempF}°F</div>
              <div class="card-stat-label">Temperature</div>
            </div>
          ` : '')}
          ${safe(humidity != null ? html`
            <div class="card-stat">
              <div class="card-stat-value">${humidity}%</div>
              <div class="card-stat-label">Humidity</div>
            </div>
          ` : '')}
          ${safe(windMph != null ? html`
            <div class="card-stat">
              <div class="card-stat-value">${windMph} mph</div>
              <div class="card-stat-label">Wind</div>
            </div>
          ` : '')}
        </div>

        <div class="card-footer">
          <span>Source: ${dataSource}</span>
          <span>Observed ${observedAt}</span>
        </div>
      </div>
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Active alerts
  // ──────────────────────────────────────────────────────────────────────────

  function renderAlerts(card) {
    const loc = card.location || {};
    const where = loc.city && loc.state
      ? `${loc.city}, ${loc.state}`
      : (loc.query || 'Unknown');

    const alerts = card.alerts || [];
    const dataSource = window.MO_CONFIG?.dataSource?.name || 'NOAA';

    if (alerts.length === 0) {
      return fromHtml(html`
        <div class="card-alerts">
          <h3 class="card-title">${where}</h3>
          <p class="card-subtitle">No active alerts</p>
          <p style="color: var(--text-body); margin: 16px 0 0;">All clear right now. NOAA isn't tracking any active warnings, watches, or advisories for this location.</p>
          <div class="card-footer">
            <span>Source: ${dataSource}</span>
          </div>
        </div>
      `);
    }

    const alertsHtml = alerts.map(a => {
      const severityColor = {
        Extreme: '#7A2020',
        Severe: '#A14820',
        Moderate: '#7A5520',
        Minor: '#4A475A',
      }[a.severity] || '#4A475A';

      return html`
        <div class="card-row" style="flex-direction: column; align-items: flex-start; gap: 6px;">
          <div style="display: flex; gap: 8px; align-items: center; width: 100%;">
            <span style="background: ${safe(severityColor)}; color: white; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.04em;">${a.severity || 'Alert'}</span>
            <span style="font-weight: 500; color: var(--text-title);">${a.event}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
            ${a.headline}
          </div>
        </div>
      `;
    }).join('');

    return fromHtml(html`
      <div class="card-alerts">
        <h3 class="card-title">${where}</h3>
        <p class="card-subtitle">${alerts.length} active alert${alerts.length === 1 ? '' : 's'}</p>
        <div class="card-list">${safe(alertsHtml)}</div>
        <div class="card-footer">
          <span>Source: ${dataSource}</span>
        </div>
      </div>
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // No data found (geocoding failed, location outside NOAA coverage, etc.)
  // ──────────────────────────────────────────────────────────────────────────

  function renderNoData(card) {
    return fromHtml(html`
      <div class="card-no-data">
        <svg class="card-no-data-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p class="card-no-data-message">${card.message || `No data for "${card.location_query || 'that location'}"`}</p>
      </div>
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Error fallback
  // ──────────────────────────────────────────────────────────────────────────

  function renderError(msg) {
    return fromHtml(html`
      <div class="mo-error">${msg}</div>
    `);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Export to global namespace (no module bundler in this project)
  // ──────────────────────────────────────────────────────────────────────────

  window.CardRenderer = { render };

})();
