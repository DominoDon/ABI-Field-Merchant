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
  const m = text.replace(/[oO]/g, '0').match(/(\d{1,3}(?:[,.\s]\d{3})+|\d{4,7})/);
  if (!m) return null;
  const v = Number(m[1].replace(/[^\d]/g, ''));
  return v >= 1000 && v <= 5000000 ? v : null;
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
      const raw = parsePrice(lines[j].text);
      if (!raw) continue;
      const price = snapPrice(t.id, raw);
      if (!price) continue;
      const cand = { typeId: t.id, typeName: t.name, price, rawPrice: raw, score: t.s, line: lines[i] };
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
// gray: Uint8Array w*h of a crop centred on the cursor. Returns { w, h, P } in cells or null.
export function crateSizeAt(gray, w, h, cx, cy, dbg = {}) {
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

// OCR enlargement: small text at 1080p needs 2x; at 4K the text is already big enough
const ocrScale = (ui) => (ui < 1.2 ? 2 : ui < 1.7 ? 1.5 : 1);

// ---------------------------------------------------------------- live reader
export class MerchantReader {
  constructor() {
    this.listeners = { hover: [], feed: [], status: [] };
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
        const size = this.pendingSize ? `${Math.min(this.pendingSize.w, this.pendingSize.h)}x${Math.max(this.pendingSize.w, this.pendingSize.h)}` : '';
        const key = `${tip.typeId}@${tip.price}#${size}@${Math.round(st.cx / 20)},${Math.round(st.cy / 20)}`;
        if (key !== this.lastHoverKey) {
          this.lastHoverKey = key;
          this.emit('hover', { typeId: tip.typeId, typeName: tip.typeName, price: tip.price, size, at: Date.now(), cursor: { x: st.cx, y: st.cy } });
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
    return s;
  }
}
