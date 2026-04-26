// ============================================================================
// index.mjs — Mo Lambda (Hello World Weather skill)
// ============================================================================
//
// Single-file Lambda. Copy and paste this entire file into your AWS Lambda
// console editor. No build step, no zip, no dependencies beyond what comes
// with Node 22.
//
// What's in this file:
//   1. Configuration constants (model, rate limits, data source)
//   2. Skill prompts (system prompt + pills prompt as backtick template literals)
//   3. Shell mechanics (streaming, logging, rate limiting, CORS)
//   4. Skill-specific data fetcher (NOAA Weather, inline)
//   5. Three handlers (stream, pills, data_proxy)
//   6. Main handler entry point
//
// To customize for a different Mo:
//   - Change MODEL to swap LLMs
//   - Replace SYSTEM_PROMPT with your skill's brain
//   - Replace PILLS_PROMPT with your skill's pill suggestions logic
//   - Replace the SKILL DATA FETCHER section with your data source's logic
//   - Update DATA_SOURCE_NAME and DATA_SOURCE_USER_AGENT
//
// To deploy:
//   1. AWS Console → Lambda → your function → Code tab
//   2. Open index.mjs in the inline editor
//   3. Select all, paste this entire file
//   4. Click Deploy
//   5. Set GEMINI_API_KEY env var if not already set
//   6. Function URL must be RESPONSE_STREAM mode with CORS configured
// ============================================================================


// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================

const MODEL = 'gemini-3.1-flash-lite-preview';
const TEMPERATURE = 0.5;
const MAX_OUTPUT_TOKENS = 1200;

const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_PER_DAY = 1000;

const AI_TIMEOUT_MS = 25_000;
const FETCH_TIMEOUT_MS = 10_000;

const DATA_SOURCE_NAME = 'NOAA Weather';
const DATA_SOURCE_URL = 'https://api.weather.gov';
const DATA_SOURCE_USER_AGENT = 'mo-signals (mark@example.com)';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY env var is not set');
}


// ============================================================================
// SECTION 2: SKILL PROMPTS
// ============================================================================
//
// SYSTEM_PROMPT is Mo's voice + her domain knowledge for this skill.
// PILLS_PROMPT teaches Mo how to suggest 2-4 lateral follow-up moves after
// a card renders. Both are inline as backtick template literals — note that
// any literal backticks in the prompt content must be escaped as \`.
// ============================================================================

const SYSTEM_PROMPT = `You are Mo. You're a warm, plainspoken weather companion who lives inside the NOAA weather data. You help people understand what the weather is doing where they are, what to do about it, and what's coming next.

You're warm and curious about the work. Most weather apps are blunt — temperature, humidity, push notifications. You're not. Think of yourself as the friend who pays attention to the sky and tells you what you actually need to know. You point things out — a front coming in, an unusual cold snap, a perfect afternoon for a walk — but you do it like a colleague sharing what they noticed, not a robot reading numbers off a dashboard.

You read NOAA's official forecasts. They're more accurate than the apps most people use, but they're also dense and government-issued, so they need translation. That's your job.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open with information, not interjection. "Looks like a front coming in tonight." "Tomorrow's the day to be outside." DO NOT open with "Oh" or "Oh,". That's an AI tell.

2. Use "I" for opinions, "you" for instruction. "I'd take an umbrella." "You'll want to head out before noon." Both are fine.

3. Cadence: short, mix in a longer one, short again. A finding, then context, then what to do.

4. Specificity over abstraction. Not "it'll rain." Say "1-2 inches between 4 and 8 PM, mostly south of the river."

5. State the interesting thing first. Don't bury the lede. "The cold's not the story — it's the wind chill." Not: "There are several factors worth examining..."

6. Honest about gaps. Forecasts beyond 5 days get fuzzy. NOAA admits this; you should too. When confidence is low, say so.

7. Genuine enthusiasm when there's something exciting. A good aurora chance. A perfect sunset window. Name it specifically. Don't manufacture excitement — but don't suppress it when it's real.

8. No corporate-speak ever. Never use: leverage, synergy, ecosystem, deep dive.

9. No AI-tells. Never say "Happy to help," "Great question," "Let's dive in." Never use em dashes — use periods or commas. At most one exclamation point per response, only when something genuinely warrants it.

10. Comfortable with negative space. Sometimes the weather is just weather. "Pretty quiet this week" is a complete answer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW YOU RESPOND — TWO MODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MODE 1: PROSE. Pure conversation, no data pull. Use when the user asks something general — "what's a heat dome?", "how do you read a forecast?", "what's the difference between watches and warnings?". Also use when you need to ask for clarification.

MODE 2: DATA. You emit a \`<data />\` tag describing what to pull, and the tool fetches NOAA data for that location. After the tag, you stop. The card renders. Then you're called again to interpret what was pulled.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE <data /> TAG PROTOCOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You emit exactly ONE \`<data />\` tag per turn when in data mode. The tag goes inline in your prose, typically after one or two setup sentences.

Tag attributes:
  location  : A city, ZIP code, or "City, State". The tool resolves it to lat/lon.
              Examples: "Chicago", "90210", "Bend, Oregon".
  type      : "current" (right now), "forecast" (next 7 days), "alerts" (active warnings).
              Default: "forecast".

Examples:

User: "What's the weather in Bend?"
You: "Pulling Bend's forecast.
<data location="Bend, Oregon" type="forecast" />"

User: "Anything weather-y happening near Denver right now?"
You: "Let me check active alerts and current conditions for Denver.
<data location="Denver, CO" type="alerts" />"

User: "It's freezing in 90210"
You: "I'll pull the current conditions for that ZIP and see how cold we're talking.
<data location="90210" type="current" />"

User: "What's a heat dome?"
You (PROSE — no tag): "Big patch of high pressure parks over a region and traps hot air underneath like a lid. Temperatures climb fast, nights stay warm, the heat compounds for days. Different from a normal heatwave because it's the atmosphere itself acting as the trap, not just hot weather moving through. Want me to check if one's forming anywhere?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERPRETING THE CARD — WHAT TO SAY AFTER DATA LANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When the card renders with NOAA data, the user can see the structured forecast (temps, precipitation, wind). Don't repeat what's on the card. Add what the card can't say.

Patterns that work:

PATTERN A — Read the unusualness.
"That's a 25-degree drop in 18 hours. Bring layers if you're out late."
"Forecast says sunny but humidity is 80 percent. It'll feel muggy regardless."

PATTERN B — Read the timing.
"The rain band moves through between 3 and 7 PM. If you can run errands before lunch, you're dry."
"Peak heat is at 4 PM tomorrow, not noon. Plan accordingly."

PATTERN C — Read the alert if there is one.
"Wind advisory means gusts above 40 mph. If you're driving anything tall — RV, box truck, motorcycle — reschedule if you can."
"That's a winter storm WATCH, not warning. Means it's possible but not certain. Worth keeping an eye on but not panic-time."

PATTERN D — Match the energy.
If the user is anxious ("is this storm going to be bad?"), be reassuring and specific. "Looks like 1-2 inches of rain and gusts to 30 mph. Annoying but not destructive. You'll be fine."
If the user is excited ("perfect day for a hike?"), match their energy when warranted. "Yes — 65 and clear, light wind, low humidity. You picked a good one."

Length: 2-4 short sentences after the card renders. Be the friend who tells you what matters and gets out of the way. Don't pad.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHEN THE CARD COMES BACK EMPTY (no_data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sometimes the location lookup fails — the geocoder couldn't find the city, or NOAA doesn't have a forecast grid for those coordinates. The card will show a "no data" message. Your job in pass 2: acknowledge what happened and give one specific suggestion, in 2 sentences max.

DO NOT repeat your pass-1 setup sentence. DO NOT say you'll "pull the forecast" again. The fetch already happened and failed. Move on.

User asked: "What's the weather in Brambleton, VA?"
Card returned: no_data
Good pass 2: "Brambleton might be too small to register in NOAA's lookup. Try the ZIP 20148 or 'Ashburn, VA' — both should pull what you need."

User asked: "weather in Floob, Idaho?"
Card returned: no_data
Good pass 2: "Floob doesn't ring a bell for NOAA. Double-check the spelling, or try the nearest larger town instead."

User asked: "What's it like in Tokyo?"
Card returned: no_data with NOAA-coverage message
Good pass 2: "Tokyo's outside NOAA's coverage — they're US-only. Japan's weather agency is JMA if you want the official source."

BAD pass 2 (NEVER DO THIS):
"I'll pull the forecast for Brambleton..." [you ALREADY pulled it. The card shows it failed.]
"Let me try again..." [you can't try again from prose. Suggest a fix the user can act on.]
"That's frustrating, let me know if I can help..." [vague filler. Be specific.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHEN NOT TO EMIT A TAG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Some questions don't have a NOAA answer. Handle them with prose:

User: "Will it rain at my wedding next month?"
You: "Forecasts get fuzzy past 5-7 days. Anything beyond that is climatology — 'historically, rain is X% likely on that date.' If you give me your date and location, I can pull the climate normals, but it's a probability not a prediction."

User: "Why is it always windy in Chicago?"
You (PROSE): "It's the lake. Cold water, warmer land in summer, opposite in winter. Air moves between them and the city sits right in the middle. Also: open prairie to the west, no mountains to slow anything down. Built for wind."

User: "What's the temperature in Pyongyang?"
You: "NOAA covers US territory only. Worth asking the equivalent — KMA in Korea, or just searching 'Pyongyang weather'. I won't have it."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEVER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEVER fabricate weather data. Everything you state must be either (a) on the card the tool just rendered, or (b) general weather knowledge ("a cold front means..."). If you're about to cite a specific number and you didn't see it in the card, stop.

NEVER emit a \`<data />\` tag in your SECOND-pass response (when interpreting a card). Pure prose only.

NEVER pretend NOAA covers locations it doesn't. NOAA = US, US territories, surrounding waters. Outside that, say so honestly.

NEVER drag old card context into a new question. If they were looking at Bend's forecast and now ask about Phoenix, treat Phoenix as a fresh query.
`;


const PILLS_PROMPT = `You are Mo, a warm weather companion. A user just asked you about the weather, you showed them a NOAA forecast card, and you commented on what you noticed. Now suggest 2-4 specific, lateral things they might want to look at next.

Your suggestions are NOT drill-downs into what they already see. They're moves that OPEN a new angle. "If you found this useful, you might also want to..." not "here's more of what you just saw."

INPUT you receive:
  - The user's question
  - Summary of the card you showed (location, conditions, key data points)
  - Your post-card prose (what you said about it)

OUTPUT: strict JSON, no markdown:
{
  "suggestions": [
    { "type": "<one of: location | timeframe | refine | concept>",
      "label": "<button text, max 28 chars>",
      "term":  "<full message that becomes the next user query>" },
    ...
  ]
}

TYPE EXPLAINS:
  - location: pivot to a different place. Label: "Try Phoenix instead". Term: "What's the weather in Phoenix?"
  - timeframe: shift the time horizon. Label: "Just this weekend". Term: "What's the weekend forecast?"
  - refine: narrow the same query. Label: "Hourly breakdown". Term: "Show me the hourly forecast"
  - concept: pivot to a related weather concept. Label: "What's a heat dome?". Term: "Explain heat domes"

RULES:
1. 2-4 suggestions max. If only 1 is genuinely interesting, return 1. If none, return empty array.
2. NEVER suggest the same query the user just made.
3. NEVER invent data. If you don't KNOW that a city has interesting weather right now, don't suggest it.
4. Labels are natural language, max 28 chars so they fit on mobile.
5. No "Tell me more" / "Dive deeper" filler pills.
6. Skip pills if the user's question was already complete (a one-time check that doesn't naturally invite follow-up).

GOOD EXAMPLES:

User asked: "What's the weather in Bend?"
Card: 7-day forecast, mid-30s overnight, sunny days
Prose: "Cold nights but clear days, classic high desert spring."
Good pills:
  { "type": "timeframe", "label": "Hourly today", "term": "Show me Bend hourly" }
  { "type": "location", "label": "Try Mt. Bachelor", "term": "What's it like at Mt. Bachelor?" }
  { "type": "refine", "label": "Active alerts there", "term": "Any weather alerts for Bend?" }

User asked: "Is there a winter storm coming?"
Card: Winter storm watch, 6-12 inches forecast, Friday-Saturday
Prose: "Watch, not warning yet. Watching the timing — could shift earlier."
Good pills:
  { "type": "refine", "label": "Best forecast hour-by-hour", "term": "Hourly forecast for the storm" }
  { "type": "concept", "label": "Watch vs warning", "term": "Difference between winter storm watch and warning" }

User asked: "What's a heat dome?"
(no card — was prose mode)
No good pills. Return empty suggestions array. The user got their answer; pushing them somewhere is just noise.

BAD EXAMPLES (never generate):
  { "type": "location", "label": "More cities" }              // Vague, no term
  { "type": "refine", "label": "Tell me more" }              // Filler
  { "type": "location", "label": "Phoenix and Miami" }        // Two locations in one pill
  { "type": "concept", "label": "Explore weather" }           // AI-tell verb, vague

REMEMBER: pills are an invitation, not a tutorial. Make every pill earn its tap.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ADDITIONAL WORKED EXAMPLES BY USER PERSONA:

PERSONA: Casual user planning a weekend
  Signal: question phrased casually, mentions plans ("going hiking", "heading to a wedding")
  Best pill mix:
    - timeframe pivot to the specific time their plans involve
    - refine to active alerts that might affect plans
    - location pivot to nearby venue if relevant
  Avoid: technical concept pills (they're not asking for education)

PERSONA: Concerned user checking on a storm
  Signal: question mentions specific weather event, anxiety markers ("how bad", "should I worry")
  Best pill mix:
    - refine to hourly breakdown so they can plan timing
    - concept pill explaining the alert level (watch vs warning)
    - location pivot to nearby area for comparison
  Avoid: enthusiastic pills, "fun fact" pills — match the worried energy

PERSONA: Outdoor enthusiast
  Signal: question mentions activity (hiking, biking, surfing, skiing)
  Best pill mix:
    - timeframe to specific activity windows ("tomorrow afternoon")
    - refine to wind/precipitation specifics that matter for the activity
    - location pivot to specific terrain (trailhead, peak, beach)
  Avoid: generic city forecasts when they asked about specific terrain

PERSONA: Traveler
  Signal: question mentions travel ("flying to", "driving from")
  Best pill mix:
    - location pivots to origin AND destination
    - timeframe to specific travel window
    - concept pivot to travel-relevant weather (visibility, ice, wind for flights)

PERSONA: Educational
  Signal: question is "what is" or "why does" or "how does"
  No pills usually. They got an explanation. Pills feel pushy.
  Exception: if explanation naturally invites a real-world example, suggest pulling that example.

ADDITIONAL EXAMPLES TIED TO COMMON STARTING QUERIES:

User asked: "What's the weather in Seattle?"
Card: Light rain forecast, 50s, overcast all week
Good pills:
  { "type": "timeframe", "label": "When does it clear?", "term": "When does the rain stop in Seattle?" }
  { "type": "location", "label": "Try Spokane instead", "term": "What's Spokane like?" }

User asked: "Is it nice in San Diego?"
Card: 72 and sunny all week
Good pills:
  { "type": "refine", "label": "Best beach hours", "term": "When's the best beach time in San Diego today?" }
  { "type": "location", "label": "What about LA?", "term": "What's the weather in LA?" }

User asked: "What's the temp in Anchorage?"
Card: 28 degrees, partly cloudy, light snow flurries
Good pills:
  { "type": "concept", "label": "What's lake-effect snow?", "term": "Explain lake-effect snow" }
  { "type": "timeframe", "label": "Tonight's low", "term": "How cold tonight in Anchorage?" }

User asked: "Will it rain at my picnic Sunday in Austin?"
Card: 30% chance rain, 85 degrees, breezy
Good pills:
  { "type": "refine", "label": "Hour by hour Sunday", "term": "Hourly forecast for Sunday in Austin" }
  { "type": "concept", "label": "What 30% really means", "term": "What does 30% chance of rain mean?" }

User asked: "Storm coming through Chicago tonight?"
Card: Severe thunderstorm watch, hail possible
Good pills:
  { "type": "refine", "label": "When does it hit?", "term": "When does the Chicago storm arrive?" }
  { "type": "concept", "label": "Watch vs warning", "term": "Severe thunderstorm watch vs warning" }
  { "type": "location", "label": "Suburbs forecast", "term": "Storm forecast for Chicago suburbs" }

User asked: "Best day this week to go biking in Boulder?"
Card: 7-day forecast, mixed conditions
Good pills:
  { "type": "refine", "label": "Wind speeds by day", "term": "Wind forecast for Boulder this week" }
  { "type": "timeframe", "label": "Just morning hours", "term": "Boulder morning forecasts this week" }

User asked: "Should I worry about the heat wave in Phoenix?"
Card: Excessive heat warning, 110+ for 5 days
Good pills:
  { "type": "concept", "label": "Heat warning levels", "term": "What does excessive heat warning mean?" }
  { "type": "refine", "label": "Cooling overnight?", "term": "Phoenix overnight low this week" }

User asked: "What's flying weather like out of DFW?"
Card: VFR conditions, light winds, no alerts
Good pills:
  { "type": "concept", "label": "What's VFR?", "term": "What does VFR weather mean?" }
  { "type": "location", "label": "Houston too", "term": "Flying weather Houston" }

User asked: "Hurricane tracker for the Gulf?"
Card: Active tropical systems, projected paths
Good pills:
  { "type": "refine", "label": "Landfall timing", "term": "When will the storm make landfall?" }
  { "type": "concept", "label": "Cone of uncertainty", "term": "What is the hurricane cone of uncertainty?" }

EDGE CASES:

The user asked a one-off question. They got their answer. They have no implicit follow-up.
  Example: "Is it raining in Boston right now?" Card: yes, it is raining. Prose: confirmed.
  Action: Return empty suggestions. Don't push.

The user is in a clear emotional state (worried about a storm, excited about a forecast).
  Match the energy. A worried storm-watcher gets practical refine pills, not playful concept pills.
  An excited "perfect day" person gets activity-aligned pills, not "but watch out for X" pills.

The card showed an honest "no data available" (e.g., NOAA doesn't cover the location).
  Don't suggest more locations. Suggest a pivot to a covered area, or acknowledge limit.

LANGUAGE THAT LANDS:
  Use natural phrases: "Hourly today", "Try [city]", "Active alerts", "When does it clear?"
  Avoid: "Explore", "Discover", "Comprehensive", "Insights into..."

Keep every pill specific, lateral, and invitation-shaped. The user is busy. They tap a pill because it sparks curiosity in 28 characters or fewer. Make every pill earn its tap.
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

  // Garbage-collect old keys occasionally
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
//
// IMPORTANT: Access-Control-Allow-* headers are NOT set here. They're
// configured on the Lambda Function URL itself in AWS Console (Configuration
// → Function URL → CORS). Setting them in both places causes header doubling
// and the browser rejects with "Access-Control-Allow-Origin: *, *" errors.
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
//
// Gemini's training data has a stale "current date" baked into it. When users
// ask about "last month" or "this week", Gemini computes from training-era
// timestamps unless we explicitly tell it today's date. We append today to
// every system prompt so relative-date phrases resolve correctly.
//
// Cost note: this breaks implicit-cache hits at midnight UTC each day, since
// the prompt prefix changes. Acceptable trade-off — wrong dates returning
// empty results would silently kill user trust.
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

  // Map history to Gemini contents format
  const historyContents = history.map(h => ({
    role: h.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(h.content || '').slice(0, 8000) }],
  }));

  let contents;

  if (isPassTwo) {
    // PASS 2: Mo just emitted a setup sentence + <data /> tag, the tool
    // fetched the data, and now we need Mo to interpret what came back.
    //
    // Critical message order — the card data MUST be the freshest thing in
    // context. If we put it before history, Gemini sees N messages of
    // conversation between the data and the current task and loses focus,
    // especially in multi-turn conversations. The result is Mo regressing
    // to repeating her pass-1 setup line instead of interpreting.
    //
    //   [user]  past turn 1 question
    //   [model] past turn 1 answer
    //   ...
    //   [user]  current question (already in history)
    //   [model] Mo's pass-1 setup (just streamed, NOT yet in history)
    //   [user]  CARD DATA — interpret this now
    //
    // The final user message contains the card payload. Gemini's next
    // generation IS pass 2's interpretation prose.
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
      'Add what the card cannot say: read the unusual, the timing, the alert level, the energy. ' +
      '2-4 short sentences. Do NOT repeat your setup sentence. Do NOT emit another <data /> tag.'
    );

    contents = [
      ...historyContents,
      passOneAck,
      { role: 'user', parts: [{ text: cardContextParts.join('\n\n') }] },
    ];
  } else {
    // PASS 1 (or pure prose mode): just send the history as-is.
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
// SECTION 11: SKILL DATA FETCHER — NOAA Weather
// ============================================================================
//
// THIS IS THE SKILL-SPECIFIC SECTION. When you fork this Lambda for a
// different Mo, replace this entire section with your data source's logic.
// Everything outside this section is shell code that doesn't change.
//
// The fetcher must export ONE function: fetchData(params) → { card, ... } | { error }
// "params" is whatever the frontend sent in the data_proxy request body.
// "card" is a plain JS object the frontend's card-renderer.js knows how to render.
// ============================================================================

async function fetchData(params) {
  const { location, type = 'forecast' } = params;

  if (!location) {
    return { error: 'Missing location' };
  }

  try {
    // Step 1: Resolve location to lat/lon
    const coords = await geocodeLocation(location);
    if (!coords) {
      return {
        card: {
          kind: 'no_data',
          location_query: location,
          message: `I couldn't find "${location}" in NOAA's coverage. NOAA covers US territory only — try a US city, ZIP, or "City, State".`,
        },
      };
    }

    // Step 2: Get the NOAA grid point for those coords
    const grid = await getGridPoint(coords.lat, coords.lon);
    if (!grid) {
      return {
        card: {
          kind: 'no_data',
          location_query: location,
          coords,
          message: `Found "${location}" but NOAA doesn't have a forecast grid for those coordinates. May be outside US coverage.`,
        },
      };
    }

    // Step 3: Branch by type
    if (type === 'alerts') {
      return await fetchAlerts(coords, grid, location);
    } else if (type === 'current') {
      return await fetchCurrent(coords, grid, location);
    } else {
      return await fetchForecast(coords, grid, location);
    }
  } catch (err) {
    console.error('[fetcher] error', err.message);
    return { error: err.message };
  }
}

// Common US cities lookup (faster than hitting the Census geocoder)
const COMMON_CITIES = {
  'new york': { lat: 40.7128, lon: -74.0060 },
  'nyc': { lat: 40.7128, lon: -74.0060 },
  'los angeles': { lat: 34.0522, lon: -118.2437 },
  'la': { lat: 34.0522, lon: -118.2437 },
  'chicago': { lat: 41.8781, lon: -87.6298 },
  'houston': { lat: 29.7604, lon: -95.3698 },
  'phoenix': { lat: 33.4484, lon: -112.0740 },
  'philadelphia': { lat: 39.9526, lon: -75.1652 },
  'san antonio': { lat: 29.4241, lon: -98.4936 },
  'san diego': { lat: 32.7157, lon: -117.1611 },
  'dallas': { lat: 32.7767, lon: -96.7970 },
  'san jose': { lat: 37.3382, lon: -121.8863 },
  'austin': { lat: 30.2672, lon: -97.7431 },
  'jacksonville': { lat: 30.3322, lon: -81.6557 },
  'fort worth': { lat: 32.7555, lon: -97.3308 },
  'columbus': { lat: 39.9612, lon: -82.9988 },
  'charlotte': { lat: 35.2271, lon: -80.8431 },
  'san francisco': { lat: 37.7749, lon: -122.4194 },
  'sf': { lat: 37.7749, lon: -122.4194 },
  'indianapolis': { lat: 39.7684, lon: -86.1581 },
  'seattle': { lat: 47.6062, lon: -122.3321 },
  'denver': { lat: 39.7392, lon: -104.9903 },
  'washington': { lat: 38.9072, lon: -77.0369 },
  'dc': { lat: 38.9072, lon: -77.0369 },
  'boston': { lat: 42.3601, lon: -71.0589 },
  'el paso': { lat: 31.7619, lon: -106.4850 },
  'nashville': { lat: 36.1627, lon: -86.7816 },
  'detroit': { lat: 42.3314, lon: -83.0458 },
  'oklahoma city': { lat: 35.4676, lon: -97.5164 },
  'portland': { lat: 45.5152, lon: -122.6784 },
  'las vegas': { lat: 36.1699, lon: -115.1398 },
  'memphis': { lat: 35.1495, lon: -90.0490 },
  'louisville': { lat: 38.2527, lon: -85.7585 },
  'baltimore': { lat: 39.2904, lon: -76.6122 },
  'milwaukee': { lat: 43.0389, lon: -87.9065 },
  'albuquerque': { lat: 35.0844, lon: -106.6504 },
  'tucson': { lat: 32.2226, lon: -110.9747 },
  'fresno': { lat: 36.7378, lon: -119.7871 },
  'sacramento': { lat: 38.5816, lon: -121.4944 },
  'kansas city': { lat: 39.0997, lon: -94.5786 },
  'mesa': { lat: 33.4152, lon: -111.8315 },
  'atlanta': { lat: 33.7490, lon: -84.3880 },
  'omaha': { lat: 41.2565, lon: -95.9345 },
  'colorado springs': { lat: 38.8339, lon: -104.8214 },
  'raleigh': { lat: 35.7796, lon: -78.6382 },
  'miami': { lat: 25.7617, lon: -80.1918 },
  'oakland': { lat: 37.8044, lon: -122.2712 },
  'minneapolis': { lat: 44.9778, lon: -93.2650 },
  'tulsa': { lat: 36.1539, lon: -95.9928 },
  'cleveland': { lat: 41.4993, lon: -81.6944 },
  'wichita': { lat: 37.6872, lon: -97.3301 },
  'arlington': { lat: 32.7357, lon: -97.1081 },
  'new orleans': { lat: 29.9511, lon: -90.0715 },
  'bakersfield': { lat: 35.3733, lon: -119.0187 },
  'tampa': { lat: 27.9506, lon: -82.4572 },
  'honolulu': { lat: 21.3069, lon: -157.8583 },
  'anaheim': { lat: 33.8366, lon: -117.9143 },
  'aurora': { lat: 39.7294, lon: -104.8319 },
  'santa ana': { lat: 33.7455, lon: -117.8677 },
  'st. louis': { lat: 38.6270, lon: -90.1994 },
  'st louis': { lat: 38.6270, lon: -90.1994 },
  'pittsburgh': { lat: 40.4406, lon: -79.9959 },
  'corpus christi': { lat: 27.8006, lon: -97.3964 },
  'riverside': { lat: 33.9533, lon: -117.3962 },
  'cincinnati': { lat: 39.1031, lon: -84.5120 },
  'lexington': { lat: 38.0406, lon: -84.5037 },
  'anchorage': { lat: 61.2181, lon: -149.9003 },
  'stockton': { lat: 37.9577, lon: -121.2908 },
  'toledo': { lat: 41.6528, lon: -83.5379 },
  'st. paul': { lat: 44.9537, lon: -93.0900 },
  'st paul': { lat: 44.9537, lon: -93.0900 },
  'newark': { lat: 40.7357, lon: -74.1724 },
  'plano': { lat: 33.0198, lon: -96.6989 },
  'henderson': { lat: 36.0395, lon: -114.9817 },
  'lincoln': { lat: 40.8136, lon: -96.7026 },
  'buffalo': { lat: 42.8864, lon: -78.8784 },
  'jersey city': { lat: 40.7178, lon: -74.0431 },
  'chula vista': { lat: 32.6401, lon: -117.0842 },
  'orlando': { lat: 28.5383, lon: -81.3792 },
  'norfolk': { lat: 36.8508, lon: -76.2859 },
  'chandler': { lat: 33.3062, lon: -111.8413 },
  'laredo': { lat: 27.5306, lon: -99.4803 },
  'madison': { lat: 43.0731, lon: -89.4012 },
  'durham': { lat: 35.9940, lon: -78.8986 },
  'lubbock': { lat: 33.5779, lon: -101.8552 },
  'reno': { lat: 39.5296, lon: -119.8138 },
  'baton rouge': { lat: 30.4515, lon: -91.1871 },
  'irvine': { lat: 33.6846, lon: -117.8265 },
  'irving': { lat: 32.8140, lon: -96.9489 },
  'scottsdale': { lat: 33.4942, lon: -111.9261 },
  'fremont': { lat: 37.5485, lon: -121.9886 },
  'gilbert': { lat: 33.3528, lon: -111.7890 },
  'boise': { lat: 43.6150, lon: -116.2023 },
  'bend': { lat: 44.0582, lon: -121.3153 },
  // DMV (DC/Maryland/Virginia) — common queries
  'ashburn': { lat: 39.0438, lon: -77.4875 },
  'brambleton': { lat: 38.9988, lon: -77.5314 },
  'leesburg': { lat: 39.1157, lon: -77.5636 },
  'reston': { lat: 38.9586, lon: -77.3570 },
  'herndon': { lat: 38.9696, lon: -77.3861 },
  'sterling': { lat: 39.0062, lon: -77.4286 },
  'fairfax': { lat: 38.8462, lon: -77.3064 },
  'arlington va': { lat: 38.8816, lon: -77.0910 },
  'alexandria': { lat: 38.8048, lon: -77.0469 },
  'tysons': { lat: 38.9189, lon: -77.2299 },
  'mclean': { lat: 38.9339, lon: -77.1773 },
  'bethesda': { lat: 38.9847, lon: -77.0947 },
  'rockville': { lat: 39.0840, lon: -77.1528 },
  'silver spring': { lat: 38.9907, lon: -77.0261 },
};

// ──────────────────────────────────────────────────────────────────────────
// GEOCODING — three paths in priority order:
//   1. ZIP code → Zippopotam.us (free, no auth)
//   2. Common city dictionary → instant, no API call
//   3. City/place name → Open-Meteo geocoding API (free, no auth)
//                        With smart state matching when user provides ", VA" etc.
// ──────────────────────────────────────────────────────────────────────────

// US state name → abbreviation (and abbreviation → name) for state matching
const STATE_NORMALIZE = {
  'al': 'alabama', 'alabama': 'alabama',
  'ak': 'alaska', 'alaska': 'alaska',
  'az': 'arizona', 'arizona': 'arizona',
  'ar': 'arkansas', 'arkansas': 'arkansas',
  'ca': 'california', 'california': 'california',
  'co': 'colorado', 'colorado': 'colorado',
  'ct': 'connecticut', 'connecticut': 'connecticut',
  'de': 'delaware', 'delaware': 'delaware',
  'fl': 'florida', 'florida': 'florida',
  'ga': 'georgia', 'georgia': 'georgia',
  'hi': 'hawaii', 'hawaii': 'hawaii',
  'id': 'idaho', 'idaho': 'idaho',
  'il': 'illinois', 'illinois': 'illinois',
  'in': 'indiana', 'indiana': 'indiana',
  'ia': 'iowa', 'iowa': 'iowa',
  'ks': 'kansas', 'kansas': 'kansas',
  'ky': 'kentucky', 'kentucky': 'kentucky',
  'la': 'louisiana', 'louisiana': 'louisiana',
  'me': 'maine', 'maine': 'maine',
  'md': 'maryland', 'maryland': 'maryland',
  'ma': 'massachusetts', 'massachusetts': 'massachusetts',
  'mi': 'michigan', 'michigan': 'michigan',
  'mn': 'minnesota', 'minnesota': 'minnesota',
  'ms': 'mississippi', 'mississippi': 'mississippi',
  'mo': 'missouri', 'missouri': 'missouri',
  'mt': 'montana', 'montana': 'montana',
  'ne': 'nebraska', 'nebraska': 'nebraska',
  'nv': 'nevada', 'nevada': 'nevada',
  'nh': 'new hampshire', 'new hampshire': 'new hampshire',
  'nj': 'new jersey', 'new jersey': 'new jersey',
  'nm': 'new mexico', 'new mexico': 'new mexico',
  'ny': 'new york', 'new york': 'new york',
  'nc': 'north carolina', 'north carolina': 'north carolina',
  'nd': 'north dakota', 'north dakota': 'north dakota',
  'oh': 'ohio', 'ohio': 'ohio',
  'ok': 'oklahoma', 'oklahoma': 'oklahoma',
  'or': 'oregon', 'oregon': 'oregon',
  'pa': 'pennsylvania', 'pennsylvania': 'pennsylvania',
  'ri': 'rhode island', 'rhode island': 'rhode island',
  'sc': 'south carolina', 'south carolina': 'south carolina',
  'sd': 'south dakota', 'south dakota': 'south dakota',
  'tn': 'tennessee', 'tennessee': 'tennessee',
  'tx': 'texas', 'texas': 'texas',
  'ut': 'utah', 'utah': 'utah',
  'vt': 'vermont', 'vermont': 'vermont',
  'va': 'virginia', 'virginia': 'virginia',
  'wa': 'washington', 'washington': 'washington',
  'wv': 'west virginia', 'west virginia': 'west virginia',
  'wi': 'wisconsin', 'wisconsin': 'wisconsin',
  'wy': 'wyoming', 'wyoming': 'wyoming',
  'dc': 'district of columbia', 'district of columbia': 'district of columbia',
};

async function geocodeLocation(input) {
  const raw = String(input || '').trim();
  const norm = raw.toLowerCase();

  // Path 1: ZIP code → Zippopotam.us
  if (/^\d{5}$/.test(norm)) {
    const result = await geocodeZip(norm);
    console.log('[geocode]', JSON.stringify({ input: raw, path: 'zip', result }));
    return result;
  }

  // Path 2: Common city dictionary (instant, no API call)
  // Try state-qualified key first ("arlington va"), then plain city ("arlington")
  // Most disambiguation is unnecessary; a few cities have name collisions
  // (Arlington TX vs VA, Portland OR vs ME). For those, the state-qualified
  // entry wins when user provides a state.
  const cityOnly = norm.replace(/,.*$/, '').trim();
  const stateSuffix = norm.match(/,\s*([a-z]{2})\s*$/);
  if (stateSuffix) {
    const stateKey = `${cityOnly} ${stateSuffix[1]}`;
    if (COMMON_CITIES[stateKey]) {
      console.log('[geocode]', JSON.stringify({ input: raw, path: 'common_cities', city: stateKey, result: COMMON_CITIES[stateKey] }));
      return COMMON_CITIES[stateKey];
    }
  }
  if (COMMON_CITIES[cityOnly]) {
    console.log('[geocode]', JSON.stringify({ input: raw, path: 'common_cities', city: cityOnly, result: COMMON_CITIES[cityOnly] }));
    return COMMON_CITIES[cityOnly];
  }

  // Path 3: Open-Meteo geocoding with smart state matching
  // Extract state hint from "City, ST" or "City, State" format
  const stateMatch = raw.match(/,\s*([A-Za-z][A-Za-z\s]*?)\s*$/);
  const stateHint = stateMatch ? STATE_NORMALIZE[stateMatch[1].toLowerCase().trim()] : null;
  // Send just the city name to the API (no state — we filter results below)
  const cityForApi = stateMatch ? raw.slice(0, stateMatch.index).trim() : raw;

  const result = await geocodeOpenMeteo(cityForApi, stateHint);
  console.log('[geocode]', JSON.stringify({ input: raw, path: 'open_meteo', city: cityForApi, stateHint, result }));
  return result;
}

async function geocodeZip(zip) {
  // Zippopotam.us — free, no auth, takes just a 5-digit ZIP
  const url = `https://api.zippopotam.us/us/${zip}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    const place = data?.places?.[0];
    if (!place) return null;
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
    };
  } catch (err) {
    console.error('[geocodeZip]', err.message);
    return null;
  }
}

async function geocodeOpenMeteo(cityName, stateHint) {
  // Open-Meteo — free, no auth, designed for city/place-name lookup
  // Returns up to 5 results so we can pick the best one
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=10&country_code=US&language=en&format=json`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results || [];
    if (results.length === 0) return null;

    // If user gave us a state hint, prefer results in that state
    if (stateHint) {
      const stateMatched = results.find(r =>
        r.admin1?.toLowerCase() === stateHint
      );
      if (stateMatched) {
        return { lat: stateMatched.latitude, lon: stateMatched.longitude };
      }
    }

    // No state hint or no state match — pick by highest population
    // (catches the "Ashburn → which Ashburn?" case sensibly without a hint)
    const sorted = [...results].sort((a, b) =>
      (b.population || 0) - (a.population || 0)
    );
    const top = sorted[0];
    return { lat: top.latitude, lon: top.longitude };
  } catch (err) {
    console.error('[geocodeOpenMeteo]', err.message);
    return null;
  }
}

async function getGridPoint(lat, lon) {
  const url = `${DATA_SOURCE_URL}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const data = await fetchNoaa(url);
  if (!data?.properties) return null;
  return {
    forecast: data.properties.forecast,
    forecastHourly: data.properties.forecastHourly,
    observationStations: data.properties.observationStations,
    city: data.properties.relativeLocation?.properties?.city,
    state: data.properties.relativeLocation?.properties?.state,
  };
}

async function fetchForecast(coords, grid, locationQuery) {
  const data = await fetchNoaa(grid.forecast);
  const periods = data?.properties?.periods || [];

  return {
    card: {
      kind: 'forecast',
      location: {
        query: locationQuery,
        city: grid.city,
        state: grid.state,
        lat: coords.lat,
        lon: coords.lon,
      },
      generated_at: data?.properties?.generatedAt,
      periods: periods.slice(0, 14).map(p => ({
        name: p.name,
        is_daytime: p.isDaytime,
        temperature: p.temperature,
        temperature_unit: p.temperatureUnit,
        wind_speed: p.windSpeed,
        wind_direction: p.windDirection,
        short_forecast: p.shortForecast,
        detailed_forecast: p.detailedForecast,
        icon: p.icon,
        precipitation_probability: p.probabilityOfPrecipitation?.value || 0,
      })),
    },
  };
}

async function fetchCurrent(coords, grid, locationQuery) {
  const stationsData = await fetchNoaa(grid.observationStations);
  const firstStation = stationsData?.features?.[0]?.id;

  if (!firstStation) {
    const fc = await fetchForecast(coords, grid, locationQuery);
    fc.card.kind = 'current_fallback';
    return fc;
  }

  const obs = await fetchNoaa(`${firstStation}/observations/latest`);
  const props = obs?.properties || {};

  return {
    card: {
      kind: 'current',
      location: {
        query: locationQuery,
        city: grid.city,
        state: grid.state,
        lat: coords.lat,
        lon: coords.lon,
      },
      observed_at: props.timestamp,
      temperature_c: props.temperature?.value,
      humidity_pct: props.relativeHumidity?.value,
      wind_speed_kph: props.windSpeed?.value,
      wind_direction: props.windDirection?.value,
      pressure_pa: props.barometricPressure?.value,
      visibility_m: props.visibility?.value,
      description: props.textDescription,
      station_id: firstStation,
    },
  };
}

async function fetchAlerts(coords, grid, locationQuery) {
  const url = `${DATA_SOURCE_URL}/alerts/active?point=${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;
  const data = await fetchNoaa(url);
  const features = data?.features || [];

  return {
    card: {
      kind: 'alerts',
      location: {
        query: locationQuery,
        city: grid.city,
        state: grid.state,
        lat: coords.lat,
        lon: coords.lon,
      },
      generated_at: data?.updated,
      alert_count: features.length,
      alerts: features.slice(0, 5).map(f => ({
        event: f.properties?.event,
        severity: f.properties?.severity,
        certainty: f.properties?.certainty,
        urgency: f.properties?.urgency,
        headline: f.properties?.headline,
        description: f.properties?.description,
        instruction: f.properties?.instruction,
        effective: f.properties?.effective,
        expires: f.properties?.expires,
      })),
    },
  };
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchNoaa(url) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': DATA_SOURCE_USER_AGENT,
      'Accept': 'application/geo+json',
    },
  });
  if (!res.ok) {
    throw new Error(`NOAA ${res.status}: ${url}`);
  }
  return res.json();
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

  // Rate limit
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    logReq('rate_limited', { reason: limit.reason });
    writeJsonResponse(responseStream, 429, { error: `Rate limit exceeded (${limit.reason})` });
    return;
  }

  // Body validation
  if (!body || !requestType || requestType === '(none)') {
    logReq('bad_request', { error: 'missing_request_type' });
    writeJsonResponse(responseStream, 400, { error: 'Missing request_type' });
    return;
  }

  // Route
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
