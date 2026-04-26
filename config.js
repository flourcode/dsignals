// ============================================================================
// public/config.js — Frontend Configuration
// ============================================================================
//
// This file holds frontend-only settings: the API endpoint, branding strings,
// theme colors, and the data source name shown in card footers.
//
// The Lambda has its own config (constants at the top of lambda/index.mjs)
// for server-side things like the LLM model, rate limits, and the data source
// API URL. They're separate because:
//   - The Lambda lives in AWS, the frontend lives on AWS Amplify
//   - There's no build step to copy values between them
//   - Keeping them separate means each can be deployed independently
//
// When you change a field that affects BOTH (data source name, branding),
// update both files. Most changes only need one or the other.
//
// This file is loaded by index.html via:
//   <script type="module">import config from './config.js'; window.MO_CONFIG = config;</script>
// ============================================================================

export default {

  // ---- Identity ----
  productName: 'mo-signals',
  displayName: 'Mo',
  tagline: "She's plugged into NOAA Weather (for now).",
  greeting: "What's the weather where you are?",

  // ---- The human behind Mo ----
  meetWith: {
    name: 'Mark',
    url: 'https://calendly.com/markflournoy/chat-with-mark',
    blurb: 'Feedback or questions about Mo?',
  },

  // ---- API Endpoint ----
  // Set this AFTER you create your Lambda Function URL.
  apiEndpoint: 'https://4yjfpnei2qnulzfcyrunh564qy0mxptv.lambda-url.us-east-1.on.aws/',

  // ---- Theme ----
  theme: {
    primaryColor: '#46446E',
    fontFamily: "'Atkinson Hyperlegible Next', system-ui, sans-serif",
    backgroundColor: '#FDFCFF',
    cardBackground: '#FFFFFF',
  },

  // ---- Data Source attribution ----
  // Shown in card footers. Should match lambda/config.js.dataSource.
  dataSource: {
    name: 'NOAA Weather',
    url: 'https://api.weather.gov',
  },

  // ---- Pills ----
  pillsEnabled: true,
};
