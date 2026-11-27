// Number and text formatting shared by the app's modules.
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const fmtK = (n) => { const a = Math.abs(n); const s = n < 0 ? '−' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e4 ? `${s}${Math.round(a / 1e3)}k` : `${s}${fmt(a)}`; };
export const pct = (v) => (v > 0 && v < 0.01 ? '<1' : v > 0.99 && v < 1 ? '>99' : String(Math.round(v * 100)));
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Always signed: "+12k" / "−8,500"; `f` picks the number format
export const signed = (n, f = fmtK) => `${n >= 0 ? '+' : '−'}${f(Math.abs(n))}`;
// A ratio as a signed whole percent: 0.24 -> "+24%"
export const signedPct = (r) => `${r >= 0 ? '+' : '−'}${Math.abs(Math.round(r * 100))}%`;
