// ============================================================================
// fetcher.js — Ed's EDGAR fetch + parse layer
// ============================================================================
//
// Two endpoints, one job: turn a resolved query into clean row objects the
// renderer can display.
//
// Endpoint 1: EDGAR full-text search
//   URL:  https://efts.sec.gov/LATEST/search-index
//   Used for: sector searches, date-range searches, company-name searches
//   Returns: JSON with hits[] metadata (NO offering amounts)
//
// Endpoint 2: Form D primary_doc.xml
//   URL:  https://www.sec.gov/Archives/edgar/data/{CIK}/{ACC_NODASH}/primary_doc.xml
//   Used for: pulling the actual $ amount + investor count + exemption info
//   Returns: XML with the full Form D structure
//
// Design: we always hit endpoint 1 first (cheap, fast, batched), then
// enrich the top N hits by fetching their XML in parallel. The enrichment
// is what gives Ed the "$5M raised by X" signal that Crunchbase-lite
// products rely on.
//
// All fetches go through the Lambda proxy (edgar_proxy), which:
//   - adds the required User-Agent header
//   - throttles to SEC's 10 req/sec limit
//   - handles retry on transient errors
// ============================================================================

import { resolve, applyPostFilters, normalizeCompanyName } from './resolver.js';

// ─────────────────────────────────────────────────────────────────────
// EDGAR full-text search
// ─────────────────────────────────────────────────────────────────────
//
// Builds the query string for efts.sec.gov/LATEST/search-index from the
// resolver's output, hits the proxy, returns the raw hit[] array.
// No enrichment here — just the metadata list.
// ─────────────────────────────────────────────────────────────────────

function buildSearchQueryString(query) {
  const params = new URLSearchParams();

  if (query.q) params.set('q', query.q);

  if (query.forms && query.forms.length > 0) {
    params.set('forms', query.forms.join(','));
  }

  if (query.dateRange) {
    if (query.dateRange.startdt || query.dateRange.enddt) {
      params.set('dateRange', 'custom');
      if (query.dateRange.startdt) params.set('startdt', query.dateRange.startdt);
      if (query.dateRange.enddt) params.set('enddt', query.dateRange.enddt);
    }
  }

  if (query.filters) {
    if (query.filters.state) {
      // EDGAR uses locationCode for state-of-incorporation filter
      params.set('locationCode', query.filters.state);
    }
    // SIC code filter — EDGAR accepts comma-separated list via category=form-type
    // but the cleaner way is to OR them into the q field. We leave SIC
    // unused in the URL for now; post-filter by parsed SIC if needed.
  }

  return params.toString();
}

export async function searchEdgar(query, proxyEndpoint) {
  const queryString = buildSearchQueryString(query);

  const res = await fetch(proxyEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'edgar_proxy',
      path: '/LATEST/search-index',
      host: 'efts.sec.gov',
      queryString,
    }),
  });

  if (!res.ok) {
    throw new Error(`EDGAR search failed: ${res.status}`);
  }

  const body = await res.json();
  const hits = body?.hits?.hits || [];
  const total = body?.hits?.total?.value || 0;

  // Shape each hit into a minimal row object. Offering amounts are NOT
  // here — they'll be added by the enrichment step.
  const rows = hits.map(h => {
    const src = h._source || {};
    const cik = (src.ciks && src.ciks[0]) || '';
    const displayName = (src.display_names && src.display_names[0]) || '';
    // display_names have the form "Company Name  (CIK 0001234567)"
    // Strip the trailing CIK annotation for clean display.
    const entityName = displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, '').trim();
    return {
      id: h._id,                   // e.g. "0002065512-25-000001:primary_doc.xml"
      accession: src.adsh,          // e.g. "0002065512-25-000001"
      cik,
      entityName,
      form: src.form,
      fileDate: src.file_date,
      incStates: src.inc_states || [],
      bizLocations: src.biz_locations || [],
      sics: src.sics || [],
      items: src.items || [],       // exemption codes like ["06b"]
      // Placeholders filled by enrichment:
      offeringAmount: null,
      totalSold: null,
      industryGroup: null,
      investmentFundType: null,
      investorCount: null,
      dateOfFirstSale: null,
      minInvestment: null,
      isAmendment: null,
      entityType: null,
      yearOfInc: null,
      exemptions: [],
      relatedPersons: [],
    };
  });

  return { rows, total };
}

// ─────────────────────────────────────────────────────────────────────
// Form D XML enrichment
// ─────────────────────────────────────────────────────────────────────
//
// For each Form D row, fetch the primary_doc.xml and parse out the
// structured fields the search endpoint doesn't return. Runs in parallel
// with a concurrency cap so we don't hammer SEC's rate limit (10/sec).
//
// Gracefully handles:
//   - 404s (some filings use different doc names; skip)
//   - parse errors (schema drift; skip)
//   - non-Form-D filings (skip enrichment, keep metadata)
// ─────────────────────────────────────────────────────────────────────

// Build the archive path: /Archives/edgar/data/{CIK-no-zeros}/{accession-no-dashes}/primary_doc.xml
function buildArchivePath(row) {
  const cikNum = String(parseInt(row.cik, 10)); // strip leading zeros
  const accNoDash = (row.accession || '').replace(/-/g, '');
  return `/Archives/edgar/data/${cikNum}/${accNoDash}/primary_doc.xml`;
}

// Tiny XML reader. We don't need a full parser — we just pluck specific
// paths. Regex is fine for this narrow job because the XML is machine-
// generated by SEC and highly consistent. For any reported parsing weirdness
// in the wild we can upgrade to a real parser later.
function xmlGet(xml, path) {
  // path like "primaryIssuer/entityName" — extract the innerText of the
  // last element. For repeated elements use xmlGetAll.
  const parts = path.split('/');
  const tag = parts[parts.length - 1];
  // Match <tag>...</tag> (non-greedy on content)
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  return m[1].trim();
}

function xmlGetAll(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// Parse a Form D XML into the enrichment fields we need. Returns an object
// that the caller merges into the row.
export function parseFormD(xml) {
  if (!xml || typeof xml !== 'string') return {};

  // Numeric parsers tolerate blanks and missing fields.
  const num = (s) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  // Related persons block — extract each <relatedPersonInfo> chunk and
  // parse name + relationship from within. SPVs typically have 1-3 of
  // these (administrator, signing officer). Operating companies have
  // their founders/execs.
  const personBlocks = xmlGetAll(xml, 'relatedPersonInfo');
  const relatedPersons = personBlocks.map(block => {
    const first = xmlGet(block, 'firstName') || '';
    const middle = xmlGet(block, 'middleName') || '';
    const last = xmlGet(block, 'lastName') || '';
    const name = [first, middle, last].filter(Boolean).join(' ');
    const rels = xmlGetAll(block, 'relationship');
    const clarification = xmlGet(block, 'relationshipClarification') || '';
    return { name, relationships: rels, clarification };
  }).filter(p => p.name.length > 0);

  // Exemption items — always a list
  const exemptions = xmlGetAll(xml, 'item').filter(x => /^[0-9]/.test(x));

  // Amendment flag
  const amendmentRaw = xmlGet(xml, 'isAmendment');
  const isAmendment = amendmentRaw === 'true';

  // Year of inc — nested in <yearOfInc><value>...
  let yearOfInc = null;
  const yearBlock = xmlGet(xml, 'yearOfInc');
  if (yearBlock) {
    const v = xmlGet(`<x>${yearBlock}</x>`, 'value');
    if (v) yearOfInc = num(v);
  }

  // Date of first sale — similar nested shape
  let dateOfFirstSale = null;
  const dosBlock = xmlGet(xml, 'dateOfFirstSale');
  if (dosBlock) {
    const v = xmlGet(`<x>${dosBlock}</x>`, 'value');
    if (v) dateOfFirstSale = v;
  }

  return {
    offeringAmount: num(xmlGet(xml, 'totalOfferingAmount')),
    totalSold: num(xmlGet(xml, 'totalAmountSold')),
    totalRemaining: num(xmlGet(xml, 'totalRemaining')),
    industryGroup: xmlGet(xml, 'industryGroupType'),
    investmentFundType: xmlGet(xml, 'investmentFundType'),
    investorCount: num(xmlGet(xml, 'totalNumberAlreadyInvested')),
    hasNonAccredited: xmlGet(xml, 'hasNonAccreditedInvestors') === 'true',
    dateOfFirstSale,
    minInvestment: num(xmlGet(xml, 'minimumInvestmentAccepted')),
    revenueRange: xmlGet(xml, 'revenueRange'),
    isAmendment,
    entityType: xmlGet(xml, 'entityType'),
    yearOfInc,
    jurisdiction: xmlGet(xml, 'jurisdictionOfInc'),
    exemptions,
    relatedPersons,
  };
}

// Fetch and parse one Form D's XML. Returns enrichment object or null on
// any failure. Logs nothing — the caller decides how to handle missing data.
export async function fetchAndParseFormD(row, proxyEndpoint) {
  const path = buildArchivePath(row);
  try {
    const res = await fetch(proxyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_type: 'edgar_proxy',
        path,
        host: 'www.sec.gov',
        raw: true, // return body as text, not parsed JSON
      }),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml || !xml.includes('<edgarSubmission')) return null;
    return parseFormD(xml);
  } catch (e) {
    return null;
  }
}

// Parallel enrichment with a concurrency cap. SEC rate limit is 10 req/sec;
// we stay conservative at 5 concurrent.
async function enrichRowsWithConcurrency(rows, proxyEndpoint, concurrency = 5) {
  const out = [...rows];
  let cursor = 0;

  async function worker() {
    while (true) {
      const myIndex = cursor++;
      if (myIndex >= out.length) return;
      const row = out[myIndex];
      // Only enrich Form D rows (10-K, 8-K etc have different XML shapes)
      if (row.form !== 'D' && row.form !== 'D/A') continue;
      const enrichment = await fetchAndParseFormD(row, proxyEndpoint);
      if (enrichment) {
        out[myIndex] = { ...row, ...enrichment };
      }
    }
  }

  await Promise.all(Array(concurrency).fill(0).map(() => worker()));
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// COMPANY SUBMISSIONS (full filing history for a known CIK)
// ─────────────────────────────────────────────────────────────────────
//
// Different endpoint: data.sec.gov/submissions/CIK##########.json returns
// the entity's full filing history as column arrays. We shape this into
// row objects like the search endpoint.
//
// Only used when the resolver returns mode='company' AND we've already
// resolved the company name to a CIK (which happens via search endpoint first).
// ─────────────────────────────────────────────────────────────────────

export async function fetchSubmissions(cik, proxyEndpoint) {
  const padded = String(cik).padStart(10, '0');
  const path = `/submissions/CIK${padded}.json`;
  const res = await fetch(proxyEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_type: 'edgar_proxy',
      path,
      host: 'data.sec.gov',
    }),
  });
  if (!res.ok) throw new Error(`Submissions fetch failed: ${res.status}`);
  return await res.json();
}

// Turn the submissions columnar-array format into row objects.
// submissions.filings.recent is the hot data; it has parallel arrays:
//   accessionNumber[], filingDate[], form[], primaryDocument[], etc.
// We zip these into objects.
export function submissionsToRows(submissions, options = {}) {
  const maxRows = options.maxRows || 50;
  const formFilter = options.formType || null;

  const r = submissions?.filings?.recent;
  if (!r || !Array.isArray(r.accessionNumber)) return [];

  const entityName = submissions?.name || '';
  const cik = submissions?.cik || '';
  const sic = submissions?.sic || '';
  const sicDesc = submissions?.sicDescription || '';

  const rows = [];
  const n = r.accessionNumber.length;
  for (let i = 0; i < n && rows.length < maxRows; i++) {
    const form = r.form[i];
    if (formFilter && form !== formFilter) continue;
    rows.push({
      accession: r.accessionNumber[i],
      cik,
      entityName,
      form,
      fileDate: r.filingDate[i],
      reportDate: r.reportDate ? r.reportDate[i] : null,
      primaryDocument: r.primaryDocument ? r.primaryDocument[i] : null,
      sics: sic ? [sic] : [],
      sicDescription: sicDesc,
      // Enrichment placeholders
      offeringAmount: null,
      totalSold: null,
      industryGroup: null,
      investorCount: null,
      exemptions: [],
      relatedPersons: [],
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────
//
// Called by askEd() with the tag attrs. Handles both company-lookup and
// full-text-search paths, enriches Form D rows with XML data, applies
// post-filters (amount bounds), returns shaped rows + metadata.
// ─────────────────────────────────────────────────────────────────────

export async function fetchEdgar(tagAttrs, proxyEndpoint) {
  const { mode, query, meta } = resolve(tagAttrs);

  if (mode === 'company') {
    // Path A: find the company's CIK first, then pull submissions
    // Two-stage resolution:
    //   1. Full-text search with the company name, capture the top-ranked CIK
    //   2. Fetch that CIK's full submissions history
    //
    // A clever shortcut: the search result itself contains enough data for
    // a good-quality filing list. We only need the submissions endpoint for
    // a complete history beyond the 10-item search result window.
    const searchQuery = {
      q: `"${query.companyInput}"`,
      forms: [query.formType],
      dateRange: {},
    };
    if (query.dateAfter) searchQuery.dateRange.startdt = query.dateAfter;
    if (query.dateBefore) searchQuery.dateRange.enddt = query.dateBefore;

    const { rows: searchRows, total: searchTotal } = await searchEdgar(searchQuery, proxyEndpoint);

    if (searchRows.length === 0) {
      return { rows: [], total: 0, mode: 'company', meta, resolvedCik: null };
    }

    // Pick the top-ranked CIK. If the first hit's display name closely
    // matches the user's input, that's our company.
    const firstHit = searchRows[0];
    const userNorm = normalizeCompanyName(query.companyInput);
    const hitNorm = normalizeCompanyName(firstHit.entityName);
    const looksLikeMatch = hitNorm.includes(userNorm) || userNorm.includes(hitNorm);

    let resolvedCik = firstHit.cik;
    let primaryEntityName = firstHit.entityName;

    if (!looksLikeMatch) {
      // Flag this in meta so the renderer can show "we couldn't find an exact match"
      meta.fuzzyMatch = true;
    }

    // Enrich top 20 Form Ds in parallel (they're the most interesting)
    const enriched = await enrichRowsWithConcurrency(
      searchRows.slice(0, 20),
      proxyEndpoint
    );

    const combined = [...enriched, ...searchRows.slice(20)];

    return {
      rows: combined,
      total: searchTotal,
      mode: 'company',
      resolvedCik,
      primaryEntityName,
      meta,
    };
  }

  // Path B: full-text search (no specific company named)
  const { rows: searchRows, total: searchTotal } = await searchEdgar(query, proxyEndpoint);

  // Enrich Form Ds with XML. We cap enrichment at top 20 for latency —
  // if the user wants amounts for results 21+ they'll scroll / refine.
  let enriched = await enrichRowsWithConcurrency(
    searchRows.slice(0, 20),
    proxyEndpoint
  );
  enriched = [...enriched, ...searchRows.slice(20)];

  // Apply post-filters (min/max amount — can't do this at query time)
  const filtered = applyPostFilters(enriched, {
    minAmount: query.filters?.minAmount,
    maxAmount: query.filters?.maxAmount,
  });

  // If post-filter dropped rows, reflect that in meta so Mo/Ed can note it
  if (filtered.length < enriched.length) {
    meta.postFiltered = {
      before: enriched.length,
      after: filtered.length,
      reason: 'amount bounds',
    };
  }

  return {
    rows: filtered,
    total: searchTotal,   // note: raw total from search, not post-filtered
    mode: 'search',
    meta,
  };
}

// ─────────────────────────────────────────────────────────────────────
// PAYLOAD SUMMARY for Gemini's second-pass grounded prose
// ─────────────────────────────────────────────────────────────────────
//
// Same pattern as Mo's summarizePayloadForMo: turn the rows into a compact
// text summary the LLM can read without burning 20K tokens on raw data.
// The LLM then writes its interpretation as a single paragraph of prose.
// ─────────────────────────────────────────────────────────────────────

export function summarizePayloadForEd(result, tagAttrs) {
  const { rows, total, mode, meta } = result;

  if (!rows || rows.length === 0) {
    return `No filings matched. Tell the user the data came back empty and suggest a different angle — different date range, different sector, different company spelling.`;
  }

  const parts = [];
  parts.push(`MODE: ${mode}`);
  parts.push(`MATCHED: ${total} total hits; showing top ${rows.length}`);

  if (mode === 'company' && result.primaryEntityName) {
    parts.push(`PRIMARY ENTITY: ${result.primaryEntityName} (CIK ${result.resolvedCik})`);
    if (meta.fuzzyMatch) {
      parts.push(`WARNING: Exact company match not found. These are fuzzy matches — you should acknowledge this.`);
    }
  }

  // Summary stats for Form Ds with enrichment
  const formDs = rows.filter(r => r.form === 'D' && r.offeringAmount != null);
  if (formDs.length > 0) {
    const total = formDs.reduce((s, r) => s + (r.offeringAmount || 0), 0);
    const avg = total / formDs.length;
    const max = Math.max(...formDs.map(r => r.offeringAmount || 0));
    parts.push(`FORM D TOTALS: ${formDs.length} enriched, $${(total / 1_000_000).toFixed(1)}M total, $${(avg / 1_000_000).toFixed(1)}M avg, $${(max / 1_000_000).toFixed(1)}M max`);

    // Top 5 by offering amount with rich detail
    const top = [...formDs].sort((a, b) => (b.offeringAmount || 0) - (a.offeringAmount || 0)).slice(0, 5);
    parts.push(`TOP 5 FORM Ds BY OFFERING AMOUNT:`);
    for (const r of top) {
      const amt = `$${((r.offeringAmount || 0) / 1_000_000).toFixed(1)}M`;
      const sold = r.totalSold != null ? ` (sold ${((r.totalSold || 0) / 1_000_000).toFixed(1)}M)` : '';
      const ind = r.industryGroup ? ` [${r.industryGroup}]` : '';
      const inv = r.investorCount ? `, ${r.investorCount} investors` : '';
      const dos = r.dateOfFirstSale ? `, first sale ${r.dateOfFirstSale}` : '';
      parts.push(`  - ${r.entityName}: ${amt}${sold}${ind}${inv}${dos}`);
    }
  }

  // Form type breakdown
  const formCounts = {};
  for (const r of rows) formCounts[r.form] = (formCounts[r.form] || 0) + 1;
  const formBreakdown = Object.entries(formCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([f, c]) => `${f}: ${c}`)
    .join(', ');
  parts.push(`FORM MIX: ${formBreakdown}`);

  // Date range of results
  const dates = rows.map(r => r.fileDate).filter(Boolean).sort();
  if (dates.length > 0) {
    parts.push(`DATE RANGE: ${dates[0]} to ${dates[dates.length - 1]}`);
  }

  // State concentration
  const stateCounts = {};
  for (const r of rows) {
    for (const s of (r.incStates || [])) {
      stateCounts[s] = (stateCounts[s] || 0) + 1;
    }
  }
  const topStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topStates.length > 0) {
    parts.push(`TOP STATES OF INC: ${topStates.map(([s, c]) => `${s}=${c}`).join(', ')}`);
  }

  // Meta annotations
  if (meta.sector) {
    parts.push(`SECTOR FILTER APPLIED: ${meta.sector.display}`);
  }
  if (meta.postFiltered) {
    parts.push(`NOTE: ${meta.postFiltered.before - meta.postFiltered.after} rows dropped by amount bounds (before=${meta.postFiltered.before}, after=${meta.postFiltered.after})`);
  }

  parts.push(``);
  parts.push(`YOUR JOB: Write 2-4 short sentences. Lead with the interesting thing — a big raise, a concentration pattern, a surprising entity type, an unusual date cluster. Then follow with one concrete next step the user could explore.`);
  parts.push(`DO NOT: restate counts that are on the card. Don't say "there are 12 filings." The user sees the card. You add the observation the card can't make on its own.`);
  parts.push(`DO NOT emit a <data /> tag in this response.`);

  return parts.join('\n');
}
