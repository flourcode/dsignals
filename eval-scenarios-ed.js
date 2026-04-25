// ============================================================================
// eval-scenarios-ed.js — persona-driven eval scenarios for Ed
// ============================================================================
//
// Each scenario plays one or more user messages through Ed's real pipeline
// (fetcher.js + the deployed Lambda). Hard assertions = product bug if fail.
// Soft assertions = LLM nondeterminism, usually safe to flake occasionally.
//
// Run via evals-ed.html in a browser. Same pattern as Mo's eval suite.
// ============================================================================

export const EVAL_SCENARIOS = [
  // ──────────────────────────────────────────────────────────────────
  // 1. VC: "Show me AI raises last month"
  //    The canonical sector + date_after query. Tests resolver sector
  //    expansion (AI → SIC + keywords) and full-text search path.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "VC: AI raises last month",
    description: "VC scrolling for new AI deals. Sector + recent date query. Tests sector expansion and Form D enrichment with offering amounts.",
    turns: [
      {
        question: "Show me AI companies that raised last month",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'data mode', check: r => r.mode === 'data' },
          { type: 'hard', label: 'sector=AI in tag', check: r => r.tagAttrs?.sector?.toLowerCase() === 'ai' },
          { type: 'hard', label: 'form_type=D in tag', check: r => (r.tagAttrs?.form_type || 'D').toUpperCase() === 'D' },
          { type: 'hard', label: 'date_after present', check: r => !!r.tagAttrs?.date_after },
          { type: 'soft', label: 'rows returned', check: r => r.rowCount > 0 },
          { type: 'soft', label: 'at least some rows have offering amounts', check: r => r.rows && r.rows.filter(x => x.offeringAmount).length > 0 },
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2. Journalist: Stealth raise hunt
  //    Big amount + recent + sector. Tests post-filter for min_amount
  //    AND sector expansion together.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Journalist: Stealth AI raises above $20M",
    description: "Journalist hunting unannounced raises. Big amount + sector + recent. Tests min_amount post-filter applied to enriched rows.",
    turns: [
      {
        question: "Stealth AI companies with big raises this quarter",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'data mode', check: r => r.mode === 'data' },
          { type: 'hard', label: 'min_amount present in tag', check: r => !!r.tagAttrs?.min_amount },
          { type: 'soft', label: 'date_after recent (within last 6 months)', check: r => {
            if (!r.tagAttrs?.date_after) return false;
            const sixMo = Date.now() - (180 * 86400_000);
            return new Date(r.tagAttrs.date_after).getTime() > sixMo;
          }},
          { type: 'soft', label: 'all returned rows respect min_amount', check: r => {
            const min = parseInt(r.tagAttrs?.min_amount || 0);
            if (!r.rows || r.rows.length === 0) return true;
            const enriched = r.rows.filter(row => row.offeringAmount != null);
            if (enriched.length === 0) return true;
            return enriched.every(row => (row.offeringAmount || 0) >= min);
          }},
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 3. Founder: Competitive recon — known company
  //    Test the company-mode path. Anthropic IS in EDGAR but only as
  //    SPVs, not direct filings. Ed should surface this honestly.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Founder: Anthropic filing history",
    description: "Founder doing competitive recon. Tests company-mode path. Anthropic is the canonical 'no direct Form D, only SPVs' case — Ed should handle it honestly.",
    turns: [
      {
        question: "Has Anthropic filed anything new?",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'data mode', check: r => r.mode === 'data' },
          { type: 'hard', label: 'company=Anthropic (or similar) in tag', check: r => /anthropic/i.test(r.tagAttrs?.company || '') },
          { type: 'soft', label: 'rows returned (SPVs count as relevant)', check: r => r.rowCount > 0 },
          { type: 'soft', label: 'second-pass prose acknowledges SPV/no-direct-filing reality', check: r => {
            const t = (r.postTagText || '').toLowerCase();
            return t.includes('spv') || t.includes('series') || t.includes('hiive') || t.includes('vehicle') || t.includes('pooled') || t.includes('not anthropic') || t.includes('third-party');
          }},
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 4. Analyst: Form D explainer (prose mode)
  //    Tests that Ed handles "what is X" questions in prose without
  //    emitting a tag. Important: most chatbots try to call APIs for
  //    everything; Ed should know when the answer is conversational.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Analyst: What's a Form D?",
    description: "Educational question — no data pull needed. Tests that Ed correctly stays in prose mode rather than emitting an empty tag.",
    turns: [
      {
        question: "What's a Form D?",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'prose mode (no data pull)', check: r => r.mode === 'prose' },
          { type: 'hard', label: 'no <data> tag emitted', check: r => !r.tagAttrs },
          { type: 'soft', label: 'response mentions Form D characteristics', check: r => {
            const t = (r.preTagText || '').toLowerCase();
            return t.includes('form d') && (t.includes('private') || t.includes('exempt') || t.includes('reg d') || t.includes('rule 506'));
          }},
          { type: 'soft', label: 'response is concise (under 250 words)', check: r => (r.preTagText || '').split(/\s+/).length < 250 },
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 5. Public-co analyst: 10-K cross-form search
  //    Tests form_type override (default is D, this should be 10-K).
  //    Cross-form search returns thousands of hits — confirms we don't
  //    accidentally limit to Form D.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Analyst: AI mentions in 10-Ks",
    description: "Cross-form search across public-co annual reports. Tests form_type override and broad keyword search.",
    turns: [
      {
        question: "Show me 10-K filings that mention artificial intelligence",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'data mode', check: r => r.mode === 'data' },
          { type: 'hard', label: 'form_type=10-K in tag', check: r => /10-?K/i.test(r.tagAttrs?.form_type || '') },
          { type: 'soft', label: 'rows returned (10-Ks mentioning AI are abundant)', check: r => r.rowCount > 0 },
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 6. Honest-limit handling: investor names question
  //    Tests that Ed honestly says "Form D doesn't have investor names"
  //    instead of either fabricating or refusing entirely. Could be
  //    prose (best) OR data (acceptable if Ed offers to pull what IS
  //    available).
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Founder: Who invested in OpenAI's last round?",
    description: "Tests honest-limit handling. Investor names aren't in Form D. Ed should acknowledge this rather than fabricate.",
    turns: [
      {
        question: "Who invested in OpenAI's latest round?",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'soft', label: 'response acknowledges investor-name limit', check: r => {
            const t = ((r.preTagText || '') + ' ' + (r.postTagText || '')).toLowerCase();
            return t.includes('investor name') || t.includes("don't") || t.includes('not required') || t.includes('not in form d') || t.includes("aren't") || t.includes('not disclosed') || t.includes('13-f') || t.includes('13f');
          }},
          { type: 'soft', label: 'does NOT name specific investors', check: r => {
            const t = ((r.preTagText || '') + ' ' + (r.postTagText || '')).toLowerCase();
            // Common VCs that Ed might fabricate from training data
            const namedInvestors = ['sequoia', 'andreessen', 'a16z', 'tiger global', 'thrive capital', 'founders fund', 'khosla'];
            return !namedInvestors.some(name => t.includes(name));
          }},
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 7. Multi-turn refinement: refer-back with deictic narrowing
  //    T1: broad sector pull. T2: "just California" should re-emit
  //    with state filter, NOT lose the sector context.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Multi-turn: sector then state-narrow",
    description: "T1 establishes sector context, T2 refines with state. Tests that follow-up classification keeps active card context.",
    turns: [
      {
        question: "Show me cybersecurity Form Ds this year",
        assert: [
          { type: 'hard', label: 'T1 sector=cyber-shaped', check: r => /cyber/i.test(r.tagAttrs?.sector || '') },
        ],
      },
      {
        question: "just the California ones",
        assert: [
          { type: 'hard', label: 'T2 state=CA', check: r => /CA/i.test(r.tagAttrs?.state || '') },
          { type: 'hard', label: 'T2 sector still cybersecurity (carried forward)', check: r => /cyber/i.test(r.tagAttrs?.sector || '') },
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 8. Multi-turn pivot: clean reset
  //    T1: company A. T2: completely new sector. Should NOT carry
  //    the company forward. This is Mo's reset-discipline pattern.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Multi-turn: clean pivot",
    description: "T1 = company query, T2 = totally new sector query. Should drop T1 context entirely.",
    turns: [
      {
        question: "What did Stripe file in 2024?",
        assert: [
          { type: 'hard', label: 'T1 company=Stripe', check: r => /stripe/i.test(r.tagAttrs?.company || '') },
        ],
      },
      {
        question: "Show me biotech Form Ds above $50M this year",
        assert: [
          { type: 'hard', label: 'T2 sector=biotech', check: r => /bio/i.test(r.tagAttrs?.sector || '') },
          { type: 'hard', label: 'T2 dropped Stripe', check: r => !/stripe/i.test(r.tagAttrs?.company || '') },
          { type: 'hard', label: 'T2 has min_amount filter', check: r => parseInt(r.tagAttrs?.min_amount || 0) >= 50_000_000 },
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 9. Fuzzy match warning
  //    Look up a company that shouldn't exist directly. Ed should
  //    flag the fuzzy match in the card meta.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Fuzzy match: nonsense company",
    description: "Tests that Ed surfaces fuzzy-match warnings instead of pretending a misspelled or unknown company resolved cleanly.",
    turns: [
      {
        question: "Has Zzqxynth Corp filed anything?",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          // Either: data mode with fuzzy flag, OR prose mode acknowledging no match
          { type: 'hard', label: 'fuzzy flag OR prose acknowledging no match', check: r => {
            if (r.mode === 'prose') return /no match|couldn't find|don't see/i.test(r.preTagText || '');
            if (r.mode === 'data') return r.meta?.fuzzyMatch === true || r.rowCount === 0;
            return false;
          }},
        ],
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 10. Date-only query
  //    No company, no sector — just "recent Form Ds". Tests that the
  //    resolver gracefully handles minimum-info queries.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "Date-only: recent Form Ds",
    description: "Bare 'recent Form Ds' query. Tests resolver with no sector or company — should still produce valid search.",
    turns: [
      {
        question: "Show me recent Form D filings from last week",
        assert: [
          { type: 'hard', label: 'no crash', check: r => r.mode !== 'error' },
          { type: 'hard', label: 'data mode', check: r => r.mode === 'data' },
          { type: 'hard', label: 'date_after present', check: r => !!r.tagAttrs?.date_after },
          { type: 'soft', label: 'rows returned (Form Ds happen daily)', check: r => r.rowCount > 0 },
        ],
      },
    ],
  },
];
