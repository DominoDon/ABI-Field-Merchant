// ABI Field Merchant - pick map + crate (or hover it in-game), drag the crate, see what it can be.
import { GAME_DATA } from './data.js';
import { extractMerchantData, validateGameData, dataSignature } from './merchantData.js';
import { WorkerListener } from './audioListener.js';
import { MerchantReader } from './screen.js';
import { fmt, fmtK, pct, esc, signed, signedPct } from './format.js';
import { Session, discordText } from './session.js';
import { decisionHtml, itemRowsHtml, seenRowHtml, SEEN_HEAD, tone } from './views.js';
import { fetchSharedPurchases, refineWithPurchases } from './purchaseOdds.js';

const $ = (id) => document.getElementById(id);
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

// all audio work runs in a background worker (audioListener.js WorkerListener) so this window never freezes
const listener = new WorkerListener();

const itemsById = new Map(GAME_DATA.items.map(i => [i.id, i]));
// one line to the exe's app.log (detections, grabs), so real game behaviour can be checked and tuned
function logLine(m) { try { fetch('/api/log?m=' + encodeURIComponent(m)).catch(() => { }); } catch (e) { } }
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
// Return on what you pay (crateStats result): "+24%"
const roiText = (st) => signedPct(st.profit / st.cost);
// Your alert (thresholds in Settings) for a crate whose sound was heard: 'red' beats 'good'; null = none.
// Derived from the odds every time, so it follows the crate in focus and threshold changes by itself.
function alertFor(st, heardSound) {
  if (!heardSound || !st || st.empty) return null;
  if (st.red > 0 && st.red >= state.alertRed / 100) return 'red';
  return (state.alertProfit > 0 ? st.profit >= state.alertProfit : st.tag === 'buy') ? 'good' : null;
}
// How much to trust the red chance of the crate in focus: the sound match, whether the size is known, and
// how many real purchases back the odds up.
function redConfidence(st) {
  let pts = 0; const why = [];
  const d = state.detection, sd = d && d.soundId === state.soundId ? strength(d) : null;
  if (Array.isArray(heard())) why.push('close call between sounds');
  else if (sd && sd.level >= 0.8) { pts += 2; why.push(`sound ${sd.word.toLowerCase()}`); }
  else if (sd) { pts += 1; why.push(`sound ${sd.word.toLowerCase()}`); }
  else if (state.soundId) { pts += 1; why.push('sound chosen by hand'); }
  else why.push('no sound heard yet');
  if (state.size) { pts += 1; why.push('size known'); } else why.push('size unknown');
  if (st.refined && st.refined.n >= 5) { pts += 1; why.push(`${st.refined.n} real purchases`); }
  return { level: pts >= 3 ? 'high' : pts === 2 ? 'medium' : 'low', why: why.join(', ') };
}

const state = {
  profile: store.get('profile', GAME_DATA.profiles[0].id),
  mapKey: store.get('map', ''),       // "Farm|Lockdown"
  crate: '',                          // "typeId@price" or '': every merchant visit starts fresh (stock changes)
  size: '',                           // rotation-normalised "1x2" etc., or '' for any
  soundId: null,
  detection: null,
  recent: [],
  valueMode: store.get('value', 'contact'), // 'contact' (trader hand-in) or 'market'
  chime: store.get('chime', true),
  buysPerRaid: store.get('buys-per-raid', 4),  // 2 normally, up to 4 with perks
  strategy: store.get('strategy', 'profit'),   // 'profit' | 'red' | 'safe'
  boughtThisRaid: 0,
  alertRed: store.get('alert-red', 25),        // alert at this red chance (%) or more
  alertProfit: store.get('alert-profit', 0),   // alert at this expected profit (Koen) or more; 0 = on every BUY
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
// `paid`: what you actually pay when the merchant has it on sale (the odds stay those of the original price);
// by default the sale price read from the screen for the crate in focus.
function crateStats(profile, crateKey, sound, size, paid) {
  const crate = crateOdds(profile, crateKey);
  if (!crate) return null;
  const cost = paid || (crateKey === state.crate && state.crateFromScreen && state.paid) || crate.price;
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
  const refined = single ? refineWithPurchases(list, crate.typeId, crate.price, single, purchases) : null;
  const ev = list.reduce((a, x) => a + x.p * valueOf(x.item), 0);
  const win = list.reduce((a, x) => a + (valueOf(x.item) > cost ? x.p : 0), 0);
  const red = list.reduce((a, x) => a + (x.item.rarity === 6 ? x.p : 0), 0);
  const profit = ev - cost;
  const tag = profit > 0 && win >= 0.5 ? 'buy' : profit > 0 ? 'maybe' : 'skip';
  list.sort((a, b) => b.p - a.p || valueOf(b.item) - valueOf(a.item));
  return { crate, cost, list, refined, ev, win, red, profit, tag };
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
    const paidNow = state.crateFromScreen ? state.paid : 0;
    $('crate-sub').innerHTML = `<span class="koen num">${KOEN}${priceHtml(paidNow, crate.price)}</span>${paidNow && paidNow < crate.price ? '<span class="sale">On sale</span>' : ''}<span class="muted">· ${n} possible items</span>`;
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
  const live = s && d && d.soundId === s.id ? strength(d) : null;
  // how sure the sound match is (not the red chance's confidence): a tag beside the sound name
  $('sound-name').innerHTML = !s ? 'Drag a crate in the game'
    : `${esc(s.name)}<span class="cert ${live && live.level < 0.8 ? 'weak' : ''}">${live ? live.word : 'By hand'}</span>`;
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

// ------------------------------------------------------------------ rendering: decision strip + items (views.js)
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
      // realistic range: the middle 80% of outcomes (10th..90th percentile of value, weighted by odds)
      const byVal = list.map(x => ({ v: valueOf(x.item), p: x.p })).sort((a, b) => a.v - b.v);
      const pctl = (q) => { let acc = 0; for (const x of byVal) { acc += x.p; if (acc >= q - 1e-9) return x.v; } return byVal.length ? byVal[byVal.length - 1].v : 0; };
      vc.innerHTML = decisionHtml({
        tag: st.tag, alert: alertFor(st, sid), items: list.length,
        crumb: [GAME_DATA.types[crate.typeId] || 'Crate', sid ? soundLabel(sid) : 'no sound yet', state.size ? sizeLabel(state.size) : 'any size'], priceHtml: priceHtml(st.cost, st.crate.price),
        chips: [sid ? '' : '<span class="tagc">Before the sound — drag it to narrow down</span>',
          st.refined ? `<span class="tagc gold" title="Odds adjusted with real purchase results for this crate and sound">Refined by ${st.refined.n} real purchase${st.refined.n === 1 ? '' : 's'}${st.refined.mine ? ` (${st.refined.mine} yours)` : ''}</span>` : ''],
        profit: st.profit, roi: roiText(st), red: st.red, conf: st.red > 0 ? redConfidence(st) : null,
        ev: st.ev, valueWord: state.valueMode === 'market' ? 'market ' : '', costHtml: priceHtml(st.cost, st.crate.price),
        range: byVal.length ? [pctl(0.1), pctl(0.9)] : [0, 0], win: st.win
      });
      const mix = heard();
      title = Array.isArray(mix) ? `What “${mix.map(m => soundLabel(m.soundId)).join("” or “")}” can be (blended)` : sid ? `What the “${soundLabel(sid)}” sound can be` : "Everything this crate can hold";
    }
  }

  $('items-title').textContent = title;
  $('items-count').textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
  const canLog = !!(crate && sid);
  $('items').classList.toggle('no-odds', !list.length || list[0].p === null);
  $('items').innerHTML = list.length ? itemRowsHtml(list.slice(0, 60), { valueOf, iconSrc, canLog, sizeText: (it) => sizeLabel(sizeKey(it.size)) })
    : `<div class="items-empty">${crate ? 'Nothing fits this choice.' : 'Items appear here once you pick a crate or a sound is heard.'}</div>`;
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
      crate: crate ? `${GAME_DATA.types[crate.typeId]} · ${state.crateFromScreen && state.paid && state.paid < crate.price ? `${fmt(state.paid)} (sale, was ${fmt(crate.price)})` : fmt(crate.price)}${state.size ? ' · ' + sizeLabel(state.size) : ''}` : null,
      verdict: st && !st.empty ? { tag: st.tag, profit: st.profit, red: st.red, roi: roiText(st), alert: alertFor(st, state.soundId), conf: st.red > 0 ? redConfidence(st).level : null } : null,
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
// "56,000 70,000" (original struck through) when on sale
const priceHtml = (paid, price) => paid && paid < price
  ? `${fmt(paid)} <s class="was">${fmt(price)}</s>` : fmt(price);
// your own purchases (this PC) + the public base of neverh8me/abi-merchant-helper refine the odds (purchaseOdds.js)
const purchases = { shared: store.get('shared-purchases', []), mine: store.get('my-purchases', []) };

function logPurchase({ soundId, typeId, price, paid, itemId, size }) {
  const rec = { soundId, typeId, price, itemId, size, profile: state.profile, map: state.mapKey, t: Date.now() };
  if (paid && paid < price) rec.paid = paid; // bought on sale (price stays the pool price: it keys the odds)
  purchases.mine.push(rec);
  store.set('my-purchases', purchases.mine);
  session.add(rec.paid || price, itemId, typeId);
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
  session.remove(rec);
  state.boughtThisRaid = Math.max(0, state.boughtThisRaid - 1);
}

function recordPurchase(itemId) {
  const crate = crateOdds(state.profile, state.crate);
  if (!crate || !state.soundId) return;
  logPurchase({ soundId: state.soundId, typeId: crate.typeId, price: crate.price, paid: state.crateFromScreen ? state.paid : 0, itemId, size: state.size });
  learnFromPurchase(state.detection, itemId);
  if (current && current.crateKey === state.crate) { const i = seen.indexOf(current); if (i >= 0) seen.splice(i, 1); current = null; }
  render();
}

// ------------------------------------------------------------------ session summary (session.js)
const session = new Session(store);
const typeName = (id) => GAME_DATA.types[id] || '';
function renderSession() {
  const sum = session.summary(itemsById, valueOf);
  if (!sum.last) {
    $('session').innerHTML = `<div class="muted" style="font-size:12.5px">No purchases logged yet. When you buy, confirm the “Purchase spotted” prompt or press <b>Got this</b> on the item — it's tracked here.</div>`;
    return;
  }
  const item = (b) => `<b style="color:var(--r${b.item.rarity})">${esc(b.item.name)}</b>`;
  const pl = (n) => `<span class="num ${tone(n)}">${signed(n)}</span>`;
  $('session').innerHTML = `<div class="stats">
      <div class="stat"><div class="k">Crates bought</div><div class="v num">${sum.buys.length}</div></div>
      <div class="stat"><div class="k">Profit</div><div class="v num ${tone(sum.profit)}">${signed(sum.profit)}</div></div>
      <div class="stat"><div class="k">Spent → worth</div><div class="v num" style="font-size:15px">${fmtK(sum.spent)} → ${fmtK(sum.worth)}</div></div>
      <div class="stat"><div class="k">Reds found</div><div class="v num ${sum.reds.length ? 'red' : ''}">${sum.reds.length}</div></div>
    </div>
    ${sum.best ? `<div class="bw">
      <div><span class="k">Best buy</span>${item(sum.best)} ${pl(sum.best.profit)}</div>
      <div><span class="k">Worst buy</span>${item(sum.worst)} ${pl(sum.worst.profit)}</div>
    </div>` : ''}
    <div class="lastbuy">Last: ${item(sum.last)} for <span class="num">${fmt(sum.last.price)}</span></div>`;
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
    // a crate grabbed in the last 4 s owns this sound; otherwise the crate the cursor was just on
    const grabbed = seen.find(s => s.dragAt && Date.now() - s.dragAt < 4000);
    if (grabbed && grabbed !== current) {
      current = grabbed; state.crate = grabbed.crateKey; state.size = grabbed.size || ''; state.paid = grabbed.paid || 0; state.crateFromScreen = true;
    }
    if (current && Date.now() - current.at < 20000) { current.soundId = m.soundId; current.mix = m.alts || null; current.match = m; current.at = Date.now(); }
    setSound(m.soundId, m);
    // your alert for this crate (the verdict and its Best buys row light up as they render); chime if wanted
    const st = state.crate ? crateStats(state.profile, state.crate, heard(), state.size || null) : null;
    const alert = alertFor(st, m.soundId);
    // chime only at the merchant: item drags in your stash or a raid make sounds too
    if (alert) { logLine(`alert ${alert}: red ${pct(st.red)}%, profit ${Math.round(st.profit)}${reader.merchantOpen ? '' : ' (merchant closed: no chime)'}`); if (state.chime && reader.merchantOpen) playChime(alert === 'red'); }
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
  // a measured size that nothing in this crate comes in is a misread: treat it as unknown
  const fit = h.size ? crateStats(state.profile, crateKey, null, h.size) : null;
  if (fit && fit.empty) { logLine(`size ${h.size} impossible for ${h.typeName} ${h.price}: ignored`); h = { ...h, size: '' }; }
  // same crate as before (still hovering / came back): keep its sound
  const prev = seen.find(s => s.crateKey === crateKey && s.size === h.size && Math.abs(s.cursor.x - h.cursor.x) < 60 && Math.abs(s.cursor.y - h.cursor.y) < 60);
  current = prev || { crateKey, typeId: h.typeId, typeName: h.typeName, price: h.price, size: h.size, soundId: null, cursor: h.cursor };
  current.at = Date.now();
  if (h.paid) current.paid = h.paid;
  state.paid = current.paid || 0;
  if (!prev) { seen.unshift(current); if (seen.length > 40) seen.pop(); }
  if (!cratesForProfile(state.profile).some(c => c.key === crateKey)) {
    const others = mapChoices().filter(c => c.profile !== state.profile && cratesForProfile(c.profile).some(x => x.key === crateKey));
    const names = others.slice(0, 3).map(c => `${c.name} ${c.mode}`).join(', ');
    $('screen-note').textContent = `${h.typeName} at ${fmt(h.price)} isn't sold on ${mapLabel(state.mapKey) || 'this map'}${names ? ` — maybe ${names}?` : ''}. Check the map at the top.`;
  } else $('screen-note').textContent = '';
  state.crate = crateKey;
  state.crateFromScreen = true;
  // no size read for this crate: clear it rather than keep the previous crate's size (that narrowed the odds wrongly)
  state.size = h.size || '';
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
  const rows = seen.map(s => ({ s, st: crateStats(state.profile, s.crateKey, s.mix && s.mix.length > 1 ? s.mix : s.soundId, s.size, s.paid) }))
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
    const spend = plan.reduce((a, r) => a + r.st.cost, 0);
    $('raid-plan').innerHTML = `<b>Raid plan</b> · buy the ${plan.length === 1 ? 'top crate' : `top ${plan.length}`} below
      → <span class="num ${tone(ev)}">${signed(ev)}</span> expected for <span class="num">${fmtK(spend)}</span>
      ${anyRed > 0 ? `· <span class="redc">${pct(anyRed)}% chance of at least one red</span>` : ''}`;
  } else {
    $('raid-plan').innerHTML = left === 0
      ? `<b>All ${state.buysPerRaid} purchases used this raid.</b> Press “New raid” when you start another.`
      : `<b>Raid plan</b> · nothing here fits “${strat.label}” yet — hover and drag more crates.`;
  }
  $('buys-left').textContent = `${left} of ${state.buysPerRaid} buys left`;
  $('seen-list').innerHTML = SEEN_HEAD + rows.slice(0, 10).map(({ s, st }, i) => seenRowHtml({
    i: seen.indexOf(s), rank: i + 1, plan: planSet.has(s), cur: s === current && s.crateKey === state.crate, alert: alertFor(st, s.soundId), name: s.typeName,
    sub: `${priceHtml(s.paid, s.price)}${s.size ? ' · ' + sizeLabel(s.size) : ''} · ${s.soundId ? esc(soundLabel(s.soundId)) : 'not dragged yet'}`,
    red: st.red, profit: st.profit, roi: roiText(st)
  })).join('');
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
  // a crate grabbed in the game: it owns the next sound (see the match handler)
  reader.on('drag', d => {
    applyHover(d);
    if (current) { current.dragAt = Date.now(); if (state.size) current.size = state.size; }
    logLine(`grabbed ${d.typeName} ${d.price}${d.paid && d.paid < d.price ? ' (on sale ' + d.paid + ')' : ''}${d.size ? ' ' + d.size : ''}`);
  });
  reader.on('feed', f => {
    // The purchase line shows other players' buys too. Strong evidence it's yours: a crate you DRAGGED
    // (its sound was heard) in the last 90 s, same price, and the revealed item fits that crate + sound + size
    // -> logged automatically, with Undo. Weaker evidence (same price, only hovered) -> ask.
    const now = Date.now();
    const fitsCrate = (s) => {
      const st = crateStats(state.profile, s.crateKey, s.mix && s.mix.length > 1 ? s.mix : s.soundId, s.size);
      return !!(st && !st.empty && st.list.some(x => x.item.id === f.itemId));
    };
    const spentOn = (s) => (s.paid || s.price) === f.price || s.price === f.price; // the line shows what was spent
    const strong = seen.find(s => spentOn(s) && s.match && now - s.match.time < 90000 && fitsCrate(s));
    if (strong) { autoLog(strong, f); return; }
    const c = seen.find(s => spentOn(s) && now - s.at < 180000);
    const crate = c && crateOdds(state.profile, c.crateKey);
    if (!c || !crate || !crate.odds.has(f.itemId)) return;
    pendingBuy = { ...f, crate: c };
    showBuyPrompt();
  });
  setScreenStatus('Merchant', '');
  reader.log = logLine;
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
fetch('/api/ping', { cache: 'no-store' }).then(r => r.json()).then(j => { if (j.version) $('app-version').textContent = 'Version ' + j.version; }).catch(() => { });
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
$('crate-select').addEventListener('change', e => { state.crate = e.target.value; state.crateFromScreen = false; state.paid = 0; render(); });
$('size-picker').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.size = b.dataset.size; render();
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
  current = s; state.crate = s.crateKey; state.size = s.size; state.soundId = s.soundId; state.crateFromScreen = true; state.paid = s.paid || 0;
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
    logPurchase({ soundId: c.soundId, typeId: c.typeId, price: c.price, paid: c.paid, itemId: pendingBuy.itemId, size: c.size });
    learnFromPurchase(c.match, pendingBuy.itemId);
    const i = seen.indexOf(c); if (i >= 0) seen.splice(i, 1);
  }
  pendingBuy = null; showBuyPrompt(); render();
});

// Auto-recorded purchase: logged right away, with a short Undo window
let autoUndo = null;
function autoLog(c, f) {
  const rec = logPurchase({ soundId: c.soundId, typeId: c.typeId, price: c.price, paid: c.paid, itemId: f.itemId, size: c.size });
  learnFromPurchase(c.match, f.itemId);
  const i = seen.indexOf(c); if (i >= 0) seen.splice(i, 1);
  if (current === c) current = null;
  const it = itemsById.get(f.itemId);
  $('auto-text').innerHTML = `<b style="color:var(--r${it ? it.rarity : 1})">${esc(it ? it.name : '?')}</b> from ${esc(c.typeName)} for <b class="num">${fmt(c.paid || c.price)}</b>`;
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
    rows.push([d.toLocaleDateString(), d.toLocaleTimeString(), r.map ? r.map.replace('|', ' · ') : (r.profile || ''), GAME_DATA.types[r.typeId] || r.typeId, r.paid || r.price, r.size || '',
      r.soundId ? soundLabel(r.soundId) : '', it ? it.name : r.itemId, it ? ['', 'white', 'green', 'blue', 'purple', 'gold', 'red'][it.rarity] : '',
      it ? it.value : '', it ? it.market || '' : '', it ? it.value - (r.paid || r.price) : '']);
  }
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `abi-purchases-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
// a button's label shows the outcome for a moment
const flashLabel = (b, text) => { const was = b.dataset.label || (b.dataset.label = b.textContent); b.textContent = text; setTimeout(() => { b.textContent = was; }, 1800); };
$('session-copy').addEventListener('click', async () => {
  const text = discordText(session.summary(itemsById, valueOf), mapLabel(state.mapKey), typeName);
  if (!text) return flashLabel($('session-copy'), 'Nothing to copy yet');
  try { await navigator.clipboard.writeText(text); flashLabel($('session-copy'), 'Copied ✓'); }
  catch (e) { flashLabel($('session-copy'), 'Copy failed'); }
});
// alert thresholds (whole numbers, clamped; empty profit = alert on every BUY)
for (const [id, key, min, max, empty] of [['alert-red', 'alertRed', 1, 100, 25], ['alert-profit', 'alertProfit', 0, Infinity, 0]]) {
  $(id).value = state[key] || '';
  $(id).addEventListener('change', e => {
    const v = Math.max(min, Math.min(max, Math.round(Number(e.target.value) || empty)));
    e.target.value = v || ''; state[key] = v; store.set(id, v); render();
  });
}
$('session-reset').addEventListener('click', () => { session.reset(); render(); });

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
fetchSharedPurchases(itemsById).then(list => { if (list) { purchases.shared = list; store.set('shared-purchases', list); render(); } });
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
    session.buys = [
      { t: Date.now(), price: 70000, itemId: 408080001 },
      { t: Date.now(), price: 470000, itemId: GAME_DATA.items.find(i => i.name === 'Gem Necklace')?.id || 408080001 }];
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
