// ABI Field Merchant - pick map + crate (or hover it in-game), drag the crate, see what it can be.
import { GAME_DATA } from './data.js';
import { extractMerchantData, validateGameData, dataSignature } from './merchantData.js';
import { GameAudioListener } from './audioListener.js';
import { MerchantReader } from './screen.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const fmtK = (n) => { const a = Math.abs(n); const s = n < 0 ? '−' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e4 ? `${s}${Math.round(a / 1e3)}k` : `${s}${fmt(a)}`; };
const pct = (v) => (v > 0 && v < 0.01 ? '<1' : v > 0.99 && v < 1 ? '>99' : String(Math.round(v * 100)));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const store = {
  get(k, d) { try { const v = localStorage.getItem('abi-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('abi-' + k, JSON.stringify(v)); } catch (e) { } }
};
const KOEN = '<svg viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';

// ------------------------------------------------------------------ game data (built-in, or a newer copy)
// A newer copy fetched on an earlier run (validated) replaces the built-in data before anything uses it.
const BUILT_IN_FETCHED = GAME_DATA.fetched || '';
function applyGameData(d) { for (const k of ['fetched', 'sounds', 'items', 'types', 'profiles', 'pools']) GAME_DATA[k] = d[k]; }
try {
  const cached = store.get('gamedata', null);
  if (cached && !validateGameData(cached) && (cached.fetched || '') > BUILT_IN_FETCHED) applyGameData(cached);
} catch (e) { }

// ------------------------------------------------------------------ maps of the current season
// Maps that are not in the game this season are hidden from the map picker. Edit this list when seasons change.
const RETIRED_MAPS = ['Distorted Valley'];
const MODE_NAMES = { SevereInfection: 'Severe Infection', DeepAnomaly: 'Deep Anomaly' };
function mapChoices() {
  const out = [];
  for (const p of GAME_DATA.profiles) for (const m of p.maps || []) {
    if (RETIRED_MAPS.includes(m.name)) continue;
    out.push({ key: `${m.name}|${m.mode}`, name: m.name, mode: MODE_NAMES[m.mode] || m.mode.replace(/([a-z])([A-Z])/g, '$1 $2'), profile: p.id });
  }
  const order = (n) => ['Farm', 'Valley', 'Armory', 'Northridge', 'TV Station', 'Airport'].indexOf(n) + 1 || 99;
  return out.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name) || a.profile - b.profile);
}
const mapLabel = (key) => { const c = mapChoices().find(x => x.key === key); return c ? `${c.name} · ${c.mode}` : ''; };

// ------------------------------------------------------------------ audio worker
// All audio work runs in a background worker (audioWorker.js) so this window never freezes.
class WorkerListener {
  constructor() {
    this.listeners = { match: [], level: [], status: [], refs: [], confirm: [], learned: [] };
    this.w = new Worker('./audioWorker.js', { type: 'module' });
    this.w.onmessage = (e) => (this.listeners[e.data.type] || []).forEach(cb => cb(e.data.payload));
    this.w.onerror = (e) => console.error('audio worker:', e.message);
  }
  on(evt, cb) { this.listeners[evt].push(cb); }
  setSensitivity(v) { this.w.postMessage({ type: 'sens', value: v }); }
  start(source, deviceId) { this.w.postMessage({ type: 'start', source, deviceId }); }
  stop() { this.w.postMessage({ type: 'stop' }); }
  setFitting(ids) {
    const key = ids ? ids.join(',') : '';
    if (key !== this.lastFits) { this.lastFits = key; this.w.postMessage({ type: 'fits', ids }); }
  }
  // sounds the chosen crate (and size) can make: the recogniser tries these first
  setAllowed(ids) {
    const key = ids ? ids.join(',') : '';
    if (key !== this.lastAllowed) { this.lastAllowed = key; this.w.postMessage({ type: 'allowed', ids }); }
  }
  // raw audio of the hit detected at `time` (for learning), or null when it's no longer kept
  requestSnippet(time) {
    return new Promise(res => {
      const h = (e) => { if (e.data.type === 'snippet' && e.data.payload.time === time) { this.w.removeEventListener('message', h); res(e.data.payload.pcm); } };
      this.w.addEventListener('message', h);
      this.w.postMessage({ type: 'snippet', time });
      setTimeout(() => { this.w.removeEventListener('message', h); res(null); }, 3000);
    });
  }
  learn(list) { if (list.length) this.w.postMessage({ type: 'learn', list }); }
  // decode here (workers can't decode audio), fingerprint in the worker
  async loadReferences() {
    const { clips, failed } = await GameAudioListener.decodeReferences(p => this.listeners.refs.forEach(cb => cb(p)));
    const ready = new Promise(res => this.listeners.refs.push(r => { if (r && r.count !== undefined) res(r); }));
    this.w.postMessage({ type: 'refs', clips, failed }, clips.map(c => c.pcm.buffer));
    await ready;
  }
}
const listener = new WorkerListener();

const itemsById = new Map(GAME_DATA.items.map(i => [i.id, i]));
const soundsById = new Map(GAME_DATA.sounds.map(s => [s.id, s]));
// sounds are shown by name only (the game's sound numbers mean nothing to a player)
const soundLabel = (id) => (soundsById.get(id) || {}).name || 'Unknown sound';
// how sure a detection is, in words. The raw score is a similarity between the live (mixed, noisy) game audio and
// a clean reference, so it never reaches 100% even for a perfect identification — words say what it means.
function strength(d) {
  if (!d) return null;
  if (d.confirmed) return { word: 'Certain', level: 1, note: 'confirmed by its drop sound' };
  if (d.method !== 'exact') return { word: 'Possible', level: 0.4, note: 'similar sound' };
  if (d.score >= 0.75) return { word: 'Certain', level: 1, note: 'clear match' };
  if (d.score >= 0.5) return { word: 'Very likely', level: 0.8, note: 'good match' };
  return { word: 'Likely', level: 0.6, note: 'match through game noise' };
}

const state = {
  profile: store.get('profile', GAME_DATA.profiles[0].id),
  mapKey: store.get('map', ''),       // "Farm|Lockdown"
  crate: store.get('crate', ''),      // "typeId@price" or ''
  size: store.get('size', ''),        // rotation-normalised "1x2" etc., or '' for any
  soundId: null,
  detection: null,
  recent: [],
  valueMode: store.get('value', 'contact'), // 'contact' (trader hand-in) or 'market'
  chime: store.get('chime', true),
  buysPerRaid: store.get('buys-per-raid', 4),  // 2 normally, up to 4 with perks
  strategy: store.get('strategy', 'profit'),   // 'profit' | 'red' | 'safe'
  boughtThisRaid: 0,
  verdict: null,
  crateFromScreen: false
};
const valueOf = (item) => (state.valueMode === 'market' && item.market ? item.market : item.value);
// What was heard: one sound id, or a close-call mix [{ soundId, w }] whose odds get blended
const heard = () => (state.soundMix && state.soundMix.length > 1 ? state.soundMix : state.soundId);
// item pictures go through the exe, which keeps a local copy (fast, works offline after the first view)
const ICON_RE = /^https:\/\/hexaov91\.github\.io\/abi-assets\/image\/Normal\/(\d+)\.png$/;
const iconSrc = (item) => { const m = ICON_RE.exec(item.icon || ''); return m ? `/api/icon/${m[1]}.png` : item.icon; };

// Short rising two-tone when a heard crate is worth buying; a brighter triple tone when it may hold a red.
let chimeCtx = null;
function playChime(red = false) {
  try {
    chimeCtx = chimeCtx || new AudioContext();
    const t = chimeCtx.currentTime;
    (red ? [[988, 0], [1319, 0.1], [1760, 0.2]] : [[880, 0], [1320, 0.12]]).forEach(([f, d]) => {
      const o = chimeCtx.createOscillator(), g = chimeCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
      o.connect(g).connect(chimeCtx.destination); o.start(t + d); o.stop(t + d + 0.25);
    });
  } catch (e) { }
}

// ------------------------------------------------------------------ sizes
// A crate can be rotated in the inventory, so 1x2 and 2x1 are the same footprint.
const sizeKey = (s) => s.split('x').map(Number).sort((a, b) => a - b).join('x');
const SIZES = [...new Set(GAME_DATA.items.map(i => sizeKey(i.size)))]
  .sort((a, b) => a.split('x').reduce((x, y) => x * y) - b.split('x').reduce((x, y) => x * y) || a.localeCompare(b));
const sizeMatches = (item) => !state.size || sizeKey(item.size) === state.size;
const sizeLabel = (k) => { const [w, h] = k.split('x'); return `${w}×${h}`; };

// For the listener's tie-break: can this sound come out of the chosen crate at the chosen size?
function soundFitsChoice(soundId) {
  if (!state.size) return true;
  const crate = crateOdds(state.profile, state.crate);
  return GAME_DATA.items.some(i => i.soundId === soundId && sizeMatches(i) && (!crate || crate.odds.has(i.id)));
}
const fittingIds = () => (state.size ? GAME_DATA.sounds.map(s => s.id).filter(soundFitsChoice) : null);
// sounds the chosen crate (and size) can make, or null when no crate is chosen
const allowedIds = () => {
  const crate = crateOdds(state.profile, state.crate);
  if (!crate) return null;
  const ids = new Set();
  for (const id of crate.odds.keys()) { const it = itemsById.get(id); if (it && sizeMatches(it)) ids.add(it.soundId); }
  return ids.size ? [...ids].sort((a, b) => a - b) : null;
};

// ------------------------------------------------------------------ odds
// A crate = (map profile, cargo type, price). It rolls one loot group by group weight,
// then one item from that group by item weight.
function crateOdds(profile, crateKey) {
  if (!crateKey) return null;
  const [typeId, price] = crateKey.split('@').map(Number);
  const groups = GAME_DATA.pools.filter(p => p.profile === profile && p.typeId === typeId && p.price === price);
  if (!groups.length) return null;
  const gTotal = groups.reduce((a, g) => a + g.weight, 0) || 1;
  const odds = new Map();
  for (const g of groups) {
    const iTotal = g.weightTotal || g.items.reduce((a, x) => a + x[1], 0) || 1;
    for (const [id, w] of g.items) odds.set(id, (odds.get(id) || 0) + (g.weight / gTotal) * (w / iTotal));
  }
  return { typeId, price, odds };
}

function cratesForProfile(profile) {
  const seenKeys = new Map();
  for (const p of GAME_DATA.pools) {
    if (p.profile !== profile) continue;
    const key = `${p.typeId}@${p.price}`;
    if (!seenKeys.has(key)) seenKeys.set(key, { key, name: GAME_DATA.types[p.typeId] || `Type ${p.typeId}`, price: p.price });
  }
  return [...seenKeys.values()].sort((a, b) => a.name.localeCompare(b.name) || a.price - b.price);
}

// Odds for one crate (profile + "typeId@price"), optionally narrowed by sound and size key.
// `sound` is a sound id, or a close-call mix [{ soundId, w }] (w = how well each matched): then each sound's
// items are weighted by w × the crate's own odds, i.e. P(item | crate, what was heard).
// Returns null when the crate doesn't exist on that map, { empty: true } when nothing fits.
function crateStats(profile, crateKey, sound, size) {
  const crate = crateOdds(profile, crateKey);
  if (!crate) return null;
  const mix = Array.isArray(sound) ? sound : sound ? [{ soundId: sound, w: 1 }] : null;
  const wOf = mix ? new Map(mix.map(m => [m.soundId, m.w])) : null;
  const fits = (it) => !size || sizeKey(it.size) === size;
  const all = [...crate.odds.entries()].map(([id, p]) => ({ item: itemsById.get(id), p })).filter(x => x.item);
  const subset = all.filter(x => (!wOf || wOf.has(x.item.soundId)) && fits(x.item))
    .map(x => ({ item: x.item, p: x.p * (wOf ? wOf.get(x.item.soundId) : 1) }));
  const mass = subset.reduce((a, x) => a + x.p, 0);
  if (!mass) return { crate, empty: true };
  const list = subset.map(x => ({ item: x.item, p: x.p / mass }));
  const single = mix && mix.length === 1 ? mix[0].soundId : null;
  const refined = single ? refineWithPurchases(list, crate.typeId, crate.price, single) : null;
  const ev = list.reduce((a, x) => a + x.p * valueOf(x.item), 0);
  const win = list.reduce((a, x) => a + (valueOf(x.item) > crate.price ? x.p : 0), 0);
  const red = list.reduce((a, x) => a + (x.item.rarity === 6 ? x.p : 0), 0);
  const profit = ev - crate.price;
  const tag = profit > 0 && win >= 0.5 ? 'buy' : profit > 0 ? 'maybe' : 'skip';
  list.sort((a, b) => b.p - a.p || valueOf(b.item) - valueOf(a.item));
  return { crate, list, refined, ev, win, red, profit, tag };
}

// ------------------------------------------------------------------ rendering: top bar + crate
function renderPickers() {
  // one entry per map + mode, grouped by map (the merchant's stock depends on the map group behind it)
  const groups = new Map();
  for (const c of mapChoices()) { if (!groups.has(c.name)) groups.set(c.name, []); groups.get(c.name).push(c); }
  $('map-select').innerHTML = [...groups.entries()].map(([name, list]) =>
    `<optgroup label="${esc(name)}">${list.map(c => `<option value="${esc(c.key)}" ${c.key === state.mapKey ? 'selected' : ''}>${esc(c.name)} · ${esc(c.mode)}</option>`).join('')}</optgroup>`).join('');
  const crates = cratesForProfile(state.profile);
  if (state.crate && !crates.some(c => c.key === state.crate)) state.crate = '';
  $('crate-select').innerHTML = `<option value="">Choose a crate…</option>` + crates.map(c =>
    `<option value="${c.key}" ${c.key === state.crate ? 'selected' : ''}>${esc(c.name)} · ${fmt(c.price)}</option>`).join('');
  $('manual-sound').innerHTML = `<option value="">Pick a sound…</option>` + GAME_DATA.sounds.map(s =>
    `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

function renderCrate() {
  const crate = crateOdds(state.profile, state.crate);
  if (!crate) {
    $('crate-title').className = 'crate-name none';
    $('crate-title').textContent = 'No crate chosen';
    $('crate-sub').innerHTML = '<span class="muted">Hover a crate at the merchant, or choose it at the top.</span>';
  } else {
    $('crate-title').className = 'crate-name';
    $('crate-title').textContent = GAME_DATA.types[crate.typeId] || 'Crate';
    const n = crate.odds.size;
    $('crate-sub').innerHTML = `<span class="koen num">${KOEN}${fmt(crate.price)}</span><span class="muted">· ${n} possible items</span>`;
  }
  $('crate-auto').innerHTML = state.crateFromScreen && crate ? '<span class="auto-tag">From screen</span>' : '';
  renderSizes();
}

function renderSizes() {
  const shape = (k) => {
    const [w, h] = k.split('x').map(Number);
    return `<span style="grid-template-columns:repeat(${h},6px)">${'<i></i>'.repeat(w * h)}</span>`;
  };
  // with a crate chosen, each size shows its red chance (and dims if nothing that size can come out)
  const info = (k) => {
    if (!state.crate) return { html: '', na: false };
    const st = crateStats(state.profile, state.crate, heard(), k || null);
    if (!st) return { html: '', na: false };
    if (st.empty) return { html: '<span class="red zero">—</span>', na: true };
    return { html: st.red > 0 ? `<span class="red">red ${pct(st.red)}%</span>` : '<span class="red zero">no red</span>', na: false };
  };
  const btn = (k, label, shp) => {
    const i = info(k);
    return `<button data-size="${k}" class="${state.size === k ? 'on' : ''} ${i.na ? 'na' : ''}">
      <span class="shape">${shp}</span><span class="lab">${label}</span>${i.html || '<span class="red zero">&nbsp;</span>'}</button>`;
  };
  $('size-picker').innerHTML = btn('', 'Any', '<span style="font-weight:800;font-size:12px">∗</span>') + SIZES.map(k => btn(k, sizeLabel(k), shape(k))).join('');
}

// ------------------------------------------------------------------ rendering: sound
function renderSound() {
  const s = state.soundId ? soundsById.get(state.soundId) : null;
  const d = state.detection;
  const ring = $('sound-ring'), arc = $('sound-arc');
  const C = 2 * Math.PI * 44;
  const live = s && d && d.soundId === s.id ? strength(d) : null;
  // centre of the ring: how sure we are, in words; the ring fills to match (full = certain)
  $('sound-num').textContent = !s ? '—' : live ? live.word : 'By hand';
  $('sound-num').className = 'v' + (s ? ' word' : '');
  ring.className = 'ring' + (s ? '' : ' idle') + (live ? ' s' + Math.round(live.level * 10) : '');
  const conf = s ? (live ? live.level : 1) : 0;
  arc.setAttribute('stroke-dasharray', `${(conf * C).toFixed(1)} ${C.toFixed(1)}`);
  arc.style.display = conf > 0 ? '' : 'none'; // a zero-length round-capped arc would still draw a dot
  $('sound-name').textContent = s ? s.name : 'Drag a crate in the game';
  $('sound-meta').textContent = !s ? 'Listening for its sound…'
    : d && d.soundId === s.id
      ? `${live.word} — ${live.note}${d.confirmed ? ' ✓' : ''}${d.outsideCrate ? ' · not from this crate?' : ''} · ${new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : 'Chosen by hand';
  // close call: show the alternatives (their odds are blended in the verdict)
  const mixNow = heard();
  if (Array.isArray(mixNow)) {
    // shares after combining the audio with how often this crate gives each sound (what the verdict uses)
    const st = state.crate ? crateStats(state.profile, state.crate, mixNow, state.size || null) : null;
    const share = new Map(mixNow.map(m => [m.soundId, m.w]));
    if (st && !st.empty) { share.clear(); for (const x of st.list) share.set(x.item.soundId, (share.get(x.item.soundId) || 0) + x.p); }
    const shown = mixNow.map(m => ({ id: m.soundId, s: share.get(m.soundId) || 0 })).sort((a, b) => b.s - a.s);
    $('sound-alts').innerHTML = `<b>Close call</b> — ${shown.map(m => `<span class="alt" data-id="${m.id}">${esc(soundLabel(m.id))} <i>${pct(m.s)}%</i></span>`).join(' ')}<span class="muted"> · odds blended${st && !st.empty ? ' with this crate' : ''} (click one to choose it)</span>`;
  } else $('sound-alts').innerHTML = '';
  $('listening').style.display = s ? 'none' : '';
  // "sounds like": the most valuable items that make this sound (in this crate, when one is chosen)
  if (s) {
    const crate = crateOdds(state.profile, state.crate);
    const pool = GAME_DATA.items.filter(i => i.soundId === s.id && sizeMatches(i) && (!crate || crate.odds.has(i.id)));
    const top = (pool.length ? pool : GAME_DATA.items.filter(i => i.soundId === s.id)).sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 3);
    $('sound-likes').innerHTML = top.length ? 'Sounds like ' + top.map(i => `<b style="color:var(--r${i.rarity})">${esc(i.name)}</b>`).join(', ') : '';
  } else $('sound-likes').innerHTML = '';
  $('manual-sound').value = s ? String(s.id) : '';
  $('play-pickup').disabled = $('play-drop').disabled = !s;
  $('recent').innerHTML = state.recent.length
    ? state.recent.map((r, i) => `<span class="chip ${i === 0 && r.soundId === state.soundId ? 'cur' : ''}" data-id="${r.soundId}" title="Heard at ${new Date(r.time).toLocaleTimeString()}">${esc(soundLabel(r.soundId))}</span>`).join('')
    : '<span class="muted" style="font-size:12px">Recently heard sounds appear here</span>';
}

// ------------------------------------------------------------------ rendering: verdict + items
function gauge(value, color, label, hot) {
  const C = 2 * Math.PI * 46;
  const v = Math.max(0, Math.min(1, value));
  return `<div class="gauge ${label === 'Red' ? 'red' : ''} ${hot ? 'hot' : ''}">
    <svg viewBox="0 0 112 112"><circle cx="56" cy="56" r="46" stroke="#232a35" stroke-width="9" fill="none"/>
      ${v > 0 ? `<circle cx="56" cy="56" r="46" stroke="${color}" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="${(v * C).toFixed(1)} ${C.toFixed(1)}"/>` : ''}</svg>
    <div class="gv num" style="color:${value > 0 ? color : 'var(--faint)'}">${pct(value)}%</div><div class="gk">${label}</div></div>`;
}

const EMPTY_ICON = '<svg viewBox="0 0 54 54" fill="none"><rect x="9" y="21" width="36" height="25" rx="4" fill="#1d232d" stroke="#f2b84b" stroke-width="2"/><rect x="7" y="13" width="40" height="10" rx="3" fill="#232a35" stroke="#ffd679" stroke-width="2"/><path d="M24 31c0-2 1.5-3.2 3.3-3.2s3.3 1.2 3.3 3c0 2.3-3 2.4-3 4.6" stroke="#ffd679" stroke-width="2.2" stroke-linecap="round"/><circle cx="27.6" cy="40" r="1.5" fill="#ffd679"/></svg>';

function renderResults() {
  const crate = crateOdds(state.profile, state.crate);
  const sid = state.soundId;
  const vc = $('verdict-card');
  let list = [];
  state.verdict = null;
  let title = 'Possible contents';

  if (!crate) {
    vc.innerHTML = `<div class="empty-hero">${EMPTY_ICON}<div><h3>${sid ? 'Which crate was that?' : 'Ready when you are'}</h3>
      <p>${sid ? 'Pick the crate at the top (or hover it in-game) to get the real odds and a verdict.' : 'Three steps at the Field Merchant — the rest is automatic.'}</p></div></div>
      ${sid ? '' : `<div class="steps">
        <div class="step"><span class="n">1</span><div><b>Pick your map</b><span>The merchant's stock depends on the map and mode.</span></div></div>
        <div class="step"><span class="n">2</span><div><b>Hover a crate</b><span>Type, price and size fill in from the screen.</span></div></div>
        <div class="step"><span class="n">3</span><div><b>Drag it</b><span>The sound tells which items it can be — and the red chance.</span></div></div>
      </div>`}`;
    list = sid ? GAME_DATA.items.filter(i => i.soundId === sid && sizeMatches(i)).map(item => ({ item, p: null })).sort((a, b) => valueOf(b.item) - valueOf(a.item)) : [];
    title = sid ? `Items with the “${soundLabel(sid)}” sound` : 'Possible contents';
  } else {
    const st = crateStats(state.profile, state.crate, heard(), state.size || null);
    if (st.empty) {
      const what = [sid ? `the “${esc(soundLabel(sid))}” sound` : '', state.size ? `size ${sizeLabel(state.size)}` : ''].filter(Boolean).join(' and ');
      vc.innerHTML = `<div class="empty-hero">${EMPTY_ICON}<div><h3 class="warnbox">That doesn't fit this crate</h3>
        <p>Nothing with ${what} can come out of this crate on this map. Check the map, crate and size${sid ? ' — or the sound may have been misheard' : ''}.</p></div></div>`;
      list = GAME_DATA.items.filter(i => (!sid || i.soundId === sid) && sizeMatches(i)).map(item => ({ item, p: null }));
    } else {
      list = st.list;
      state.verdict = st.tag;
      const label = { buy: 'BUY', maybe: 'GAMBLE', skip: 'SKIP' }[st.tag];
      // realistic range: the middle 80% of outcomes (10th..90th percentile of value, weighted by odds)
      const byVal = list.map(x => ({ v: valueOf(x.item), p: x.p })).sort((a, b) => a.v - b.v);
      const pctl = (q) => { let acc = 0; for (const x of byVal) { acc += x.p; if (acc >= q - 1e-9) return x.v; } return byVal.length ? byVal[byVal.length - 1].v : 0; };
      const range = byVal.length ? [pctl(0.1), pctl(0.9)] : [0, 0];
      vc.innerHTML = `<div class="verdict">
        <div>
          <span class="badge ${st.tag}">${label}</span>
          <div class="profit num ${st.profit >= 0 ? 'good' : 'bad'}">${st.profit >= 0 ? '+' : '−'}${fmt(Math.abs(st.profit))}</div>
          <div class="evline">Expected ${state.valueMode === 'market' ? 'market ' : ''}value <b class="num">${fmt(st.ev)}</b> for <b class="num">${fmt(st.crate.price)}</b></div>
          <div class="chips-line">
            <span class="tagc num">${list.length} possible item${list.length === 1 ? '' : 's'}</span>
            <span class="tagc num" title="80% of the time the item is worth between these">${range[0] === range[1] ? fmtK(range[0]) : `80%: ${fmtK(range[0])} – ${fmtK(range[1])}`}</span>
            ${sid ? '' : '<span class="tagc">Before the sound — drag it to narrow down</span>'}
            ${state.size ? `<span class="tagc">${sizeLabel(state.size)} only</span>` : ''}
            ${st.refined ? `<span class="tagc gold" title="Odds adjusted with real purchase results for this crate and sound">Refined by ${st.refined.n} real purchase${st.refined.n === 1 ? '' : 's'}${st.refined.mine ? ` (${st.refined.mine} yours)` : ''}</span>` : ''}
          </div>
        </div>
        <div class="gauges">${gauge(st.red, 'var(--r6)', 'Red', st.red >= 0.25)}${gauge(st.win, 'var(--good)', 'Profit')}</div>
      </div>`;
      const mix = heard();
      title = Array.isArray(mix) ? `What “${mix.map(m => soundLabel(m.soundId)).join("” or “")}” can be (blended)` : sid ? `What the “${soundLabel(sid)}” sound can be` : "Everything this crate can hold";
    }
  }

  $('items-title').textContent = title;
  $('items-count').textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
  const canLog = !!(crate && sid);
  const topP = list.length && list[0].p !== null ? list[0].p : null;
  $('items').innerHTML = list.length ? list.slice(0, 60).map(({ item, p }, i) => `
    <div class="item r${item.rarity} ${i === 0 && topP !== null && list.length > 1 ? 'best' : ''}" style="--rc:var(--r${item.rarity})">
      ${canLog ? `<button class="got" data-item="${item.id}" title="I bought this crate and got this item — remember it to improve the odds">Got this</button>` : ''}
      <div class="art"><img src="${esc(iconSrc(item))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" /></div>
      <div class="nm">${esc(item.name)}</div>
      <div class="meta">${esc(item.category)} · ${sizeLabel(sizeKey(item.size))}</div>
      <div class="row"><span class="val num">${fmt(valueOf(item))}</span>${p !== null ? `<span class="pp num">${p >= 0.0995 ? Math.round(p * 100) : p >= 0.001 ? (p * 100).toFixed(1) : '<0.1'}%</span>` : ''}</div>
      ${p !== null ? `<div class="pbar"><i style="width:${Math.max(2, p * 100).toFixed(1)}%"></i></div>` : ''}
    </div>`).join('')
    : `<div class="items-empty" style="grid-column:1/-1">${crate ? 'Nothing fits this choice.' : 'Items appear here once you pick a crate or a sound is heard.'}</div>`;
}

// Live state for the mini always-on-top window (mini.html mirrors it; it does no listening itself)
const liveChannel = new BroadcastChannel('abi-live');
liveChannel.onmessage = (e) => { if (e.data && e.data.type === 'hello') broadcastLive(); };
function broadcastLive() {
  try {
    const s = state.soundId ? soundsById.get(state.soundId) : null, d = state.detection, mix = heard();
    const crate = crateOdds(state.profile, state.crate);
    const st = crate ? crateStats(state.profile, state.crate, mix, state.size || null) : null;
    liveChannel.postMessage({ type: 'state', s: {
      listening: /Listening/.test($('status-text').textContent), status: $('status-text').textContent,
      sound: s ? { id: s.id, name: s.name, meta: d && d.soundId === s.id ? `${strength(d).word}${d.confirmed ? ' ✓' : ''}` : 'By hand',
        level: d && d.soundId === s.id ? strength(d).level : 1,
        alts: Array.isArray(mix) ? mix.map(m => soundLabel(m.soundId)).join(' / ') : null } : null,
      crate: crate ? `${GAME_DATA.types[crate.typeId]} · ${fmt(crate.price)}${state.size ? ' · ' + sizeLabel(state.size) : ''}` : null,
      verdict: st && !st.empty ? { tag: st.tag, profit: st.profit, red: st.red } : null,
      items: st && !st.empty ? st.list.slice(0, 4).map(x => ({ name: x.item.name, rarity: x.item.rarity, p: x.p, value: valueOf(x.item), icon: iconSrc(x.item) })) : []
    } });
  } catch (e) { }
}

function render() {
  renderCrate(); renderSound(); renderResults(); renderSeen(); renderSession();
  broadcastLive();
  listener.setFitting(fittingIds()); // crate-size tie-break info for the worker
  listener.setAllowed(allowedIds()); // sounds the chosen crate can make
}

// ------------------------------------------------------------------ purchases
// Real purchase results refine the merchant odds: the merchant data counts as PRIOR_N purchases, then each
// recorded (crate type, price, sound) -> item result is added on top (method from abi-merchant-helper).
// Sources: the public base of neverh8me/abi-merchant-helper (read-only) + your own results (this PC only).
const PRIOR_N = 20;
const SHARED_URL = 'https://raw.githubusercontent.com/neverh8me/abi-merchant-helper/main/library/purchases.json';
// their sound-group ids, in our sound-id order (#1..#38)
const SHARED_GROUPS = ['med_comp', 'container_big_metal', 'med_fabric', 'acc_fuel', 'acc_concrete', 'med_metal_crisp',
  'acc_plastic_large', 'med_wood', 'small_comp', 'electronicdevice', 'acc_plastic_small', 'acc_tech_small', 'acc_pc',
  'big_wood', 'acc_battery_small', 'acc_med_comp', 'med_metal_blunt', 'small_metal_blunt', 'container_small_metal',
  'big_blunt', 'small_wood', 'small_metal_crisp', 'small_fabric', 'small_glass', 'med_wood_clock', 'glass', 'food_bag',
  'acc_statue', 'coin', 'med_glass', 'acc_clock', 'acc_teapot', 'necklace', 'med_paper', 'small_paper', 'med_statue',
  'big_paper', 'acc_radio'];
const typeIdByName = new Map(Object.entries(GAME_DATA.types).map(([id, n]) => [n.toLowerCase(), Number(id)]));
const poolPrices = (typeId) => [...new Set(GAME_DATA.pools.filter(p => p.typeId === typeId).map(p => p.price))];
const purchases = { shared: store.get('shared-purchases', []), mine: store.get('my-purchases', []) };

function normaliseShared(raw) {
  const out = [];
  for (const r of raw || []) {
    const g = typeof r.soundId === 'string' && r.soundId.startsWith('lib:') ? SHARED_GROUPS.indexOf(r.soundId.slice(4)) : -1;
    const typeId = typeIdByName.get(String(r.label || '').toLowerCase());
    if (g < 0 || !typeId || !itemsById.has(r.itemId)) continue;
    // their price may be the in-game price (pool price + ~10%): snap to the nearest pool price of that type
    const prices = poolPrices(typeId);
    const price = prices.find(p => p === r.price) || prices.find(p => Math.abs(p * 1.1 - r.price) <= p * 0.01);
    if (!price) continue;
    out.push({ soundId: g + 1, typeId, price, itemId: r.itemId, t: r.t });
  }
  return out;
}

async function loadSharedPurchases() {
  try {
    const res = await fetch(SHARED_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const list = normaliseShared((await res.json()).purchases);
    if (list.length) { purchases.shared = list; store.set('shared-purchases', list); render(); }
  } catch (e) { /* offline: keep the cached copy */ }
}

function refineWithPurchases(list, typeId, price, soundId) {
  const counts = new Map();
  let n = 0, mine = 0;
  const ids = new Set(list.map(x => x.item.id));
  for (const [src, arr] of [['shared', purchases.shared], ['mine', purchases.mine]]) {
    for (const r of arr) {
      if (r.typeId !== typeId || r.price !== price || r.soundId !== soundId || !ids.has(r.itemId)) continue;
      counts.set(r.itemId, (counts.get(r.itemId) || 0) + 1); n++;
      if (src === 'mine') mine++;
    }
  }
  if (!n) return null;
  for (const x of list) x.p = (PRIOR_N * x.p + (counts.get(x.item.id) || 0)) / (PRIOR_N + n);
  return { n, mine };
}

function logPurchase({ soundId, typeId, price, itemId, size }) {
  const rec = { soundId, typeId, price, itemId, size, profile: state.profile, map: state.mapKey, t: Date.now() };
  purchases.mine.push(rec);
  store.set('my-purchases', purchases.mine);
  addToSession(price, itemId);
  state.boughtThisRaid++;
  return rec;
}

// ------------------------------------------------------------------ learning your real sounds
// When you buy a crate, the game audio of its drag is saved (on this PC, IndexedDB) as an extra reference for
// the sound of the item you actually got. Only when that item matches what was heard, so a stray noise can't
// be learned. Newest LEARN_MAX per sound are kept.
const LEARN_MAX = 6;
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('abi-learned', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 't' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('clips', mode), st = t.objectStore('clips');
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', st => st.getAll()); },
  put(rec) { return this.tx('readwrite', st => st.put(rec)); },
  del(t) { return this.tx('readwrite', st => st.delete(t)); },
  clear() { return this.tx('readwrite', st => st.clear()); }
};
let learnedStats = { clips: 0, sounds: 0 };

async function learnFromPurchase(match, itemId) {
  try {
    const item = itemsById.get(itemId);
    if (!match || !item) return;
    const heardIds = new Set([match.soundId, ...(match.alts || []).map(a => a.soundId)]);
    if (!heardIds.has(item.soundId)) return; // the hit was probably not this crate
    const pcm = await listener.requestSnippet(match.time);
    if (!pcm) return;
    const pcm16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) pcm16[i] = Math.max(-1, Math.min(1, pcm[i])) * 32767;
    await idb.put({ t: Date.now(), soundId: item.soundId, pcm16 });
    const mine = (await idb.all()).filter(r => r.soundId === item.soundId).sort((a, b) => a.t - b.t);
    for (const old of mine.slice(0, Math.max(0, mine.length - LEARN_MAX))) await idb.del(old.t);
    listener.learn([{ soundId: item.soundId, pcm }]);
    await refreshLearnedStats();
  } catch (e) { console.warn('learning failed:', e); }
}

async function loadLearned() {
  try {
    const all = await idb.all();
    listener.learn(all.map(r => ({ soundId: r.soundId, pcm: Float32Array.from(r.pcm16, v => v / 32767) })));
    await refreshLearnedStats(all);
  } catch (e) { /* no IndexedDB: nothing learned yet */ }
}
async function refreshLearnedStats(all) {
  try { all = all || await idb.all(); } catch (e) { all = []; }
  learnedStats = { clips: all.length, sounds: new Set(all.map(r => r.soundId)).size };
  renderDataInfo();
}

// Undo the most recent logged purchase (for the auto-record "Undo" button)
function unlogPurchase(rec) {
  const i = purchases.mine.indexOf(rec);
  if (i >= 0) { purchases.mine.splice(i, 1); store.set('my-purchases', purchases.mine); }
  const j = session.buys.findIndex(b => b.t >= rec.t - 5 && b.itemId === rec.itemId && b.price === rec.price);
  if (j >= 0) { session.buys.splice(j, 1); store.set('session', session); }
  state.boughtThisRaid = Math.max(0, state.boughtThisRaid - 1);
}

function recordPurchase(itemId) {
  const crate = crateOdds(state.profile, state.crate);
  if (!crate || !state.soundId) return;
  logPurchase({ soundId: state.soundId, typeId: crate.typeId, price: crate.price, itemId, size: state.size });
  learnFromPurchase(state.detection, itemId);
  if (current && current.crateKey === state.crate) { const i = seen.indexOf(current); if (i >= 0) seen.splice(i, 1); current = null; }
  render();
}

// ------------------------------------------------------------------ session summary
// Resets itself after 6 hours without a purchase (a new play session).
function loadSession() {
  const s = store.get('session', null);
  if (!s || !Array.isArray(s.buys) || Date.now() - (s.last || s.start) > 6 * 3600e3) return { start: Date.now(), last: Date.now(), buys: [] };
  return s;
}
let session = loadSession();
function addToSession(price, itemId) {
  session.buys.push({ t: Date.now(), price, itemId });
  session.last = Date.now();
  store.set('session', session);
}
function renderSession() {
  const buys = session.buys.map(b => ({ ...b, item: itemsById.get(b.itemId) })).filter(b => b.item);
  const spent = buys.reduce((a, b) => a + b.price, 0), worth = buys.reduce((a, b) => a + valueOf(b.item), 0);
  const reds = buys.filter(b => b.item.rarity === 6).length, profit = worth - spent;
  if (!buys.length) {
    $('session').innerHTML = `<div class="muted" style="font-size:12.5px">No purchases logged yet. When you buy, confirm the “Purchase spotted” prompt or press <b>Got this</b> on the item — it's tracked here.</div>`;
    return;
  }
  const last = buys[buys.length - 1];
  $('session').innerHTML = `<div class="stats">
      <div class="stat"><div class="k">Crates bought</div><div class="v num">${buys.length}</div></div>
      <div class="stat"><div class="k">Profit</div><div class="v num ${profit >= 0 ? 'good' : 'bad'}">${profit >= 0 ? '+' : '−'}${fmtK(Math.abs(profit))}</div></div>
      <div class="stat"><div class="k">Spent → worth</div><div class="v num" style="font-size:15px">${fmtK(spent)} → ${fmtK(worth)}</div></div>
      <div class="stat"><div class="k">Reds found</div><div class="v num ${reds ? 'red' : ''}">${reds}</div></div>
    </div>
    <div class="lastbuy">Last: <b style="color:var(--r${last.item.rarity})">${esc(last.item.name)}</b> for <span class="num">${fmt(last.price)}</span></div>`;
}

// ------------------------------------------------------------------ sound + playback
function setSound(id, detection = null) {
  state.soundId = id;
  state.detection = detection;
  state.soundMix = detection && detection.alts ? detection.alts : null;
  render();
}

function play(kind) {
  const s = soundsById.get(state.soundId);
  if (!s) return;
  const p = $('player');
  p.src = `/api/refsound/${s[kind]}.ogg`;
  p.play().catch(() => { });
}

// ------------------------------------------------------------------ status pills
function setStatus(dotClass, text) {
  $('status-dot').className = 'dot ' + dotClass;
  $('status-text').textContent = text;
  broadcastLive();
}
function setLevel(v) {
  const n = Math.min(6, Math.round(Math.sqrt(v) * 20));
  [...$('meter').children].forEach((bar, i) => {
    bar.style.height = (3 + (i < n ? (i + 1) * 1.8 : 0)) + 'px';
    bar.className = i < n ? 'lit' : '';
  });
}

async function initAudio() {
  let native = false;
  try { native = !!(await (await fetch('/api/ping', { cache: 'no-store' })).json()).native; } catch (e) { }
  if (!native) {
    setStatus('', 'Open with ABI-Field-Merchant.exe');
    return;
  }
  const devices = await (await fetch('/api/devices')).json().catch(() => []);
  const saved = store.get('source', 'game');
  $('source-select').innerHTML = `<option value="game">Arena Breakout only (recommended)</option>` +
    devices.map(d => `<option value="dev:${esc(d.id)}">Everything on: ${esc(d.name)}</option>`).join('');
  $('source-select').value = [...$('source-select').options].some(o => o.value === saved) ? saved : 'game';
  const sens = store.get('sens', 70);
  $('sens').value = sens; $('sens-val').textContent = sens + '%';
  listener.setSensitivity(sens / 100);
  listener.setFitting(fittingIds());

  listener.on('refs', r => {
    if (!r.ready && r.total) setStatus('wait', r.done >= r.total ? 'Preparing sounds' : `Loading sounds ${r.done}/${r.total}`);
    else if (!r.ready) setStatus('', 'Sounds unavailable (internet needed once)');
  });
  listener.on('status', s => {
    if (s.state === 'listening') setStatus('on', s.source === 'game' ? 'Listening' : 'Listening (device)');
    else if (s.state === 'waiting-game') { setStatus('wait', 'Waiting for game'); setLevel(0); }
    else if (s.state === 'error') setStatus('wait', /activation|Initialize/i.test(s.message || '') ? 'Pick a device in ⚙' : 'Reconnecting');
    else if (s.state === 'paused') setStatus('', 'Paused');
  });
  listener.on('level', setLevel);
  // every detection goes to the exe's app.log, so real game scores can be checked and the matcher tuned
  const logLine = (m) => { try { fetch('/api/log?m=' + encodeURIComponent(m)).catch(() => { }); } catch (e) { } };
  listener.on('confirm', c => {
    logLine(`drop confirmed ${soundLabel(c.soundId || (state.detection || {}).soundId)}`);
    if (state.detection && state.detection.time === c.time) { state.detection.confirmed = true; renderSound(); }
  });
  listener.on('match', m => {
    logLine(`${soundLabel(m.soundId)} [${m.soundId}] score ${(+m.score || 0).toFixed(3)} ${m.method}${m.spec !== undefined ? ' spec ' + (+m.spec).toFixed(2) : ''}`
      + ` -> ${(strength(m) || {}).word}${m.alts ? ' | alts ' + m.alts.map(a => `${soundLabel(a.soundId)} ${(a.w * 100).toFixed(0)}%`).join(', ') : ''}`
      + `${m.outsideCrate ? ' | outside crate' : ''}${state.crate ? ' | crate ' + state.crate : ''}${state.size ? ' ' + state.size : ''}`);
    state.recent.unshift(m);
    state.recent = state.recent.slice(0, 8);
    // the sound belongs to the crate the cursor was just on (dragging starts on a hovered crate)
    if (current && Date.now() - current.at < 20000) { current.soundId = m.soundId; current.mix = m.alts || null; current.match = m; current.at = Date.now(); }
    setSound(m.soundId, m);
    if (state.chime) {
      // red alert (25%+ red chance) beats the good-buy chime
      const st = state.crate ? crateStats(state.profile, state.crate, heard(), state.size || null) : null;
      if (st && !st.empty && st.red >= 0.25) playChime(true);
      else if (state.verdict === 'buy') playChime();
    }
    const card = $('sound-card');
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  });

  initScreen();
  setStatus('wait', 'Loading sounds');
  await listener.loadReferences();
  await loadLearned();
  startSource($('source-select').value);
}

function startSource(val) {
  store.set('source', val);
  if (val.startsWith('dev:')) listener.start('device', val.slice(4));
  else listener.start('game');
}

// ------------------------------------------------------------------ merchant screen (rough draft)
const reader = new MerchantReader();
const seen = [];            // crates hovered this merchant visit: { crateKey, typeId, price, size, soundId, at, cursor }
let current = null;         // the crate the cursor is on (or was on last)
let pendingBuy = null;      // purchase line waiting for the user's confirmation

function setScreenStatus(text, cls) {
  $('screen-status').textContent = text;
  $('screen-dot').className = 'dot ' + (cls || '');
}

function applyHover(h) {
  const crateKey = `${h.typeId}@${h.price}`;
  // same crate as before (still hovering / came back): keep its sound
  const prev = seen.find(s => s.crateKey === crateKey && s.size === h.size && Math.abs(s.cursor.x - h.cursor.x) < 60 && Math.abs(s.cursor.y - h.cursor.y) < 60);
  current = prev || { crateKey, typeId: h.typeId, typeName: h.typeName, price: h.price, size: h.size, soundId: null, cursor: h.cursor };
  current.at = Date.now();
  if (!prev) { seen.unshift(current); if (seen.length > 40) seen.pop(); }
  if (!cratesForProfile(state.profile).some(c => c.key === crateKey)) {
    const others = mapChoices().filter(c => c.profile !== state.profile && cratesForProfile(c.profile).some(x => x.key === crateKey));
    const names = others.slice(0, 3).map(c => `${c.name} ${c.mode}`).join(', ');
    $('screen-note').textContent = `${h.typeName} at ${fmt(h.price)} isn't sold on ${mapLabel(state.mapKey) || 'this map'}${names ? ` — maybe ${names}?` : ''}. Check the map at the top.`;
  } else $('screen-note').textContent = '';
  state.crate = crateKey; store.set('crate', crateKey);
  state.crateFromScreen = true;
  if (h.size) { state.size = h.size; store.set('size', h.size); }
  state.soundId = current.soundId; state.detection = current.match || null; state.soundMix = current.mix || null;
  renderPickers(); render();
}

// Ranking by strategy: max profit (expected profit), red hunting (red chance), safe (chance of profit)
const STRATEGY = {
  profit: { label: 'Max profit', score: st => st.profit, ok: st => st.profit > 0 },
  red: { label: 'Red hunting', score: st => st.red * 1e9 + st.profit, ok: st => st.red > 0 },
  safe: { label: 'Safe', score: st => st.win * 1e9 + st.profit, ok: st => st.profit > 0 && st.win >= 0.5 }
};

function renderSeen() {
  const strat = STRATEGY[state.strategy] || STRATEGY.profit;
  const rows = seen.map(s => ({ s, st: crateStats(state.profile, s.crateKey, s.mix && s.mix.length > 1 ? s.mix : s.soundId, s.size) }))
    .filter(r => r.st && !r.st.empty)
    .sort((a, b) => strat.score(b.st) - strat.score(a.st));
  $('seen-card').style.display = rows.length ? '' : 'none';
  // raid plan: the best crates for the purchases you have left this raid
  const left = Math.max(0, state.buysPerRaid - state.boughtThisRaid);
  const plan = rows.filter(r => strat.ok(r.st)).slice(0, left);
  const planSet = new Set(plan.map(r => r.s));
  if (plan.length) {
    const ev = plan.reduce((a, r) => a + r.st.profit, 0);
    const anyRed = 1 - plan.reduce((a, r) => a * (1 - r.st.red), 1);
    const spend = plan.reduce((a, r) => a + r.st.crate.price, 0);
    $('raid-plan').innerHTML = `<b>Raid plan</b> · buy the ${plan.length === 1 ? 'top crate' : `top ${plan.length}`} below
      → <span class="num ${ev >= 0 ? 'good' : 'bad'}">${ev >= 0 ? '+' : '−'}${fmtK(Math.abs(ev))}</span> expected for <span class="num">${fmtK(spend)}</span>
      ${anyRed > 0 ? `· <span class="redc">${pct(anyRed)}% chance of at least one red</span>` : ''}`;
  } else {
    $('raid-plan').innerHTML = left === 0
      ? `<b>All ${state.buysPerRaid} purchases used this raid.</b> Press “New raid” when you start another.`
      : `<b>Raid plan</b> · nothing here fits “${strat.label}” yet — hover and drag more crates.`;
  }
  $('buys-left').textContent = `${left} of ${state.buysPerRaid} buys left`;
  $('seen-list').innerHTML = rows.slice(0, 10).map((r, i) => {
    const { s, st } = r;
    return `<div class="seen ${s === current ? 'cur' : ''} ${planSet.has(s) ? 'plan' : ''}" data-i="${seen.indexOf(s)}">
      <span class="rk">${planSet.has(s) ? '★' : i + 1}</span>
      <span class="wt">${esc(s.typeName)}<small class="num">${fmt(s.price)}${s.size ? ' · ' + sizeLabel(s.size) : ''} · ${s.soundId ? esc(soundLabel(s.soundId)) : 'not dragged yet'}</small></span>
      <span class="rd">${st.red > 0 ? `red ${pct(st.red)}%` : ''}</span>
      <span class="pf num ${st.profit >= 0 ? 'good' : 'bad'}">${st.profit >= 0 ? '+' : '−'}${fmtK(Math.abs(st.profit))}</span>
    </div>`;
  }).join('');
}

function showBuyPrompt() {
  const el = $('buy-prompt');
  if (!pendingBuy) { el.style.display = 'none'; return; }
  const it = itemsById.get(pendingBuy.itemId);
  el.style.display = '';
  $('buy-text').innerHTML = `Someone got <b style="color:var(--r${it ? it.rarity : 1})">${esc(it ? it.name : '?')}</b> for <b class="num">${fmt(pendingBuy.price)}</b>. Was it you? (${esc(pendingBuy.crate.typeName)}${pendingBuy.crate.soundId ? `, “${esc(soundLabel(pendingBuy.crate.soundId))}” sound` : ''})`;
}

function initScreen() {
  reader.on('status', s => setScreenStatus(s.open ? 'Merchant open' : s.why === 'no-game' ? 'Merchant' : 'Merchant closed', s.open ? 'on' : ''));
  reader.on('hover', applyHover);
  reader.on('feed', f => {
    // The purchase line shows other players' buys too. Strong evidence it's yours: a crate you DRAGGED
    // (its sound was heard) in the last 90 s, same price, and the revealed item fits that crate + sound + size
    // -> logged automatically, with Undo. Weaker evidence (same price, only hovered) -> ask.
    const now = Date.now();
    const fitsCrate = (s) => {
      const st = crateStats(state.profile, s.crateKey, s.mix && s.mix.length > 1 ? s.mix : s.soundId, s.size);
      return !!(st && !st.empty && st.list.some(x => x.item.id === f.itemId));
    };
    const strong = seen.find(s => s.price === f.price && s.match && now - s.match.time < 90000 && fitsCrate(s));
    if (strong) { autoLog(strong, f); return; }
    const c = seen.find(s => s.price === f.price && now - s.at < 180000);
    const crate = c && crateOdds(state.profile, c.crateKey);
    if (!c || !crate || !crate.odds.has(f.itemId)) return;
    pendingBuy = { ...f, crate: c };
    showBuyPrompt();
  });
  setScreenStatus('Merchant', '');
  reader.start();
}

// ------------------------------------------------------------------ automatic game-data updates
async function refreshGameData() {
  try {
    const res = await fetch('/api/merchantpage', { cache: 'no-store' });
    if (!res.ok) return;
    const fetched = (res.headers.get('X-Fetched') || new Date().toISOString()).slice(0, 10);
    const d = extractMerchantData(await res.text(), fetched);
    const problem = validateGameData(d);
    if (problem) { console.warn('game data update skipped:', problem); return; }
    if (dataSignature(d) === dataSignature(GAME_DATA)) {
      if (fetched > (GAME_DATA.fetched || '')) { GAME_DATA.fetched = fetched; renderDataInfo('up to date'); }
      return;
    }
    store.set('gamedata', d);
    $('data-text').innerHTML = `abibuilder.com has new merchant data (${d.items.length} items, ${d.pools.length} crate pools) — maybe a new season. Your odds will use it from now on.`;
    $('data-notice').style.display = '';
  } catch (e) { /* offline: keep what we have */ }
}

function renderDataInfo(extra) {
  const src = (GAME_DATA.fetched || '') > BUILT_IN_FETCHED ? 'updated automatically' : 'built in';
  $('data-info').innerHTML = `Merchant odds from abibuilder.com, ${esc(GAME_DATA.fetched || 'unknown date')} (${src}${extra ? ', ' + extra : ''}).
    ${GAME_DATA.items.length} items · ${GAME_DATA.sounds.length} sounds · ${GAME_DATA.pools.length} crate pools. Checked for updates every start.`;
  $('mine-info').textContent = purchases.mine.length
    ? `${purchases.mine.length} of your purchases help refine the odds (stored on this PC only).`
    : 'None yet. Logged purchases stay on this PC and refine the odds.';
  $('learned-info').textContent = learnedStats.clips
    ? `${learnedStats.clips} recordings of ${learnedStats.sounds} sound${learnedStats.sounds === 1 ? '' : 's'} from your own game, used as extra references (up to ${LEARN_MAX} per sound, on this PC).`
    : 'None yet. Each crate you buy teaches the app how that sound really plays on your PC.';
}

// ------------------------------------------------------------------ events
const openDrawer = (open) => { $('settings').classList.toggle('open', open); $('scrim').classList.toggle('open', open); if (open) renderDataInfo(); };
$('settings-btn').addEventListener('click', () => openDrawer(true));
$('mini-btn').addEventListener('click', () => fetch('/api/mini', { cache: 'no-store' }).catch(() => { }));
fetch('/api/autostart', { cache: 'no-store' }).then(r => r.json()).then(j => { $('autostart').checked = !!j.on; }).catch(() => { $('autostart').disabled = true; });
$('autostart').addEventListener('change', e => fetch('/api/autostart?set=' + (e.target.checked ? 1 : 0), { cache: 'no-store' })
  .then(r => r.json()).then(j => { $('autostart').checked = !!j.on; }).catch(() => { }));
$('settings-close').addEventListener('click', () => openDrawer(false));
$('scrim').addEventListener('click', () => openDrawer(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') openDrawer(false); });

$('map-select').addEventListener('change', e => {
  const c = mapChoices().find(x => x.key === e.target.value); if (!c) return;
  state.mapKey = c.key; state.profile = c.profile; store.set('map', c.key); store.set('profile', c.profile);
  renderPickers(); render();
});
$('crate-select').addEventListener('change', e => { state.crate = e.target.value; state.crateFromScreen = false; store.set('crate', state.crate); render(); });
$('size-picker').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.size = b.dataset.size; store.set('size', state.size); render();
});
$('items').addEventListener('click', e => { const b = e.target.closest('button.got'); if (b) recordPurchase(Number(b.dataset.item)); });
$('manual-sound').addEventListener('change', e => setSound(e.target.value ? Number(e.target.value) : null));
$('sound-alts').addEventListener('click', e => {
  const a = e.target.closest('.alt'); if (!a) return;
  const id = Number(a.dataset.id);
  setSound(id, state.detection ? { ...state.detection, soundId: id, alts: null } : null);
});
$('recent').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) setSound(Number(c.dataset.id), state.recent.find(r => r.soundId === Number(c.dataset.id))); });
$('play-pickup').addEventListener('click', () => play('pickup'));
$('play-drop').addEventListener('click', () => play('drop'));
$('seen-list').addEventListener('click', e => {
  const row = e.target.closest('.seen'); if (!row) return;
  const s = seen[Number(row.dataset.i)]; if (!s) return;
  current = s; state.crate = s.crateKey; state.size = s.size; state.soundId = s.soundId; state.crateFromScreen = true;
  renderPickers(); render();
});
$('seen-clear').addEventListener('click', () => { seen.length = 0; current = null; state.boughtThisRaid = 0; render(); });
const syncSeg = (id, val) => [...$(id).children].forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
$('strategy-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.strategy = b.dataset.v; store.set('strategy', state.strategy); syncSeg('strategy-seg', state.strategy); render();
});
$('buys-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.buysPerRaid = Number(b.dataset.v); store.set('buys-per-raid', state.buysPerRaid); syncSeg('buys-seg', state.buysPerRaid); render();
});
$('buy-yes').addEventListener('click', () => {
  if (pendingBuy) {
    const c = pendingBuy.crate;
    logPurchase({ soundId: c.soundId, typeId: c.typeId, price: c.price, itemId: pendingBuy.itemId, size: c.size });
    learnFromPurchase(c.match, pendingBuy.itemId);
    const i = seen.indexOf(c); if (i >= 0) seen.splice(i, 1);
  }
  pendingBuy = null; showBuyPrompt(); render();
});

// Auto-recorded purchase: logged right away, with a short Undo window
let autoUndo = null;
function autoLog(c, f) {
  const rec = logPurchase({ soundId: c.soundId, typeId: c.typeId, price: c.price, itemId: f.itemId, size: c.size });
  learnFromPurchase(c.match, f.itemId);
  const i = seen.indexOf(c); if (i >= 0) seen.splice(i, 1);
  if (current === c) current = null;
  const it = itemsById.get(f.itemId);
  $('auto-text').innerHTML = `<b style="color:var(--r${it ? it.rarity : 1})">${esc(it ? it.name : '?')}</b> from ${esc(c.typeName)} for <b class="num">${fmt(c.price)}</b>`;
  $('auto-toast').style.display = '';
  clearTimeout(autoUndo && autoUndo.timer);
  autoUndo = { rec, crate: c, timer: setTimeout(() => { $('auto-toast').style.display = 'none'; autoUndo = null; }, 12000) };
  render();
}
$('auto-undo').addEventListener('click', () => {
  if (!autoUndo) return;
  unlogPurchase(autoUndo.rec);
  if (!seen.includes(autoUndo.crate)) seen.unshift(autoUndo.crate);
  clearTimeout(autoUndo.timer); autoUndo = null;
  $('auto-toast').style.display = 'none';
  render();
});
$('buy-no').addEventListener('click', () => { pendingBuy = null; showBuyPrompt(); });
$('data-apply').addEventListener('click', () => location.reload());
$('data-later').addEventListener('click', () => { $('data-notice').style.display = 'none'; });
// Export every purchase you logged (all sessions) as a CSV spreadsheet
$('session-export').addEventListener('click', () => {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Time', 'Map', 'Crate', 'Price', 'Size', 'Sound', 'Item', 'Rarity', 'Hand-in value', 'Market value', 'Profit (hand-in)']];
  for (const r of purchases.mine) {
    const it = itemsById.get(r.itemId), d = new Date(r.t);
    rows.push([d.toLocaleDateString(), d.toLocaleTimeString(), r.map ? r.map.replace('|', ' · ') : (r.profile || ''), GAME_DATA.types[r.typeId] || r.typeId, r.price, r.size || '',
      r.soundId ? soundLabel(r.soundId) : '', it ? it.name : r.itemId, it ? ['', 'white', 'green', 'blue', 'purple', 'gold', 'red'][it.rarity] : '',
      it ? it.value : '', it ? it.market || '' : '', it ? it.value - r.price : '']);
  }
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `abi-purchases-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('session-reset').addEventListener('click', () => { session = { start: Date.now(), last: Date.now(), buys: [] }; store.set('session', session); render(); });

$('source-select').addEventListener('change', e => startSource(e.target.value));
const syncValueSeg = () => [...$('value-seg').children].forEach(b => b.classList.toggle('on', b.dataset.v === state.valueMode));
$('value-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.valueMode = b.dataset.v; store.set('value', state.valueMode); syncValueSeg(); render();
});
$('chime').checked = state.chime;
$('chime').addEventListener('change', e => { state.chime = e.target.checked; store.set('chime', state.chime); if (state.chime) playChime(); });
$('sens').addEventListener('input', e => { const v = Number(e.target.value); $('sens-val').textContent = v + '%'; listener.setSensitivity(v / 100); store.set('sens', v); });
// Self-check: the exe's checks (Windows, game window, capture, text reading, F8, sound files) + what the page knows
$('selfcheck-btn').addEventListener('click', async () => {
  const box = $('selfcheck');
  box.innerHTML = '<div class="check info"><span class="ic">…</span><span>Checking…</span></div>';
  const items = [];
  try {
    const r = await (await fetch('/api/selfcheck', { cache: 'no-store' })).json();
    items.push(...r.items);
  } catch (e) {
    items.push({ status: 'warn', text: 'The app\'s background part isn\'t answering. Close this window and start ABI-Field-Merchant.exe again.' });
  }
  const audio = $('status-text').textContent;
  items.push(/Listening/.test(audio) ? { status: 'ok', text: `Game audio: ${audio.toLowerCase()}.` }
    : /Waiting/.test(audio) ? { status: 'info', text: 'Game audio: waiting for Arena Breakout to start.' }
      : { status: 'warn', text: `Game audio: ${audio}. If this doesn't change, pick your headset/speakers under “Listen to” below.` });
  items.push(/open/.test($('screen-status').textContent)
    ? { status: 'ok', text: 'Merchant screen: being read.' }
    : { status: 'info', text: 'Merchant screen: not seen right now (open the Field Merchant in-game; the game must be in Borderless Window).' });
  items.push({ status: 'ok', text: `Odds data from ${GAME_DATA.fetched || 'unknown date'} · ${learnedStats.clips} learned sound recording${learnedStats.clips === 1 ? '' : 's'} · ${purchases.mine.length} logged purchase${purchases.mine.length === 1 ? '' : 's'}.` });
  const icon = { ok: '✓', warn: '!', info: 'i' };
  box.innerHTML = items.map(i => `<div class="check ${i.status}"><span class="ic">${icon[i.status] || 'i'}</span><span>${esc(i.text)}</span></div>`).join('');
});

$('forget-learned').addEventListener('click', async () => {
  if (!learnedStats.clips || !confirm('Forget all sounds learned from your purchases? This cannot be undone.')) return;
  await idb.clear().catch(() => { });
  await refreshLearnedStats([]);
  alert('Forgotten. Restart the app to stop using them in this session.');
});
$('forget-mine').addEventListener('click', () => {
  if (!purchases.mine.length || !confirm('Forget all purchases you logged on this PC? This cannot be undone.')) return;
  purchases.mine = []; store.set('my-purchases', []); renderDataInfo(); render();
});

// ------------------------------------------------------------------ start
{ // pick a valid map: the saved one, else the first map of the saved group, else the first map
  const choices = mapChoices();
  const c = choices.find(x => x.key === state.mapKey) || choices.find(x => x.profile === state.profile) || choices[0];
  state.mapKey = c.key; state.profile = c.profile;
}
if (state.size && !SIZES.includes(state.size)) state.size = '';
syncValueSeg();
syncSeg('strategy-seg', state.strategy);
syncSeg('buys-seg', state.buysPerRaid);
renderPickers();
render();
renderDataInfo();
initAudio();
loadSharedPurchases();
refreshGameData();

// ?demo: fill the screen with a sample situation (for screenshots); nothing is saved
if (new URLSearchParams(location.search).has('demo')) {
  store.set = () => { };
  state.mapKey = 'Farm|Forbidden'; state.profile = 2; renderPickers();
  const hov = (t, n, p, s, x, y) => applyHover({ typeId: t, typeName: n, price: p, size: s, at: Date.now(), cursor: { x, y } });
  const hear = (id, c) => listener.listeners.match.forEach(cb => cb({ time: Date.now(), soundId: id, kind: 'pickup', method: 'exact', score: 0.95, confidence: c }));
  setTimeout(() => {
    hov(100022, 'Mystery Cargo', 70000, '1x2', 1500, 800); hear(28, 96);
    hov(100026, 'Rare Mystery Cargo', 470000, '2x3', 1600, 400); hear(36, 94);
    hov(100026, 'Rare Mystery Cargo', 470000, '2x2', 1800, 600); hear(33, 98);
    session = { start: Date.now(), last: Date.now(), buys: [
      { t: Date.now(), price: 70000, itemId: 408080001 },
      { t: Date.now(), price: 470000, itemId: GAME_DATA.items.find(i => i.name === 'Gem Necklace')?.id || 408080001 }] };
    render();
  }, 300);
}

// debug handle (used by tools/ test pages)
window.__abi = { reader, seen, state, listener, render, crateStats, setSound, idb };

// When a newer build of the app takes over the server, reload this window onto it.
(async () => {
  let build = null;
  try { build = (await (await fetch('/api/ping', { cache: 'no-store' })).json()).build; } catch (e) { }
  if (!build) return;
  setInterval(async () => {
    try {
      const b = (await (await fetch('/api/ping', { cache: 'no-store' })).json()).build;
      if (b && b !== build) location.reload();
    } catch (e) { /* server restarting */ }
  }, 2000);
})();
