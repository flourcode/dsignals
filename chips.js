// ============================================================================
// chips.js — Smart pill suggestions
// ============================================================================
//
// SHELL FILE — same across every Mo skill.
//
// What this file exports:
//   - window.Chips.render(suggestions, onPick) → returns HTMLElement
//
// "suggestions" is the array returned from the pills handler. Shape:
//   [ { type: 'location', label: 'Try Phoenix', term: 'What's the weather in Phoenix?' }, ... ]
//
// "onPick" is a callback (term) => void. Called when user taps a pill.
// Typical usage: pre-fill the input with `term` and submit.
// ============================================================================

(function () {
  'use strict';

  function render(suggestions, onPick) {
    if (!suggestions || !suggestions.length) return null;

    const container = document.createElement('div');
    container.className = 'mo-pills';

    for (const s of suggestions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mo-pill';
      btn.textContent = s.label || s.term || 'More';
      btn.title = s.term || '';
      btn.dataset.type = s.type || '';
      btn.dataset.term = s.term || '';
      btn.addEventListener('click', () => {
        if (typeof onPick === 'function') onPick(s.term);
      });
      container.appendChild(btn);
    }

    return container;
  }

  window.Chips = { render };

})();
