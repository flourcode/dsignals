// ============================================================================
// app.js — UI orchestration
// ============================================================================
//
// SHELL FILE — same across every Mo skill.
//
// Wires together:
//   - The greeting (Mo's first impression, with example queries)
//   - The composer (input + send button)
//   - The conversation thread (renders user + Mo turns)
//   - The about modal
//
// Reads from window.MO_CONFIG (set by index.html's inline module script).
// Calls into window.MoStream, window.CardRenderer, window.Chips.
// ============================================================================

(function () {
  'use strict';

  const config = window.MO_CONFIG || {};
  const FACE_OPEN = '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#icon-face-open"/></svg>';

  const els = {
    thread:       document.getElementById('mo-thread'),
    composer:     document.getElementById('mo-composer'),
    input:        document.getElementById('mo-input'),
    send:         document.getElementById('mo-send'),
    btnReset:     document.getElementById('btn-reset'),
    btnAbout:     document.getElementById('btn-about'),
    modal:        document.getElementById('mo-modal'),
    modalContent: document.getElementById('mo-modal-content'),
    modalClose:   document.getElementById('mo-modal-close'),
    modalBackdrop: document.getElementById('mo-modal-backdrop'),
  };

  const state = {
    history: [],   // [{ role: 'user' | 'model', content: string }]
    busy: false,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Greeting (shown on initial load and after reset)
  // ──────────────────────────────────────────────────────────────────────────

  function renderGreeting() {
    els.thread.innerHTML = '';

    const greetingDiv = document.createElement('div');
    greetingDiv.className = 'greeting';

    const greeting = config.greeting || "Hey, I'm Mo. What can I help with?";
    const tagline = config.tagline || '';
    const displayName = config.displayName || 'Mo';

    greetingDiv.innerHTML = `
      <div class="greeting-face">${FACE_OPEN}</div>
      <div class="greeting-intro-text">
        <div class="greeting-hi">Hi, I'm ${escapeHtml(displayName)}.</div>
        <div class="greeting-sub">${escapeHtml(greeting)}</div>
        ${tagline ? `<div class="greeting-sub" style="margin-top: 4px; font-size: 13px; color: var(--text-faint);">${escapeHtml(tagline)}</div>` : ''}
      </div>
    `;

    els.thread.appendChild(greetingDiv);

    // Example queries from config — each becomes a tappable chip on the
    // greeting screen. If config doesn't define them, no chips render.
    const examples = Array.isArray(config.exampleQueries) ? config.exampleQueries : [];

    if (examples.length > 0) {
      const examplesEl = document.createElement('div');
      examplesEl.className = 'greeting-examples';
      examplesEl.style.marginTop = '12px';
      examplesEl.style.marginLeft = '80px';

      for (const ex of examples) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'greeting-example';
        btn.textContent = ex;
        btn.addEventListener('click', () => submitMessage(ex));
        examplesEl.appendChild(btn);
      }

      els.thread.appendChild(examplesEl);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Submit a user message
  // ──────────────────────────────────────────────────────────────────────────

  async function submitMessage(text) {
    if (state.busy) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    // Clear the greeting on first message
    if (state.history.length === 0) {
      els.thread.innerHTML = '';
    }

    // Render user bubble
    const userTurn = document.createElement('div');
    userTurn.className = 'turn-user';
    userTurn.innerHTML = `<div class="turn-user-bubble">${escapeHtml(trimmed)}</div>`;
    els.thread.appendChild(userTurn);

    // Update history
    state.history.push({ role: 'user', content: trimmed });

    // Clear the input and disable composer while streaming
    els.input.value = '';
    setBusy(true);

    // Scroll user message into view
    userTurn.scrollIntoView({ behavior: 'smooth', block: 'end' });

    try {
      await window.MoStream.streamTurn({
        history: state.history.slice(),
        container: els.thread,
        apiEndpoint: config.apiEndpoint,
        onCardRendered: () => {
          // Scroll the new card into view as it appears
          els.thread.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        },
        onTurnComplete: (summary) => {
          // Add the model turn to history for next round
          const fullText = [summary.first_pass_text, summary.second_pass_text]
            .filter(Boolean)
            .join('\n\n');
          if (fullText) {
            state.history.push({ role: 'model', content: fullText });
          }
        },
      });
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
      els.input.focus();
    }
  }

  function setBusy(b) {
    state.busy = b;
    els.send.disabled = b;
    els.input.disabled = b;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Reset — start a new conversation
  // ──────────────────────────────────────────────────────────────────────────

  function resetThread() {
    state.history = [];
    state.busy = false;
    els.input.value = '';
    setBusy(false);
    renderGreeting();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // About modal
  // ──────────────────────────────────────────────────────────────────────────

  function openAbout() {
    const meet = config.meetWith || {};
    const dataSource = config.dataSource || {};
    const displayName = config.displayName || 'Mo';

    els.modalContent.innerHTML = `
      <h2>About ${escapeHtml(displayName)}</h2>
      <p>${escapeHtml(displayName)} is a chatbot built on the Mo platform. ${escapeHtml(config.tagline || '')}</p>
      <p>Every fact ${escapeHtml(displayName)} cites comes from <a href="${escapeAttr(dataSource.url || '#')}" target="_blank" rel="noopener">${escapeHtml(dataSource.name || 'a public data source')}</a>. You can verify anything specific on EDGAR directly.</p>
      ${meet.name ? `<p>Feedback or just want to talk? <a href="${escapeAttr(meet.url || '#')}" target="_blank" rel="noopener">Meet ${escapeHtml(meet.name)}</a>.</p>` : ''}
      <p style="font-size: 12px; color: var(--text-faint); margin-top: 24px;">Powered by Gemini · <a href="https://github.com/" target="_blank" rel="noopener">Built on Mo</a></p>
    `;

    els.modal.hidden = false;
  }

  function closeAbout() {
    els.modal.hidden = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Wire up
  // ──────────────────────────────────────────────────────────────────────────

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submitMessage(els.input.value);
  });

  els.btnReset.addEventListener('click', resetThread);
  els.btnAbout.addEventListener('click', openAbout);
  els.modalClose.addEventListener('click', closeAbout);
  els.modalBackdrop.addEventListener('click', closeAbout);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) closeAbout();
  });

  // Util
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // Expose for stream-client to call back
  window.MoApp = { submitMessage, resetThread };

  // Set browser tab title from config
  if (config.pageTitle) {
    document.title = config.pageTitle;
  }

  // Set input placeholder from config
  if (config.inputPlaceholder && els.input) {
    els.input.placeholder = config.inputPlaceholder;
  }

  // Initial render
  renderGreeting();

  // ──────────────────────────────────────────────────────────────────────
  // URL query routing — if ?q=... is present in the URL, auto-fire that
  // query as if the user had typed it. Used by Substack newsletter deep
  // links: dsignals.com/?q=Anthropic+SPV+activity
  // ──────────────────────────────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const initialQuery = urlParams.get('q');
  if (initialQuery && initialQuery.trim()) {
    // Tiny delay so the greeting renders first, then we transition into the query
    setTimeout(() => {
      window.MoApp.submitMessage(initialQuery.trim());
    }, 200);
  }

})();
