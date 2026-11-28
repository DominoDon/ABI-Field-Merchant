// The "View" dialogs in Settings: your logged purchases, and the sounds the app learned from them.
// Plain data in, HTML out (the app gathers the data); plus playback of a learned recording.
import { fmt, esc, signed } from './format.js';
import { tone } from './views.js';

const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// rows (newest first): { t, map, crate, paid, price, size, sound, item: { name, rarity } | null, value }
export function purchasesHtml(rows) {
  if (!rows.length) return '<p class="muted">No purchases logged yet.</p>';
  const spent = rows.reduce((a, r) => a + r.paid, 0), worth = rows.reduce((a, r) => a + (r.item ? r.value : 0), 0);
  return `<p class="rec-sum">${rows.length} purchase${rows.length === 1 ? '' : 's'} · spent <b class="num">${fmt(spent)}</b> → worth <b class="num">${fmt(worth)}</b> · <b class="num ${tone(worth - spent)}">${signed(worth - spent, fmt)}</b></p>
    <table class="rec"><thead><tr><th>When</th><th>Crate</th><th>Sound · size</th><th>Item</th><th class="r">Paid</th><th class="r">Worth</th><th class="r">Profit</th></tr></thead><tbody>
    ${rows.map(r => `<tr>
      <td class="muted">${esc(when(r.t))}<small>${esc(r.map)}</small></td>
      <td>${esc(r.crate)}${r.paid < r.price ? `<small class="num">sale, was ${fmt(r.price)}</small>` : ''}</td>
      <td>${esc(r.sound)}<small>${esc(r.size || 'size unknown')}</small></td>
      <td>${r.item ? `<b style="color:var(--r${r.item.rarity})">${esc(r.item.name)}</b>` : '<span class="muted">unknown item</span>'}</td>
      <td class="r num">${fmt(r.paid)}</td>
      <td class="r num">${r.item ? fmt(r.value) : '—'}</td>
      <td class="r num ${r.item ? tone(r.value - r.paid) : ''}">${r.item ? signed(r.value - r.paid, fmt) : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

// groups: [{ name, clips: [{ t, seconds }] }], biggest first. Each clip plays by its t.
export function learnedHtml(groups) {
  if (!groups.length) return '<p class="muted">No sounds learned yet. Each crate you buy teaches the app how its sound plays on your PC.</p>';
  return `<p class="rec-sum">${groups.reduce((a, g) => a + g.clips.length, 0)} recordings of ${groups.length} sound${groups.length === 1 ? '' : 's'}, used as extra references when matching.</p>
    <div class="rec-sounds">${groups.map(g => `<div class="rec-sound"><b>${esc(g.name)}</b>
      <div class="rec-clips">${g.clips.map(c => `<button class="chip" data-play="${c.t}" title="Play this recording">▶ ${esc(when(c.t))} · ${c.seconds.toFixed(1)} s</button>`).join('')}</div></div>`).join('')}</div>`;
}

// play a learned recording (16-bit samples at 48 kHz, as the listener keeps them)
let ctx = null;
export function playPcm16(pcm16) {
  ctx = ctx || new AudioContext();
  const buf = ctx.createBuffer(1, pcm16.length, 48000), ch = buf.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) ch[i] = pcm16[i] / 32767;
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
}
