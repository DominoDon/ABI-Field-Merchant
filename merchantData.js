// Turns the abibuilder.com/merchant page into the app's game data (same shape as data.js).
// Used live by the app (automatic data updates) and by tools/gen-data.js (the built-in copy). No DOM.

export function extractMerchantData(html, fetched) {
  let s = '';
  const re = /self\.__next_f\.push\(\[1,(".*?")\]\)<\/script>/gs;
  let m;
  while ((m = re.exec(html))) { try { s += JSON.parse(m[1]); } catch (e) { } }
  const grab = (key, from = 0) => {
    const k = s.indexOf(`"${key}":[`, from);
    if (k < 0) return null;
    let i = s.indexOf('[', k), depth = 0, inStr = false, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) break; }
    }
    try { return { value: JSON.parse(s.slice(i, j + 1)), end: j }; } catch (e) { return null; }
  };
  let items = null, pos = 0;
  for (;;) {
    const r = grab('items', pos);
    if (!r) break;
    if (r.value.length && r.value[0] && r.value[0].soundId != null && (!items || r.value.length > items.length)) items = r.value;
    pos = r.end;
  }
  const sounds = grab('sounds'), types = grab('types'), pools = grab('pools'), profiles = grab('profiles');
  if (!items || !sounds || !types || !pools || !profiles) return null;

  const outItems = items.map(i => ({
    id: i.id, name: i.name, rarity: i.rarity, size: `${i.size[0]}x${i.size[1]}`,
    category: i.categoryName, value: i.contactPrice, market: i.referencePrice, soundId: i.soundId, icon: i.iconUrl
  }));
  const outSounds = sounds.value.map(x => ({
    id: x.id, pickup: x.pickup, drop: x.drop, name: soundName(x.pickup),
    itemCount: outItems.filter(i => i.soundId === x.id).length
  }));
  const outPools = pools.value.map(p => ({
    profile: p.profile, typeId: p.typeId, price: p.price, weight: p.weight, weightTotal: p.weightTotal,
    items: p.items.map(x => [x.id, x.weight])
  }));
  return {
    fetched: fetched || new Date().toISOString().slice(0, 10),
    sounds: outSounds,
    items: outItems,
    types: Object.fromEntries(types.value.map(t => [t.id, t.name])),
    profiles: profiles.value
      .filter(p => outPools.some(x => x.profile === p.id))
      .map(p => ({
        id: p.id, label: String(p.label).replace(/^Unknown Profile \d+$/, `Other maps (${p.id})`),
        maps: (p.maps || []).map(x => ({ id: String(x.map), name: x.mapName, mode: x.mode }))
      })),
    pools: outPools
  };
}

// Readable name from the game's sound file name, e.g. Item_Container_Big_Metal_Up -> "Large Metal Container",
// Item_GoldChain_Up -> "Gold Chain", Prop_Acc_Plastic_Large_UP_01 -> "Large Plastic".
export function soundName(pickup) {
  const isProp = /^Prop_/.test(pickup);
  const words = pickup.replace(/^(Item|Prop)_/, '').replace(/_(Up|UP|up|Down|DOWN|down)(_\d+)?$/, '')
    .split('_').flatMap(w => w.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  const MAP = { Med: 'Medium', Big: 'Large', Comp: 'Components', PC: 'PC' };
  const SIZE = new Set(['Small', 'Medium', 'Large']);
  let size = '', tail = [], acc = false;
  const out = [];
  for (let w of words) {
    if (w === 'Misc') continue;
    if (w === 'Acc') { if (!isProp) acc = true; continue; }
    w = MAP[w] || w;
    if (SIZE.has(w)) { size = w; continue; }
    if (w === 'Crisp' || w === 'Blunt') { tail.push(`(${w.toLowerCase()})`); continue; }
    if (w === 'Container') { tail.unshift('Container'); continue; }
    out.push(w);
  }
  const name = [size, ...out, ...tail].filter(Boolean).join(' ') + (acc ? ' (accessory)' : '');
  return name || pickup;
}

// Sanity checks before trusting new data (a site redesign must never break the app)
export function validateGameData(d) {
  if (!d || !Array.isArray(d.items) || !Array.isArray(d.sounds) || !Array.isArray(d.pools) || !Array.isArray(d.profiles)) return 'missing parts';
  if (d.items.length < 100 || d.sounds.length < 20 || d.pools.length < 100 || !d.profiles.length) return 'too little data';
  const itemIds = new Set(d.items.map(i => i.id)), soundIds = new Set(d.sounds.map(s => s.id));
  if (d.items.some(i => !soundIds.has(i.soundId) || !(i.value > 0) || !/^\dx\d$/.test(i.size))) return 'bad items';
  if (d.sounds.some(s => !/^[A-Za-z0-9_]+$/.test(s.pickup) || !/^[A-Za-z0-9_]+$/.test(s.drop))) return 'bad sounds';
  let missing = 0;
  for (const p of d.pools) for (const [id] of p.items) if (!itemIds.has(id)) missing++;
  if (missing > 0) return 'pools reference unknown items';
  return null;
}

// Cheap fingerprint to tell whether the data changed
export function dataSignature(d) {
  let h = 2166136261;
  const s = JSON.stringify([d.sounds, d.items, d.pools, d.types]);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}
