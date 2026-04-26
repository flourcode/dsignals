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
//   <script src="config.js"></script>
// (Plain script, not type=module, so it runs synchronously before app.js.)
// ============================================================================

window.MO_CONFIG = {

  // ---- Identity ----
  productName: 'mo-signals',
  displayName: 'Mo',
  pageTitle: 'Mo · SEC Filings',
  tagline: "She lives inside SEC EDGAR.",
  greeting: "What private company are you watching?",
  inputPlaceholder: "Ask Mo about a company or sector...",

  // ---- Example queries shown as tappable chips on the greeting screen ----
  exampleQueries: [
    "Anthropic filing history",
    "AI raises last month",
    "Stripe in 2024",
    "What's a Form D?",
  ],

  // ---- The human behind Mo ----
  meetWith: {
    name: 'Mark',
    url: 'https://calendly.com/markflournoy/chat-with-mark',
    blurb: 'Feedback or questions about Mo?',
  },

  // ---- API Endpoint ----
  // Same Lambda Function URL as Hello World — we're just swapping brains
  apiEndpoint: 'https://4yjfpnei2qnulzfcyrunh564qy0mxptv.lambda-url.us-east-1.on.aws/',

  // ---- Theme ----
  theme: {
    primaryColor: '#46446E',
    fontFamily: "'Atkinson Hyperlegible Next', system-ui, sans-serif",
    backgroundColor: '#FDFCFF',
    cardBackground: '#FFFFFF',
  },

  // ---- Data Source attribution ----
  dataSource: {
    name: 'SEC EDGAR',
    url: 'https://www.sec.gov/edgar',
  },

  // ---- Pills ----
  pillsEnabled: true,
};
