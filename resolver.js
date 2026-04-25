// ============================================================================
// resolver.js — Ed's natural-language → EDGAR-query resolver
// ============================================================================
//
// Input:  a dataAttrs-shaped object from Ed's <data /> tag:
//         { company, sector, form_type, state, min_amount, max_amount,
//           date_after, date_before, exec_name }
//
// Output: { mode, query } where:
//   mode = 'company'   → query is a CIK + filter spec for submissions API
//          'search'    → query is a full-text search spec for efts.sec.gov
//
// The fetcher (stream-client.js / Lambda) consumes this and issues the right
// EDGAR API call.
//
// This file is the "brain" of Ed — SIC code translation, company name → CIK
// lookup, sector keyword expansion, state normalization. Pure functions,
// no network calls (the fetcher does network).
// ============================================================================

// ─────────────────────────────────────────────────────────────────────
// SECTOR EXPANSION
// ─────────────────────────────────────────────────────────────────────
//
// SIC codes are from 1987 and don't match modern categories. "AI" isn't a
// code. Most AI companies file under 7372 (Prepackaged Software) or 7371
// (Computer Services). To surface them reliably we combine:
//   1. SIC code filter   — narrow to plausible industries
//   2. keyword filter    — company name or filing text matches modern terms
//
// Each sector alias maps to (sicCodes, keywords). Both are OR'd in the query.
// ─────────────────────────────────────────────────────────────────────

const SECTORS = {
  'ai': {
    sicCodes: ['7372', '7371', '7389', '8742'],
    keywords: ['artificial intelligence', 'machine learning', 'LLM', 'large language model',
               'foundation model', 'generative AI', 'neural network', 'AI platform',
               'AI model', 'AI research', 'AI assistant'],
    display: 'Artificial Intelligence',
  },
  'cybersecurity': {
    sicCodes: ['7372', '7371', '7389'],
    keywords: ['cybersecurity', 'cyber security', 'information security', 'infosec',
               'endpoint security', 'cloud security', 'zero trust', 'SIEM', 'SOAR',
               'threat detection', 'vulnerability management', 'SOC'],
    display: 'Cybersecurity',
  },
  'fintech': {
    sicCodes: ['6199', '6020', '6029', '7372', '6770'],
    keywords: ['fintech', 'financial technology', 'payments', 'banking platform',
               'neobank', 'digital bank', 'embedded finance', 'BNPL', 'buy now pay later',
               'lending platform', 'payment processing'],
    display: 'Financial Technology',
  },
  'climate': {
    sicCodes: ['4911', '4961', '3612', '3674', '2899', '8731'],
    keywords: ['climate', 'carbon capture', 'carbon removal', 'clean energy',
               'renewable energy', 'solar', 'battery storage', 'grid-scale',
               'decarbonization', 'electrification', 'sustainability'],
    display: 'Climate / Clean Energy',
  },
  'biotech': {
    sicCodes: ['2836', '8731', '3841', '8099'],
    keywords: ['biotech', 'biotechnology', 'drug discovery', 'therapeutics',
               'oncology', 'gene therapy', 'mRNA', 'clinical trial',
               'pharmaceutical', 'pharma', 'life sciences'],
    display: 'Biotechnology',
  },
  'hardware': {
    sicCodes: ['3674', '3827', '3829', '3825', '3669'],
    keywords: ['semiconductor', 'chip', 'custom silicon', 'robotics',
               'hardware platform', 'edge device', 'IoT', 'sensors'],
    display: 'Hardware / Semiconductors',
  },
  'saas': {
    sicCodes: ['7372', '7371', '7389'],
    keywords: ['SaaS', 'software-as-a-service', 'cloud software', 'enterprise software',
               'workflow automation', 'collaboration platform', 'vertical SaaS'],
    display: 'SaaS',
  },
  'crypto': {
    sicCodes: ['7372', '6199', '6770'],
    keywords: ['blockchain', 'cryptocurrency', 'crypto', 'digital assets',
               'Web3', 'DeFi', 'decentralized finance', 'stablecoin', 'NFT'],
    display: 'Crypto / Web3',
  },
  'real estate': {
    sicCodes: ['6798', '6500', '1540', '6552'],
    keywords: ['real estate', 'proptech', 'property technology', 'REIT',
               'commercial real estate', 'property management'],
    display: 'Real Estate',
  },
  'consumer': {
    sicCodes: ['5812', '5912', '5651', '2844', '3944'],
    keywords: ['consumer brand', 'DTC', 'direct to consumer', 'e-commerce',
               'marketplace', 'consumer product'],
    display: 'Consumer',
  },
};

function normalizeSectorKey(input) {
  if (!input || typeof input !== 'string') return null;
  const key = input.trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Common aliases — map variations to the canonical key
  const aliases = {
    'artificial intelligence': 'ai',
    'ml': 'ai',
    'machine learning': 'ai',
    'llm': 'ai',
    'cyber': 'cybersecurity',
    'cyber security': 'cybersecurity',
    'infosec': 'cybersecurity',
    'security': 'cybersecurity',
    'financial technology': 'fintech',
    'payments': 'fintech',
    'climatetech': 'climate',
    'cleantech': 'climate',
    'clean energy': 'climate',
    'bio': 'biotech',
    'biotechnology': 'biotech',
    'pharma': 'biotech',
    'semiconductors': 'hardware',
    'semis': 'hardware',
    'chips': 'hardware',
    'software': 'saas',
    'enterprise saas': 'saas',
    'blockchain': 'crypto',
    'web3': 'crypto',
    'proptech': 'real estate',
    'realestate': 'real estate',
    'ecommerce': 'consumer',
    'dtc': 'consumer',
  };
  return aliases[key] || (SECTORS[key] ? key : null);
}

export function expandSector(input) {
  const key = normalizeSectorKey(input);
  if (!key) return null;
  return { key, ...SECTORS[key] };
}

// ─────────────────────────────────────────────────────────────────────
// COMPANY NAME → CIK RESOLUTION
// ─────────────────────────────────────────────────────────────────────
//
// Two-stage resolution:
//   1. Public ticker map (from /files/company_tickers.json, cached) —
//      handles "NVDA", "Apple", "Tesla" instantly. Public companies only.
//   2. EDGAR company search endpoint for name-based fuzzy match —
//      handles private companies filing Form Ds ("Anthropic", "Stripe").
//      Returns the best-guess CIK.
//
// This module has the logic; the actual fetch happens in the fetcher.
// resolveCompany returns the resolved form so the fetcher knows which
// endpoint to hit.
// ─────────────────────────────────────────────────────────────────────

// Normalize a company name for matching: lowercase, strip punctuation,
// strip common suffixes that cause false mismatches.
export function normalizeCompanyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase()
    .replace(/[.,'"`]/g, '')
    .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|holdings|group|plc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Given a `company` string from the tag, decide if it looks like a ticker
// (all caps, 1-5 chars) or a name. Tickers resolve exactly; names need fuzzy.
export function looksLikeTicker(input) {
  if (!input || typeof input !== 'string') return false;
  return /^[A-Z][A-Z0-9\-.]{0,5}$/.test(input.trim());
}

// ─────────────────────────────────────────────────────────────────────
// STATE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────

const STATES = {
  'delaware': 'DE', 'de': 'DE',
  'california': 'CA', 'ca': 'CA', 'calif': 'CA',
  'new york': 'NY', 'ny': 'NY',
  'texas': 'TX', 'tx': 'TX',
  'washington': 'WA', 'wa': 'WA',
  'massachusetts': 'MA', 'ma': 'MA', 'mass': 'MA',
  'florida': 'FL', 'fl': 'FL',
  'illinois': 'IL', 'il': 'IL',
  'colorado': 'CO', 'co': 'CO',
  'nevada': 'NV', 'nv': 'NV',
  // Add more as needed; most filings are DE anyway
};

export function normalizeState(input) {
  if (!input || typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  if (STATES[key]) return STATES[key];
  // If it's already a 2-letter code uppercased, accept it
  if (/^[A-Z]{2}$/.test(input.trim().toUpperCase())) return input.trim().toUpperCase();
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// DATE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────
//
// The tag should already emit ISO dates, but we defend against any slop.
// Returns 'YYYY-MM-DD' or null.

export function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try to parse
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// FORM TYPE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────

const VALID_FORMS = new Set(['D', 'D/A', '10-K', '10-Q', '8-K', 'S-1', 'S-1/A', '13-F', '13F-HR', 'DEF 14A']);

export function normalizeFormType(input) {
  if (!input) return 'D'; // default
  const s = String(input).trim().toUpperCase();
  // Common variations
  if (s === 'FORM D' || s === 'D') return 'D';
  if (s === '10K' || s === '10-K') return '10-K';
  if (s === '10Q' || s === '10-Q') return '10-Q';
  if (s === '8K' || s === '8-K') return '8-K';
  if (s === 'S1' || s === 'S-1') return 'S-1';
  if (s === '13F' || s === '13-F') return '13-F';
  if (VALID_FORMS.has(s)) return s;
  return 'D'; // unknown → default to Form D
}

// ─────────────────────────────────────────────────────────────────────
// MAIN RESOLVER
// ─────────────────────────────────────────────────────────────────────
//
// Turns Ed's <data /> tag attributes into a query spec the fetcher can run.
// Decides which EDGAR endpoint to use based on whether a specific company
// was named.
//
// Returns: { mode, query, meta }
//   mode = 'company' — company-specific query, needs CIK resolution
//                      query = { companyInput, formType, dateAfter, dateBefore }
//   mode = 'search'  — full-text search across filings
//                      query = { forms, q, dateRange, state, ... }
//   meta = { sector, stateNormalized, ... } — for debug + card rendering
// ─────────────────────────────────────────────────────────────────────

export function resolve(tagAttrs) {
  const attrs = tagAttrs || {};
  const meta = {};

  // Normalize common fields
  const formType = normalizeFormType(attrs.form_type);
  const dateAfter = normalizeDate(attrs.date_after);
  const dateBefore = normalizeDate(attrs.date_before);
  const state = normalizeState(attrs.state);
  const sectorInfo = attrs.sector ? expandSector(attrs.sector) : null;

  meta.formType = formType;
  if (dateAfter) meta.dateAfter = dateAfter;
  if (dateBefore) meta.dateBefore = dateBefore;
  if (state) meta.state = state;
  if (sectorInfo) meta.sector = sectorInfo;

  // Path A: company-specific query
  if (attrs.company && String(attrs.company).trim()) {
    const companyInput = String(attrs.company).trim();
    return {
      mode: 'company',
      query: {
        companyInput,
        isTicker: looksLikeTicker(companyInput),
        formType,
        dateAfter,
        dateBefore,
      },
      meta,
    };
  }

  // Path B: full-text search (sector, amount, state, date filters)
  const query = {
    forms: [formType],
    dateRange: {},
    filters: {},
  };

  if (dateAfter) query.dateRange.startdt = dateAfter;
  if (dateBefore) query.dateRange.enddt = dateBefore;

  // Build the full-text `q` parameter from sector keywords
  const qParts = [];
  if (sectorInfo && sectorInfo.keywords.length > 0) {
    // EDGAR full-text search supports quoted phrases; wrap multi-word keywords
    const phrases = sectorInfo.keywords.map(k =>
      k.includes(' ') ? `"${k}"` : k
    );
    // Join with OR (EDGAR treats space as OR by default, but we quote for clarity)
    qParts.push(phrases.join(' '));
  }
  if (attrs.exec_name) {
    qParts.push(`"${String(attrs.exec_name).trim()}"`);
    meta.execName = String(attrs.exec_name).trim();
  }
  if (qParts.length > 0) {
    query.q = qParts.join(' ');
  }

  // SIC filter (narrows the universe before keyword match)
  if (sectorInfo && sectorInfo.sicCodes.length > 0) {
    query.filters.sicCodes = sectorInfo.sicCodes;
  }

  // State filter (state of incorporation — EDGAR calls this locationCode)
  if (state) {
    query.filters.state = state;
  }

  // Amount filters are post-filters. EDGAR full-text search doesn't support
  // amount ranges directly; we apply them after fetch.
  if (attrs.min_amount != null) {
    const n = Number(attrs.min_amount);
    if (Number.isFinite(n) && n > 0) query.filters.minAmount = n;
  }
  if (attrs.max_amount != null) {
    const n = Number(attrs.max_amount);
    if (Number.isFinite(n) && n > 0) query.filters.maxAmount = n;
  }

  return { mode: 'search', query, meta };
}

// ─────────────────────────────────────────────────────────────────────
// POST-FILTERS
// ─────────────────────────────────────────────────────────────────────
//
// Some filters can't be expressed in the EDGAR query (amount bounds on
// Form Ds, for example — the API doesn't support it). Apply them here
// after the fetcher returns rows.

export function applyPostFilters(rows, postFilters) {
  if (!rows || rows.length === 0 || !postFilters) return rows;
  let out = rows;
  if (postFilters.minAmount != null) {
    out = out.filter(r => (r.offeringAmount || 0) >= postFilters.minAmount);
  }
  if (postFilters.maxAmount != null) {
    out = out.filter(r => (r.offeringAmount || 0) <= postFilters.maxAmount);
  }
  return out;
}
