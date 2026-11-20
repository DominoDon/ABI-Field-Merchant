// Background worker: all audio work (stream reading, hit detection, recognition) runs here, so the app
// window can never freeze ("page unresponsive") however busy the game audio gets.
import { GameAudioListener } from './audioListener.js';

const L = new GameAudioListener();
let lastLevel = 0;
L.on('match', m => postMessage({ type: 'match', payload: m }));
L.on('confirm', c => postMessage({ type: 'confirm', payload: c }));
L.on('status', s => postMessage({ type: 'status', payload: s }));
L.on('refs', r => postMessage({ type: 'refs', payload: r }));
L.on('level', v => {
  const now = Date.now();
  if (now - lastLevel >= 50) { lastLevel = now; postMessage({ type: 'level', payload: v }); }
});

onmessage = (e) => {
  const d = e.data;
  switch (d.type) {
    case 'refs':
      L.buildReferences(d.clips, d.failed);
      break;
    case 'learn': {
      // your own in-game recordings (from bought crates) become extra references
      const n = L.addLearned(d.list || []);
      postMessage({ type: 'learned', payload: { added: n } });
      break;
    }
    case 'snippet': {
      // the raw sound of the hit detected at d.time (for learning), or null if it's gone
      const pcm = L.snippets.get(d.time) || null;
      postMessage({ type: 'snippet', payload: { time: d.time, pcm } });
      break;
    }
    case 'start': L.start(d.source, d.deviceId); break;
    case 'stop': L.stop(); break;
    case 'sens': L.setSensitivity(d.value); break;
    case 'fits': {
      const ids = d.ids ? new Set(d.ids) : null;
      L.sizeFits = ids ? (id => ids.has(id)) : null;
      break;
    }
    case 'allowed': L.allowed = d.ids ? new Set(d.ids) : null; break;
    case 'drops': L.useDropSounds = !!d.value; break;
    // test hook: run samples through the recognizer as if they came from the game
    case 'inject': {
      const t0 = performance.now();
      for (let i = 0; i < d.pcm.length; i += 960) L.process(d.pcm.subarray(i, i + 960));
      postMessage({ type: 'injected', payload: { ms: Math.round(performance.now() - t0) } });
      break;
    }
  }
};
postMessage({ type: 'hello' });
