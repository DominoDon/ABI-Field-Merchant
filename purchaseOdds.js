// Real purchase results refine the merchant odds: the merchant data counts as PRIOR_N purchases, then each
// recorded (crate type, price, sound) -> item result is added on top (method from abi-merchant-helper).
// Sources: the public base of neverh8me/abi-merchant-helper (read-only) + your own results (this PC only).
import { GAME_DATA } from './data.js';

const PRIOR_N = 20;
const SHARED_URL = 'https://raw.githubusercontent.com/neverh8me/abi-merchant-helper/main/library/purchases.json';
// their sound-group ids, in our sound-id order (#1..#38)
const SHARED_GROUPS = ['med_comp', 'container_big_metal', 'med_fabric', 'acc_fuel', 'acc_concrete', 'med_metal_crisp',
  'acc_plastic_large', 'med_wood', 'small_comp', 'electronicdevice', 'acc_plastic_small', 'acc_tech_small', 'acc_pc',
  'big_wood', 'acc_battery_small', 'acc_med_comp', 'med_metal_blunt', 'small_metal_blunt', 'container_small_metal',
  'big_blunt', 'small_wood', 'small_metal_crisp', 'small_fabric', 'small_glass', 'med_wood_clock', 'glass', 'food_bag',
  'acc_statue', 'coin', 'med_glass', 'acc_clock', 'acc_teapot', 'necklace', 'med_paper', 'small_paper', 'med_statue',
  'big_paper', 'acc_radio'];

// Their records -> ours ({ soundId, typeId, price, itemId, t }); records we can't place are dropped.
function normaliseShared(raw, itemsById) {
  const typeIdByName = new Map(Object.entries(GAME_DATA.types).map(([id, n]) => [n.toLowerCase(), Number(id)]));
  const poolPrices = (typeId) => [...new Set(GAME_DATA.pools.filter(p => p.typeId === typeId).map(p => p.price))];
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

// The shared base, or null (offline, or nothing usable in it)
export async function fetchSharedPurchases(itemsById) {
  try {
    const res = await fetch(SHARED_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const list = normaliseShared((await res.json()).purchases, itemsById);
    return list.length ? list : null;
  } catch (e) { return null; }
}

// Adjusts `list` ([{ item, p }]) in place with the purchases recorded for this crate + sound.
// `purchases` = { shared: [...], mine: [...] }. Returns { n, mine } or null when none apply.
export function refineWithPurchases(list, typeId, price, soundId, purchases) {
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
