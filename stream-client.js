// ============================================================================
// stream-client.js — SSE streaming, message rendering, <data /> tag handling
// ============================================================================
//
// SHELL FILE — same across every Mo skill.
//
// What this file exports:
//   - window.MoStream.streamTurn(opts) → Promise that resolves when turn is complete
//
// opts:
//   - history          : Array of { role, content } turns to send
//   - container        : HTMLElement to append the turn to
//   - apiEndpoint      : Lambda Function URL
//   - onCardRendered   : Optional callback (card) => void after card renders
//   - onTurnComplete   : Optional callback (turnSummary) => void at end
//
// Flow:
//   1. Stream Mo's first-pass prose, watching for a <data ... /> tag inline.
//   2. When tag detected: pause stream, parse tag attributes, fetch data via
//      Lambda data_proxy, render the card.
//   3. Send a SECOND turn back to Lambda with the data summary, stream Mo's
//      grounded interpretation prose.
//   4. Fetch smart pills (if pillsEnabled), render them.
// ============================================================================

(function () {
  'use strict';

  const FACE_OPEN = '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#icon-face-open"/></svg>';
  const FACE_WATCH = '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#icon-face-watch"/></svg>';
  const FACE_LOCKED = '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#icon-face-locked"/></svg>';

  // ──────────────────────────────────────────────────────────────────────────
  // Public entry
  // ──────────────────────────────────────────────────────────────────────────

  async function streamTurn(opts) {
    const { history, container, apiEndpoint, onCardRendered, onTurnComplete } = opts;

    if (!apiEndpoint) {
      renderError(container, "Mo isn't connected yet. Set apiEndpoint in config.js after creating your Lambda Function URL.");
      return;
    }

    const turnEl = document.createElement('div');
    turnEl.className = 'turn-mo';
    container.appendChild(turnEl);

    // Mo's avatar header
    const headerEl = document.createElement('div');
    headerEl.className = 'turn-mo-header';
    headerEl.innerHTML = `${FACE_OPEN}<span class="turn-mo-meta">Mo · just now</span>`;
    turnEl.appendChild(headerEl);

    // First-pass prose container
    const proseEl = document.createElement('div');
    proseEl.className = 'turn-mo-prose';
    turnEl.appendChild(proseEl);

    const turnSummary = {
      first_pass_text: '',
      tag: null,
      card: null,
      second_pass_text: '',
    };

    try {
      // ── PASS 1: stream first-pass prose, watching for <data /> tag ────────
      const firstPass = await streamPass(apiEndpoint, {
        request_type: 'stream',
        history,
      }, proseEl);

      turnSummary.first_pass_text = firstPass.text;
      turnSummary.tag = firstPass.tag;

      // ── If a <data /> tag was emitted, fetch + render card ────────────────
      if (firstPass.tag) {
        // Strip the tag from displayed prose (it was streamed inline as text)
        proseEl.innerHTML = renderProse(firstPass.text);

        const cardEl = document.createElement('div');
        cardEl.className = 'turn-mo-card';
        turnEl.appendChild(cardEl);

        // Loading skeleton — shimmer outline matching SEC card structure
        cardEl.innerHTML = `
          <div class="mo-skeleton" aria-hidden="true">
            <div class="mo-skeleton-line mo-skeleton-title"></div>
            <div class="mo-skeleton-line mo-skeleton-sub"></div>
            <div class="mo-skeleton-rows">
              <div class="mo-skeleton-row"></div>
              <div class="mo-skeleton-row"></div>
              <div class="mo-skeleton-row"></div>
              <div class="mo-skeleton-row mo-skeleton-row--short"></div>
            </div>
          </div>`;

        const dataResult = await fetchData(apiEndpoint, firstPass.tag);

        if (dataResult.error) {
          cardEl.innerHTML = '';
          cardEl.appendChild(makeErrorBox(dataResult.error));
        } else if (dataResult.card) {
          cardEl.innerHTML = '';
          const rendered = window.CardRenderer.render(dataResult.card);
          if (rendered) cardEl.appendChild(rendered);
          turnSummary.card = dataResult.card;

          if (typeof onCardRendered === 'function') onCardRendered(dataResult.card);

          // ── PASS 2: stream Mo's grounded interpretation ─────────────────────
          const afterEl = document.createElement('div');
          afterEl.className = 'turn-mo-after';
          turnEl.appendChild(afterEl);

          const cardSummary = summarizeCard(dataResult.card);

          const secondPass = await streamPass(apiEndpoint, {
            request_type: 'stream',
            history,
            first_pass_text: firstPass.text,
            active_card_summary: cardSummary,
            payload_summary: JSON.stringify(dataResult.card).slice(0, 6000),
          }, afterEl);

          turnSummary.second_pass_text = secondPass.text;

          // ── Smart pills ──────────────────────────────────────────────────────
          if (window.MO_CONFIG?.pillsEnabled !== false) {
            const lastUserQ = [...history].reverse().find(h => h.role === 'user')?.content || '';
            const pillsResult = await fetchPills(apiEndpoint, {
              question: lastUserQ,
              card_summary: cardSummary,
              prose: secondPass.text,
            });
            if (pillsResult?.suggestions?.length) {
              const onPick = (term) => {
                if (window.MoApp && typeof window.MoApp.submitMessage === 'function') {
                  window.MoApp.submitMessage(term);
                }
              };
              const pillsEl = window.Chips.render(pillsResult.suggestions, onPick);
              if (pillsEl) turnEl.appendChild(pillsEl);
            }
          }
        }
      }

      if (typeof onTurnComplete === 'function') onTurnComplete(turnSummary);
    } catch (err) {
      console.error('[stream-client] turn error:', err);
      const errBox = makeErrorBox(err.message || 'Something went wrong.');
      turnEl.appendChild(errBox);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stream one pass of Gemini output. Returns { text, tag }.
  // The tag is detected inline; everything after it is dropped from streaming.
  // ──────────────────────────────────────────────────────────────────────────

  async function streamPass(endpoint, body, proseEl) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Mo returned ${res.status}`);
    }
    if (!res.body) {
      throw new Error('No response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let textBuffer = '';      // raw, includes the tag if present
    let displayedText = '';   // what's actually visible — stripped at the tag
    let tagFound = null;
    let stopAccumulating = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        try {
          const parsed = JSON.parse(raw);

          if (parsed.t === 'chunk' && typeof parsed.text === 'string') {
            if (stopAccumulating) continue;

            textBuffer += parsed.text;

            // Look for <data /> tag in accumulated text
            const tagMatch = textBuffer.match(/<data\b([^>]*?)\/>/);
            if (tagMatch && !tagFound) {
              tagFound = parseTagAttrs(tagMatch[1]);
              displayedText = textBuffer.slice(0, tagMatch.index).trimEnd();
              proseEl.innerHTML = renderProse(displayedText);
              stopAccumulating = true;
            } else {
              // No tag yet — but if we see what looks like the START of a tag,
              // hide that incomplete portion from display so the user doesn't
              // see "<data location=" flash on screen mid-stream.
              const partialStart = textBuffer.lastIndexOf('<data');
              if (partialStart !== -1) {
                displayedText = textBuffer.slice(0, partialStart).trimEnd();
              } else {
                displayedText = textBuffer;
              }
              proseEl.innerHTML = renderProse(displayedText);
            }
          } else if (parsed.t === 'error') {
            throw new Error(parsed.message || 'Stream error');
          } else if (parsed.t === 'done') {
            // End of stream
          }
        } catch (e) {
          if (e.message && e.message !== 'Stream error') {
            // Probably malformed JSON, skip
          } else {
            throw e;
          }
        }
      }
    }

    // Return the cleaned display text (without tag), not the raw buffer
    return { text: displayedText, raw: textBuffer, tag: tagFound };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Parse <data attr="value" attr2="value" /> attributes into an object
  // ──────────────────────────────────────────────────────────────────────────

  function parseTagAttrs(rawAttrs) {
    const attrs = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(rawAttrs)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Convert plain text with paragraph breaks into HTML paragraphs
  // ──────────────────────────────────────────────────────────────────────────

  function renderProse(text) {
    if (!text) return '';
    return text
      .split(/\n\n+/)
      .map(para => {
        // Escape HTML first, then re-apply safe markdown: **bold** and *italic*
        let p = escapeHtml(para.trim());
        p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        p = p.replace(/\*(.+?)\*/g, '<em>$1</em>');
        return `<p>${p}</p>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Call data_proxy handler — Lambda fetches from skill's data source
  // ──────────────────────────────────────────────────────────────────────────

  async function fetchData(endpoint, tagAttrs) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_type: 'data_proxy',
          ...tagAttrs,
        }),
      });
      if (!res.ok) {
        return { error: `Data fetch failed: ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Call pills handler
  // ──────────────────────────────────────────────────────────────────────────

  async function fetchPills(endpoint, payload) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_type: 'pills',
          ...payload,
        }),
      });
      if (!res.ok) return { suggestions: [] };
      return await res.json();
    } catch {
      return { suggestions: [] };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build a summary of the card to send back as context for pass 2
  // ──────────────────────────────────────────────────────────────────────────

  function summarizeCard(card) {
    if (!card) return '';

    if (card.kind === 'no_data') {
      return `No data: ${card.query_summary || ''}. ${card.message || ''}`.trim();
    }

    if (card.kind === 'company_filings') {
      const company = card.company || 'Company';
      const total = card.total || card.shown || 0;
      const formType = card.filters?.form_type;
      const dateAfter = card.filters?.date_after;
      const rows = card.rows || [];

      let summary = `${company}: ${total} filing${total === 1 ? '' : 's'}`;
      if (formType) summary += ` (Form ${formType})`;
      if (dateAfter) summary += ` since ${dateAfter}`;
      summary += '.';

      if (card.is_spv_trail && card.groups && card.groups.length > 0) {
        const top = card.groups.slice(0, 3).map(g => `${g.family_name} (${g.count})`).join(', ');
        summary += ` SPV trail active. Top filer families: ${top}.`;
        if (card.timeline) {
          summary += ` Date range: ${card.timeline.start} to ${card.timeline.end}.`;
        }
      } else {
        const recent = rows.slice(0, 6).map(r => `${r.form_type} filed ${r.filed_date}`).join('; ');
        if (recent) summary += ` Most recent: ${recent}.`;
      }
      return summary;
    }

    if (card.kind === 'filings_list') {
      const total = card.total || 0;
      const label = card.query_summary || 'Filings';
      const rows = card.rows || [];
      let summary = `${label}: ${total} filing${total === 1 ? '' : 's'}.`;
      const top = rows.slice(0, 5).map(r =>
        `${r.filer_name}${r.amount ? ' ($' + (r.amount / 1e6).toFixed(1) + 'M)' : ''} on ${r.filed_date}`
      ).join('; ');
      if (top) summary += ` Top results: ${top}.`;
      if (card.unknown_amount_count) summary += ` ${card.unknown_amount_count} with undisclosed amount.`;
      return summary;
    }

    return JSON.stringify(card).slice(0, 600);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Error UI helpers
  // ──────────────────────────────────────────────────────────────────────────

  function renderError(container, msg) {
    const wrap = document.createElement('div');
    wrap.className = 'turn-mo';
    wrap.innerHTML = `
      <div class="turn-mo-header">${FACE_LOCKED}<span class="turn-mo-meta">Mo · just now</span></div>
    `;
    wrap.appendChild(makeErrorBox(msg));
    container.appendChild(wrap);
  }

  function makeErrorBox(msg) {
    const div = document.createElement('div');
    div.className = 'mo-error';
    div.textContent = msg;
    return div;
  }

  window.MoStream = { streamTurn };

})();
