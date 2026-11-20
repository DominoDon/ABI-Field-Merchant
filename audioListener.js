// Game-audio listener for Arena Breakout: Infinite's Field Merchant.
//
// Audio comes from Launch-ABI-Companion.exe:
//   /api/loopback?source=game   -> ONLY the game's own audio (Windows process loopback of UAGame.exe)
//   /api/loopback?device=<id>   -> fallback: everything playing on one output device
// Samples arrive as mono float32 over a streaming fetch (keeps running while the window is hidden).
//
// Recognition: the game's real pickup/drop sound files (/api/refsound/*.ogg) are fingerprinted at
// startup with exactly the same detector used on live audio. Each live sound is compared against all
// 76 references; only close matches are reported, so gunfire, footsteps, music etc. are ignored.

import { GAME_DATA } from './data.js';

const BANDS = 64;
const FRAMES = 16;          // spectrogram frames per fingerprint (~360 ms)
const FRAME_N = 2048;       // at 48 kHz: 42.7 ms
const HOP = 1024;           // 21.3 ms
const SR = 48000;
const FLOOR_DB = -60;
// Sounds that need a strong, exact match on their own: #31 (desk clock) is known to be set off by
// speech (real-game calibration in neverh8me/abi-merchant-helper).
const STRICT_SOUNDS = new Set([31]);

// In-game recordings that differ from the abibuilder files (waveform similarity 0.62-0.88), served by the exe
// from a pinned commit of github.com/neverh8me/abi-merchant-helper (library/sounds).
const EXTRA_REFS = [
  { soundId: 22, file: 'small_metal_crisp_up.wav' },
  { soundId: 24, file: 'small_glass_up.wav' },
  { soundId: 29, file: 'coin_up.wav' },
  { soundId: 33, file: 'necklace_up.wav' },
  { soundId: 35, file: 'small_paper_up.wav' }
];

function trimLeadingSilence(x) {
  let peak = 0;
  for (const v of x) if (Math.abs(v) > peak) peak = Math.abs(v);
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < peak * 0.03) i++;
  return x.slice(Math.max(0, i - 240)); // keep 5 ms before the start
}

// ---- Matched filter (waveform correlation at 16 kHz) ----------------------------------------
// The game plays these exact files, so correlating the live waveform with each file is extremely
// noise-robust. It weakens if the game pitch-shifts a sound; the spectrogram stage covers that.
const MF_DEC = 2;                         // 48 kHz -> 24 kHz (bands up to 11.5 kHz, where voice chat is quiet)
const MF_RATE = 48000 / MF_DEC;
const MF_N = 32768;                       // FFT size at 24 kHz (1.37 s)
const MF_REF = Math.round(0.4 * MF_RATE); // first 0.4 s of each reference
const MF_WIN = Math.round(0.624 * MF_RATE); // live window length (0.62 s)
const MF_PRE = Math.round(0.25 * MF_RATE);  // live window starts 0.25 s before the onset
const MF_TAIL = Math.round(0.025 * MF_RATE); // lags in the last 25 ms are not searched

function decimateMF(x, from = 0, count = Math.floor((x.length - from) / MF_DEC)) {
  const y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const k = from + i * MF_DEC;
    y[i] = ((x[k - 1] || 0) + 2 * (x[k] || 0) + (x[k + 1] || 0)) / 4; // light low-pass, then keep every 2nd
  }
  return y;
}

function prepareClip(data48k, soundId, kind) {
  const d = decimateMF(data48k).subarray(0, MF_REF);
  const re = new Float64Array(MF_N), im = new Float64Array(MF_N);
  let e = 0;
  for (let i = 0; i < d.length; i++) { re[i] = d[i]; e += d[i] * d[i]; }
  fftInPlace(re, im);
  return {
    soundId, kind, re: Float32Array.from(re), im: Float32Array.from(im), norm: Math.sqrt(e), len: d.length,
    dur: data48k.length / 48000, band: prepareBands(d)
  };
}

function matchedFilterScores(x, clips) {
  const xr = new Float64Array(MF_N), xi = new Float64Array(MF_N);
  for (let i = 0; i < x.length && i < MF_N; i++) xr[i] = x[i];
  fftInPlace(xr, xi);
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i] * x[i];
  const pr = new Float64Array(MF_N), pi = new Float64Array(MF_N);
  const out = [];
  for (const c of clips) {
    for (let k = 0; k < MF_N; k++) {
      pr[k] = xr[k] * c.re[k] + xi[k] * c.im[k];
      pi[k] = xi[k] * c.re[k] - xr[k] * c.im[k];
    }
    fftInPlace(pr, pi, true);
    // energy floor: never normalise by a near-silent stretch (would inflate scores past 1)
    let maxE = 0;
    for (let lag = 0; lag < x.length - MF_TAIL; lag++) {
      const e = pre[Math.min(x.length, lag + c.len)] - pre[lag];
      if (e > maxE) maxE = e;
    }
    const floorE = maxE * 0.05 + 1e-12;
    let best = 0;
    for (let lag = 0; lag < x.length - MF_TAIL; lag++) {
      const e = Math.max(floorE, pre[Math.min(x.length, lag + c.len)] - pre[lag]);
      const s = pr[lag] / MF_N / (c.norm * Math.sqrt(e));
      if (s > best) best = s;
    }
    const b = c.baseline || 0;
    out.push({ soundId: c.soundId, kind: c.kind, raw: best, score: Math.max(0, (best - b) / (1 - b)) });
  }
  return out;
}

// ---- Band-split matched filter ----------------------------------------------------------------
// Idea credited to neverh8me/abi-merchant-helper (reimplemented here): correlate per frequency band and
// weight each band by how much of the reference's energy it holds. Voice chat or rumble in the low band
// can't hide a sound that lives higher up, and EQ that changes band volumes doesn't break the match.
// A second score from the bands below 4.5 kHz alone rescues sounds whose top end got muffled.
const MF_BANDS = [[40, 900], [900, 2500], [2500, 4500], [4500, 7600], [7600, 11500]];
const LOW_MAX_HZ = 4500;
function biquadCoefs(type, f, q, fs) {
  const w = 2 * Math.PI * f / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b = type === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
  return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * cw / a0, (1 - al) / a0];
}
const BAND_SECTIONS = MF_BANDS.map(([lo, hi]) =>
  [0.5411961, 1.3065630].map(q => biquadCoefs('hp', lo, q, MF_RATE))
    .concat([0.5411961, 1.3065630].map(q => biquadCoefs('lp', hi, q, MF_RATE))));
function splitBands(x) {
  return BAND_SECTIONS.map(secs => {
    let y = Float32Array.from(x);
    for (const [b0, b1, b2, a1, a2] of secs) {
      let z1 = 0, z2 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = y[i], o = b0 * v + z1;
        z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o;
      }
    }
    return y;
  });
}
function prepareBands(d16) {
  const bands = splitBands(d16);
  const e = bands.map(b => { let s = 0; for (const v of b) s += v * v; return s; });
  const total = e.reduce((a, b) => a + b, 0) || 1;
  let w = e.map(v => (v / total < 0.03 ? 0 : v / total));
  const ws = w.reduce((a, b) => a + b, 0) || 1; w = w.map(v => v / ws);
  const lowIdx = MF_BANDS.map(([, hi], i) => (hi <= LOW_MAX_HZ && w[i] ? i : -1)).filter(i => i >= 0);
  const eLow = lowIdx.reduce((a, i) => a + e[i], 0);
  const wlf = MF_BANDS.map((_, i) => (lowIdx.includes(i) && eLow > total * 0.02 ? e[i] / eLow : 0));
  const spec = bands.map((b, i) => {
    if (!w[i] && !wlf[i]) return null;
    const re = new Float64Array(MF_N), im = new Float64Array(MF_N), norm = Math.sqrt(e[i]) || 1;
    for (let k = 0; k < b.length; k++) re[k] = b[k] / norm;
    fftInPlace(re, im);
    return { re: Float32Array.from(re), im: Float32Array.from(im) };
  });
  return { w, wlf, spec };
}
function bandScores(x, clips) {
  const xb = splitBands(x).map(b => {
    const re = new Float64Array(MF_N), im = new Float64Array(MF_N);
    for (let i = 0; i < b.length; i++) re[i] = b[i];
    fftInPlace(re, im);
    const pre = new Float64Array(b.length + 1);
    for (let i = 0; i < b.length; i++) pre[i + 1] = pre[i] + b[i] * b[i];
    let maxE = 0;
    return { re, im, pre, maxE };
  });
  const n = x.length, out = [];
  const zr = new Float64Array(MF_N), zi = new Float64Array(MF_N);
  for (const c of clips) {
    const npos = n - MF_TAIL, full = new Float64Array(npos), low = new Float64Array(npos);
    const used = c.band.spec.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
    for (let u = 0; u < used.length; u += 2) {
      const b1 = used[u], b2 = used[u + 1];
      // two real correlations share one inverse FFT: IFFT(P1 + i*P2) = corr1 + i*corr2
      const X1 = xb[b1], T1 = c.band.spec[b1];
      for (let k = 0; k < MF_N; k++) {
        zr[k] = X1.re[k] * T1.re[k] + X1.im[k] * T1.im[k];
        zi[k] = X1.im[k] * T1.re[k] - X1.re[k] * T1.im[k];
      }
      if (b2 !== undefined) {
        const X2 = xb[b2], T2 = c.band.spec[b2];
        for (let k = 0; k < MF_N; k++) {
          const pr = X2.re[k] * T2.re[k] + X2.im[k] * T2.im[k];
          const pi = X2.im[k] * T2.re[k] - X2.re[k] * T2.im[k];
          zr[k] -= pi; zi[k] += pr;
        }
      }
      fftInPlace(zr, zi, true);
      for (const [b, part] of [[b1, zr], [b2, zi]]) {
        if (b === undefined) continue;
        const X = xb[b];
        let maxE = 0;
        for (let k = 0; k < npos; k++) { const e = X.pre[Math.min(n, k + c.len)] - X.pre[k]; if (e > maxE) maxE = e; }
        const floorE = maxE * 0.05 + 1e-14;
        for (let k = 0; k < npos; k++) {
          const e = Math.max(floorE, X.pre[Math.min(n, k + c.len)] - X.pre[k]);
          const ncc = part[k] / MF_N / Math.sqrt(e);
          full[k] += c.band.w[b] * ncc;
          low[k] += c.band.wlf[b] * ncc;
        }
      }
    }
    let best = 0;
    for (let k = 0; k < npos; k++) { if (full[k] > best) best = full[k]; if (low[k] > best) best = low[k]; }
    const bl = c.baselineBand || 0;
    out.push({ soundId: c.soundId, kind: c.kind, raw: best, score: Math.max(0, (best - bl) / (1 - bl)) });
  }
  return out;
}

// Onset detection bands at 48 kHz (4th-order Butterworth band-pass each)
const ONSET_BANDS = [[40, 900], [900, 2500], [2500, 4500], [4500, 11000]];
const ONSET_SECTIONS = ONSET_BANDS.map(([lo, hi]) =>
  [0.5411961, 1.3065630].map(q => biquadCoefs('hp', lo, q, 48000))
    .concat([0.5411961, 1.3065630].map(q => biquadCoefs('lp', hi, q, 48000))));

function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const HANN = (() => { const w = new Float64Array(FRAME_N); for (let i = 0; i < FRAME_N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME_N - 1)); return w; })();
const BAND_BINS = (() => {
  const lo = 80, hi = 16000, ratio = Math.pow(hi / lo, 1 / BANDS), binHz = SR / FRAME_N, out = [];
  for (let b = 0; b < BANDS; b++) {
    const k0 = Math.max(1, Math.round(lo * Math.pow(ratio, b) / binHz));
    const k1 = Math.max(k0 + 1, Math.round(lo * Math.pow(ratio, b + 1) / binHz));
    out.push([k0, k1]);
  }
  return out;
})();

// Fingerprint = FRAMES x BANDS log-spectrogram (dB) starting just before the onset,
// normalised so its loudest cell is 0 dB (volume-independent), floored at -60 dB.
const re_ = new Float64Array(FRAME_N), im_ = new Float64Array(FRAME_N);
function frameBands(getSample, off, out, o) {
  for (let i = 0; i < FRAME_N; i++) { re_[i] = getSample(off + i) * HANN[i]; im_[i] = 0; }
  fftInPlace(re_, im_);
  for (let b = 0; b < BANDS; b++) {
    const [k0, k1] = BAND_BINS[b];
    let sum = 0;
    for (let k = k0; k < k1; k++) sum += re_[k] * re_[k] + im_[k] * im_[k];
    out[o + b] = 10 * Math.log10(sum / (k1 - k0) + 1e-12);
  }
}

// withNoise: also measure the background spectrum just before the hit (same dB scale), used by
// fpDistance to tell "the reference's quiet tail is buried in game ambience" from "different sound".
export function fingerprintAt(getSample, start, withNoise = false) {
  const fp = new Float32Array(FRAMES * BANDS);
  let max = -Infinity;
  for (let f = 0; f < FRAMES; f++) frameBands(getSample, start + f * HOP, fp, f * BANDS);
  for (let i = 0; i < fp.length; i++) if (fp[i] > max) max = fp[i];
  for (let i = 0; i < fp.length; i++) fp[i] = Math.max(FLOOR_DB, fp[i] - max);
  if (withNoise) {
    const tmp = new Float32Array(BANDS), acc = new Float64Array(BANDS);
    const N = 4;
    for (let k = 0; k < N; k++) {
      frameBands(getSample, start - FRAME_N - 480 - k * HOP, tmp, 0);
      for (let b = 0; b < BANDS; b++) acc[b] += Math.pow(10, tmp[b] / 10);
    }
    const noise = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) noise[b] = 10 * Math.log10(acc[b] / N + 1e-12) - max;
    fp.noise = noise;
  }
  return fp;
}

const dbSum = (a, b) => 10 * Math.log10(Math.pow(10, a / 10) + Math.pow(10, b / 10));

// Distance between a live fingerprint and a reference (dB, lower = closer).
// - compares only cells where the reference actually has energy (background noise elsewhere is ignored)
// - removes the overall level difference (game volume) before comparing
// - tries small timing offsets (onset jitter)
// - penalises strong live energy in places the reference is silent (a different sound)
export function fpDistance(live, ref) {
  const noise = live.noise;
  let best = 99;
  for (let shift = -2; shift <= 2; shift++) {
    // level offset from the reference's strongest cells (least affected by background)
    let n = 0, sumDiff = 0;
    for (let f = 0; f < FRAMES; f++) {
      const lf = f + shift;
      if (lf < 0 || lf >= FRAMES) continue;
      for (let b = 0; b < BANDS; b++) {
        const r = ref[f * BANDS + b];
        if (r > -20) { sumDiff += live[lf * BANDS + b] - r; n++; }
      }
    }
    if (n < 4) continue;
    const offset = sumDiff / n;
    // expected live cell = reference (at live level) + measured background; compare where either is audible
    let err = 0, cnt = 0;
    for (let f = 0; f < FRAMES; f++) {
      const lf = f + shift;
      if (lf < 0 || lf >= FRAMES) continue;
      for (let b = 0; b < BANDS; b++) {
        const r = ref[f * BANDS + b];
        let expect = r > FLOOR_DB ? r + offset : -200;
        if (noise) expect = dbSum(expect, noise[b]);
        expect = Math.max(FLOOR_DB, expect);
        const l = live[lf * BANDS + b];
        if (l <= -45 && expect <= -45) continue;
        err += Math.min(30, Math.abs(l - expect)); cnt++;
      }
    }
    if (cnt < 8) continue;
    const d = err / cnt;
    if (d < best) best = d;
  }
  return best;
}

// Onset detector shared by live audio and reference files.
class OnsetDetector {
  constructor(onOnset, { bands = true } = {}) {
    this.onOnset = onOnset;
    this.hop = 240; // 5 ms
    this.acc = 0; this.sum = 0; this.pos = 0;
    this.last = -1e12;
    this.sensitivity = 0.7;
    // Broadband channel plus one channel per frequency band (idea from abi-merchant-helper): a crate hit that
    // lives in the highs still stands out there while voice chat or music fills the lows.
    this.useBands = bands; // clean reference files only need the broadband channel (5x faster)
    this.ch = [null, ...(bands ? ONSET_BANDS : [])].map(() => ({ sum: 0, floorDb: -90, hist: new Array(8).fill(-120) }));
    this.filt = ONSET_SECTIONS.map(secs => secs.map(() => [0, 0]));
  }
  push(sample) {
    const ch = this.ch;
    ch[0].sum += sample * sample;
    for (let b = 0; this.useBands && b < ONSET_SECTIONS.length; b++) {
      let v = sample;
      const secs = ONSET_SECTIONS[b], st = this.filt[b];
      for (let s = 0; s < secs.length; s++) {
        const [b0, b1, b2, a1, a2] = secs[s], z = st[s];
        const o = b0 * v + z[0];
        z[0] = b1 * v - a1 * o + z[1]; z[1] = b2 * v - a2 * o; v = o;
      }
      ch[b + 1].sum += v * v;
    }
    this.pos++;
    if (++this.acc < this.hop) return null;
    this.acc = 0;
    const rise = 12 - 7 * this.sensitivity;
    const ready = this.pos > SR * 0.3 && this.pos - this.last > SR * 0.25;
    let trig = false, rms0 = 0;
    for (let c = 0; c < ch.length; c++) {
      const k = ch[c], rms = Math.sqrt(k.sum / this.hop);
      k.sum = 0;
      if (c === 0) rms0 = rms;
      const db = 20 * Math.log10(rms + 1e-9);
      // compare with the quietest of the last 40 ms, so slower attacks still count as a hit
      const prev = Math.min(...k.hist);
      k.hist.shift(); k.hist.push(db);
      if (db < k.floorDb) k.floorDb += (db - k.floorDb) * 0.2;
      else k.floorDb += (db - k.floorDb) * 0.002;
      // band channels need a slightly sharper jump (they are noisier) and an absolute level
      const need = c === 0 ? rise : rise + 2;
      if (ready && db > (c === 0 ? -70 : -76) && db - prev > need && db - k.floorDb > need + 2) trig = true;
    }
    if (trig) {
      this.last = this.pos;
      this.onOnset(this.pos - this.hop, rms0);
    }
    return rms0;
  }
}

export class GameAudioListener {
  constructor() {
    this.isListening = false;
    this.source = null;           // 'game' | 'device'
    this.deviceId = null;
    this.specThreshold = 5;       // dB mean difference for the spectrogram fallback
    this.mfMode = 'band';         // 'band' (per-frequency-band correlation) or 'broad'
    this.useDropSounds = false;   // also match "put down" sounds
    this.sizeFits = null;         // optional (soundId) => bool: does this sound fit the chosen crate size? (close-call tie-break)
    this.allowed = null;          // optional Set of sound ids the chosen crate (and size) can make: tried first
    this.lastPickup = null;       // last pick-up match { time, soundId }: drop sounds are only checked right after one
    this.snipQueue = []; this.snippets = new Map(); // recent hits' raw audio, for learning
    this.muteUntil = -Infinity;
    this.refs = [];               // [{ soundId, kind: 'pickup'|'drop', fp }]
    this.refsReady = false;
    this.listeners = { match: [], level: [], status: [], refs: [], confirm: [] };
    this.token = 0;
    this.reset();
  }

  on(evt, cb) { this.listeners[evt].push(cb); }
  emit(evt, data) { this.listeners[evt].forEach(cb => cb(data)); }
  setSensitivity(v) { this.detector.sensitivity = Math.max(0.1, Math.min(1, v)); this.sensitivity = this.detector.sensitivity; }

  reset() {
    this.ringSize = 1 << 16; // 1.36 s
    this.ring = new Float32Array(this.ringSize);
    this.written = 0;
    this.pending = [];
    this.levelAcc = 0; this.levelPeak = 0;
    this.muteUntil = -Infinity;
    this.snipQueue = []; // sample positions restart with a new stream
    const sens = this.detector ? this.detector.sensitivity : 0.7;
    this.detector = new OnsetDetector((pos, rms) => this.pending.push({ onset: pos, start: pos - 480, rms }));
    this.detector.sensitivity = sens;
  }

  // ---------------------------------------------------------------- references
  // Fetch + decode the 76 reference files (needs the page: workers can't decode audio).
  // Returns { clips: [{ soundId, kind, pcm: Float32Array 48 kHz mono }], failed }.
  static async decodeReferences(onProgress) {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const jobs = [];
    for (const s of GAME_DATA.sounds) {
      jobs.push({ soundId: s.id, kind: 'pickup', name: s.pickup });
      jobs.push({ soundId: s.id, kind: 'drop', name: s.drop });
    }
    // Extra pick-up references: in-game recordings (neverh8me/abi-merchant-helper) of the sounds whose
    // version differs most from the abibuilder file (coins/necklace jingle differently each time).
    for (const x of EXTRA_REFS) jobs.push({ ...x, kind: 'pickup', extra: true });
    const total = jobs.length, clips = [];
    let done = 0, failed = 0;
    const worker = async () => {
      while (jobs.length) {
        const j = jobs.shift();
        try {
          const res = await fetch(j.extra ? `/api/extrasound/${j.file}` : `/api/refsound/${j.name}.ogg`);
          if (!res.ok) throw new Error(res.status);
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          let pcm = buf.getChannelData(0).slice(0);
          if (j.extra) pcm = trimLeadingSilence(pcm); // recordings start a little before the sound
          clips.push({ soundId: j.soundId, kind: j.kind, pcm });
        } catch (e) { failed++; }
        done++;
        if (onProgress) onProgress({ ready: false, done, total });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { clips, failed };
  }

  async loadReferences() {
    const decoded = await GameAudioListener.decodeReferences(p => this.emit('refs', p));
    this.buildReferences(decoded.clips, decoded.failed);
  }

  // Heavy part (fingerprints, FFTs, noise baselines): runs in the background worker in the app.
  buildReferences(decoded, failed = 0) {
    const refs = [], clips = [];
    for (const d of decoded) {
      for (const fp of GameAudioListener.fingerprintClip(d.pcm)) refs.push({ soundId: d.soundId, kind: d.kind, fp });
      clips.push(prepareClip(d.pcm, d.soundId, d.kind));
    }
    // Noise-like references (e.g. sloshing fuel) correlate a little with any noise. Measure each
    // reference's score on pure white/pink noise and treat that as its zero point.
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const base = new Map(), baseBand = new Map();
    for (const pink of [0, 1]) for (let rep = 0; rep < 2; rep++) {
      const w = new Float32Array(MF_WIN);
      let p = 0;
      for (let i = 0; i < MF_WIN; i++) { const x = rnd(); p = 0.97 * p + 0.03 * x; w[i] = pink ? p : x; }
      matchedFilterScores(w, clips).forEach((r, i) => base.set(i, Math.max(base.get(i) || 0, r.score)));
      bandScores(w, clips).forEach((r, i) => baseBand.set(i, Math.max(baseBand.get(i) || 0, r.score)));
    }
    clips.forEach((c, i) => {
      c.baseline = Math.min(0.6, base.get(i) || 0);
      c.baselineBand = Math.min(0.6, baseBand.get(i) || 0);
    });
    this.refs = refs;
    this.clips = clips;
    this.refsReady = refs.length > 0;
    this.emit('refs', { ready: this.refsReady, count: clips.length, failed });
  }

  // Fingerprint a reference clip using the same onset detector as live audio.
  // A clip can contain several hits; live audio may trigger on any of them depending on volume and
  // background noise, so every distinct trigger point (clean and noisy, loud and quiet) gets a fingerprint.
  static fingerprintClip(data) {
    const pad = Math.round(SR * 0.4);
    const len = pad + data.length + Math.round(SR * 0.5);
    const get = (i) => (i >= pad && i < pad + data.length ? data[i - pad] : 0);
    const onsets = [];
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    for (const [gain, noiseAmp] of [[1, 2e-5], [0.25, 2e-5]]) {
      for (const sens of [0.4, 0.7, 1]) {
        const det = new OnsetDetector((pos) => onsets.push(pos), { bands: false });
        det.sensitivity = sens;
        for (let i = 0; i < len; i++) det.push(get(i) * gain + noise() * noiseAmp);
      }
    }
    onsets.sort((a, b) => a - b);
    const uniq = [];
    for (const p of onsets) if (!uniq.length || p - uniq[uniq.length - 1] > SR * 0.03) uniq.push(p);
    if (!uniq.length) uniq.push(pad);
    return uniq.slice(0, 6).map(p => fingerprintAt(get, p - 480));
  }

  // Which references take part. Drop ("put down") sounds are off by default: real-game calibration in
  // neverh8me/abi-merchant-helper had to disable 28 of 38 of them for false alarms, and dragging a
  // crate always plays the pick-up sound first anyway.
  activeKind(kind) { return this.useDropSounds || kind === 'pickup' || !!(this.lastPickup && Date.now() - this.lastPickup.time < 4000); }

  classifyFingerprint(fp) {
    const best = new Map();
    for (const r of this.refs) {
      if (!this.activeKind(r.kind)) continue;
      const d = fpDistance(fp, r.fp);
      const cur = best.get(r.soundId);
      if (!cur || d < cur.distance) best.set(r.soundId, { soundId: r.soundId, kind: r.kind, distance: d });
    }
    return [...best.values()].sort((a, b) => a.distance - b.distance);
  }

  // Best normalised waveform correlation per sound id (1 = identical waveform).
  matchedFilter(window16k) {
    const best = new Map();
    const clips = (this.clips || []).filter(c => this.activeKind(c.kind));
    const scores = this.mfMode === 'broad' ? matchedFilterScores(window16k, clips) : bandScores(window16k, clips);
    for (const r of scores) {
      const cur = best.get(r.soundId);
      if (!cur || r.score > cur.score) best.set(r.soundId, r);
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------- capture
  async start(source = 'game', deviceId = null) {
    this.stop(true);
    const token = ++this.token;
    this.source = source; this.deviceId = deviceId;
    this.isListening = true;
    this.connect(token);
  }

  stop(silent = false) {
    this.token++;
    if (this.abort) { try { this.abort.abort(); } catch (e) { } this.abort = null; }
    this.isListening = false;
    if (!silent) this.emit('status', { state: 'paused' });
  }

  async connect(token) {
    if (token !== this.token) return;
    const retry = (ms) => setTimeout(() => this.connect(token), ms);
    try {
      if (this.source === 'game') {
        const g = await (await fetch('/api/game', { cache: 'no-store' })).json();
        if (!g.running) { this.emit('status', { state: 'waiting-game' }); return retry(3000); }
      }
      const ctrl = new AbortController();
      this.abort = ctrl;
      const url = this.source === 'game' ? '/api/loopback?source=game'
        : '/api/loopback' + (this.deviceId ? `?device=${encodeURIComponent(this.deviceId)}` : '');
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      this.reset();
      this.emit('status', { state: 'listening', source: this.source });
      const reader = res.body.getReader();
      let carry = new Uint8Array(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done || token !== this.token) break;
        let bytes = value;
        if (carry.length) { const m = new Uint8Array(carry.length + value.length); m.set(carry); m.set(value, carry.length); bytes = m; }
        const n = bytes.length >> 2;
        if (n) { const f = new Float32Array(n); new Uint8Array(f.buffer).set(bytes.subarray(0, n * 4)); this.process(f); }
        carry = bytes.slice(n * 4);
      }
    } catch (e) {
      if (token !== this.token) return;
      this.emit('status', { state: 'error', message: String(e.message || e) });
      return retry(3000);
    }
    // stream ended (game closed, device changed): reconnect
    if (token === this.token) { this.emit('status', { state: 'waiting-game' }); retry(1500); }
  }

  // ---------------------------------------------------------------- live DSP
  process(buf) {
    const mask = this.ringSize - 1;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i];
      this.ring[this.written & mask] = s;
      this.written++;
      const rms = this.detector.push(s);
      if (rms !== null) {
        if (rms > this.levelPeak) this.levelPeak = rms;
        if (++this.levelAcc >= 10) { this.emit('level', this.levelPeak); this.levelAcc = 0; this.levelPeak = 0; }
      }
    }
    if (this.snipQueue.length) this.takeSnippets();
    const specEnd = (FRAMES - 1) * HOP + FRAME_N + 480;   // after onset
    const mfEnd = (MF_WIN - MF_PRE) * MF_DEC + 6;          // after onset
    const need = Math.max(specEnd, mfEnd);
    // under heavy load (gunfight) never build a backlog: only the newest few hits matter
    if (this.pending.length > 4) this.pending.splice(0, this.pending.length - 3);
    while (this.pending.length && this.written >= this.pending[0].onset + need) {
      const p = this.pending.shift();
      const earliest = Math.min(p.start - FRAME_N - 480 - 4 * HOP, p.onset - MF_PRE * MF_DEC - 3);
      if (this.written - earliest > this.ringSize) continue; // fell out of the buffer
      const get = i => this.ring[i & mask];
      const fp = fingerprintAt(get, p.start, true);
      const win = new Float32Array(MF_WIN);
      const base = p.onset - MF_PRE * MF_DEC;
      for (let i = 0; i < MF_WIN; i++) {
        const k = base + i * MF_DEC;
        win[i] = (get(k - 1) + 2 * get(k) + get(k + 1)) / 4; // same light low-pass as the references
      }
      // inside the previous crate's sound (its later hits): only a matching drop sound can still count (as a confirmation)
      const confirmOnly = p.onset < this.muteUntil;
      const r = this.classify(fp, win, p.onset, confirmOnly);
      if (r) this.muteUntil = p.onset + Math.round(((r.dur || 0.3) + 0.15) * SR);
    }
  }

  // The decision rules on (already ranked) matched-filter and spectrogram results.
  //  1) strong waveform match on its own
  //  2) weaker waveform match (noise) confirmed by the spectrogram
  //  3) waveform doesn't line up (pitch-shifted?) but the spectrogram is clearly this sound
  //  4) close call between similar sounds: the one that fits the chosen crate size decides
  decide(mf, spec) {
    const m0 = mf[0], m1 = mf[1], s0 = spec[0], s1 = spec[1];
    const mfMargin = m0 ? m0.score - (m1 ? m1.score : 0) : 0;
    const specDistOf = (id) => { const r = spec.find(x => x.soundId === id); return r ? r.distance : 99; };
    const strict = (id) => STRICT_SOUNDS.has(id);
    if (m0 && m0.score >= (strict(m0.soundId) ? 0.8 : 0.55) && mfMargin >= 0.1)
      return { soundId: m0.soundId, kind: m0.kind, method: 'exact', score: m0.score };
    if (m0 && !strict(m0.soundId) && m0.score >= 0.30 && mfMargin >= 0.06 && specDistOf(m0.soundId) <= this.specThreshold)
      return { soundId: m0.soundId, kind: m0.kind, method: 'exact', score: m0.score };
    if (s0 && !strict(s0.soundId) && s0.distance <= this.specThreshold && (!s1 || s1.distance - s0.distance >= 0.4))
      return { soundId: s0.soundId, kind: s0.kind, method: 'approx', score: s0.distance };
    if (m0 && this.sizeFits && m0.score >= 0.30 && !strict(m0.soundId)) {
      const fitting = mf.filter(r => r.score >= m0.score - 0.05 && this.sizeFits(r.soundId));
      if (fitting.length === 1 && specDistOf(fitting[0].soundId) <= this.specThreshold + 1)
        return { soundId: fitting[0].soundId, kind: fitting[0].kind, method: 'exact', score: fitting[0].score, bySize: true };
    }
    return null;
  }

  // Decide what (if anything) a live hit was. Otherwise: not a cargo sound -> ignored.
  classify(fp, win, onset, confirmOnly = false) {
    if (!this.refsReady) return null;
    if (confirmOnly) {
      // still inside the last crate's sound: only check whether this is that crate's drop sound
      const lp = this.lastPickup;
      if (!lp || Date.now() - lp.time > 4000) return null;
      const drops = (this.clips || []).filter(c => c.kind === 'drop' && c.soundId === lp.soundId);
      const best = Math.max(0, ...(this.mfMode === 'broad' ? matchedFilterScores(win, drops) : bandScores(win, drops)).map(r => r.score));
      if (best >= 0.45) this.emit('confirm', { time: lp.time, soundId: lp.soundId });
      return null;
    }
    const spec = this.classifyFingerprint(fp);
    if (!spec.length || spec[0].distance > 10) return null; // nothing like any cargo sound: skip the costly stage
    const mf = this.matchedFilter(win);

    // The chosen crate (and size) narrows the candidates: try the sounds it can make first. Only fall back to
    // all sounds when the best allowed one is clearly worse than the best overall (wrong map/crate picked?).
    let result = null;
    if (this.allowed) {
      const inMf = mf.filter(r => this.allowed.has(r.soundId)), inSpec = spec.filter(r => this.allowed.has(r.soundId));
      const r = this.decide(inMf, inSpec);
      const bestAll = mf[0] ? mf[0].score : 0;
      if (r && !(r.method === 'exact' && bestAll - r.score > 0.15)) { result = r; result.pool = { mf: inMf, spec: inSpec }; }
    }
    if (!result) {
      result = this.decide(mf, spec);
      if (result) { result.pool = { mf, spec }; if (this.allowed && !this.allowed.has(result.soundId)) result.outsideCrate = true; }
    }
    if (!result) return null;

    // A drop sound right after a pick-up only confirms it (never a new detection)
    const now = Date.now();
    if (result.kind === 'drop') {
      const lp = this.lastPickup;
      if (lp && now - lp.time < 4000 && lp.soundId === result.soundId) this.emit('confirm', { time: lp.time, soundId: result.soundId });
      delete result.pool;
      return null;
    }

    // Close call: keep the near-equal alternatives with weights, so the odds can be blended
    const alts = [];
    if (result.method === 'exact') {
      for (const r of result.pool.mf) if (r.kind === 'pickup' && r.score >= result.score - 0.08) alts.push({ soundId: r.soundId, x: r.score / 0.03 });
    } else {
      for (const r of result.pool.spec) if (r.distance <= result.score + 0.6) alts.push({ soundId: r.soundId, x: -r.distance / 0.3 });
    }
    delete result.pool;
    if (alts.length > 1) {
      const mx = Math.max(...alts.map(a => a.x));
      const sum = alts.reduce((s, a) => s + Math.exp(a.x - mx), 0);
      result.alts = alts.map(a => ({ soundId: a.soundId, w: Math.exp(a.x - mx) / sum }))
        .filter(a => a.w >= 0.08).sort((a, b) => b.w - a.w).slice(0, 3);
      const tot = result.alts.reduce((s, a) => s + a.w, 0);
      result.alts.forEach(a => (a.w /= tot));
      if (result.alts.length < 2) delete result.alts;
    }

    const clip = (this.clips || []).find(c => c.soundId === result.soundId && c.kind === result.kind);
    result.dur = clip ? clip.dur : 0.3;
    result.confidence = result.method === 'exact'
      ? Math.round(Math.min(99, 70 + result.score * 30))
      : Math.round(Math.max(40, Math.min(75, 95 - result.score * 9)));
    result.time = now;
    this.lastPickup = { time: now, soundId: result.soundId };
    // keep the raw sound of this hit for a little while: if you buy the crate, it can be learned
    if (onset !== undefined) this.snipQueue.push({ time: now, onset });
    this.emit('match', result);
    return result;
  }

  // ---------------------------------------------------------------- learning your real sounds
  // Snippets of recent hits (48 kHz mono, from just before the hit), kept for a few minutes by match time.
  takeSnippets() {
    const mask = this.ringSize - 1, len = Math.round(SR * 0.8);
    while (this.snipQueue.length && this.written >= this.snipQueue[0].onset + len) {
      const q = this.snipQueue.shift();
      const start = q.onset - Math.round(SR * 0.01);
      if (this.written - start > this.ringSize) continue;
      const pcm = new Float32Array(len);
      for (let i = 0; i < len; i++) pcm[i] = this.ring[(start + i) & mask];
      this.snippets.set(q.time, pcm);
    }
    if (this.snippets.size > 12) this.snippets.delete(this.snippets.keys().next().value);
  }

  // Add your own in-game recordings as extra references: [{ soundId, pcm }]
  addLearned(list) {
    const fresh = [];
    for (const d of list) {
      const clip = prepareClip(d.pcm, d.soundId, 'pickup');
      clip.learned = true;
      fresh.push(clip);
      for (const fp of GameAudioListener.fingerprintClip(d.pcm)) this.refs.push({ soundId: d.soundId, kind: 'pickup', fp, learned: true });
    }
    // baselines for the new clips (their score on pure noise), as for the built-in ones
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    for (const pink of [0, 1]) for (let rep = 0; rep < 2; rep++) {
      const w = new Float32Array(MF_WIN); let p = 0;
      for (let i = 0; i < MF_WIN; i++) { const x = rnd(); p = 0.97 * p + 0.03 * x; w[i] = pink ? p : x; }
      matchedFilterScores(w, fresh).forEach((r, i) => { fresh[i].baseline = Math.min(0.6, Math.max(fresh[i].baseline || 0, r.score)); });
      bandScores(w, fresh).forEach((r, i) => { fresh[i].baselineBand = Math.min(0.6, Math.max(fresh[i].baselineBand || 0, r.score)); });
    }
    this.clips = (this.clips || []).concat(fresh);
    return fresh.length;
  }
}

export const gameAudioListener = new GameAudioListener();
