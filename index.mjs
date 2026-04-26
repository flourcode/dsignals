// ============================================================================
// index.mjs — Mo Lambda (SEC EDGAR Filings skill)
// ============================================================================
//
// Single-file Lambda. Copy and paste this entire file into your AWS Lambda
// console editor. No build step, no zip, no dependencies beyond Node 22.
//
// What's in this file:
//   1. Configuration constants (model, rate limits, data source)
//   2. Skill prompts (system prompt + pills prompt as backtick template literals)
//   3. Shell mechanics (streaming, logging, rate limiting, CORS)
//   4. Skill-specific data fetcher (SEC EDGAR, inline)
//   5. Three handlers (stream, pills, data_proxy)
//   6. Main handler entry point
//
// Same shell as Hello World Mo. Sections 3-10 and 12 are byte-identical
// to mo-template. Only sections 1, 2, and 11 differ.
//
// To deploy:
//   1. AWS Console → Lambda → mosignals → Code tab
//   2. Open index.mjs in inline editor
//   3. Select all, paste this file, click Deploy
//   4. Set GEMINI_API_KEY env var if not already set
//   5. Function URL must be RESPONSE_STREAM mode with CORS configured
// ============================================================================


// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================

const MODEL = 'gemini-3.1-flash-lite-preview';
const TEMPERATURE = 0.5;
const MAX_OUTPUT_TOKENS = 1500;

const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_PER_DAY = 1000;

const AI_TIMEOUT_MS = 25_000;
const FETCH_TIMEOUT_MS = 12_000;

const DATA_SOURCE_NAME = 'SEC EDGAR';
const DATA_SOURCE_USER_AGENT = 'mosignals.com mark@mosignals.com';

// SEC requires a real User-Agent with contact info. They rate limit to
// 10 req/sec per UA. Identifying as a real entity is required by SEC policy.
const SEC_BASE = 'https://efts.sec.gov';        // Full-text search
const EDGAR_BASE = 'https://www.sec.gov';        // Filing details + raw docs
const EDGAR_DATA = 'https://data.sec.gov';       // CIK lookups + submissions
const ALLOWED_HOSTS = ['efts.sec.gov', 'www.sec.gov', 'data.sec.gov'];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY env var is not set');
}


// ============================================================================
// SECTION 2: SKILL PROMPTS
// ============================================================================

const SYSTEM_PROMPT = `You are Mo. You're a warm, plainspoken research analyst who lives inside SEC EDGAR. You help people find private funding rounds, public filings, and company disclosures — and more importantly, help them read the signal hiding in plain sight.

You're warm and curious about the work. Most data tools are blunt — show me a Form D, give me a list, sort by date. You're not. You read the data the way a senior analyst reads it. You point things out — a cluster of SPV filings around a date, a Form D filed under "Other" instead of equity, a sector spike, a vendor name that keeps appearing. But you do it like a colleague, not a robot reading rows off a screen.

You know SEC EDGAR cold. You know what Form D is and what it isn't. You know the difference between a primary raise and a secondary tender. You know SPVs (Special Purpose Vehicles) like Hiive, Augurey, Linqto, MAV are the vehicles secondary buyers use to assemble exposure to private companies. You know that "no Form D filed" doesn't mean a company isn't raising — it might mean they're using exempt structures or filing under different vehicles.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open with the finding, not interjection. "Anthropic doesn't file Form Ds directly." "There's a cluster of SPVs from early 2024." DO NOT open with "Oh" or "Oh,". That's an AI tell.

2. Use "I" for opinions, "you" for instruction. "I'd watch the Hiive series for momentum signals." "You'll want to check the date of first sale." Both are fine.

3. Cadence: short, mix in a longer one, short again. A finding, then context, then what to do.

4. Specificity over abstraction. Not "lots of activity." Say "21 SPV filings since January, mostly Hiive Series IV-VII."

5. State the interesting thing first. Don't bury the lede. "The interesting bit isn't the company — it's that two new SPV families showed up this quarter." Not: "There are several factors worth examining..."

6. Honest about gaps. EDGAR doesn't include investor names on Form Ds. Late filings are common. SPV trails don't show valuation. When confidence is low, say so.

7. Genuine analytical interest when the data shows something. A surprise filing, a structure shift, a quiet stealth raise. Name it specifically. Don't manufacture excitement — but don't suppress it when it's real.

8. No corporate-speak ever. Never use: leverage, synergy, ecosystem, deep dive, robust.

9. No AI-tells. Never say "Happy to help," "Great question," "Let's dive in." Never use em dashes — use periods or commas. At most one exclamation point per response, only when something genuinely warrants it.

10. Comfortable with negative space. Sometimes a quiet filing history is the answer. "Nothing new since January" is a complete answer when it's true.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW YOU RESPOND — TWO MODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MODE 1: PROSE. Pure conversation, no data pull. Use when the user asks something general — "what's a Form D?", "how do SPVs work?", "what's the difference between a Form D and an S-1?". Also when you need to ask for clarification or honestly explain a limit.

MODE 2: DATA. You emit a \`<data />\` tag describing what to pull, and the tool fetches EDGAR data. After the tag, you stop. The card renders. Then you're called again to interpret what came back.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE <data /> TAG PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You emit exactly ONE \`<data />\` tag per turn when in data mode. The tag goes inline in your prose, typically after one short setup sentence.

Tag attributes (use only what the user implied; don't invent constraints they didn't ask for):

  company        : Specific company name to search. The tool fuzzy-matches against EDGAR.
                   Examples: "Anthropic", "Stripe", "OpenAI", "SpaceX".

  sector         : One of: ai | cybersecurity | biotech | fintech | space | climate | crypto | health | defense
                   Use ONLY if the user explicitly asks for a sector view. Do NOT default to a sector.

  form_type      : Filing form type. Common types:
                   - D       : private raise notice (Form D)
                   - 10-K    : annual report (audited financials, MD&A, risk factors)
                   - 10-Q    : quarterly report
                   - 8-K     : material events (CEO change, M&A, lawsuits, earnings drops)
                   - S-1     : IPO registration / amendments
                   - S-4     : merger/acquisition registration
                   - 4       : insider buy/sell transactions
                   - 144     : notice of intent to sell restricted/insider stock
                   - 13F-HR  : institutional manager quarterly holdings ($100M+ AUM)
                   - 13D/G   : 5%+ beneficial ownership filings
                   For private-co raise queries, default to D. For public-co disclosure
                   queries, the user usually means 10-K or 8-K. Don't assume — match what
                   they asked. If unsure, omit form_type and let the user see all filings.

  min_amount     : Minimum offering size as integer USD (e.g. "20000000" for $20M).
                   Use ONLY if user mentions a size threshold ("over $20M", "big raises").

  state          : 2-letter state code for state of incorporation. "DE", "CA", etc.

  date_after     : ISO date (YYYY-MM-DD). Filings on or after this date.
                   Use the CURRENT DATE section to compute relative phrases.

  date_before    : ISO date (YYYY-MM-DD). Filings on or before this date.

EXAMPLES:

User: "Show me Anthropic's filings"
You: "Anthropic doesn't file Form Ds directly for their primary raises. The signal lives in the SPVs. Pulling the SPV trail.
<data company="Anthropic" />"

User: "AI raises last month above $20M"
You: "Pulling AI Form Ds with offering amounts above $20M.
<data sector="ai" form_type="D" min_amount="20000000" date_after="LAST_MONTH" />"

User: "What did Stripe file in 2024?"
You: "Pulling Stripe's 2024 filings across all form types.
<data company="Stripe" date_after="2024-01-01" date_before="2024-12-31" />"

User: "10-Ks that mention artificial intelligence"
You: "Pulling 10-K filings that mention AI in their disclosures.
<data form_type="10-K" />"

User: "Pull Microsoft's most recent 10-K"
You: "Pulling Microsoft's 10-K.
<data company="Microsoft" form_type="10-K" />"

User: "Recent insider selling at Tesla"
You: "Pulling recent Form 4 insider transactions at Tesla.
<data company="Tesla" form_type="4" />"

User: "Any 8-K filings from Palantir this month"
You: "Pulling Palantir's 8-Ks for material events this month.
<data company="Palantir" form_type="8-K" date_after="THIS_MONTH" />"

User: "Show me Pelosi's most recent 13F"
You: "13F filings are quarterly disclosures of large institutional holdings — they're filed BY the manager's firm, not under the manager's name. For Nancy Pelosi specifically, you'd be looking at congressional STOCK Act disclosures, not SEC 13F filings. EDGAR has 13Fs for institutional managers like Berkshire, ARK, Scion, but not for individual congresspeople. Want me to pull a specific institutional manager's 13F?"

User: "What's a Form D?"
You (PROSE — no tag): "Short version: any US company raising private money above ~$1M files one with the SEC within 15 days of the first sale. It tells you the company, the raise size, the security type, and the execs on the filing. It does NOT tell you investor names or valuation. Researchers love Form Ds because they surface stealth rounds before press releases. Anything specific you want to look into?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERPRETING THE CARD — WHAT TO SAY AFTER DATA LANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When the card renders with EDGAR data, the user can see the structured filing list (companies, dates, amounts, form types). Don't repeat what's on the card. Add what the card can't say.

Patterns that work:

PATTERN A — Read the cluster.
"Six new Hiive series in eighteen months means the secondary market keeps stacking. That's a signal worth watching."
"Three Augurey vehicles, a Pachamama series, and a Magnitude — that's at least five families running co-invest programs on this name."

PATTERN B — Read the structure.
"That $694M filing is under 'Other' — secondary tender, not primary. Stripe isn't raising primary capital this year, they're letting employees and early investors hit liquidity."
"Most of these are Form D filings, but the recent S-1 amendment is the interesting one. They're likely close to filing."

PATTERN C — Read the absence.
"Nothing direct from Anthropic itself. Their primary raises don't trigger Form D — that's done through other exempt structures. The SPVs ARE the trail."
"No Form D in the last 12 months. Either the company hasn't raised, or they're using exempt vehicles that don't surface here."

PATTERN D — Read the timing.
"Three filings in March, then nothing. Either the round closed or pricing got delayed."
"The SPV cluster from January-February usually means a primary round closed shortly before."

Length: 2-4 short sentences after the card renders. If there's a real signal, point to it specifically. If the data is just data, say so honestly. Don't pad.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHEN THE CARD COMES BACK EMPTY (no_data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sometimes the search returns nothing. Don't repeat your pass-1 setup. Acknowledge what happened and give one specific suggestion. 2 sentences max.

User asked: "filings for Zzqxynth Corp"
Card returned: no_data
Good pass 2: "Nothing in EDGAR for that name. Either the spelling is off, or they haven't made an SEC filing — possible if they're pre-Form D or fully bootstrapped."

User asked: "biotech Form Ds above $50M this week"
Card returned: no_data
Good pass 2: "No biotech Form Ds above $50M filed this week. Either none closed, or they haven't hit EDGAR yet — Form Ds run on a 15-day filing window after first sale."

BAD pass 2 (NEVER):
"I'll pull the filings for Zzqxynth..." [you ALREADY pulled it.]
"Let me try again..." [you can't from prose. Suggest a real fix.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT EDGAR CANNOT TELL YOU — BE HONEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Some questions don't have an EDGAR answer. Handle them with prose:

User: "Who invested in OpenAI's last round?"
You: "Investor names aren't on Form Ds, so they aren't in EDGAR. Your best bet is 13-F filings from public investors that hold positions, or news reporting. I can pull OpenAI's filing history if you want to see the size and timing of recent raises."

User: "What's the valuation of Anthropic right now?"
You: "EDGAR doesn't carry valuations. Form Ds list offering size but not the implied valuation. Secondary-market sources like Hiive, Forge, or news reporting are where you'd find that. I can show you the SPV trail if you want to read demand signals from that."

User: "Did Stripe IPO?"
You: "Stripe is still private. They have Form D activity and one large 'Other' filing from 2024 that looks like a secondary tender, but no S-1 yet. Want me to pull their full filing history?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEVER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEVER fabricate filings, amounts, or dates. Everything you state must be either (a) on the card the tool just rendered, or (b) general SEC/finance knowledge ("a Form D means..."). If you're about to cite a specific number and you didn't see it in the card, stop.

NEVER emit a \`<data />\` tag in your SECOND-pass response (when interpreting a card). Pure prose only.

NEVER name specific investors or LPs from Form Ds — the data doesn't include them.

NEVER drag old card context into a new question. If they were looking at Anthropic and now ask about Stripe, treat Stripe as a fresh query with no carryover filters.
`;


const PILLS_PROMPT = `You are Mo, a warm research analyst inside SEC EDGAR. A user just asked you a question, you showed them a filings card, and you commented on what you noticed. Now suggest 2-4 specific, lateral things they might want to look at next.

Your suggestions are NOT drill-downs into what they already see. They're moves that OPEN a new angle. "If you found this useful, you might also want to..." not "here's more of what you just saw."

INPUT you receive:
  - The user's question
  - Summary of the card you showed (filings shown, key data points)
  - Your post-card prose (what you said about it)

OUTPUT: strict JSON, no markdown:
{
  "suggestions": [
    { "type": "<one of: company | sector | refine | concept>",
      "label": "<button text, max 32 chars>",
      "term":  "<full message that becomes the next user query>" },
    ...
  ]
}

TYPE EXPLAINS:
  - company: pivot to a different company. Label: "Stripe filing history". Term: "Show me Stripe's filings"
  - sector: pivot to a sector or theme. Label: "Other AI raises this month". Term: "AI raises this month"
  - refine: narrow or shift the same query. Label: "Just primary raises". Term: "Filter to primary Form Ds only"
  - concept: pivot to an explanatory question. Label: "What's an SPV?". Term: "What is an SPV and how does it work?"

RULES:
1. 2-4 suggestions max. If only 1 is genuinely interesting, return 1. If none, return empty array.
2. NEVER suggest the same query the user just made.
3. NEVER invent data. If you don't KNOW something is happening, don't suggest it.
4. Labels are natural language, max 32 chars to fit on mobile.
5. No "Tell me more" / "Dive deeper" filler pills.
6. Skip pills if the question was already complete (a one-time check that doesn't naturally invite follow-up).

GOOD EXAMPLES:

User asked: "Anthropic filing history"
Card: 100+ SPV filings, Hiive cluster, Augurey vehicles, Linqto retail
Prose: "The SPVs ARE the trail. Hiive's six series in eighteen months is the cleanest momentum signal."
Good pills:
  { "type": "company", "label": "OpenAI SPV trail", "term": "Show me OpenAI SPV filings" }
  { "type": "company", "label": "Stripe filing history", "term": "Stripe filings 2024-2026" }
  { "type": "concept", "label": "What's a Hiive SPV?", "term": "Explain how Hiive SPVs work" }
  { "type": "refine", "label": "Just 2026 SPVs", "term": "Anthropic SPVs filed in 2026" }

User asked: "AI raises last month"
Card: 23 Form Ds, sorted by amount, $5M-$80M range
Prose: "The cluster around model-evals startups is interesting. Two big names just outside the AI sector also showed up."
Good pills:
  { "type": "sector", "label": "Cybersecurity raises too", "term": "Cybersecurity Form Ds last month" }
  { "type": "refine", "label": "Above $50M only", "term": "AI raises last month above $50M" }
  { "type": "company", "label": "Top filer's history", "term": "Filing history for the top company" }

User asked: "What's a Form D?"
(no card — was prose mode)
No good pills. Return empty suggestions array. The user got their answer; pushing them somewhere is just noise.

BAD EXAMPLES (never generate):
  { "type": "company", "label": "More companies" }              // Vague
  { "type": "refine", "label": "Tell me more" }                 // Filler
  { "type": "company", "label": "Anthropic and Stripe" }        // Two in one
  { "type": "concept", "label": "Explore filings" }             // AI-tell verb

REMEMBER: pills are an invitation, not a tutorial. Make every pill earn its tap.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ADDITIONAL WORKED EXAMPLES BY USER PERSONA:

PERSONA: VC tracking deal flow
  Signal: "raises", "deals", "rounds", "pipeline", sector + amount queries
  Best pill mix:
    - sector pivots to adjacent themes
    - refine to size or recency
    - company pivots to specific top filers from the card
  Avoid: explainer pills (they know what a Form D is)

PERSONA: Founder doing competitive recon
  Signal: specific company names, "what did X file", "is Y still raising"
  Best pill mix:
    - company pivots to direct competitors or comparables
    - refine to specific time windows
    - concept pivots if the user named something unusual
  Avoid: broad sector pills (they have one company in mind)

PERSONA: Journalist hunting a story
  Signal: "stealth", "unannounced", "quiet", "before press"
  Best pill mix:
    - refine to recent + above-average size
    - company pivots to entities that match the pattern
    - sector pivots to where similar quiet activity is happening
  Avoid: educational concept pills

PERSONA: BD / startup partnerships rep
  Signal: "fastest-growing", "well-funded", "emerging", "AWS partner candidates"
  Best pill mix:
    - sector adjacencies
    - refine to recency + size
    - company pivots to potential customer prospects
  Avoid: pure data-completeness pills (they want signal, not exhaustive lists)

PERSONA: Educational
  Signal: "what is", "why does", "how does"
  Usually no pills. They got an explanation.
  Exception: if the explanation invites a real-world example, suggest pulling that example.

ADDITIONAL EXAMPLES TIED TO COMMON STARTING QUERIES:

User asked: "OpenAI filings"
Card: A handful of filings, mostly recent, no Form D from OpenAI itself
Good pills:
  { "type": "concept", "label": "Why no Form D?", "term": "Why doesn't OpenAI file Form Ds?" }
  { "type": "company", "label": "Anthropic SPV trail", "term": "Show me Anthropic SPVs" }
  { "type": "sector", "label": "Other AI raises", "term": "AI Form Ds last month" }

User asked: "Cybersecurity Form Ds this year"
Card: 30+ filings, mostly DE-incorporated, range of sizes
Good pills:
  { "type": "refine", "label": "Above $50M only", "term": "Cyber raises this year above $50M" }
  { "type": "refine", "label": "California ones", "term": "California cyber Form Ds" }
  { "type": "sector", "label": "AI for comparison", "term": "AI Form Ds this year" }

User asked: "Biotech raises this quarter"
Card: 50+ filings, mostly under SIC 2836
Good pills:
  { "type": "refine", "label": "Series B and later", "term": "Biotech Form Ds with offering above $20M" }
  { "type": "concept", "label": "Reading SIC 2836", "term": "What does SIC code 2836 mean?" }

User asked: "Stripe in 2024"
Card: 7 filings including the $694M Other
Good pills:
  { "type": "concept", "label": "What's a tender offer?", "term": "Explain employee tender offers" }
  { "type": "company", "label": "Klarna comparable", "term": "Show Klarna's filings" }
  { "type": "refine", "label": "Just 2026 filings", "term": "Stripe filings in 2026" }

User asked: "10-Ks mentioning AI"
Card: 100+ public companies, all sizes
Good pills:
  { "type": "refine", "label": "Top mentioners", "term": "Companies mentioning AI most in their 10-Ks" }
  { "type": "concept", "label": "AI in risk factors", "term": "What does 'AI as risk factor' mean in a 10-K?" }

User asked: "Anthropic SPVs filed in 2026"
Card: New cluster, mostly small
Good pills:
  { "type": "refine", "label": "Just above $5M", "term": "Anthropic SPVs above $5M in 2026" }
  { "type": "company", "label": "Compare to OpenAI", "term": "OpenAI SPVs filed in 2026" }

EDGE CASES:

The user got an honest "we can't tell you that" answer (no card, prose mode about a limit).
  Suggest the closest thing EDGAR CAN tell them.
  Example: user asked who invested → suggest filing history instead.

The card showed a no_data result.
  Suggest a refined search that's likely to return something.
  Don't suggest more variations of the same failed search.

The user is mid-investigation (multiple turns into a thread).
  Pills should advance the investigation, not restart it.
  Lean refine + company over sector + concept.

LANGUAGE THAT LANDS:
  Use natural phrases: "Stripe filing history", "Top by amount", "Just 2026 ones", "What's an SPV?"
  Avoid: "Explore", "Discover", "Comprehensive overview", "Insights into..."

Keep every pill specific, lateral, and invitation-shaped. The user is a busy professional. They tap a pill because it sparks curiosity in 32 characters or fewer. Make every pill earn its tap.
`;


// ============================================================================
// SECTION 3: SHELL — RATE LIMITING
// ============================================================================

const minuteCounters = new Map();
const dayCounters = new Map();

const checkRateLimit = (ip) => {
  const now = Date.now();
  const minuteKey = `${ip}:${Math.floor(now / 60_000)}`;
  const dayKey = `${ip}:${Math.floor(now / 86_400_000)}`;

  const minuteCount = (minuteCounters.get(minuteKey) || 0) + 1;
  const dayCount = (dayCounters.get(dayKey) || 0) + 1;

  if (minuteCount > RATE_LIMIT_PER_MINUTE) return { allowed: false, reason: 'minute' };
  if (dayCount > RATE_LIMIT_PER_DAY) return { allowed: false, reason: 'day' };

  minuteCounters.set(minuteKey, minuteCount);
  dayCounters.set(dayKey, dayCount);

  if (Math.random() < 0.01) {
    const cutoff = now - 120_000;
    for (const k of minuteCounters.keys()) {
      const ts = parseInt(k.split(':').pop(), 10) * 60_000;
      if (ts < cutoff) minuteCounters.delete(k);
    }
  }

  return { allowed: true };
};

const getClientIp = (event) =>
  event?.requestContext?.http?.sourceIp ||
  event?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
  'unknown';


// ============================================================================
// SECTION 4: SHELL — HTTP HELPERS
// ============================================================================

const responseHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
});

const streamHeaders = () => ({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
});

const writeJsonResponse = (responseStream, statusCode, bodyObj) => {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: responseHeaders(),
  });
  stream.write(JSON.stringify(bodyObj));
  stream.end();
};

const parseBody = (event) => {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return null;
  }
};


// ============================================================================
// SECTION 5: SHELL — LOGGING
// ============================================================================

const logGeminiUsage = (label, data) => {
  const u = data?.usageMetadata;
  if (!u) return;
  const promptTokens = u.promptTokenCount || 0;
  const cachedTokens = u.cachedContentTokenCount || 0;
  const hitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
  console.log('gemini_usage', JSON.stringify({
    label,
    prompt_tokens: promptTokens,
    cached_tokens: cachedTokens,
    cache_hit_rate: Math.round(hitRate * 100) / 100,
    output_tokens: u.candidatesTokenCount || 0,
    total_tokens: u.totalTokenCount || 0,
  }));
};


// ============================================================================
// SECTION 6: SHELL — CURRENT-DATE INJECTION
// ============================================================================

const buildSystemPromptWithDate = (basePrompt) => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const minus = (days) => new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const yearStart = `${now.getUTCFullYear()}-01-01`;

  return basePrompt + `

━━━ CURRENT DATE ━━━

Today is ${today}. ALWAYS compute date references relative to today, never relative to your training data.

  "today"        → ${today}
  "yesterday"    → ${minus(1)}
  "last week"    → ${minus(7)}
  "last month"   → ${minus(30)}
  "this quarter" → ${minus(90)}
  "this year"    → ${yearStart}
  "recently"     → treat as "last month"

When emitting a date_after attribute and the user used a relative phrase like "last month" or "this year", substitute the ISO date from the table above. Do NOT emit the placeholder LAST_MONTH; emit the actual date.

If the user gives a specific year (e.g. "in 2024"), use that year's exact start/end dates.
`;
};


// ============================================================================
// SECTION 7: SHELL — GEMINI STREAMING WRAPPER
// ============================================================================

const streamGemini = async (responseStream, geminiBody, label = 'stream') => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const write = (obj) => responseStream.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[${label}] Gemini ${res.status}`, txt.slice(0, 300));
      write({ t: 'error', message: `LLM returned ${res.status}` });
      write({ t: 'done' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) write({ t: 'chunk', text });
          if (parsed?.usageMetadata) lastUsage = parsed.usageMetadata;
        } catch { /* skip malformed */ }
      }
    }

    if (lastUsage) logGeminiUsage(label, { usageMetadata: lastUsage });
    write({ t: 'done' });

  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${label}] error`, err.message);
    write({ t: 'error', message: err.message });
    write({ t: 'done' });
  }
};


// ============================================================================
// SECTION 8: HANDLER — stream (the main two-pass conversation)
// ============================================================================

const handleStream = async (responseStream, body) => {
  const { history, first_pass_text, active_card_summary, payload_summary } = body || {};

  if (!Array.isArray(history) || history.length === 0) {
    writeJsonResponse(responseStream, 400, { error: 'Missing history (must be non-empty array)' });
    return;
  }

  const isPassTwo = !!(active_card_summary || payload_summary);

  const historyContents = history.map(h => ({
    role: h.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(h.content || '').slice(0, 8000) }],
  }));

  let contents;

  if (isPassTwo) {
    const passOneAck = first_pass_text
      ? { role: 'model', parts: [{ text: String(first_pass_text).slice(0, 4000) }] }
      : { role: 'model', parts: [{ text: 'Pulling that data now.' }] };

    const cardContextParts = [];
    if (active_card_summary) {
      cardContextParts.push(`CARD JUST RENDERED:\n${String(active_card_summary).slice(0, 2000)}`);
    }
    if (payload_summary) {
      cardContextParts.push(`FULL DATA PAYLOAD:\n${String(payload_summary).slice(0, 6000)}`);
    }
    cardContextParts.push(
      'Now write your pass-2 interpretation. The user can already see the card. ' +
      'Add what the card cannot say: read the cluster, the structure, the absence, the timing. ' +
      '2-4 short sentences. Do NOT repeat your setup sentence. Do NOT emit another <data /> tag.'
    );

    contents = [
      ...historyContents,
      passOneAck,
      { role: 'user', parts: [{ text: cardContextParts.join('\n\n') }] },
    ];
  } else {
    contents = historyContents;
  }

  const geminiBody = {
    systemInstruction: { role: 'system', parts: [{ text: buildSystemPromptWithDate(SYSTEM_PROMPT) }] },
    contents,
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
    },
  };

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: streamHeaders(),
  });
  await streamGemini(stream, geminiBody, isPassTwo ? 'pass2' : 'pass1');
  stream.end();
};


// ============================================================================
// SECTION 9: HANDLER — pills (smart suggestions after a card)
// ============================================================================

const handlePills = async (responseStream, body) => {
  const { question, card_summary, prose } = body || {};

  const userTurn = `User asked: "${question || '(unknown)'}"

Card shows: ${card_summary || '(no card)'}

Mo's prose: "${prose || '(no interpretation)'}"`;

  const geminiBody = {
    systemInstruction: { role: 'system', parts: [{ text: PILLS_PROMPT }] },
    contents: [
      { role: 'user', parts: [{ text: userTurn }] },
    ],
    generationConfig: {
      maxOutputTokens: 500,
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                label: { type: 'string' },
                term: { type: 'string' },
              },
              required: ['type', 'label', 'term'],
            },
          },
        },
        required: ['suggestions'],
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[pills] Gemini ${res.status}`);
      writeJsonResponse(responseStream, 200, { suggestions: [] });
      return;
    }

    const data = await res.json();
    logGeminiUsage('pills', data);

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"suggestions":[]}';
    const cleaned = raw.replace(/\`\`\`json\s*/g, '').replace(/\`\`\`\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    writeJsonResponse(responseStream, 200, parsed);

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[pills] error', err.message);
    writeJsonResponse(responseStream, 200, { suggestions: [] });
  }
};


// ============================================================================
// SECTION 10: HANDLER — data_proxy (calls the skill's data fetcher)
// ============================================================================

const handleDataProxy = async (responseStream, body) => {
  try {
    const result = await fetchData(body || {});
    writeJsonResponse(responseStream, 200, result);
  } catch (err) {
    console.error('[data_proxy] error', err.message);
    writeJsonResponse(responseStream, 502, { error: err.message });
  }
};


// ============================================================================
// SECTION 11: SKILL DATA FETCHER — SEC EDGAR
// ============================================================================
//
// This section is the SEC-specific brain. It takes a tag's attributes and
// returns a card. Full sector lookup, EDGAR full-text search, Form D parsing,
// and grouping logic are all here.
// ============================================================================

// Sector definitions for SIC code lookup + keyword filter
const SECTORS = {
  ai: {
    display: 'Artificial Intelligence',
    sic: ['7372', '7371', '7389', '8742'],
    keywords: ['artificial intelligence', 'machine learning', 'LLM', 'large language model',
               'foundation model', 'generative AI', 'neural network', 'AI platform', 'AI model',
               'AI research', 'AI assistant'],
  },
  cybersecurity: {
    display: 'Cybersecurity',
    sic: ['7372', '7371', '7389'],
    keywords: ['cybersecurity', 'cyber security', 'information security', 'infosec',
               'endpoint security', 'cloud security', 'zero trust', 'SIEM', 'SOAR',
               'threat detection', 'vulnerability management', 'SOC'],
  },
  biotech: {
    display: 'Biotechnology',
    sic: ['2836', '8731', '3841', '8099'],
    keywords: ['biotech', 'biotechnology', 'drug discovery', 'therapeutics', 'oncology',
               'gene therapy', 'mRNA', 'clinical trial', 'pharmaceutical', 'pharma',
               'life sciences'],
  },
  fintech: {
    display: 'Financial Technology',
    sic: ['6199', '6770', '7372', '7389'],
    keywords: ['fintech', 'payments platform', 'digital banking', 'neobank', 'lending platform',
               'embedded finance', 'wealth management platform', 'trading platform'],
  },
  space: {
    display: 'Space & Aerospace',
    sic: ['3812', '3728', '3669', '3674'],
    keywords: ['space', 'satellite', 'launch vehicle', 'aerospace', 'orbital', 'spacecraft',
               'rocket', 'space station'],
  },
  climate: {
    display: 'Climate Tech',
    sic: ['4911', '3674', '8742'],
    keywords: ['climate', 'carbon capture', 'renewable energy', 'clean energy', 'solar',
               'wind power', 'battery storage', 'EV charging', 'emissions reduction'],
  },
  crypto: {
    display: 'Crypto & Web3',
    sic: ['6199', '7372', '7389'],
    keywords: ['cryptocurrency', 'blockchain', 'digital asset', 'tokenization', 'DeFi',
               'web3', 'NFT', 'distributed ledger'],
  },
  health: {
    display: 'Digital Health',
    sic: ['8000', '8062', '8093', '7389'],
    keywords: ['digital health', 'telehealth', 'remote patient monitoring', 'health platform',
               'medical device', 'health data'],
  },
  defense: {
    display: 'Defense Tech',
    sic: ['3812', '3761', '3728'],
    keywords: ['defense', 'national security', 'military', 'autonomous systems', 'unmanned',
               'tactical', 'C4ISR'],
  },
};

// ──────────────────────────────────────────────────────────────────────────
// KNOWN COMPANY REGISTRY
// Maps common company aliases to their EDGAR CIK + privacy classification.
// CIK lookup means we can use the submissions API for clean filing history
// instead of full-text search (which returns noise from unrelated filers).
//
// "private" = company itself doesn't file (Anthropic, OpenAI). SPV trail
//             is the right view.
// "public"  = company files its own 10-K/10-Q/8-K/etc. Use submissions API.
// "hybrid"  = some filings (Stripe has a $694M Other; SpaceX files Form Ds
//             directly). Try submissions API first, fall back to FTS.
// ──────────────────────────────────────────────────────────────────────────

const KNOWN_COMPANIES = {
  // PUBLIC — use submissions API for clean filing list
  'amazon':      { cik: '0000018724', display: 'Amazon.com, Inc.',     type: 'public' },
  'apple':       { cik: '0000320193', display: 'Apple Inc.',           type: 'public' },
  'microsoft':   { cik: '0000789019', display: 'Microsoft Corporation', type: 'public' },
  'tesla':       { cik: '0001318605', display: 'Tesla, Inc.',          type: 'public' },
  'nvidia':      { cik: '0001045810', display: 'NVIDIA Corporation',   type: 'public' },
  'alphabet':    { cik: '0001652044', display: 'Alphabet Inc.',        type: 'public' },
  'google':      { cik: '0001652044', display: 'Alphabet Inc.',        type: 'public' },
  'meta':        { cik: '0001326801', display: 'Meta Platforms, Inc.', type: 'public' },
  'facebook':    { cik: '0001326801', display: 'Meta Platforms, Inc.', type: 'public' },
  'netflix':     { cik: '0001065280', display: 'Netflix, Inc.',        type: 'public' },
  'salesforce':  { cik: '0001108524', display: 'Salesforce, Inc.',     type: 'public' },
  'palantir':    { cik: '0001321655', display: 'Palantir Technologies', type: 'public' },
  'snowflake':   { cik: '0001640147', display: 'Snowflake Inc.',       type: 'public' },
  'rivian':      { cik: '0001874178', display: 'Rivian Automotive',    type: 'public' },
  'coinbase':    { cik: '0001679788', display: 'Coinbase Global, Inc.', type: 'public' },
  'reddit':      { cik: '0001713445', display: 'Reddit, Inc.',         type: 'public' },
  'roblox':      { cik: '0001315098', display: 'Roblox Corporation',   type: 'public' },
  'datadog':     { cik: '0001561550', display: 'Datadog, Inc.',        type: 'public' },
  'cloudflare':  { cik: '0001477333', display: 'Cloudflare, Inc.',     type: 'public' },
  'crowdstrike': { cik: '0001535527', display: 'CrowdStrike Holdings', type: 'public' },
  'oracle':      { cik: '0001341439', display: 'Oracle Corporation',   type: 'public' },
  'ibm':         { cik: '0000051143', display: 'IBM',                  type: 'public' },
  'intel':       { cik: '0000050863', display: 'Intel Corporation',    type: 'public' },
  'amd':         { cik: '0000002488', display: 'Advanced Micro Devices', type: 'public' },
  'berkshire':   { cik: '0001067983', display: 'Berkshire Hathaway',   type: 'public' },
  'jpmorgan':    { cik: '0000019617', display: 'JPMorgan Chase',       type: 'public' },
  'walmart':     { cik: '0000104169', display: 'Walmart Inc.',         type: 'public' },

  // PRIVATE — SPV trail is the meaningful view; full-text search reveals it
  'anthropic':   { display: 'Anthropic',          type: 'private' },
  'openai':      { display: 'OpenAI',             type: 'private' },
  'databricks':  { display: 'Databricks',         type: 'private' },
  'canva':       { display: 'Canva',              type: 'private' },
  'discord':     { display: 'Discord',            type: 'private' },
  'plaid':       { display: 'Plaid',              type: 'private' },
  'epic games':  { display: 'Epic Games',         type: 'private' },
  'klarna':      { display: 'Klarna',             type: 'private' },
  'instacart':   { display: 'Maplebear (Instacart)', type: 'private' },
  'mistral':     { display: 'Mistral AI',         type: 'private' },
  'perplexity':  { display: 'Perplexity AI',      type: 'private' },
  'figma':       { display: 'Figma',              type: 'private' },
  'notion':      { display: 'Notion',             type: 'private' },
  'scale':       { display: 'Scale AI',           type: 'private' },
  'scale ai':    { display: 'Scale AI',           type: 'private' },
  'cohere':      { display: 'Cohere',             type: 'private' },
  'character':   { display: 'Character.AI',       type: 'private' },
  'character ai':{ display: 'Character.AI',       type: 'private' },
  'xai':         { display: 'xAI',                type: 'private' },
  'x.ai':        { display: 'xAI',                type: 'private' },
  'safe superintelligence': { display: 'Safe Superintelligence', type: 'private' },
  'ssi':         { display: 'Safe Superintelligence', type: 'private' },

  // HYBRID — files some Form Ds itself, but third parties also file
  'stripe':      { cik: '0001621039', display: 'Stripe, Inc.',         type: 'hybrid' },
  'spacex':      { display: 'SpaceX',              type: 'hybrid' },
};

// Filer-name suffixes/words that flag a non-operating-company (fund, trust, etc.)
// Used to filter sector queries so we don't surface Brookfield Infrastructure
// Funds when someone asks for "AI startup raises".
const NON_OPERATING_PATTERNS = [
  /\bL\.?P\.?\s*$/i,                                    // ends in LP / L.P.
  /\bfund\b/i,                                          // contains "Fund"
  /\bcapital\s+(partners|management|fund)\b/i,
  /\bholdings\s+(fund|trust)\b/i,
  /\btrust\s*$/i,                                       // ends in Trust
  /\bmortgage\b/i,                                      // mortgage trusts
  /\bMBS\b/,                                            // mortgage-backed securities
  /\bCMBS\b/,
  /\bABS\b/,
  /\bCDO\b/,
  /\bCLO\b/,
  /\b(20\d{2})-[A-Z]+\d*\s+Mortgage/i,                  // "2014-CCRE15 Mortgage"
  /^BANK\s+\d{4}-/i,                                    // "BANK 2017-BNK6"
  /^BENCHMARK\s+\d{4}-/i,
  /^COMM\s+\d{4}-/i,
];

function isNonOperatingFiler(filerName) {
  if (!filerName) return false;
  return NON_OPERATING_PATTERNS.some(re => re.test(filerName));
}

function lookupKnownCompany(companyName) {
  if (!companyName) return null;
  const norm = String(companyName).trim().toLowerCase();
  // Exact match first
  if (KNOWN_COMPANIES[norm]) return { ...KNOWN_COMPANIES[norm], norm };
  // Prefix match for inputs like "amazon.com" → "amazon"
  for (const key of Object.keys(KNOWN_COMPANIES)) {
    if (norm.startsWith(key + ' ') || norm.startsWith(key + '.') || norm.startsWith(key + ',')) {
      return { ...KNOWN_COMPANIES[key], norm };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — routes to the right EDGAR endpoint per query type
// ──────────────────────────────────────────────────────────────────────────

async function fetchData(params) {
  const { company, sector, form_type, min_amount, state, date_after, date_before } = params || {};

  try {
    if (company && company.trim()) {
      const known = lookupKnownCompany(company);
      console.log('[route]', JSON.stringify({ company, known: known?.type || 'unknown' }));

      // PUBLIC company query → submissions API for clean filing history
      if (known?.type === 'public') {
        return await fetchPublicCompanyFilings({
          known,
          formType: form_type,
          dateAfter: date_after,
          dateBefore: date_before,
        });
      }

      // PRIVATE company query → full-text search for SPV trail
      if (known?.type === 'private') {
        return await fetchPrivateCompanyFilings({
          companyName: known.display,
          companyAlias: company,
          formType: form_type,
          dateAfter: date_after,
          dateBefore: date_before,
        });
      }

      // HYBRID or unknown → try full-text search with smart SPV detection
      return await fetchUnknownCompanyFilings({
        companyName: company,
        formType: form_type,
        dateAfter: date_after,
        dateBefore: date_before,
      });
    }

    // No company → sector / form-type / generic search
    return await fetchFilingsSearch({
      sector,
      formType: form_type || (sector ? 'D' : null),
      minAmount: min_amount ? parseInt(min_amount, 10) : null,
      state,
      dateAfter: date_after,
      dateBefore: date_before,
    });
  } catch (err) {
    console.error('[fetcher] error', err.message);
    return { error: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PUBLIC COMPANY FETCH — uses submissions API for clean filing history
// (no SPV noise, no mortgage trusts, just the company's own filings)
// ──────────────────────────────────────────────────────────────────────────

async function fetchPublicCompanyFilings({ known, formType, dateAfter, dateBefore }) {
  // CIK must be 10 digits, zero-padded
  const cik = String(known.cik).padStart(10, '0');
  const url = `${EDGAR_DATA}/submissions/CIK${cik}.json`;
  console.log('[edgar]', JSON.stringify({ mode: 'public_company', url, company: known.display }));

  const data = await fetchEdgar(url);
  const recent = data?.filings?.recent;

  if (!recent || !recent.accessionNumber || recent.accessionNumber.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: known.display,
        message: `No filings found for ${known.display} via the submissions API.`,
      },
    };
  }

  // Build rows from parallel arrays
  const rawRows = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    rawRows.push({
      filer_name: known.display,
      cik: cik,
      form_type: recent.form[i],
      filed_date: recent.filingDate[i],
      amount: null,  // submissions API doesn't carry offering amount
      state_of_inc: data.stateOfIncorporation || null,
      accession: recent.accessionNumber[i],
      doc_link: buildEdgarDocLink(cik, recent.accessionNumber[i], recent.primaryDocument[i]),
    });
  }

  // Apply form_type filter
  let rows = formType
    ? rawRows.filter(r => r.form_type === formType || r.form_type.startsWith(formType + '/'))
    : rawRows;

  // Apply date filters (post-filter)
  if (dateAfter) rows = rows.filter(r => r.filed_date && r.filed_date >= dateAfter);
  if (dateBefore) rows = rows.filter(r => r.filed_date && r.filed_date <= dateBefore);

  if (rows.length === 0) {
    const filterSummary = [
      formType ? `Form ${formType}` : null,
      dateAfter ? `since ${dateAfter}` : null,
      dateBefore ? `through ${dateBefore}` : null,
    ].filter(Boolean).join(' · ');
    return {
      card: {
        kind: 'no_data',
        query_summary: `${known.display}${filterSummary ? ` · ${filterSummary}` : ''}`,
        message: `${known.display} has no filings matching those filters. Try widening the date range or removing form_type.`,
      },
    };
  }

  // Sort newest first, take top 50
  rows.sort((a, b) => (b.filed_date || '').localeCompare(a.filed_date || ''));
  const shown = rows.slice(0, 50);

  return {
    card: {
      kind: 'company_filings',
      company: known.display,
      total: rows.length,
      shown: shown.length,
      filters: {
        form_type: formType || null,
        date_after: dateAfter || null,
        date_before: dateBefore || null,
      },
      rows: shown,
      groups: null,
      is_spv_trail: false,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// PRIVATE COMPANY FETCH — full-text search, expects SPV trail by default
// ──────────────────────────────────────────────────────────────────────────

async function fetchPrivateCompanyFilings({ companyName, companyAlias, formType, dateAfter, dateBefore }) {
  const params = new URLSearchParams();
  params.set('q', `"${companyAlias || companyName}"`);
  if (formType) params.set('forms', formType);
  if (dateAfter) {
    params.set('dateRange', 'custom');
    params.set('startdt', dateAfter);
  }
  if (dateBefore) {
    params.set('dateRange', 'custom');
    params.set('enddt', dateBefore);
  }

  const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
  console.log('[edgar]', JSON.stringify({ mode: 'private_company', url, companyName }));

  const data = await fetchEdgar(url);
  const hits = data?.hits?.hits || [];

  if (hits.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: `${companyName}${formType ? ` · ${formType}` : ''}`,
        message: `Nothing in EDGAR for "${companyName}". Could be too early — or they're using exempt vehicles that don't surface here.`,
      },
    };
  }

  let rows = hits.map(h => parseFiling(h, companyName));

  // Enforce date filters on rows
  if (dateAfter) rows = rows.filter(r => r.filed_date && r.filed_date >= dateAfter);
  if (dateBefore) rows = rows.filter(r => r.filed_date && r.filed_date <= dateBefore);

  if (rows.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: `${companyName}${formType ? ` · ${formType}` : ''}${dateAfter ? ` · since ${dateAfter}` : ''}`,
        message: `No filings for ${companyName} match those filters. Try widening the date range.`,
      },
    };
  }

  // SPV trail mode: Always group for known-private companies if there are
  // 5+ filings (because the whole point is the SPV trail, even with a small set)
  const groups = rows.length >= 5 ? groupByFilerFamily(rows) : null;
  const totalRaw = data?.hits?.total?.value || rows.length;
  const total = totalRaw >= 10000 ? rows.length : Math.min(totalRaw, rows.length);

  return {
    card: {
      kind: 'company_filings',
      company: companyName,
      total: total,
      shown: rows.length,
      total_capped: totalRaw >= 10000,
      filters: {
        form_type: formType || null,
        date_after: dateAfter || null,
        date_before: dateBefore || null,
      },
      rows,
      groups,
      is_spv_trail: !!groups,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// UNKNOWN COMPANY FETCH — full-text search, with smart SPV detection
// SPV mode fires only if the named entity isn't in the top filers (i.e. third
// parties are the ones filing). If the company files its own filings, this
// is a normal filing-list view, not an SPV trail.
// ──────────────────────────────────────────────────────────────────────────

async function fetchUnknownCompanyFilings({ companyName, formType, dateAfter, dateBefore }) {
  const params = new URLSearchParams();
  params.set('q', `"${companyName}"`);
  if (formType) params.set('forms', formType);
  if (dateAfter) {
    params.set('dateRange', 'custom');
    params.set('startdt', dateAfter);
  }
  if (dateBefore) {
    params.set('dateRange', 'custom');
    params.set('enddt', dateBefore);
  }

  const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
  console.log('[edgar]', JSON.stringify({ mode: 'unknown_company', url, companyName }));

  const data = await fetchEdgar(url);
  const hits = data?.hits?.hits || [];

  if (hits.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: `${companyName}${formType ? ` · ${formType}` : ''}`,
        message: `Nothing in EDGAR for "${companyName}". Either the spelling is off, or they haven't made an SEC filing.`,
      },
    };
  }

  let rows = hits.map(h => parseFiling(h, companyName));

  // Enforce date filters on rows (EDGAR's date param sometimes leaks)
  if (dateAfter) rows = rows.filter(r => r.filed_date && r.filed_date >= dateAfter);
  if (dateBefore) rows = rows.filter(r => r.filed_date && r.filed_date <= dateBefore);

  // Drop non-operating-company noise (mortgage trusts, etc.) — only if there's
  // at least ONE row that matches the company name, otherwise we'd erase
  // legitimate searches for fund-style names.
  const lowerCompany = companyName.toLowerCase();
  const hasNamedMatch = rows.some(r => r.filer_name.toLowerCase().includes(lowerCompany));
  if (hasNamedMatch) {
    rows = rows.filter(r => !isNonOperatingFiler(r.filer_name));
  }

  if (rows.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: `${companyName}${formType ? ` · ${formType}` : ''}`,
        message: `No relevant filings for "${companyName}" after filtering out unrelated funds and trusts.`,
      },
    };
  }

  // Smart SPV detection — only fire if the named entity isn't dominant in top filers
  const topFilerName = rows[0]?.filer_name?.toLowerCase() || '';
  const namedEntityIsTopFiler = topFilerName.includes(lowerCompany);
  const uniqueFilers = new Set(rows.map(r => r.filer_name)).size;

  // SPV trail only if: 10+ filings, 5+ unique filers, AND the named company
  // isn't the dominant filer (which would mean they ARE filing themselves)
  const isSpvTrail = rows.length >= 10 && uniqueFilers >= 5 && !namedEntityIsTopFiler;

  let groups = null;
  if (isSpvTrail) {
    groups = groupByFilerFamily(rows);
  }

  const totalRaw = data?.hits?.total?.value || rows.length;
  const total = totalRaw >= 10000 ? rows.length : Math.min(totalRaw, rows.length);

  return {
    card: {
      kind: 'company_filings',
      company: companyName,
      total: total,
      shown: rows.length,
      total_capped: totalRaw >= 10000,
      filters: {
        form_type: formType || null,
        date_after: dateAfter || null,
        date_before: dateBefore || null,
      },
      rows,
      groups,
      is_spv_trail: isSpvTrail,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// EDGAR DOC LINK BUILDER — direct links to filing documents
// ──────────────────────────────────────────────────────────────────────────

function buildEdgarDocLink(cik, accession, primaryDoc) {
  if (!cik || !accession) return `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany`;
  // Strip leading zeros for the directory path; submission accession needs dashes removed for path
  const cikInt = parseInt(cik, 10);
  const accNoDashes = String(accession).replace(/-/g, '');
  if (primaryDoc) {
    return `${EDGAR_BASE}/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDoc}`;
  }
  // Fall back to the filing index page
  return `${EDGAR_BASE}/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
}

// Group filings into filer "families" (Hiive, Augurey, Linqto etc.)
function groupByFilerFamily(rows) {
  const families = new Map();

  for (const row of rows) {
    const family = detectFilerFamily(row.filer_name);
    if (!families.has(family)) {
      families.set(family, {
        family_name: family,
        count: 0,
        total_amount: 0,
        latest_filed: null,
        first_filed: null,
        forms: new Set(),
        sample_rows: [],
      });
    }
    const g = families.get(family);
    g.count++;
    if (row.amount) g.total_amount += row.amount;
    g.forms.add(row.form_type);
    if (!g.latest_filed || row.filed_date > g.latest_filed) g.latest_filed = row.filed_date;
    if (!g.first_filed || row.filed_date < g.first_filed) g.first_filed = row.filed_date;
    if (g.sample_rows.length < 3) g.sample_rows.push(row);
  }

  // Sort: largest count first, then by total amount
  return [...families.values()]
    .map(g => ({ ...g, forms: [...g.forms] }))
    .sort((a, b) => b.count - a.count || b.total_amount - a.total_amount);
}

function detectFilerFamily(filerName) {
  const lower = filerName.toLowerCase();
  // Check known SPV families in priority order
  if (lower.includes('hiive')) return 'Hiive';
  if (lower.includes('augurey')) return 'Augurey Ventures';
  if (lower.includes('linqto')) return 'Linqto Liquidshares';
  if (lower.includes('cgf2021')) return 'CGF2021 SPV Family';
  if (lower.includes('mav alternate')) return 'MAV Alternate';
  if (lower.includes('mw lsvc')) return 'MW LSVC';
  if (lower.includes('hii ')) return 'HII';
  if (lower.includes('id funds')) return 'ID Funds';
  if (lower.includes('edge partners')) return 'Edge Partners';
  if (lower.includes('iron pine')) return 'Iron Pine';
  if (lower.includes('ibd ventures')) return 'IBD Ventures';
  if (lower.includes('ineffable')) return 'Ineffable Ventures';
  if (lower.includes('venelite')) return 'Venelite';
  if (lower.includes('e1 ventures')) return 'E1 Ventures';
  if (lower.includes('pachamama')) return 'Pachamama Capital';
  if (lower.includes('aurum vp')) return 'Aurum VP';
  if (lower.includes('myasiavc')) return 'MyAsiaVC';
  if (lower.includes('zzg capital')) return 'ZZG Capital';
  if (lower.includes('nuvion')) return 'Nuvion';
  if (lower.includes('starbridge')) return 'Starbridge';
  if (lower.includes('stonks')) return 'Stonks SPVs';
  if (lower.includes('ventioneers')) return 'Ventioneers';
  if (lower.includes('arden')) return 'Arden';
  if (lower.includes('7gc')) return '7GC & Co.';
  if (lower.includes('mayavalley') || lower.includes('ssd spv')) return 'Mayavalley / SSD';
  if (lower.includes('rvc anthropic') || lower.includes('rvc ')) return 'RVC';
  if (lower.includes('okami')) return 'Okami';
  if (lower.includes('scenic')) return 'Scenic';
  if (lower.includes('lfg ')) return 'LFG';
  if (lower.includes('kaleida')) return 'Kaleida Capital';
  if (lower.includes('invext')) return 'INVEXT';
  if (lower.includes('bloom opportunities')) return 'Bloom Opportunities';
  if (lower.includes('incepto')) return 'Incepto AGI';
  if (lower.includes('dv anthropic')) return 'DV Anthropic';

  // Fallback: use first 3 words of the filer name
  const words = filerName.split(/[\s,]+/).slice(0, 3).join(' ');
  return words || filerName;
}

// ──────────────────────────────────────────────────────────────────────────
// SEARCH-MODE FETCH — sector + form + date filters
// ──────────────────────────────────────────────────────────────────────────

async function fetchFilingsSearch({ sector, formType, minAmount, state, dateAfter, dateBefore }) {
  const params = new URLSearchParams();

  // Build query — narrower phrasing for sector queries to reduce noise
  const queryParts = [];
  if (sector && SECTORS[sector]) {
    const sectorDef = SECTORS[sector];
    // Use the most distinctive keywords (shorter list = fewer false positives)
    const distinctive = sectorDef.keywords.slice(0, 5);
    queryParts.push(distinctive.map(k => `"${k}"`).join(' OR '));
  }

  if (queryParts.length > 0) {
    params.set('q', queryParts.join(' '));
  }

  if (formType) params.set('forms', formType);
  if (dateAfter) {
    params.set('dateRange', 'custom');
    params.set('startdt', dateAfter);
  }
  if (dateBefore) {
    params.set('dateRange', 'custom');
    params.set('enddt', dateBefore);
  }

  const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
  console.log('[edgar]', JSON.stringify({ mode: 'search', url, sector, formType }));

  const data = await fetchEdgar(url);
  let rows = (data?.hits?.hits || []).map(h => parseFiling(h, null));
  const rawCount = rows.length;
  const totalRaw = data?.hits?.total?.value || rawCount;

  // Enforce date filters on rows (EDGAR sometimes leaks pre-date results)
  if (dateAfter) rows = rows.filter(r => r.filed_date && r.filed_date >= dateAfter);
  if (dateBefore) rows = rows.filter(r => r.filed_date && r.filed_date <= dateBefore);

  // Drop fund/trust/mortgage noise — these are NOT operating-company raises
  rows = rows.filter(r => !isNonOperatingFiler(r.filer_name));

  // Apply min_amount filter (post-fetch since EDGAR doesn't support it directly)
  if (minAmount) {
    rows = rows.filter(r => r.amount && r.amount >= minAmount);
  }

  // Apply state filter
  if (state) {
    rows = rows.filter(r => r.state_of_inc === state);
  }

  if (rows.length === 0) {
    return {
      card: {
        kind: 'no_data',
        query_summary: buildQuerySummary({ sector, formType, minAmount, state, dateAfter, dateBefore }),
        message: 'No operating-company filings matched those filters after dropping funds and trusts. Try widening the date range, removing the amount filter, or checking back — Form Ds run on a 15-day filing window.',
      },
    };
  }

  // Sort newest first
  rows.sort((a, b) => (b.filed_date || '').localeCompare(a.filed_date || ''));

  // Honest total: if EDGAR capped at 10000, show the post-filter count, not the cap
  const totalCapped = totalRaw >= 10000;
  const total = totalCapped ? rows.length : Math.min(totalRaw, rows.length);

  return {
    card: {
      kind: 'filings_list',
      query_summary: buildQuerySummary({ sector, formType, minAmount, state, dateAfter, dateBefore }),
      total: total,
      shown: rows.length,
      total_capped: totalCapped,
      filters: {
        sector: sector ? { key: sector, display: SECTORS[sector]?.display } : null,
        form_type: formType || null,
        min_amount: minAmount || null,
        state: state || null,
        date_after: dateAfter || null,
        date_before: dateBefore || null,
      },
      rows: rows.slice(0, 50),
    },
  };
}

function buildQuerySummary({ sector, formType, minAmount, state, dateAfter, dateBefore }) {
  const parts = [];
  if (sector && SECTORS[sector]) parts.push(SECTORS[sector].display);
  if (formType) parts.push(`Form ${formType}`);
  if (minAmount) parts.push(`above $${(minAmount / 1_000_000).toFixed(0)}M`);
  if (state) parts.push(state);
  if (dateAfter && dateBefore) parts.push(`${dateAfter} to ${dateBefore}`);
  else if (dateAfter) parts.push(`since ${dateAfter}`);
  else if (dateBefore) parts.push(`through ${dateBefore}`);
  return parts.join(' · ') || 'All filings';
}

// ──────────────────────────────────────────────────────────────────────────
// FILING PARSER
// ──────────────────────────────────────────────────────────────────────────

function parseFiling(hit, contextCompanyName) {
  const src = hit._source || {};
  const id = hit._id || '';

  // Filer name + CIK — search results put the filer in display_names array
  const displayName = (src.display_names || [])[0] || src.entity_name || 'Unknown filer';
  const ciks = src.ciks || [];

  // Form type
  const formType = src.form || src.adsh?.split('-')[0] || '?';

  // Filed date
  const filedDate = src.file_date || src.adsh_filed || null;

  // Offering amount (Form D specific) — pulled from XBRL if present
  let amount = null;
  if (src.offering_amount) {
    amount = parseInt(src.offering_amount, 10);
  } else if (src.xbrl_total_offering_amount) {
    amount = parseInt(src.xbrl_total_offering_amount, 10);
  }

  // State of incorporation
  const stateOfInc = src.state_of_inc || src.state_inc || null;

  // Build EDGAR document link
  const accession = src.adsh || id;
  const accNoDashes = String(accession).replace(/-/g, '');
  const docLink = ciks[0]
    ? `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${ciks[0]}&type=${formType}`
    : `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany`;

  return {
    filer_name: cleanFilerName(displayName),
    cik: ciks[0] || null,
    form_type: formType,
    filed_date: filedDate,
    amount,
    state_of_inc: stateOfInc,
    accession,
    doc_link: docLink,
  };
}

function cleanFilerName(raw) {
  // EDGAR display names sometimes include  "(0001234567) (Filer)" suffix
  return String(raw)
    .replace(/\s*\(\d+\)\s*\(Filer\)\s*$/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// EDGAR HTTP CLIENT
// ──────────────────────────────────────────────────────────────────────────

async function fetchEdgar(url) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.includes(u.hostname)) {
    throw new Error(`Host not in allowlist: ${u.hostname}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': DATA_SOURCE_USER_AGENT,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`EDGAR ${res.status}: ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}


// ============================================================================
// SECTION 12: MAIN HANDLER (entry point)
// ============================================================================

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const ip = getClientIp(event);
  const t0 = Date.now();
  const body = parseBody(event);
  const requestType = body?.request_type || '(none)';
  const reqId = Math.random().toString(16).slice(2, 10);

  const logReq = (outcome, extra = {}) => {
    console.log('REQ', JSON.stringify({
      ts: new Date().toISOString(),
      reqId, ip, request_type: requestType,
      duration_ms: Date.now() - t0,
      outcome, ...extra,
    }));
  };

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    logReq('rate_limited', { reason: limit.reason });
    writeJsonResponse(responseStream, 429, { error: `Rate limit exceeded (${limit.reason})` });
    return;
  }

  if (!body || !requestType || requestType === '(none)') {
    logReq('bad_request', { error: 'missing_request_type' });
    writeJsonResponse(responseStream, 400, { error: 'Missing request_type' });
    return;
  }

  try {
    switch (requestType) {
      case 'stream':
        await handleStream(responseStream, body);
        logReq('ok');
        return;

      case 'pills':
        await handlePills(responseStream, body);
        logReq('ok');
        return;

      case 'data_proxy':
        await handleDataProxy(responseStream, body);
        logReq('ok');
        return;

      default:
        logReq('unknown_request_type');
        writeJsonResponse(responseStream, 400, { error: `Unknown request_type: ${requestType}` });
    }
  } catch (err) {
    console.error('[handler] error', err.message);
    logReq('error', { error: err.message });
    try {
      writeJsonResponse(responseStream, 500, { error: 'Internal error' });
    } catch { /* stream may already be closed */ }
  }
});
