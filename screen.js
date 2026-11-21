// Merchant screen reading (ROUGH DRAFT - tuned on the official infographic crops; to be tuned on real frames).
//
// Uses the exe's endpoints:
//   /api/state                    window rect, cursor (client px), left mouse button, focus
//   /api/ocr?x=&y=&w=&h=&scale=   Windows OCR of a client-pixel region -> lines + word boxes
//   /api/frame?x=&y=&w=&h=&png    picture of a region (fractions of the client area)
//
// What it reads:
//   hover  - when the cursor rests on a crate, the tooltip: crate name + price -> crate type and pool price
//   size   - the crate's outline under the cursor (grid lines) -> 1x1 / 1x2 / 2x2 / 2x3
//   drag   - the left button goes down on the crate just read (or on a fresh outline): the crate you are
//            dragging, so the sound heard next belongs to it. In the game the crate's slot goes dark and a red
//            footprint with an "R Rotate" hint follows the cursor; the size comes from the slot outline.
//   feed   - "... spent 250,000 Koen on a mystery cargo and obtained [Item]" (shows other players' buys too,
//            so the app only *offers* to log it when the price matches the crate you were just on)
import { GAME_DATA } from './data.js';

// built on first use, so they follow automatic data updates (GAME_DATA is refreshed before the app starts)
let _types = null, _itemKeys = null, _dataSig = null;
function lists() {
  const sig = GAME_DATA.fetched + ':' + GAME_DATA.items.length;
  if (sig !== _dataSig) {
    _dataSig = sig;
    _types = Object.entries(GAME_DATA.types).map(([id, name]) => ({ id: Number(id), name, key: name.toLowerCase().replace(/[^a-z]/g, '') }));
    _itemKeys = GAME_DATA.items.map(i => ({ id: i.id, key: i.name.toLowerCase().replace(/[^a-z0-9]/g, '') }));
  }
  return { TYPE_NAMES: _types, ITEM_KEYS: _itemKeys };
}

// ---------------------------------------------------------------- text helpers
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// Best crate-type name for an OCR'd line (tolerant to misreads like "Corgo")
export function matchType(text) {
  const k = text.toLowerCase().replace(/[^a-z]/g, '');
  if (k.length < 4) return null;
  let best = null;
  for (const t of lists().TYPE_NAMES) {
    const s = similarity(k, t.key);
    if (!best || s > best.s) best = { ...t, s };
  }
  return best && best.s >= 0.72 ? best : null;
}

export function parsePrice(text) {
  const all = parsePrices(text);
  return all.length ? all[0] : null;
}
// Every price on a line, in order. A discounted crate shows "56,000 70,000": the sale price, then the
// original price struck through (the odds are listed under the original price).
export function parsePrices(text) {
  const out = [], re = /(\d{1,3}(?:[,.]\d{3})+|\d{4,7})/g;
  const s = text.replace(/[oO](?=[\d,.])|(?<=[\d,.])[oO]/g, '0');
  let m;
  while ((m = re.exec(s))) {
    const v = Number(m[1].replace(/[^\d]/g, ''));
    if (v >= 1000 && v <= 5000000) out.push(v);
  }
  return out;
}
// Common merchant discounts: when the struck-through price is unreadable, the sale price / (1 - d) is tried
const DISCOUNTS = [0.2, 0.1, 0.15, 0.25, 0.3, 0.5];

// The crate's pool (original) price and what you actually pay, from the numbers read on the price line
export function resolvePrice(typeId, nums) {
  if (!nums.length) return null;
  // 1) a number that is itself a pool price; with two (sale + original) the original is the larger one
  const snapped = nums.map(n => ({ n, p: snapPrice(typeId, n) })).filter(x => x.p);
  if (snapped.length) {
    const orig = snapped.reduce((a, b) => (b.p > a.p ? b : a));
    const sale = nums.filter(n => n < orig.p * 0.98).sort((a, b) => b - a)[0];
    return { price: orig.p, paid: sale && sale >= orig.p * 0.4 ? sale : orig.p };
  }
  // 2) only the sale price came through: undo a usual discount
  const sale = Math.min(...nums);
  for (const d of DISCOUNTS) {
    const p = snapPrice(typeId, sale / (1 - d));
    if (p) return { price: p, paid: sale };
  }
  return null;
}

// Snap an OCR'd price to a real pool price of that crate type (OCR may drop or misread a digit)
function snapPrice(typeId, price) {
  const prices = [...new Set(GAME_DATA.pools.filter(p => p.typeId === typeId).map(p => p.price))];
  let best = null;
  for (const p of prices) {
    const d = Math.abs(p - price) / p;
    if (d <= 0.02 && (!best || d < best.d)) best = { p, d };
  }
  return best ? best.p : null;
}

export function matchItem(text) {
  const k = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k.length < 3) return null;
  let best = null;
  for (const it of lists().ITEM_KEYS) {
    const s = similarity(k, it.key);
    if (!best || s > best.s) best = { id: it.id, s };
  }
  return best && best.s >= 0.75 ? best.id : null;
}

// Tooltip = a line naming a crate type with a price line just below it
export function parseTooltip(lines) {
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const t = matchType(lines[i].text);
    if (!t) continue;
    for (let j = 0; j < lines.length; j++) {
      if (j === i) continue;
      const below = lines[j].y - lines[i].y;
      if (below <= 0 || below > lines[i].h * 4) continue;
      const nums = parsePrices(lines[j].text);
      if (!nums.length) continue;
      const pr = resolvePrice(t.id, nums);
      if (!pr) continue;
      const cand = { typeId: t.id, typeName: t.name, price: pr.price, paid: pr.paid, rawPrice: nums[0], score: t.s, line: lines[i] };
      if (!best || cand.score > best.score) best = cand;
    }
  }
  return best;
}

// "...spent 250,000 Koen on a mystery cargo and obtained [Gold Lion Statue]"
export function parseFeed(lines) {
  const out = [];
  for (const l of lines) {
    const t = l.text;
    const m = t.match(/spent\s+([\d,.\s]+)\s*Koen.*?obtained\s*[\[(|]?\s*([^\])|]+)/i);
    if (!m) continue;
    const price = Number(m[1].replace(/[^\d]/g, ''));
    const itemId = matchItem(m[2]);
    if (price && itemId) out.push({ price, itemId, text: t });
  }
  return out;
}

// ---------------------------------------------------------------- crate size from grid lines
// The merchant panel is a square grid; each crate is a block of cells framed by a light line, with no lines
// inside it (just its name label and icon). So: find the grid (cell size + offset) from where lines sit,
// then, starting at the cursor's cell, join neighbouring cells while no frame line separates them.
// gray: Uint8Array w*h of a crop around the cursor. Returns { w, h, P, box } in cells/crop px, or null.
export function crateSizeAt(gray, w, h, cx, cy, dbg = {}) {
  const { vline, hline } = lineMaps(gray, w, h);
  // the tooltip (very dark box, next to the cursor) hides part of the grid: edges under it don't count
  const hidden = darkMask(gray, w, h);
  // line profiles: how much of each column / row is line
  const colP = new Float32Array(w), rowP = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (vline[i]) colP[x]++; if (hline[i]) rowP[y]++; }
  // grid: the cell size P and offsets that put lattice lines on the strongest columns and rows
  const comb = (prof, P) => {
    let best = null;
    for (let off = 0; off < P; off++) {
      let s = 0, n = 0;
      for (let x = off; x < prof.length; x += P) { s += Math.max(prof[x], prof[x - 1] || 0, prof[x + 1] || 0); n++; }
      if (n >= 2 && (!best || s / n > best.s)) best = { off, s: s / n };
    }
    return best;
  };
  const meanC = colP.reduce((a, b) => a + b, 0) / w, meanR = rowP.reduce((a, b) => a + b, 0) / h;
  const cands = [];
  // a cell is ~64 px on the 1080p-sized copy the reader measures on (the game UI scales with the window)
  for (let P = 46; P <= 86; P++) {
    const cxm = comb(colP, P), cym = comb(rowP, P);
    if (!cxm || !cym) continue;
    // mild preference for the usual cell size, so a lattice of 1.25 cells can't win on a lucky crop
    const prior = 1 - 0.4 * Math.abs(P - 64) / 64;
    cands.push({ P, offX: cxm.off, offY: cym.off, s: (cxm.s / (meanC + 1) + cym.s / (meanR + 1)) * prior });
  }
  if (!cands.length) { dbg.fail = 'no grid'; return null; }
  const top = cands.reduce((a, b) => (b.s > a.s ? b : a));
  // multiples of the cell size line up too (crates are often 2 cells wide): take the smallest good one
  let grid = top;
  if (dbg.fixedP) grid = cands.reduce((a, b) => (Math.abs(b.P - dbg.fixedP) < Math.abs(a.P - dbg.fixedP) ? b : a));
  else for (const c of cands.slice().sort((a, b) => a.P - b.P)) {
    if (c.s >= top.s * 0.8 && top.P % c.P <= 2 || c.s >= top.s * 0.8 && c.P - (top.P % c.P) <= 2) { grid = c; break; }
  }
  const { P, offX, offY } = grid;
  Object.assign(dbg, { grid });
  // is there a frame line between two cells? A frame runs the whole edge; the crate icon (centred in the
  // crate, often right on an inner grid line) and the name label only cover part of it. So the edge is
  // sampled near each end and the weaker end counts.
  const along = (fixed, from, len, vertical) => {
    const part = (a, b) => {
      let hit = 0, n = 0;
      for (let s = Math.round(from + len * a); s < from + len * b; s++) {
        const inRange = vertical ? s >= 0 && s < h : s >= 0 && s < w;
        if (!inRange || (vertical ? hidden[s * w + fixed] : hidden[fixed * w + s])) continue; n++;
        for (let d = -2; d <= 2; d++) {
          const f = fixed + d;
          if (vertical ? f >= 0 && f < w && vline[s * w + f] : f >= 0 && f < h && hline[f * w + s]) { hit++; break; }
        }
      }
      return n >= 4 ? hit / n : null; // null: hidden / off the picture
    };
    const a = part(0.1, 0.3), b = part(0.7, 0.9);
    return a === null ? b : b === null ? a : Math.min(a, b);
  };
  const vEdge = (i, j) => along(offX + (i + 1) * P, offY + j * P, P, true);   // between cell (i,j) and (i+1,j)
  const hEdge = (i, j) => along(offY + (j + 1) * P, offX + i * P, P, false);  // between cell (i,j) and (i,j+1)
  const inside = (i, j) => offX + i * P >= 0 && offX + (i + 1) * P < w && offY + j * P >= 0 && offY + (j + 1) * P < h;
  const i0 = Math.floor((cx - offX) / P), j0 = Math.floor((cy - offY) / P);
  if (!inside(i0, j0)) { dbg.fail = 'cursor cell outside'; return null; }
  // Every rectangle (1-3 x 1-3 cells) holding the cursor's cell is scored: its outline should be frame line,
  // its inside edges should not. Scoring whole outlines (instead of walking edge by edge) shrugs off a frame
  // partly hidden by the tooltip or a label.
  const memo = new Map(), known = (xs) => xs.filter(v => v !== null);
  const ve = (i, j) => { const k = 'v' + i + ',' + j; if (!memo.has(k)) memo.set(k, vEdge(i, j)); return memo.get(k); };
  const he = (i, j) => { const k = 'h' + i + ',' + j; if (!memo.has(k)) memo.set(k, hEdge(i, j)); return memo.get(k); };
  let best = null;
  for (let cw = 1; cw <= 3; cw++) for (let chh = 1; chh <= 3; chh++)
    for (let i1 = i0 - cw + 1; i1 <= i0; i1++) for (let j1 = j0 - chh + 1; j1 <= j0; j1++) {
      if (!inside(i1, j1) || !inside(i1 + cw - 1, j1 + chh - 1)) continue;
      const outl = [], inn = [];
      for (let j = j1; j < j1 + chh; j++) { outl.push(ve(i1 - 1, j), ve(i1 + cw - 1, j)); for (let i = i1; i < i1 + cw - 1; i++) inn.push(ve(i, j)); }
      for (let i = i1; i < i1 + cw; i++) { outl.push(he(i, j1 - 1), he(i, j1 + chh - 1)); for (let j = j1; j < j1 + chh - 1; j++) inn.push(he(i, j)); }
      const ko = known(outl), ki = known(inn);
      if (ko.length < Math.max(2, outl.length / 2)) continue; // too little of the outline visible
      const o = ko.reduce((a, b) => a + Math.min(1, b / 0.7), 0) / ko.length;
      const n = ki.length ? ki.reduce((a, b) => a + Math.min(1, b / 0.7), 0) / ki.length : 0;
      // more visible outline that is frame = more evidence (breaks ties toward the box that explains more)
      const score = o - n + 0.015 * ko.length;
      if (!best || score > best.score + 1e-9) best = { cw, chh, i1, j1, score, o, n };
    }
  Object.assign(dbg, { best });
  if (!best || best.o < 0.6 || best.n > 0.35) { dbg.fail = 'no clear outline'; return null; }
  const { cw, chh, i1, j1 } = best;
  return { w: cw, h: chh, P, box: { L: offX + i1 * P, R: offX + (i1 + cw) * P, U: offY + j1 * P, D: offY + (j1 + chh) * P } };
}

// pixels near something very dark (the tooltip's box is far darker than the merchant panel)
function darkMask(gray, w, h) {
  const R = 3, dark = new Uint8Array(w * h), tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i] < 34 ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let d = -R; d <= R && !m; d++) { const xx = x + d; if (xx >= 0 && xx < w) m = dark[y * w + xx]; } tmp[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let d = -R; d <= R && !m; d++) { const yy = y + d; if (yy >= 0 && yy < h) m = tmp[yy * w + x]; } out[y * w + x] = m; }
  // only big dark areas (the tooltip, empty slots): thin dark strokes don't hide anything
  return out;
}

// light line pixels (vertical / horizontal): brighter than both sides
function lineMaps(gray, w, h) {
  const vline = new Uint8Array(w * h), hline = new Uint8Array(w * h);
  const DMAX = 4;
  // crate frames are ~+60 brighter than the panel; the faint cell lines inside a hovered crate only ~+10
  const T = lineMaps.T || 24;
  for (let y = DMAX; y < h - DMAX; y++) {
    for (let x = DMAX; x < w - DMAX; x++) {
      const i = y * w + x, v = gray[i];
      let cv = -255, ch = -255;
      for (let d = 2; d <= DMAX; d++) {
        cv = Math.max(cv, Math.min(v - gray[i - d], v - gray[i + d]));
        ch = Math.max(ch, Math.min(v - gray[i - d * w], v - gray[i + d * w]));
      }
      if (cv > T) vline[i] = 1;
      if (ch > T) hline[i] = 1;
    }
  }
  return { vline, hline };
}

// the earlier outline walker (kept for comparison in tools/screen-test.html)
export function crateSizeAtOld(gray, w, h, cx, cy, dbg = {}) {
  const vline = new Uint8Array(w * h), hline = new Uint8Array(w * h);
  const T = 8, DMAX = 6;
  for (let y = DMAX; y < h - DMAX; y++) {
    for (let x = DMAX; x < w - DMAX; x++) {
      const i = y * w + x, v = gray[i];
      // light line of any thickness up to ~2*DMAX px: brighter than both sides at some distance d
      let cv = -255, ch = -255;
      for (let d = 2; d <= DMAX; d++) {
        cv = Math.max(cv, Math.min(v - gray[i - d], v - gray[i + d]));
        ch = Math.max(ch, Math.min(v - gray[i - d * w], v - gray[i + d * w]));
      }
      if (cv > T) vline[i] = 1;
      if (ch > T) hline[i] = 1;
    }
  }
  // Column / row profiles of long line runs -> grid period
  const runProfile = (map, vertical) => {
    const len = vertical ? w : h, other = vertical ? h : w, prof = new Float32Array(len);
    for (let a = 0; a < len; a++) {
      let run = 0, sum = 0;
      for (let b = 0; b <= other; b++) {
        const on = b < other && map[vertical ? b * w + a : a * w + b];
        if (on) { run++; continue; }
        if (run >= 10) sum += run;
        run = 0;
      }
      prof[a] = sum / other;
    }
    return prof;
  };
  const V = runProfile(vline, true), H = runProfile(hline, false);
  const peaks = (p) => {
    const mx = Math.max(...p), out = [];
    for (let i = 1; i < p.length - 1; i++) if (p[i] >= mx * 0.25 && p[i] >= p[i - 1] && p[i] > p[i + 1]) {
      if (out.length && i - out[out.length - 1] < 6) { if (p[i] > p[out[out.length - 1]]) out[out.length - 1] = i; } else out.push(i);
    }
    return out;
  };
  const pv = peaks(V), ph = peaks(H);
  const gaps = [];
  for (const ps of [pv, ph]) for (let i = 1; i < ps.length; i++) gaps.push(ps[i] - ps[i - 1]);
  Object.assign(dbg, { pv, ph });

  // Walk out from the cursor to the nearest line that runs along the crate edge (>= 55% coverage)
  const band = Math.max(6, Math.round(Math.min(w, h) * 0.05));
  const covV = (x) => { let n = 0, c = 0; for (let y = cy - band; y <= cy + band; y++) { if (y < 0 || y >= h) continue; n++; let hit = 0; for (let d = -1; d <= 1; d++) hit |= vline[y * w + x + d]; c += hit; } return n ? c / n : 0; };
  const covH = (y) => { let n = 0, c = 0; for (let x = cx - band; x <= cx + band; x++) { if (x < 0 || x >= w) continue; n++; let hit = 0; for (let d = -1; d <= 1; d++) hit |= hline[(y + d) * w + x]; c += hit; } return n ? c / n : 0; };
  const walk = (start, step, limit, cov) => { for (let p = start; p !== limit; p += step) if (cov(p) >= 0.55) return p; return null; };
  const L = walk(cx, -1, 3, covV), R = walk(cx, 1, w - 3, covV), U = walk(cy, -1, 3, covH), D = walk(cy, 1, h - 3, covH);
  Object.assign(dbg, { L, R, U, D }); if (L === null || R === null || U === null || D === null) { dbg.fail = "edge not found"; return null; }
  // Cell size: the crate box is cw x ch cells (1..3 each, square cells). Among the readings that keep the
  // cells square, take the one best supported by the spacing of the grid lines around it.
  const bw = R - L, bh = D - U;
  if (bw < 10 || bh < 10) { dbg.fail = 'tiny box'; return null; }
  let best = null;
  for (let cw = 1; cw <= 3; cw++) for (let chh = 1; chh <= 3; chh++) {
    const Pw = bw / cw, Ph = bh / chh;
    if (Math.abs(Pw - Ph) / Math.max(Pw, Ph) > 0.15) continue;
    const P = (Pw + Ph) / 2;
    let score = 0;
    for (const g of gaps) {
      const k = Math.round(g / P);
      if (k >= 1 && k <= 3 && Math.abs(g / P - k) < 0.15) score += k === 1 ? 2 : 1;
    }
    if (dbg.fixedP) score = -Math.abs(P - dbg.fixedP); // a known cell size (from earlier frames) wins
    if (!best || score > best.score || (score === best.score && P > best.P)) best = { cw, chh, P, score };
  }
  dbg.best = best;
  if (!best) { dbg.fail = 'not square cells'; return null; }
  return { w: best.cw, h: best.chh, P: Math.round(best.P), box: { L, R, U, D } };
}

// "1x2" style key, smaller side first (crate orientation doesn't matter for the odds)
const sizeKeyOf = (s) => `${Math.min(s.w, s.h)}x${Math.max(s.w, s.h)}`;

// OCR enlargement: small text at 1080p needs 2x; at 4K the text is already big enough
const ocrScale = (ui) => (ui < 1.2 ? 2 : ui < 1.7 ? 1.5 : 1);

// ---------------------------------------------------------------- live reader
export class MerchantReader {
  constructor() {
    this.listeners = { hover: [], drag: [], feed: [], status: [] };
    this.lastHover = null;      // { typeId, typeName, price, paid, size, box (client px), cursor, t }
    this.lmbWas = false;
    this.running = false;
    this.lastCursor = null; this.stillSince = 0; this.lastTooltipAt = 0;
    this.lastHoverKey = ''; this.seenFeed = new Set(); this.lastFeedAt = 0;
    this.merchantOpen = false; this.merchantSeenAt = 0;
  }
  on(e, cb) { this.listeners[e].push(cb); }
  emit(e, d) { this.listeners[e].forEach(cb => cb(d)); }

  start() { if (!this.running) { this.running = true; this.loop(); } }
  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      let wait = 120;
      try { await this.tick(); if (!this.gameUp) wait = 1500; /* game closed: check rarely */ }
      catch (e) { wait = 2000; /* server restarting/unreachable: back off */ }
      await new Promise(r => setTimeout(r, wait));
    }
  }

  async tick() {
    const st = await (await fetch('/api/state', { cache: 'no-store' })).json();
    this.gameUp = !!st.game;
    if (!st.game) { this.setOpen(false, 'no-game'); return; }
    const now = performance.now();
    const ui = st.h / 1080; // UI scale relative to 1080p
    // the merchant panel is on the right half; the cursor must be there and still
    const onPanel = st.cx > st.w * 0.45 && st.cx < st.w && st.cy > 0 && st.cy < st.h;
    // Only read the screen when a menu is up: the game hides the mouse cursor while you aim/move in a raid.
    // (If the cursor flag never turns on - a game-drawn cursor - don't gate on it at all.)
    if (st.cursor && st.focused) this.cursorEverShown = true;
    const canRead = st.cursor || !this.cursorEverShown || this.merchantOpen;
    const moved = !this.lastCursor || Math.abs(st.cx - this.lastCursor.x) > 3 || Math.abs(st.cy - this.lastCursor.y) > 3;
    if (moved) { this.stillSince = now; this.sizeTaken = false; }
    this.lastCursor = { x: st.cx, y: st.cy };

    // drag: the button just went down on the panel. If it's on the crate just read (inside its outline, or
    // close to where its tooltip was read), that crate is being dragged - its sound comes next.
    const pressed = st.lmb && !this.lmbWas;
    this.lmbWas = !!st.lmb;
    if (pressed && canRead && onPanel && st.focused) await this.onPress(st, ui, now);

    // size: grab the outline right after the cursor settles (before the tooltip covers it)
    if (canRead && onPanel && st.focused && !st.lmb && !moved && !this.sizeTaken && now - this.stillSince > 60) {
      this.sizeTaken = true;
      this.pendingSize = await this.readSize(st, ui);
    }
    // tooltip: once the cursor has rested ~350 ms
    if (canRead && onPanel && st.focused && !st.lmb && now - this.stillSince > 350 && now - this.lastTooltipAt > 600) {
      this.lastTooltipAt = now;
      const rx = Math.max(0, Math.round(st.cx - 120 * ui)), ry = Math.max(0, Math.round(st.cy - 80 * ui));
      const r = await this.ocr(rx, ry, Math.round(560 * ui), Math.round(300 * ui), ocrScale(ui));
      const tip = r && parseTooltip(r.lines);
      if (tip) {
        this.setOpen(true);
        const ps = this.pendingSize;
        const size = ps ? sizeKeyOf(ps) : '';
        this.lastHover = { typeId: tip.typeId, typeName: tip.typeName, price: tip.price, paid: tip.paid, size,
          box: ps && ps.client, cursor: { x: st.cx, y: st.cy }, t: now, P: this.cellP ? this.cellP * ui : 85 * ui / 1.333 };
        const key = `${tip.typeId}@${tip.price}#${size}@${Math.round(st.cx / 20)},${Math.round(st.cy / 20)}`;
        if (key !== this.lastHoverKey) {
          this.lastHoverKey = key;
          this.emit('hover', { typeId: tip.typeId, typeName: tip.typeName, price: tip.price, paid: tip.paid, size, at: Date.now(), cursor: { x: st.cx, y: st.cy } });
        }
      }
    }
    // purchase line: the top of the merchant panel, every ~2.5 s while the game is in front
    if (canRead && st.focused && now - this.lastFeedAt > (this.merchantOpen ? 2500 : 6000)) {
      this.lastFeedAt = now;
      const r = await this.ocr(Math.round(st.w * 0.45), 0, Math.round(st.w * 0.55), Math.round(st.h * 0.3), ocrScale(ui));
      if (r) {
        const text = r.lines.map(l => l.text).join(' ').toLowerCase();
        if (/purchase/.test(text) && /(sell|supplies)/.test(text)) this.setOpen(true);
        else if (now - this.merchantSeenAt > 15000) this.setOpen(false, 'closed');
        for (const f of parseFeed(r.lines)) {
          const k = `${f.price}|${f.itemId}|${f.text.slice(0, 20)}`;
          if (this.seenFeed.has(k)) continue;
          this.seenFeed.add(k);
          if (this.feedPrimed) this.emit('feed', { ...f, at: Date.now() }); // lines already on screen at start are old
        }
        this.feedPrimed = true;
      }
    }
  }

  // Left button pressed on the panel: is it on the crate we just read?
  async onPress(st, ui, now) {
    const h = this.lastHover;
    if (!h || now - h.t > 20000) return;
    const P = h.P || 64 * ui;
    const inBox = h.box && st.cx >= h.box.L - 4 && st.cx <= h.box.R + 4 && st.cy >= h.box.U - 4 && st.cy <= h.box.D + 4;
    const near = !h.box && Math.abs(st.cx - h.cursor.x) < P * 0.6 && Math.abs(st.cy - h.cursor.y) < P * 0.6;
    if (!inBox && !near) return;
    let size = h.size;
    // no size from the hover (quick grab, tooltip in the way): measure the slot under the press now
    if (!size) { const s = await this.readSize(st, ui); if (s) size = sizeKeyOf(s); }
    this.emit('drag', { typeId: h.typeId, typeName: h.typeName, price: h.price, paid: h.paid, size, at: Date.now(), cursor: { ...h.cursor } });
  }

  setOpen(open, why) {
    if (open) this.merchantSeenAt = performance.now();
    if (open !== this.merchantOpen) { this.merchantOpen = open; this.emit('status', { open, why }); }
  }

  async ocr(x, y, w, h, scale) {
    const res = await fetch(`/api/ocr?x=${x}&y=${y}&w=${w}&h=${h}&scale=${scale}`, { cache: 'no-store' });
    return res.ok ? res.json() : null;
  }

  async readSize(st, ui) {
    const half = Math.round(260 * ui);
    const x = Math.max(0, st.cx - half), y = Math.max(0, st.cy - half);
    const w = Math.min(st.w - x, half * 2), h = Math.min(st.h - y, half * 2);
    const down = ui > 1.1 ? 1 / ui : 1; // measure on a 1080p-sized copy (4K is 4x the work)
    const res = await fetch(`/api/frame?png&scale=${down}&x=${x / st.w}&y=${y / st.h}&w=${w / st.w}&h=${h / st.h}`, { cache: "no-store" });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height), cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data, g = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    // remember the grid's cell size from earlier good reads: it settles borderline boxes
    const dbg = this.cellP ? { fixedP: this.cellP } : {};
    const s = crateSizeAt(g, bmp.width, bmp.height, Math.round((st.cx - x) * down), Math.round((st.cy - y) * down), dbg);
    if (s && (s.w > 1 || s.h > 1)) {
      this.cellSamples = (this.cellSamples || []).concat(s.P).slice(-15);
      const sorted = this.cellSamples.slice().sort((a, b) => a - b);
      if (sorted.length >= 3) this.cellP = sorted[sorted.length >> 1];
    }
    // outline in client pixels (for telling whether a later press is on this crate)
    if (s && s.box) s.client = { L: x + s.box.L / down, R: x + s.box.R / down, U: y + s.box.U / down, D: y + s.box.D / down };
    return s;
  }
}
