// ============================================================================
// test-runner.js — runs 15 SEC queries against the live Lambda
// ============================================================================
//
// Each test does what stream-client.js does in production:
//   1. POST {request_type:'stream', history:[{role:'user', content:query}]}
//      → consume SSE stream → extract pass-1 prose + <data /> tag
//   2. If tag found: POST {request_type:'data_proxy', ...tag_attrs}
//      → get card payload
//   3. POST {request_type:'stream', history, first_pass_text, active_card_summary,
//                                    payload_summary} → pass-2 prose
//
// Each test specifies what we're looking for in pass/fail criteria, but
// grading is by the human reading the page.
// ============================================================================

(function () {
  'use strict';

  const apiEndpoint = window.MO_CONFIG?.apiEndpoint;
  if (!apiEndpoint) {
    document.getElementById('test-results').innerHTML =
      '<div class="test-error">No apiEndpoint in config.js. Check the file.</div>';
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15 TEST QUERIES, organized by persona
  // ──────────────────────────────────────────────────────────────────────────

  const PERSONAS = [
    {
      name: 'Angel investor',
      job: 'Doing diligence on a private startup before writing a check',
      tests: [
        {
          query: 'Anthropic SPV activity in 2026',
          expects: 'SPV trail card with grouped filer families (Hiive, Augurey, Linqto, etc.). Date filter should be applied — no rows older than 2026-01-01.',
        },
        {
          query: 'AI Form Ds above $20M in the last 60 days',
          expects: 'filings_list card with sector + form + min_amount + date filters. NO mortgage trusts, NO Brookfield Infrastructure Funds. Operating-company AI startups only.',
        },
        {
          query: "What's an SPV?",
          expects: 'Pure prose answer, no card, no <data /> tag. Mo explains SPVs (Special Purpose Vehicles) as the secondary-market vehicles assembling exposure to private companies.',
        },
      ],
    },
    {
      name: 'Retail DD investor (r/WSB / FinTwit)',
      job: 'Active retail trader using primary sources for due diligence',
      tests: [
        {
          query: 'Recent insider selling at Tesla',
          expects: 'Tesla Form 4 filings (insider transactions). Should use submissions API since Tesla is in known-public list. NO SPV trail mode. Clean list of insider transactions.',
        },
        {
          query: "Show me Pelosi's most recent 13F",
          expects: 'PROSE answer (no card). Mo should explain that 13Fs are filed by institutional managers, not individual congresspeople — Pelosi disclosures are STOCK Act, not SEC 13F.',
        },
        {
          query: 'Any 8-K filings from Palantir this month',
          expects: 'Palantir 8-K filings filtered to current month. Submissions API path. Clean list, dates within current month only.',
        },
      ],
    },
    {
      name: 'Founder doing competitive recon',
      job: 'Tracking what competitors are raising and from whom',
      tests: [
        {
          query: 'Competitors of Hippocratic AI',
          expects: 'Hippocratic AI is not a known company. Mo could either (a) ask for clarification, (b) pull Hippocratic AI directly, or (c) suggest related digital-health AI sector queries. Anything sensible is acceptable.',
        },
        {
          query: 'Cybersecurity Form Ds in California this year',
          expects: 'filings_list with sector=cybersecurity, form_type=D, state=CA, date_after=2026-01-01. No fund/trust noise. Operating-company cyber startups only.',
        },
        {
          query: 'OpenAI filing history',
          expects: 'SPV trail card (OpenAI is private). Should show grouped filer families. May be smaller than Anthropic but should still be grouped.',
        },
      ],
    },
    {
      name: 'Corp dev / Director of Startups',
      job: 'Scouting acquisition targets and partnership candidates',
      tests: [
        {
          query: 'Climate tech raises this quarter',
          expects: 'filings_list with sector=climate, form_type=D, date_after this-quarter. Operating-company climate startups, not Brookfield infrastructure funds.',
        },
        {
          query: 'Stripe filings in 2024',
          expects: 'company_filings card. Stripe is hybrid in our registry. Should show Stripe\'s 2024 filings including the $694M "Other" filing if present.',
        },
        {
          query: 'Fintech companies that raised between $10M and $50M last year',
          expects: 'filings_list with sector=fintech, form_type=D, min_amount=10000000, date_after=2025-01-01, date_before=2025-12-31. Note: "between" with max is harder — Mo may emit only min_amount.',
        },
      ],
    },
    {
      name: 'Sales rep prepping for meeting',
      job: 'Skimming a customer\'s 10-K before a big meeting',
      tests: [
        {
          query: "Pull Microsoft's most recent 10-K",
          expects: 'company_filings card via submissions API. ONLY Microsoft\'s own 10-Ks (no Novell, no Yahoo, no game studios). NO SPV trail mode. The most recent 10-K should be at the top.',
        },
        {
          query: "What's in Item 7 of a 10-K?",
          expects: 'PROSE answer, no card. Mo explains Item 7 is the Management Discussion and Analysis (MD&A).',
        },
        {
          query: "What's Salesforce's biggest risk factor?",
          expects: 'Mo could pull Salesforce\'s 10-K (company_filings card via submissions API), or answer in prose explaining she can\'t read the 10-K text content but can pull the filing. Either is acceptable; what matters is honesty about EDGAR\'s limits.',
        },
      ],
    },
  ];

  // Flatten into a numbered list
  const TESTS = [];
  let testNum = 0;
  PERSONAS.forEach(persona => {
    persona.tests.forEach(test => {
      testNum++;
      TESTS.push({ ...test, num: testNum, persona: persona.name });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER initial DOM
  // ──────────────────────────────────────────────────────────────────────────

  const resultsContainer = document.getElementById('test-results');

  PERSONAS.forEach(persona => {
    const section = document.createElement('div');
    section.className = 'persona-section';
    section.innerHTML = `
      <h2>${escapeHtml(persona.name)}</h2>
      <div class="persona-job">${escapeHtml(persona.job)}</div>
    `;

    persona.tests.forEach(test => {
      const num = TESTS.find(t => t.query === test.query).num;
      const block = document.createElement('div');
      block.className = 'test-block';
      block.id = `test-${num}`;
      block.innerHTML = `
        <div class="test-block-head">
          <span class="test-block-num">Test ${num} · ${escapeHtml(persona.name)}</span>
          <span class="test-block-status pending" data-status="pending">Pending</span>
        </div>
        <div class="test-query">${escapeHtml(test.query)}</div>
        <div class="test-criteria">Expect: ${escapeHtml(test.expects)}</div>
        <div class="test-result"></div>
        <div class="test-block-footer">
          <span class="test-elapsed"></span>
          <button data-rerun="${num}">Rerun</button>
        </div>
        <div class="test-debug"></div>
      `;
      section.appendChild(block);
    });

    resultsContainer.appendChild(section);
  });

  // Wire up rerun buttons
  document.querySelectorAll('[data-rerun]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const num = parseInt(e.target.dataset.rerun, 10);
      const test = TESTS.find(t => t.num === num);
      if (test) runSingleTest(test);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RUN A SINGLE TEST
  // ──────────────────────────────────────────────────────────────────────────

  let stopRequested = false;

  async function runSingleTest(test) {
    const block = document.getElementById(`test-${test.num}`);
    const statusEl = block.querySelector('.test-block-status');
    const resultEl = block.querySelector('.test-result');
    const elapsedEl = block.querySelector('.test-elapsed');
    const debugEl = block.querySelector('.test-debug');

    // Reset visual state
    statusEl.className = 'test-block-status running';
    statusEl.dataset.status = 'running';
    statusEl.textContent = 'Running';
    resultEl.innerHTML = '';
    elapsedEl.textContent = '';
    debugEl.textContent = '';

    updateSummary();

    const t0 = Date.now();
    const debug = [];

    try {
      // ── Pass 1: stream the first response ──
      const history = [{ role: 'user', content: test.query }];
      debug.push(`POST /stream with: ${JSON.stringify({ history })}`);

      const pass1 = await streamPass({ request_type: 'stream', history });
      debug.push(`Pass 1 raw text: ${JSON.stringify(pass1.text)}`);
      debug.push(`Pass 1 tag found: ${JSON.stringify(pass1.tag)}`);

      const pass1El = document.createElement('div');
      pass1El.className = 'test-pass-1';
      pass1El.textContent = pass1.text || '(empty)';
      resultEl.appendChild(pass1El);

      // ── If a <data /> tag was emitted, fetch the card ──
      let cardPayload = null;
      if (pass1.tag) {
        debug.push(`POST /data_proxy with: ${JSON.stringify({ request_type: 'data_proxy', ...pass1.tag })}`);

        const dataRes = await fetch(apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_type: 'data_proxy', ...pass1.tag }),
        });

        const dataJson = await dataRes.json();
        debug.push(`Data response: ${JSON.stringify(dataJson, null, 2).slice(0, 2000)}`);
        cardPayload = dataJson;

        // Render the card
        const cardSlot = document.createElement('div');
        cardSlot.className = 'test-card-slot turn-mo-card';
        if (dataJson?.error) {
          cardSlot.innerHTML = `<div class="test-error">Card fetch error: ${escapeHtml(dataJson.error)}</div>`;
        } else if (dataJson?.card) {
          const rendered = window.CardRenderer.render(dataJson.card);
          if (rendered) cardSlot.appendChild(rendered);
        }
        resultEl.appendChild(cardSlot);

        // ── Pass 2: interpret the card ──
        if (dataJson?.card) {
          const cardSummary = summarizeCard(dataJson.card);
          const pass2Body = {
            request_type: 'stream',
            history,
            first_pass_text: pass1.text,
            active_card_summary: cardSummary,
            payload_summary: JSON.stringify(dataJson.card).slice(0, 6000),
          };
          debug.push(`POST /stream pass2 with: ${JSON.stringify({ ...pass2Body, payload_summary: '[truncated]' })}`);

          const pass2 = await streamPass(pass2Body);
          debug.push(`Pass 2 text: ${JSON.stringify(pass2.text)}`);

          const pass2El = document.createElement('div');
          pass2El.className = 'test-pass-2';
          pass2El.textContent = pass2.text || '(empty)';
          resultEl.appendChild(pass2El);
        }
      } else {
        // Pure prose mode — no card
        const noCardEl = document.createElement('div');
        noCardEl.className = 'test-no-card';
        noCardEl.textContent = 'No <data /> tag emitted — prose-only response (this may be correct for explainer queries).';
        resultEl.appendChild(noCardEl);
      }

      const elapsed = Date.now() - t0;
      elapsedEl.textContent = `Done in ${(elapsed / 1000).toFixed(1)}s`;
      statusEl.className = 'test-block-status done';
      statusEl.dataset.status = 'done';
      statusEl.textContent = 'Done';
      debugEl.textContent = debug.join('\n\n');

    } catch (err) {
      const elapsed = Date.now() - t0;
      elapsedEl.textContent = `Failed after ${(elapsed / 1000).toFixed(1)}s`;
      statusEl.className = 'test-block-status failed';
      statusEl.dataset.status = 'failed';
      statusEl.textContent = 'Failed';
      const errEl = document.createElement('div');
      errEl.className = 'test-error';
      errEl.textContent = `Error: ${err.message}`;
      resultEl.appendChild(errEl);
      debugEl.textContent = debug.concat([`ERROR: ${err.stack || err.message}`]).join('\n\n');
    }

    updateSummary();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STREAM A PASS — consume SSE response, return text + parsed tag
  // ──────────────────────────────────────────────────────────────────────────

  async function streamPass(body) {
    const res = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Lambda returned ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let textBuffer = '';
    let displayedText = '';
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

            const tagMatch = textBuffer.match(/<data\b([^>]*?)\/>/);
            if (tagMatch && !tagFound) {
              tagFound = parseTagAttrs(tagMatch[1]);
              displayedText = textBuffer.slice(0, tagMatch.index).trimEnd();
              stopAccumulating = true;
            } else {
              const partialStart = textBuffer.lastIndexOf('<data');
              displayedText = partialStart !== -1 ? textBuffer.slice(0, partialStart).trimEnd() : textBuffer;
            }
          } else if (parsed.t === 'error') {
            throw new Error(parsed.message || 'Stream error');
          }
        } catch (e) {
          if (e.message && e.message !== 'Stream error') {
            // Skip malformed JSON
          } else {
            throw e;
          }
        }
      }
    }

    return { text: displayedText, raw: textBuffer, tag: tagFound };
  }

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
  // CARD SUMMARY for pass-2 prompt
  // ──────────────────────────────────────────────────────────────────────────

  function summarizeCard(card) {
    if (!card) return '(no card)';
    if (card.kind === 'no_data') return `No data: ${card.message || ''}`;
    if (card.kind === 'company_filings') {
      const parts = [`Company: ${card.company}`, `${card.total} filings`];
      if (card.is_spv_trail) parts.push(`SPV trail with ${card.groups?.length || 0} filer families`);
      if (card.groups) {
        parts.push('Top families: ' + card.groups.slice(0, 5).map(g => `${g.family_name} (${g.count})`).join(', '));
      }
      return parts.join('. ');
    }
    if (card.kind === 'filings_list') {
      const parts = [`Filings list: ${card.query_summary}`, `${card.total} matches`];
      if (card.rows?.length) {
        parts.push('Top filers: ' + card.rows.slice(0, 5).map(r => r.filer_name).join(', '));
      }
      return parts.join('. ');
    }
    return JSON.stringify(card).slice(0, 500);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RUN ALL — sequential, with stop button
  // ──────────────────────────────────────────────────────────────────────────

  document.getElementById('run-all').addEventListener('click', async () => {
    stopRequested = false;
    document.getElementById('run-all').disabled = true;
    document.getElementById('stop-all').disabled = false;
    document.getElementById('summary-bar').hidden = false;

    const startTime = Date.now();
    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById('stat-elapsed').textContent = `${sec}s`;
    }, 1000);

    for (const test of TESTS) {
      if (stopRequested) break;
      await runSingleTest(test);
    }

    clearInterval(elapsedTimer);
    document.getElementById('run-all').disabled = false;
    document.getElementById('stop-all').disabled = true;
  });

  document.getElementById('stop-all').addEventListener('click', () => {
    stopRequested = true;
  });

  document.getElementById('reset-all').addEventListener('click', () => {
    if (!confirm('Reset all test results?')) return;
    TESTS.forEach(test => {
      const block = document.getElementById(`test-${test.num}`);
      const statusEl = block.querySelector('.test-block-status');
      statusEl.className = 'test-block-status pending';
      statusEl.dataset.status = 'pending';
      statusEl.textContent = 'Pending';
      block.querySelector('.test-result').innerHTML = '';
      block.querySelector('.test-elapsed').textContent = '';
      block.querySelector('.test-debug').textContent = '';
    });
    document.getElementById('summary-bar').hidden = true;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY BAR
  // ──────────────────────────────────────────────────────────────────────────

  function updateSummary() {
    let completed = 0, running = 0, errored = 0;
    TESTS.forEach(test => {
      const block = document.getElementById(`test-${test.num}`);
      const status = block.querySelector('.test-block-status').dataset.status;
      if (status === 'done') completed++;
      else if (status === 'running') running++;
      else if (status === 'failed') errored++;
    });
    document.getElementById('stat-completed').textContent = completed;
    document.getElementById('stat-running').textContent = running;
    document.getElementById('stat-errored').textContent = errored;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HTML escape helper
  // ──────────────────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
