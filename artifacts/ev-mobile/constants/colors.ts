/**
 * Semantic design tokens for the mobile app.
 *
 * These mirror the EV Tracker web artifact's "terminal" theme
 * (artifacts/ev-tracker/src/index.css) so both apps share one visual
 * identity. The web app is dark-by-default, so both the `light` and `dark`
 * palettes use the same dark terminal values — the app always renders dark
 * regardless of the device appearance setting.
 */

const terminal = {
  // Legacy aliases (kept for backward compatibility)
  text: '#fafafa',
  tint: '#1a8cff',

  // Core surfaces
  background: '#09090b', // 240 10% 4%
  foreground: '#fafafa', // 0 0% 98%

  // Cards / elevated surfaces
  card: '#0e0e11', // 240 10% 6%
  cardForeground: '#fafafa',
  cardBorder: '#1c1c22', // 240 10% 12%

  // Primary action color (electric blue)
  primary: '#1a8cff', // 210 100% 55%
  primaryForeground: '#00122e', // 240 100% 10%

  // Secondary / less-emphasis interactive surfaces
  secondary: '#22222a', // 240 10% 15%
  secondaryForeground: '#fafafa',

  // Muted / subdued elements (dividers, timestamps, placeholders)
  muted: '#1c1c22', // 240 10% 12%
  mutedForeground: '#a1a1aa', // 240 5% 65%

  // Accent highlights
  accent: '#22222a',
  accentForeground: '#fafafa',

  // Destructive actions / negative values
  destructive: '#ef4444', // 0 84% 60%
  destructiveForeground: '#fafafa',

  // Positive / winning values (vivid green)
  positive: '#00cc66', // 150 100% 40%
  positiveForeground: '#00220f',

  // Warning / abstain (amber) — the web uses amber-500 for insufficient data
  warning: '#f59e0b',

  // Borders and input outlines
  border: '#22222a', // 240 10% 15%
  input: '#22222a',
  ring: '#3399ff', // 210 100% 60%
};

const colors = {
  light: terminal,
  dark: terminal,

  // Border radius (in px). Sync from the web --radius: 0.25rem (4px).
  radius: 4,
};

export default colors;
