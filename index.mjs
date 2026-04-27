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

  state          : 2-letter state code for state of INCORPORATION (not HQ).
                   Most US tech companies incorporate in Delaware regardless
                   of where they operate. So "California Form Ds" via state="CA"
                   will return very few results — most California cybersecurity
                   companies are Delaware-incorporated. Use this filter ONLY
                   when the user explicitly asks about state of incorporation,
                   or when looking for traditional industries (banking, real
                   estate, energy) where in-state incorporation is more common.
                   Don't auto-emit state for queries like "California cyber
                   companies" — clarify first that EDGAR doesn't index HQ.

  date_after     : ISO date (YYYY-MM-DD). Filings on or after this date.
                   Use the CURRENT DATE section to compute relative phrases.

  date_before    : ISO date (YYYY-MM-DD). Filings on or before this date.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTOR QUERIES HAVE A REAL LIMITATION — SET EXPECTATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When the user asks for a sector + date query ("AI raises last month", "climate Form Ds this quarter", "fintech raises last year"), be honest in pass-1: EDGAR's full-text search ranks by RELEVANCE, not date. For broad sectors like "climate" or "energy" with thousands of historical filings, EDGAR's top results are almost always old infrastructure funds and mature companies — recent operating-company raises often don't surface.

For these queries, pass-1 should set expectations BEFORE the user sees a possibly-empty result:

User: "Climate tech raises this quarter"
Good: "Climate is a noisy keyword in EDGAR — a lot of old infrastructure funds match it. Let me see what's recent and operating-company, but if it's quiet, you'd probably want to track specific climate-tech company names directly. <data sector='climate' form_type='D' date_after='2026-04-01' />"

User: "Fintech raises last year"
Good: "Fintech sector queries can be hit-or-miss because EDGAR ranks by relevance not date — recent raises sometimes get buried. Pulling what I can find. <data sector='fintech' form_type='D' date_after='2025-01-01' date_before='2025-12-31' />"

DO NOT promise a clean result. DO NOT pretend EDGAR is a comprehensive sector database. It isn't.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
WHEN THE QUERY IS VAGUE OR CONCEPTUAL — ASK BEFORE NARROWING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Some queries describe a concept rather than a specific filter. "Competitors of Hippocratic AI", "companies like Stripe", "AI safety startups", "early-stage cybersecurity plays". These can't be turned into a clean SEC search without losing fidelity. EDGAR doesn't index "competitors" or "companies like X" — and over-narrowing to a single sector + recent date will return useless results.

For these, do PROSE first. Ask the user to name 2-3 specific companies, OR offer 2-3 reasonable interpretations they can pick from.

User: "Competitors of Hippocratic AI"
Good (PROSE — no tag): "EDGAR doesn't index competitive landscapes — it indexes filings. To pull useful data, I need names. If you give me 2-3 companies you're tracking against Hippocratic, I can pull their filing histories side by side. Or if you want a sector view, I can pull recent Form Ds in healthcare AI broadly — but that'll include everyone from drug discovery to telehealth. Which way works?"

User: "AI safety startups"
Good (PROSE): "AI safety isn't a SIC code — companies file under their broader sector. Anthropic, OpenAI, Conjecture, and Mechanize are the names usually grouped here. Want me to pull any of them, or pull recent AI Form Ds and let you scan?"

DO NOT emit a tag that returns 1 result and then complain about the empty set. If the search would be too narrow, ask first.

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

NEVER claim to have read a filing's actual content. The card shows you metadata only — filer, form type, date, accession number. It does NOT show you the text inside the 10-K, 10-Q, S-1, or any other filing. You cannot quote risk factors, MD&A passages, specific dollar figures from financial statements, or any prose written inside a filing. If a user asks "what does Salesforce's 10-K say about AI risks," you can confirm the filing exists and link to it, but you must say honestly: "I can show you the filing exists. I can't read what's inside. The 2026 10-K is at the link — Item 1A Risk Factors is where their risk language lives."

NEVER compare the contents of two filings against each other if the card only shows their metadata. Do not say "the 2026 filing emphasizes X more than the 2024 version" unless that comparison is visible on the card itself.

NEVER add analytical color the data can't support. Do not claim "consistent cadence", "steady pace", "incredibly disciplined", "X is dialed in" based on a few dates alone. Three filings is not a "cadence." Two filings 18 months apart is not a "pattern." When the data is thin, say what you see ("filed in March each of the last three years") instead of editorializing about it ("incredibly consistent reporting cadence"). Numbers earn the descriptor, not the other way around.

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

  // Calendar quarter start (Jan 1, Apr 1, Jul 1, or Oct 1)
  const month = now.getUTCMonth();          // 0-11
  const quarterStartMonth = Math.floor(month / 3) * 3;
  const quarterStart = `${now.getUTCFullYear()}-${String(quarterStartMonth + 1).padStart(2, '0')}-01`;

  // Last calendar quarter
  let lastQuarterStartYear = now.getUTCFullYear();
  let lastQuarterStartMonth = quarterStartMonth - 3;
  if (lastQuarterStartMonth < 0) {
    lastQuarterStartMonth = 9;  // Q4 of previous year
    lastQuarterStartYear -= 1;
  }
  const lastQuarterStart = `${lastQuarterStartYear}-${String(lastQuarterStartMonth + 1).padStart(2, '0')}-01`;

  return basePrompt + `

━━━ CURRENT DATE ━━━

Today is ${today}. ALWAYS compute date references relative to today, never relative to your training data.

  "today"           → ${today}
  "yesterday"       → ${minus(1)}
  "last week"       → ${minus(7)}
  "last month"      → ${minus(30)}
  "last 60 days"    → ${minus(60)}
  "last 90 days"    → ${minus(90)}
  "this quarter"    → ${quarterStart}    (current calendar quarter start)
  "last quarter"    → ${lastQuarterStart} (previous calendar quarter start)
  "this year"       → ${yearStart}
  "recently"        → treat as "last month"

When emitting a date_after attribute and the user used a relative phrase like "last month" or "this year", substitute the ISO date from the table above. Do NOT emit the placeholder LAST_MONTH; emit the actual date.

If the user gives a specific year (e.g. "in 2024"), use that year's exact start and end (date_after="2024-01-01", date_before="2024-12-31").
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
// SECTION 10b: HANDLER — audit (diagnostic; hits EDGAR raw, reports filter impact)
// ============================================================================
//
// Lets a frontend audit page hit EDGAR directly via the Lambda (bypassing
// browser CORS) and see exactly what Mo's filter pipeline dropped vs kept.
//
// Body shape:
//   { request_type: 'audit', edgar_params: {q, forms, startdt, enddt, ...},
//     min_amount: 20000000, state: 'CA' }
//
// Response shape:
//   {
//     raw: { total: N, hits: [...rows] },
//     filtered: {
//       dropped_non_operating: [...rows],
//       dropped_amount: [...rows],
//       dropped_state: [...rows],
//       survived: [...rows]
//     }
//   }
// ============================================================================

const handleAudit = async (responseStream, body) => {
  try {
    const { edgar_params, min_amount, state } = body || {};
    if (!edgar_params) {
      writeJsonResponse(responseStream, 400, { error: 'Missing edgar_params' });
      return;
    }

    // Build the EDGAR full-text search URL — strip 'hits' if present, we manage it
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(edgar_params)) {
      if (k === 'hits' || k === 'from') continue;
      if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
    }

    const baseUrl = `${SEC_BASE}/LATEST/search-index?${params.toString()}`;
    const dateAfter = edgar_params.startdt;
    const dateBefore = edgar_params.enddt;

    // Paginate the same way fetchFilingsSearch does
    const MAX_PAGES = 5;
    let totalRaw = 0;
    let allRows = [];
    let pagesFetched = 0;
    let stopReason = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      const pageUrl = `${baseUrl}&hits=100&from=${page * 100}`;
      const pageData = await fetchEdgar(pageUrl);
      pagesFetched++;
      if (page === 0) {
        totalRaw = pageData?.hits?.total?.value || 0;
      }
      const pageHits = pageData?.hits?.hits || [];
      if (pageHits.length === 0) {
        stopReason = 'no more pages';
        break;
      }
      allRows.push(...pageHits.map(h => parseFiling(h, null)));
      if (pageHits.length < 100) {
        stopReason = 'partial page (end of results)';
        break;
      }
    }
    if (!stopReason) stopReason = `hit MAX_PAGES (${MAX_PAGES})`;

    const url = baseUrl + '&hits=100';  // for display only
    console.log('[audit]', JSON.stringify({ url, pagesFetched, allRowsCount: allRows.length }));

    const data = await fetchEdgar(url);
    const hits = data?.hits?.hits || [];
    const totalRawFromAPI = totalRaw;

    // Use rows from pagination
    const rows = allRows;

    // Apply Mo's filter pipeline IN ORDER, mirroring fetchFilingsSearch:
    //   1. date_after / date_before
    //   2. non-operating filers
    //   3. min_amount (smart: keep unknowns separately)
    //   4. state
    let surviving = [...rows];

    let droppedDate = [];
    if (dateAfter) {
      droppedDate = droppedDate.concat(surviving.filter(r => !r.filed_date || r.filed_date < dateAfter));
      surviving = surviving.filter(r => r.filed_date && r.filed_date >= dateAfter);
    }
    if (dateBefore) {
      droppedDate = droppedDate.concat(surviving.filter(r => !r.filed_date || r.filed_date > dateBefore));
      surviving = surviving.filter(r => r.filed_date && r.filed_date <= dateBefore);
    }

    const droppedNonOperating = surviving.filter(r => isNonOperatingFiler(r.filer_name));
    surviving = surviving.filter(r => !isNonOperatingFiler(r.filer_name));

    // Smart amount filter: track known vs unknown separately so audit reflects
    // production behavior (unknowns are KEPT in production, just labeled)
    let droppedAmount = [];
    let unknownAmount = [];
    if (min_amount) {
      const minAmt = parseInt(min_amount, 10);
      droppedAmount = surviving.filter(r => r.amount && r.amount < minAmt);
      unknownAmount = surviving.filter(r => !r.amount);
      // In production we KEEP unknowns. Audit should reflect that. Only drop
      // rows where amount is known AND below threshold.
      surviving = surviving.filter(r => !r.amount || r.amount >= minAmt);
    }

    let droppedState = [];
    if (state) {
      droppedState = surviving.filter(r => r.state_of_inc !== state);
      surviving = surviving.filter(r => r.state_of_inc === state);
    }

    writeJsonResponse(responseStream, 200, {
      raw: {
        total: totalRawFromAPI,
        returned: rows.length,
        pages_fetched: pagesFetched,
        stop_reason: stopReason,
        sample: rows.slice(0, 10),
      },
      filtered: {
        dropped_date_count: droppedDate.length,
        dropped_date_sample: droppedDate.slice(0, 5),
        dropped_non_operating_count: droppedNonOperating.length,
        dropped_non_operating_sample: droppedNonOperating.slice(0, 5),
        dropped_amount_count: droppedAmount.length,
        dropped_amount_sample: droppedAmount.slice(0, 5),
        unknown_amount_count: unknownAmount.length,
        unknown_amount_sample: unknownAmount.slice(0, 5),
        dropped_state_count: droppedState.length,
        dropped_state_sample: droppedState.slice(0, 5),
        survived_count: surviving.length,
        survived: surviving.slice(0, 30),
      },
      url,
    });
  } catch (err) {
    console.error('[audit] error', err.message);
    writeJsonResponse(responseStream, 502, { error: err.message });
  }
};


// ============================================================================
// SECTION 10c: HANDLER — brief_candidates (newsletter signal gathering)
// ============================================================================
//
// Runs 5 parallel research queries to surface candidate signals for the
// weekly Substack brief. Returns a list of candidates the user picks 3 from.
//
// Body shape:
//   { request_type: 'brief_candidates', date_after: '2026-04-19' }
//
// Response shape:
//   {
//     date_range: { since: '2026-04-19', through: '2026-04-26' },
//     candidates: [
//       { bucket, kind, headline, company, filing_count, sample_filings, raw_query }
//     ]
//   }
// ============================================================================

// Public AI-adjacent companies to monitor for insider activity (Form 4)
const BRIEF_AI_PUBLIC_TICKERS = [
  'microsoft', 'alphabet', 'meta', 'amazon', 'nvidia', 'amd',
  'palantir', 'salesforce', 'oracle', 'ibm', 'snowflake',
  'datadog', 'cloudflare', 'crowdstrike',
];

// Wider public-company watchlist for annual reports (10-K), proxies (DEF 14A),
// and earnings (8-K Item 2.02). Includes the AI list plus financial,
// consumer, and other notable public companies whose filings interest
// dsignals readers.
const BRIEF_PUBLIC_WATCHLIST = [
  // AI / cloud / SaaS
  'microsoft', 'alphabet', 'meta', 'amazon', 'nvidia', 'amd',
  'palantir', 'salesforce', 'oracle', 'ibm', 'snowflake',
  'datadog', 'cloudflare', 'crowdstrike',
  // Public consumer / fintech / other
  'apple', 'tesla', 'netflix', 'rivian', 'coinbase', 'reddit', 'roblox',
  'intel', 'jpmorgan', 'walmart', 'berkshire',
];

// Private AI / fintech / climate companies for SPV trail scanning
const BRIEF_PRIVATE_COMPANIES = [
  'anthropic', 'openai', 'databricks', 'mistral', 'stripe', 'plaid',
  'klarna', 'canva', 'discord',
];

const handleBriefCandidates = async (responseStream, body) => {
  try {
    const { date_after } = body || {};

    // Default: last 7 days
    const today = new Date();
    const sinceDefault = new Date(today.getTime() - 7 * 86400000);
    const since = date_after || sinceDefault.toISOString().slice(0, 10);
    const through = today.toISOString().slice(0, 10);

    console.log('[brief_candidates]', JSON.stringify({ since, through }));

    // Gather all candidate buckets in parallel:
    //   1. SPV trails (private companies)
    //   2. Sector raises (operating-company Form Ds)
    //   3. New 10-Ks this week (annual reports)
    //   4. New 10-Qs this week (quarterly reports — sellers' scorecards)
    //   5. New DEF 14A proxies (annual letters to shareholders)
    //   6. Earnings (8-K Item 2.02)
    //   7. Insider clusters (Form 4)
    //   8. AI disclosure language (10-K/10-Q full text)
    const [
      spvTrails,
      sectorRaises,
      annualReports,
      quarterlyReports,
      proxies,
      earnings,
      insiderActivity,
      aiDisclosures,
    ] = await Promise.all([
      gatherSpvTrailCandidates(since),
      gatherSectorRaiseCandidates(since),
      gatherAnnualReportCandidates(since),
      gatherQuarterlyReportCandidates(since),
      gatherProxyCandidates(since),
      gatherEarningsCandidates(since),
      gatherInsiderCandidates(since),
      gatherAiDisclosureCandidates(since),
    ]);

    const candidates = [
      ...spvTrails.map(c => ({ ...c, bucket: 'spv_trail' })),
      ...sectorRaises.map(c => ({ ...c, bucket: 'sector_raise' })),
      ...annualReports.map(c => ({ ...c, bucket: 'annual_report' })),
      ...quarterlyReports.map(c => ({ ...c, bucket: 'quarterly_report' })),
      ...proxies.map(c => ({ ...c, bucket: 'proxy_letter' })),
      ...earnings.map(c => ({ ...c, bucket: 'earnings' })),
      ...insiderActivity.map(c => ({ ...c, bucket: 'insider' })),
      ...aiDisclosures.map(c => ({ ...c, bucket: 'ai_disclosure' })),
    ];

    writeJsonResponse(responseStream, 200, {
      date_range: { since, through },
      candidates,
      bucket_counts: {
        spv_trail: spvTrails.length,
        sector_raise: sectorRaises.length,
        annual_report: annualReports.length,
        quarterly_report: quarterlyReports.length,
        proxy_letter: proxies.length,
        earnings: earnings.length,
        insider: insiderActivity.length,
        ai_disclosure: aiDisclosures.length,
      },
    });
  } catch (err) {
    console.error('[brief_candidates] error', err.message);
    writeJsonResponse(responseStream, 502, { error: err.message });
  }
};

// ── Bucket 1: SPV trail activity ────────────────────────────────────────
// Scan known-private companies for new SPV-like filings in the date window.
// A company is a "candidate" if it had 3+ new SPV-like Form Ds this week.
async function gatherSpvTrailCandidates(since) {
  const candidates = [];

  for (const companyKey of BRIEF_PRIVATE_COMPANIES) {
    try {
      const companyInfo = KNOWN_COMPANIES[companyKey];
      if (!companyInfo) continue;
      const companyName = companyInfo.display;

      // Re-use the existing private company fetcher logic — but with date filter
      const params = new URLSearchParams();
      params.set('q', `"${companyName}"`);
      params.set('forms', 'D,D/A');
      params.set('dateRange', 'custom');
      params.set('startdt', since);

      const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
      const data = await fetchEdgar(url);
      const hits = data?.hits?.hits || [];
      const rows = hits.map(h => parseFiling(h, companyName));

      // Filter to SPV-like rows
      const tokens = companyName.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const spvRows = rows.filter(r => {
        const filerLower = (r.filer_name || '').toLowerCase();
        return tokens.some(t => filerLower.includes(t));
      });
      // Apply date filter (EDGAR sometimes leaks)
      const recent = spvRows.filter(r => r.filed_date && r.filed_date >= since);

      if (recent.length >= 5) {
        candidates.push({
          kind: 'spv_trail',
          headline: `${recent.length} new SPVs formed around ${companyName} this week`,
          company: companyName,
          company_key: companyKey,
          filing_count: recent.length,
          sample_filings: recent.slice(0, 6).map(r => ({
            filer: r.filer_name,
            form: r.form_type,
            date: r.filed_date,
            doc_link: r.doc_link,
          })),
          raw_query: `company="${companyName}" form_type="D" date_after="${since}"`,
          deep_link: `?q=${encodeURIComponent(companyName + ' SPV activity')}`,
        });
      }
    } catch (err) {
      console.error('[brief_candidates] SPV scan error for', companyKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 2: Sector raises (operating companies) ─────────────────────
// AI / fintech / climate sector Form Ds with a real amount, last 7d
async function gatherSectorRaiseCandidates(since) {
  const candidates = [];
  const sectorsToCheck = ['ai', 'fintech', 'climate', 'cybersecurity', 'biotech'];

  for (const sectorKey of sectorsToCheck) {
    try {
      const sectorDef = SECTORS[sectorKey];
      if (!sectorDef) continue;

      const distinctive = sectorDef.keywords.slice(0, 5);
      const params = new URLSearchParams();
      params.set('q', distinctive.map(k => `"${k}"`).join(' OR '));
      params.set('forms', 'D');
      params.set('dateRange', 'custom');
      params.set('startdt', since);

      // Single page fetch for candidate gathering — keeps it fast
      const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
      const data = await fetchEdgar(url);
      const hits = data?.hits?.hits || [];
      let rows = hits.map(h => parseFiling(h, null));

      // Date filter (EDGAR FTS is unreliable on dates)
      rows = rows.filter(r => r.filed_date && r.filed_date >= since);

      // Drop non-operating
      rows = rows.filter(r => !isNonOperatingFiler(r.filer_name));

      // Each operating-company filing is a potential signal
      for (const row of rows.slice(0, 3)) {
        candidates.push({
          kind: 'sector_raise',
          headline: row.amount
            ? `${sectorDef.display} raise: ${row.filer_name} filed Form D for $${(row.amount/1_000_000).toFixed(1)}M`
            : `${sectorDef.display} raise: ${row.filer_name} filed Form D (amount undisclosed)`,
          company: row.filer_name,
          sector: sectorDef.display,
          filing_count: 1,
          sample_filings: [{
            filer: row.filer_name,
            form: row.form_type,
            date: row.filed_date,
            amount: row.amount,
            doc_link: row.doc_link,
          }],
          raw_query: `sector="${sectorKey}" form_type="D" date_after="${since}"`,
          deep_link: `?q=${encodeURIComponent(sectorDef.display + ' raises since ' + since)}`,
        });
      }
    } catch (err) {
      console.error('[brief_candidates] sector scan error for', sectorKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 3: New 10-Ks this week (annual reports) ────────────────────
// Substack readers love new annual reports. Each 10-K is a meaty document
// with an MD&A, risk factors, and financial deep-dive. The signal is
// "here's who just dropped their annual."
async function gatherAnnualReportCandidates(since) {
  const candidates = [];

  for (const tickerKey of BRIEF_PUBLIC_WATCHLIST) {
    try {
      const companyInfo = KNOWN_COMPANIES[tickerKey];
      if (!companyInfo || !companyInfo.cik) continue;

      const result = await fetchPublicCompanyFilings({
        known: companyInfo,
        formType: '10-K',
        dateAfter: since,
        dateBefore: null,
      });

      const filings = result?.card?.rows || [];
      if (filings.length === 0) continue;

      // 10-Ks are filed once a year — any 10-K this week is a signal
      const latest = filings[0];
      candidates.push({
        kind: 'annual_report',
        headline: `${companyInfo.display} filed 10-K on ${latest.filed_date}`,
        company: companyInfo.display,
        company_key: tickerKey,
        filing_count: filings.length,
        sample_filings: [{
          filer: companyInfo.display,
          form: latest.form_type,
          date: latest.filed_date,
          doc_link: latest.doc_link,
        }],
        raw_query: `company="${companyInfo.display}" form_type="10-K" date_after="${since}"`,
        deep_link: `?q=${encodeURIComponent(companyInfo.display + ' 10-K')}`,
      });
    } catch (err) {
      console.error('[brief_candidates] 10-K scan error for', tickerKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 4: New 10-Qs this week (quarterly reports — sellers' scorecards) ──
// 10-Qs are the quarterly version of the 10-K. For B2B sellers with quarterly
// targets, a fresh 10-Q from a target account is the most actionable document
// of the quarter — segment revenue, capex direction, guidance commentary.
// Unlike 8-Ks, 10-Qs hit on a known cadence (3 per year per company) so they
// aren't routine noise — they're scheduled scorecards.
async function gatherQuarterlyReportCandidates(since) {
  const candidates = [];

  for (const tickerKey of BRIEF_PUBLIC_WATCHLIST) {
    try {
      const companyInfo = KNOWN_COMPANIES[tickerKey];
      if (!companyInfo || !companyInfo.cik) continue;

      const result = await fetchPublicCompanyFilings({
        known: companyInfo,
        formType: '10-Q',
        dateAfter: since,
        dateBefore: null,
      });

      const filings = result?.card?.rows || [];
      if (filings.length === 0) continue;

      const latest = filings[0];
      candidates.push({
        kind: 'quarterly_report',
        headline: `${companyInfo.display} filed 10-Q on ${latest.filed_date}`,
        company: companyInfo.display,
        company_key: tickerKey,
        filing_count: filings.length,
        sample_filings: [{
          filer: companyInfo.display,
          form: latest.form_type,
          date: latest.filed_date,
          doc_link: latest.doc_link,
        }],
        raw_query: `company="${companyInfo.display}" form_type="10-Q" date_after="${since}"`,
        deep_link: `?q=${encodeURIComponent(companyInfo.display + ' 10-Q')}`,
      });
    } catch (err) {
      console.error('[brief_candidates] 10-Q scan error for', tickerKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 5: Annual proxies (DEF 14A) — letters to shareholders ──────
// The annual proxy contains the letter to shareholders, which is often the
// most readable strategic document a public company files. Buffett's letter,
// Bezos-style letters, exec comp tables. High signal when they land.
async function gatherProxyCandidates(since) {
  const candidates = [];

  for (const tickerKey of BRIEF_PUBLIC_WATCHLIST) {
    try {
      const companyInfo = KNOWN_COMPANIES[tickerKey];
      if (!companyInfo || !companyInfo.cik) continue;

      const result = await fetchPublicCompanyFilings({
        known: companyInfo,
        formType: 'DEF 14A',
        dateAfter: since,
        dateBefore: null,
      });

      const filings = result?.card?.rows || [];
      if (filings.length === 0) continue;

      const latest = filings[0];
      candidates.push({
        kind: 'proxy_letter',
        headline: `${companyInfo.display} filed annual proxy (DEF 14A) on ${latest.filed_date}`,
        company: companyInfo.display,
        company_key: tickerKey,
        filing_count: filings.length,
        sample_filings: [{
          filer: companyInfo.display,
          form: latest.form_type,
          date: latest.filed_date,
          doc_link: latest.doc_link,
        }],
        raw_query: `company="${companyInfo.display}" form_type="DEF 14A" date_after="${since}"`,
        deep_link: `?q=${encodeURIComponent(companyInfo.display + ' annual proxy')}`,
      });
    } catch (err) {
      console.error('[brief_candidates] proxy scan error for', tickerKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 6: Earnings (8-K with Item 2.02) ────────────────────────────
// When a company reports earnings, they file an 8-K with Item 2.02
// (Results of Operations) attaching the press release and call materials.
// The submissions API doesn't filter by item code, so we pull all 8-Ks for
// the company in the date range. If there's a fresh 8-K right at earnings
// season timing, it's almost certainly the earnings report.
async function gatherEarningsCandidates(since) {
  const candidates = [];

  for (const tickerKey of BRIEF_PUBLIC_WATCHLIST) {
    try {
      const companyInfo = KNOWN_COMPANIES[tickerKey];
      if (!companyInfo || !companyInfo.cik) continue;

      const result = await fetchPublicCompanyFilings({
        known: companyInfo,
        formType: '8-K',
        dateAfter: since,
        dateBefore: null,
      });

      const filings = result?.card?.rows || [];
      if (filings.length === 0) continue;

      // For earnings season, what matters most is "this company filed AN 8-K
      // this week" — let the user click through to confirm it's earnings.
      // We still need to be careful not to flood the brief with routine 8-Ks,
      // so we only flag if the company has 1-3 8-Ks this week (more than 3
      // suggests something else is happening, like governance churn — covered
      // by other buckets).
      if (filings.length > 3) continue;

      const latest = filings[0];
      candidates.push({
        kind: 'earnings',
        headline: `${companyInfo.display} filed 8-K on ${latest.filed_date} (likely earnings)`,
        company: companyInfo.display,
        company_key: tickerKey,
        filing_count: filings.length,
        sample_filings: filings.slice(0, 3).map(r => ({
          filer: companyInfo.display,
          form: r.form_type,
          date: r.filed_date,
          doc_link: r.doc_link,
        })),
        raw_query: `company="${companyInfo.display}" form_type="8-K" date_after="${since}"`,
        deep_link: `?q=${encodeURIComponent(companyInfo.display + ' recent 8-K')}`,
      });
    } catch (err) {
      console.error('[brief_candidates] earnings scan error for', tickerKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 7: Insider activity (Form 4) at AI-adjacent public companies ──
async function gatherInsiderCandidates(since) {
  const candidates = [];

  for (const tickerKey of BRIEF_AI_PUBLIC_TICKERS) {
    try {
      const companyInfo = KNOWN_COMPANIES[tickerKey];
      if (!companyInfo || !companyInfo.cik) continue;

      const result = await fetchPublicCompanyFilings({
        known: companyInfo,
        formType: '4',
        dateAfter: since,
        dateBefore: null,
      });

      const filings = result?.card?.rows || [];
      // Only flag if there are 5+ Form 4s this week (real clusters, not routine activity)
      if (filings.length < 5) continue;

      candidates.push({
        kind: 'insider',
        headline: `${filings.length} insider transactions at ${companyInfo.display} this week`,
        company: companyInfo.display,
        company_key: tickerKey,
        filing_count: filings.length,
        sample_filings: filings.slice(0, 6).map(r => ({
          filer: r.filer_name,
          form: r.form_type,
          date: r.filed_date,
          doc_link: r.doc_link,
        })),
        raw_query: `company="${companyInfo.display}" form_type="4" date_after="${since}"`,
        deep_link: `?q=${encodeURIComponent(companyInfo.display + ' insider activity')}`,
      });
    } catch (err) {
      console.error('[brief_candidates] insider scan error for', tickerKey, err.message);
    }
  }

  return candidates;
}

// ── Bucket 8: 10-K/10-Q with AI disclosure language ───────────────────
async function gatherAiDisclosureCandidates(since) {
  const candidates = [];

  try {
    const params = new URLSearchParams();
    params.set('q', '"artificial intelligence" OR "machine learning" OR "generative AI"');
    params.set('forms', '10-K,10-Q');
    params.set('dateRange', 'custom');
    params.set('startdt', since);

    const url = `${SEC_BASE}/LATEST/search-index?${params.toString()}&hits=100`;
    const data = await fetchEdgar(url);
    const hits = data?.hits?.hits || [];
    let rows = hits.map(h => parseFiling(h, null));

    rows = rows.filter(r => r.filed_date && r.filed_date >= since);
    rows = rows.filter(r => !isNonOperatingFiler(r.filer_name));

    for (const row of rows.slice(0, 5)) {
      candidates.push({
        kind: 'ai_disclosure',
        headline: `${row.filer_name} ${row.form_type} mentions AI`,
        company: row.filer_name,
        filing_count: 1,
        sample_filings: [{
          filer: row.filer_name,
          form: row.form_type,
          date: row.filed_date,
          doc_link: row.doc_link,
        }],
        raw_query: `form_type="${row.form_type}" date_after="${since}" — AI language`,
        deep_link: `?q=${encodeURIComponent(row.filer_name + ' ' + row.form_type)}`,
      });
    }
  } catch (err) {
    console.error('[brief_candidates] AI disclosure scan error', err.message);
  }

  return candidates;
}


// ============================================================================
// SECTION 10d: HANDLER — brief_draft (generate newsletter markdown)
// ============================================================================
//
// Takes 3 picked candidates and asks Gemini to draft each in the dsignals
// newsletter format. Returns a single markdown blob ready to paste into
// Substack.
//
// Body shape:
//   { request_type: 'brief_draft',
//     issue_number: 7,
//     candidates: [...3 candidate objects from brief_candidates],
//     date_range: { since, through } }
// ============================================================================

const BRIEF_SYSTEM_PROMPT = `You are drafting a weekly Substack newsletter for dsignals — a real-time SEC filings intelligence product.

Your readers are sales reps, partners, investors, and competitors at AI/fintech/SaaS companies. They paid $10/month because they want NON-OBVIOUS insights from SEC data, not textbook definitions of filing types. If your draft sounds like a finance textbook, you have failed.

VOICE:
- Declarative and tight. Short paragraphs.
- No hedging. "This is X" not "This could potentially indicate X."
- No buzzwords. No "synergy", "leverage", "ecosystem play".
- Concrete and specific. Use the company name, the actual count, the actual date.

THE FORMAT FOR EACH SIGNAL (FIXED):

### Signal #N — [Specific headline naming company + action + key number]

**What got filed**
[2 sentences. The specific filing, who filed it, when, and the most important number. Use the data exactly. Don't invent.]

**What it actually is**
[2-3 sentences. Connect the filing TYPE pattern to what's likely happening at THIS company. Reference the count, the cluster, the timing. Don't define the form type — translate the situation.]

**Why it matters**
[3-4 short bullets. Each bullet must be SPECIFIC to this filing's pattern. No generic "signals corporate activity" language.]

**What to do**
- If you sell into [company]: [tactical action that uses the timing of this filing]
- If you partner in this space: [tactical action]
- If you track competitors: [tactical action]

👉 [Open in dsignals](DEEP_LINK_HERE)

---

EXAMPLES OF GOOD VS. BAD PROSE:

❌ BAD "What it actually is" (generic textbook):
"An 8-K disclosure is the primary mechanism for announcing material changes in operations, leadership, or financial outlook."

✅ GOOD "What it actually is" (specific to the situation):
"Datadog rarely files 8-Ks mid-quarter. Three weeks before earnings is the timing window for either a guidance preannouncement or a material acquisition disclosure. Either way, something is moving."

❌ BAD "Why it matters" (generic):
- Indicates a shift in operational strategy
- Alerts stakeholders to immediate changes
- Often precedes a broader public announcement

✅ GOOD "Why it matters" (specific):
- Datadog hasn't filed an unscheduled 8-K since the December acquisition
- Mid-quarter timing rules out routine compliance items
- April 22 is exactly three weeks before their typical Q1 earnings release

❌ BAD "What to do" (filler):
"Review the filing for mentions of new product lines."

✅ GOOD "What to do" (tactical):
"If you sell observability into Datadog accounts: hold your renewal pitches for 10 days until the news drops. If you compete with Datadog: assume they're either preannouncing weak Q1 or buying a feature gap. Watch their job postings for the gap."

KEY RULES:
- For SPV trail signals: always reference the specific dominant filer family from the data and the count. Never just say "an SPV was filed."
- For insider clusters: count matters more than dates. "5 Form 4s in 4 days from 3 different officers" is the headline.
- For sector raises: use the dollar amount IF it's known. If undisclosed, say "amount undisclosed" — that itself is a signal (suggests bridge or recap).
- Never use em dashes (—) inside sentences. Commas, periods, or dashes only.
- Never claim to have READ filing contents. You can describe what filings of THIS TYPE typically signal in THIS COMPANY's situation, but don't fabricate language from inside the filing.

AFTER ALL 3 SIGNALS, write:

## The pattern this week

[3-4 sentences. Find the SPECIFIC thread connecting the three signals. Not "things are happening in tech" — what is actually moving? Examples: "Three of the four largest AI SPV operators filed this week. The cluster suggests secondary pricing has firmed up." Or: "Two cybersecurity Form D raises and one cyber 10-K with material disclosure language. Cyber budgets are flowing while everyone else cuts."]

End with one of these closers (not all):
- "These signals show up in filings before they show up anywhere else."
- "The market hasn't priced this in yet."
- "Watch this space."

Then sign off:

---

— Mark`;

const handleBriefDraft = async (responseStream, body) => {
  try {
    const { issue_number, candidates, date_range } = body || {};
    if (!candidates || candidates.length === 0) {
      writeJsonResponse(responseStream, 400, { error: 'No candidates provided' });
      return;
    }

    const candidatesPayload = candidates.map((c, i) => {
      const samples = (c.sample_filings || []).map(s =>
        `  - ${s.filer} | ${s.form} | ${s.date}${s.amount ? ' | $' + (s.amount/1_000_000).toFixed(1) + 'M' : ''}`
      ).join('\n');

      // Compute date span and unique filer count from samples
      const dates = (c.sample_filings || []).map(s => s.date).filter(Boolean).sort();
      const dateSpan = dates.length > 0
        ? (dates.length === 1 ? dates[0] : `${dates[0]} through ${dates[dates.length - 1]}`)
        : 'unknown';
      const uniqueFilers = new Set((c.sample_filings || []).map(s => s.filer)).size;

      return `Signal ${i + 1} candidate:
  Bucket type: ${c.bucket}
  Headline hint: ${c.headline}
  Company / topic: ${c.company}
  Total filing count this week: ${c.filing_count}
  Date span of filings: ${dateSpan}
  Unique filer entities: ${uniqueFilers}
  ${c.sector ? 'Sector: ' + c.sector : ''}
  Sample filings (use these exact names and dates, do not invent):
${samples}
  Deep link path: ${c.deep_link}`;
    }).join('\n\n');

    const userMessage = `Issue #${issue_number || 'X'}
Date range covered: ${date_range?.since || 'last week'} through ${date_range?.through || 'today'}

Here are the 3 picked candidates. Draft the full newsletter in markdown.

${candidatesPayload}

Build the deep links as: https://dsignals.com${candidates[0].deep_link}, https://dsignals.com${candidates[1].deep_link}, https://dsignals.com${candidates[2].deep_link}

Now write the newsletter. Use SPECIFIC details (counts, dates, filer names) from the candidates above. Do not invent. Do not write generic filing-type definitions. Make each signal feel like an insight, not a definition.

Start with the issue title (e.g. "Issue #${issue_number}: [theme]"), then 3 signal blocks, then "## The pattern this week", then sign-off.`;

    // Call Gemini directly with the brief-specific prompt
    if (!GEMINI_API_KEY) {
      writeJsonResponse(responseStream, 500, { error: 'GEMINI_API_KEY not set' });
      return;
    }

    const geminiBody = {
      systemInstruction: { role: 'system', parts: [{ text: BRIEF_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const markdown = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    writeJsonResponse(responseStream, 200, {
      issue_number: issue_number || null,
      date_range,
      markdown,
    });

  } catch (err) {
    console.error('[brief_draft] error', err.message);
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

  // SPV trail mode: only fire if filings genuinely look like SPVs
  // (Form Ds from entities with company name in the filer name).
  // Otherwise it's a regular filings list — even for known-private companies,
  // the data might just be mutual fund holdings disclosures, not SPVs.
  const isSpvTrail = isGenuineSpvTrail(rows, companyName);
  const groups = isSpvTrail ? groupByFilerFamily(rows, companyName) : null;
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
      timeline: isSpvTrail ? buildTimeline(rows) : null,
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

  // SPV trail mode: strict gate — only fire if filings genuinely look like SPVs
  // (Form Ds from entities whose name contains the company). This prevents
  // misidentifying mutual fund disclosures or public-company 8-Ks as SPVs.
  const isSpvTrail = isGenuineSpvTrail(rows, companyName);
  const groups = isSpvTrail ? groupByFilerFamily(rows, companyName) : null;

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
      timeline: isSpvTrail ? buildTimeline(rows) : null,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// EDGAR DOC LINK BUILDER — direct links to filing documents
// ──────────────────────────────────────────────────────────────────────────

function buildEdgarDocLink(cik, accession, primaryDoc) {
  if (!cik || !accession) return `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany`;
  const cikInt = parseInt(cik, 10);
  const accNoDashes = String(accession).replace(/-/g, '');
  // If primary doc is HTML/PDF, link directly to it. If it's XML (XBRL), link
  // to the filing index page where EDGAR auto-renders a readable view.
  if (primaryDoc && !/\.xml$/i.test(primaryDoc)) {
    return `${EDGAR_BASE}/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDoc}`;
  }
  return `${EDGAR_BASE}/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
}

// Returns true ONLY if these filings genuinely look like an SPV trail.
// An SPV trail means: third parties created Special Purpose Vehicles to
// assemble exposure to the named company. Most filings should be Form D
// from small entities whose name explicitly references the company.
//
// This filter prevents misidentifying mutual fund disclosures (NPORT-P) and
// public-company 8-Ks/proxies as SPV trails, which was the OpenAI/Stripe bug.
function isGenuineSpvTrail(rows, companyName) {
  if (!rows || rows.length < 5) return false;
  if (!companyName) return false;

  const companyLower = companyName.toLowerCase();
  const tokens = companyLower.split(/\s+/).filter(t => t.length > 2);
  if (tokens.length === 0) return false;

  // A row is "SPV-like" if:
  //   - Form is D or D/A (Form D is the SPV signature)
  //   - The filer name contains the company name (or a key token)
  const spvLikeRows = rows.filter(r => {
    const isFormD = r.form_type === 'D' || r.form_type === 'D/A';
    if (!isFormD) return false;
    const filerLower = (r.filer_name || '').toLowerCase();
    return tokens.some(t => filerLower.includes(t));
  });

  // Need at least 5 SPV-like filings AND they must be the majority
  if (spvLikeRows.length < 5) return false;
  if (spvLikeRows.length / rows.length < 0.5) return false;

  // Need diversity of filers among the SPV-like rows
  const uniqueSpvFilers = new Set(spvLikeRows.map(r => r.filer_name)).size;
  if (uniqueSpvFilers < 3) return false;

  return true;
}

// Build a sparkline timeline payload from the filings.
// Returns the date range and an array of date strings (one per filing).
// Renderer turns this into a horizontal scatter of dots showing when
// activity happened across the period. Especially useful for spotting
// acceleration vs steady cadence.
function buildTimeline(rows) {
  if (!rows || rows.length === 0) return null;
  const dates = rows
    .map(r => r.filed_date)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return null;
  return {
    start: dates[0],
    end: dates[dates.length - 1],
    dates,
  };
}

// Group filings into filer "families" (Hiive, Augurey, Linqto etc.)
// When companyName is provided, ONLY groups Form D filings from filers whose
// names contain the company. This prevents grouping mutual fund disclosures
// or public-company 8-Ks as if they were SPVs.
function groupByFilerFamily(rows, companyName) {
  // If a company is given, restrict to SPV-like rows
  let workingRows = rows;
  if (companyName) {
    const tokens = companyName.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    workingRows = rows.filter(r => {
      const isFormD = r.form_type === 'D' || r.form_type === 'D/A';
      if (!isFormD) return false;
      const filerLower = (r.filer_name || '').toLowerCase();
      return tokens.some(t => filerLower.includes(t));
    });
  }

  const families = new Map();

  for (const row of workingRows) {
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

  // EDGAR full-text search returns results sorted by relevance, not date.
  // For sector queries with date filters, the top relevance hits are often
  // OLD filings unrelated to current activity. So we paginate up to 5 pages
  // (500 results) and apply date filters across all pages, stopping early
  // once we have enough date-matching results.
  //
  // We collect:
  //   - All rows that match the date filter (these are what we'll show)
  //   - Total raw count from EDGAR (for honest reporting)
  const baseUrl = `${SEC_BASE}/LATEST/search-index?${params.toString()}`;
  const MAX_PAGES = 5;
  const TARGET_DATE_MATCHES = 100;
  let collectedDateMatches = [];
  let totalRaw = 0;
  let pagesActuallyFetched = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * 100;
    const url = `${baseUrl}&hits=100&from=${from}`;
    console.log('[edgar]', JSON.stringify({ mode: 'search', page, url, sector, formType }));

    const data = await fetchEdgar(url);
    if (page === 0) {
      totalRaw = data?.hits?.total?.value || 0;
    }
    const pageHits = data?.hits?.hits || [];
    pagesActuallyFetched++;
    if (pageHits.length === 0) break;

    const pageRows = pageHits.map(h => parseFiling(h, null));

    // Apply date filter to this page only
    let pageDateMatches = pageRows;
    if (dateAfter) pageDateMatches = pageDateMatches.filter(r => r.filed_date && r.filed_date >= dateAfter);
    if (dateBefore) pageDateMatches = pageDateMatches.filter(r => r.filed_date && r.filed_date <= dateBefore);

    collectedDateMatches.push(...pageDateMatches);

    // Stop early if we have enough
    if (collectedDateMatches.length >= TARGET_DATE_MATCHES) break;
    // Stop if EDGAR returned fewer than a full page (no more data)
    if (pageHits.length < 100) break;
  }

  let rows = collectedDateMatches;
  console.log('[edgar]', JSON.stringify({
    sector, formType,
    pages_fetched: pagesActuallyFetched,
    total_raw: totalRaw,
    date_matches: collectedDateMatches.length,
  }));

  // Enforce date filters on rows (EDGAR sometimes leaks pre-date results)
  if (dateAfter) rows = rows.filter(r => r.filed_date && r.filed_date >= dateAfter);
  if (dateBefore) rows = rows.filter(r => r.filed_date && r.filed_date <= dateBefore);

  // Drop fund/trust/mortgage noise — these are NOT operating-company raises
  rows = rows.filter(r => !isNonOperatingFiler(r.filer_name));

  // Smart min_amount filter: many Form Ds don't fill in offering_amount (it's
  // optional). Treating "unknown amount" as "below threshold" silently hides
  // real raises. Better behavior: KEEP unknowns separately and surface them
  // with a clear "amount not disclosed" indicator. Show known-amount matches
  // first (largest first), then unknowns.
  let unknownAmountCount = 0;
  if (minAmount) {
    const known = rows.filter(r => r.amount && r.amount >= minAmount);
    const unknown = rows.filter(r => !r.amount);
    unknownAmountCount = unknown.length;
    // Sort known largest-first so the headline number is highest
    known.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    // Sort unknowns newest-first
    unknown.sort((a, b) => (b.filed_date || '').localeCompare(a.filed_date || ''));
    rows = [...known, ...unknown];
  }

  // Apply state filter
  if (state) {
    rows = rows.filter(r => r.state_of_inc === state);
  }

  if (rows.length === 0) {
    // Build a context-aware no_data message
    let message;
    const sectorDisplay = sector && SECTORS[sector] ? SECTORS[sector].display : null;

    if (totalRaw >= 500 && (dateAfter || dateBefore)) {
      // EDGAR FTS limitation: lots of total hits but none in date range
      // because EDGAR sorts by relevance, not date
      message = `EDGAR has ${totalRaw.toLocaleString()} filings matching ${sectorDisplay || 'these keywords'}, but none of the top ${pagesActuallyFetched * 100} relevance-ranked results fell in your date range. EDGAR's full-text search ranks by relevance across all time — it doesn't reliably surface recent sector activity. To find current ${sectorDisplay || 'sector'} raises, try pulling a specific company's filings (e.g. "${sector === 'climate' ? 'Sunrun filings' : sector === 'cybersecurity' ? 'CrowdStrike filings' : 'a known company name'}") instead.`;
    } else if (state && totalRaw > 50) {
      // State filter killed everything — likely state-of-incorporation issue
      message = `${totalRaw.toLocaleString()} filings matched the keyword search, but none had ${state} as their state of INCORPORATION. Most US tech and finance companies incorporate in Delaware regardless of where they operate, so state filters often miss the real answer. Want me to search without the state filter?`;
    } else if (totalRaw === 0) {
      // Genuinely nothing in EDGAR
      message = `EDGAR has no filings matching ${sectorDisplay || 'these keywords'}${dateAfter ? ` since ${dateAfter}` : ''}${formType ? ` on Form ${formType}` : ''}. Try a different sector keyword or a wider date range.`;
    } else {
      // Filtered out by funds/trusts
      message = `${totalRaw.toLocaleString()} filings matched, but all were funds, trusts, or special-purpose vehicles after filtering — no operating-company raises in this window. Try widening the date range or checking a known company directly.`;
    }

    return {
      card: {
        kind: 'no_data',
        query_summary: buildQuerySummary({ sector, formType, minAmount, state, dateAfter, dateBefore }),
        message,
      },
    };
  }

  // Sort newest first ONLY if we didn't already sort by amount
  if (!minAmount) {
    rows.sort((a, b) => (b.filed_date || '').localeCompare(a.filed_date || ''));
  }

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
      unknown_amount_count: unknownAmountCount,
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

  // Build EDGAR document link.
  // The full-text search id is formatted "ACCESSION:DOCUMENT" (e.g.
  // "0001234567-26-000001:primary_doc.html"). When we have both, we can build
  // a direct link to the actual filing document.
  //
  // BUT: many Form Ds have primary_doc.xml as the document, which renders as
  // raw XBRL in the browser. The filing's INDEX page (just the directory
  // listing) is much more useful — it shows the human-readable filing list
  // including primary_doc.html. So we skip XML docs and link to the index.
  const idParts = id.split(':');
  const accession = src.adsh || idParts[0] || '';
  const docFile = idParts[1] || null;
  const cik = ciks[0];
  const accNoDashes = String(accession).replace(/-/g, '');

  let docLink;
  if (cik && accNoDashes && docFile && !/\.xml$/i.test(docFile)) {
    // Direct link to the readable filing document (HTML/PDF)
    docLink = `${EDGAR_BASE}/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDashes}/${docFile}`;
  } else if (cik && accNoDashes) {
    // Filing index page — EDGAR auto-renders Form D XML as readable HTML here
    // and shows the document list for any other filing type
    docLink = `${EDGAR_BASE}/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDashes}/`;
  } else if (cik) {
    docLink = `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
  } else {
    docLink = `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany`;
  }

  return {
    filer_name: cleanFilerName(displayName),
    cik: cik || null,
    form_type: formType,
    filed_date: filedDate,
    amount,
    state_of_inc: stateOfInc,
    accession,
    doc_link: docLink,
  };
}

function cleanFilerName(raw) {
  // EDGAR display names include suffixes like:
  //   "Foo Corp  (CIK 0001234567) (Filer)"
  //   "Foo Corp (CIK 0001234567)"
  //   "Foo Corp (FOO)  (CIK 0001234567)"
  //   "Foo Corp (0001234567) (Filer)" (rare older format)
  // Strip ALL trailing parenthesized groups so the L.P./Fund/Trust regex
  // patterns can match on the actual entity name's tail.
  let cleaned = String(raw);
  // Drop "(Filer)" suffix
  cleaned = cleaned.replace(/\s*\(Filer\)\s*$/i, '');
  // Drop "(CIK 0001234567)" or "(0001234567)" suffix(es), possibly multiple
  while (/\s*\(\s*(?:CIK\s+)?\d+\s*\)\s*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\s*\(\s*(?:CIK\s+)?\d+\s*\)\s*$/, '');
  }
  // Drop trailing ticker symbol "(MSFT)" — short uppercase only
  cleaned = cleaned.replace(/\s*\([A-Z]{1,5}(?:\s+[A-Z]{1,5})*\)\s*$/, '');
  return cleaned.trim();
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

      case 'audit':
        await handleAudit(responseStream, body);
        logReq('ok');
        return;

      case 'brief_candidates':
        await handleBriefCandidates(responseStream, body);
        logReq('ok');
        return;

      case 'brief_draft':
        await handleBriefDraft(responseStream, body);
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
