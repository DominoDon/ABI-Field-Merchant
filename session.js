// The purchases of this play session (stored on this PC): totals, best / worst buy and a Discord summary.
// A session ends by itself after 6 hours without a purchase.
import { fmtK, signed, signedPct } from './format.js';

const IDLE_RESET = 6 * 3600e3;

export class Session {
  constructor(store) {
    this.store = store;
    const s = store.get('session', null);
    const fresh = !s || !Array.isArray(s.buys) || Date.now() - (s.last || s.start) > IDLE_RESET;
    Object.assign(this, fresh ? { start: Date.now(), last: Date.now(), buys: [] } : { start: s.start, last: s.last, buys: s.buys });
  }
  save() { this.store.set('session', { start: this.start, last: this.last, buys: this.buys }); }
  add(price, itemId, typeId) { this.buys.push({ t: Date.now(), price, itemId, typeId }); this.last = Date.now(); this.save(); }
  // undo a logged purchase (`rec` from the purchase log; `paid` when it was on sale)
  remove(rec) {
    const j = this.buys.findIndex(b => b.t >= rec.t - 5 && b.itemId === rec.itemId && b.price === (rec.paid || rec.price));
    if (j >= 0) { this.buys.splice(j, 1); this.save(); }
  }
  reset() { this.start = this.last = Date.now(); this.buys = []; this.save(); }

  // Everything the session panel and the Discord text show. `valueOf(item)` = what an item is worth.
  summary(itemsById, valueOf) {
    const buys = this.buys.map(b => ({ ...b, item: itemsById.get(b.itemId) })).filter(b => b.item)
      .map(b => ({ ...b, profit: valueOf(b.item) - b.price }));
    const spent = buys.reduce((a, b) => a + b.price, 0), profit = buys.reduce((a, b) => a + b.profit, 0);
    const byProfit = buys.slice().sort((a, b) => b.profit - a.profit);
    return {
      buys, spent, profit, worth: spent + profit,
      reds: buys.filter(b => b.item.rarity === 6),
      last: buys[buys.length - 1] || null,
      // best / worst only mean something with two or more buys
      best: buys.length > 1 ? byProfit[0] : null, worst: buys.length > 1 ? byProfit[byProfit.length - 1] : null,
      minutes: buys.length ? Math.max(1, Math.round((buys[buys.length - 1].t - Math.min(this.start, buys[0].t)) / 60000)) : 0
    };
  }
}

// Plain text for pasting into Discord ('' when nothing was bought). `typeName(id)` = crate type name or ''.
export function discordText(sum, mapName, typeName) {
  if (!sum.buys.length) return '';
  const m = sum.minutes, dur = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  const buy = (b) => `${b.item.name}${typeName(b.typeId) ? ' from ' + typeName(b.typeId) : ''} (${signed(b.profit)})`;
  const lines = [
    `**ABI Field Merchant** · ${mapName || 'session'} · ${dur}`,
    `Crates: ${sum.buys.length} · Spent ${fmtK(sum.spent)} → worth ${fmtK(sum.worth)} · **Profit ${signed(sum.profit)}**${sum.spent ? ` (${signedPct(sum.profit / sum.spent)})` : ''}`,
    `Reds: ${sum.reds.length}${sum.reds.length ? ' (' + sum.reds.map(b => b.item.name).join(', ') + ')' : ''}`
  ];
  if (sum.best) lines.push(`Best: ${buy(sum.best)}`, `Worst: ${buy(sum.worst)}`);
  return lines.join('\n');
}
