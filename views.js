// HTML for the decision strip, the possible-contents rows and the Best buys rows.
// Plain data in, HTML out: the app works out the numbers, this only lays them out.
import { fmt, fmtK, pct, esc, signed } from './format.js';

export const tone = (n) => (n >= 0 ? 'gain' : 'loss'); // gains green; losses slate (red means legendary only)
const VERDICT = { buy: 'BUY', maybe: 'GAMBLE', skip: 'SKIP' };
const RARITY = ['', 'White', 'Green', 'Blue', 'Purple', 'Gold', 'Red'];
const oddsText = (p) => (p >= 0.0995 ? Math.round(p * 100) : p >= 0.001 ? (p * 100).toFixed(1) : '<0.1') + '%';

// Confidence in the red chance (not the sound match): 1–3 bars + a word; `why` on hover
export const confHtml = (c) => `<span class="conf ${c.level}" title="${esc(`An estimate from the merchant's odds. Confidence: ${c.why}.`)}">`
  + `<span class="bars3"><i></i><i></i><i></i></span>${c.level[0].toUpperCase() + c.level.slice(1)} confidence</span>`;

// d: { tag, alert, items, crumb: [crate, sound, size], priceHtml (what you pay; sale shows the old price struck), chips: [html], profit, roi, red, conf, ev, valueWord, costHtml, range: [lo, hi], win }
export function decisionHtml(d) {
  const range = d.range[0] === d.range[1] ? fmtK(d.range[0]) : `${fmtK(d.range[0])} – ${fmtK(d.range[1])}`;
  return `<div class="dtop"><span class="crumb">${d.crumb.map((c, i) => (i ? `<i>/</i>${esc(c)}` : `<b>${esc(c)}</b> <span class="cprice num">${d.priceHtml}</span>`)).join('')}</span>${d.chips.join('')}</div>
    <div class="signal">
      <div class="metric m-verdict ${d.tag} ${d.alert === 'good' ? 'alert-good' : ''}"><span class="k">Verdict</span>
        <span class="v">${VERDICT[d.tag]}</span><span class="s">${d.items} possible item${d.items === 1 ? '' : 's'}</span></div>
      <div class="metric"><span class="k">Expected profit</span>
        <span class="v num ${tone(d.profit)}">${signed(d.profit, fmt)}</span><span class="s">ROI <b class="num">${d.roi}</b></span></div>
      <div class="metric m-red ${d.red > 0 ? '' : 'zero'} ${d.alert === 'red' ? 'alert-red' : ''}"><span class="k">Red chance</span>
        <span class="v num">${pct(d.red)}%</span><span class="s">${d.conf ? confHtml(d.conf) : 'No red item possible'}</span></div>
    </div>
    <div class="dmeta"><span>Expected ${d.valueWord}value <b class="num">${fmt(d.ev)}</b> for <b class="num">${d.costHtml}</b></span>
      <span title="80% of the time the item is worth between these">Middle 80% of values <b class="num">${range}</b></span>
      <span>Chance of profit <b class="num">${pct(d.win)}%</b></span></div>`;
}

// list: [{ item, p }] (p null = no odds, no crate chosen). o: { valueOf, iconSrc, sizeText, canLog }
export function itemRowsHtml(list, o) {
  const odds = list[0].p !== null;
  const head = `<div class="ihead"><span>Item</span><span>Value</span>${odds ? '<span>Odds</span>' : ''}<span></span></div>`;
  return head + list.map(({ item: it, p }) => `<div class="irow r${it.rarity}" style="--rc:var(--r${it.rarity})">
      <div class="it"><div class="art"><img src="${esc(o.iconSrc(it))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" /></div>
        <div><div class="nm">${esc(it.name)}</div><div class="meta"><i></i>${RARITY[it.rarity] || ''} · ${esc(it.category)} · ${o.sizeText(it)}</div></div></div>
      <span class="val num">${fmt(o.valueOf(it))}</span>
      ${odds ? `<span class="odds num">${oddsText(p)}<span class="bar"><i style="width:${Math.max(3, p * 100).toFixed(1)}%"></i></span></span>` : ''}
      ${o.canLog ? `<button class="got" data-item="${it.id}" title="I bought this crate and got this item — remember it to improve the odds">Got this</button>` : '<span></span>'}
    </div>`).join('');
}

export const SEEN_HEAD = '<div class="seen-head"><span></span><span>Crate</span><span>Red chance</span><span>Exp. profit</span><span>ROI</span></div>';
// r: { i (index in seen), rank, plan, cur, alert, name, sub (html), red, profit, roi }
export const seenRowHtml = (r) => `<div class="seen ${r.cur ? 'cur' : ''} ${r.plan ? 'plan' : ''} ${r.alert ? 'alert-' + r.alert : ''}" data-i="${r.i}">
    <span class="rk">${r.plan ? '★' : r.rank}</span>
    <span class="wt">${esc(r.name)}${r.cur ? '<span class="curtag">CURRENT</span>' : ''}<small class="num">${r.sub}</small></span>
    <span class="rd num ${r.red > 0 ? '' : 'zero'}">${r.red > 0 ? pct(r.red) + '%' : '—'}</span>
    <span class="pf num ${tone(r.profit)}">${signed(r.profit)}</span>
    <span class="roi num">${r.roi}</span>
  </div>`;
