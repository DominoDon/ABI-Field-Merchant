# Prompt: build an Arena Breakout: Infinite Field Merchant companion app

Copy everything below the line into Claude Code (or another coding agent), in an empty folder on a Windows 11 PC.

---

I want to build a Windows companion app for **Arena Breakout: Infinite** (ABI) that helps with the **Field Merchant** mystery crates. When I drag a crate in the merchant screen, the game plays the pick-up sound of the item inside. The app should hear that sound, work out which item(s) it could be, read the merchant screen (crate type, price, crate size), and show the real odds, the chance of a red (top-tier) item, expected value, and a BUY / GAMBLE / SKIP verdict.

Work step by step, and check each part works before moving on. Ask me before anything that needs a decision only I can make.

## Ground rules (most important)

1. **No made-up data.** Every sound, item, weight, price and odd must come from a real source (below). If you can't find something, say so instead of guessing. An earlier attempt by another AI invented sound links and odds — don't repeat that.
2. **It must never behave like a cheat.** No process handle to the game, no memory reading/writing, no injection, no overlay drawn on top of the game, no keyboard/mouse input sent to it. Only use what any streaming/recording app uses:
   - audio from the Windows audio service (application audio capture, like OBS/Discord),
   - pictures of the screen (like a screenshot),
   - read-only Windows queries for the window position and cursor.
3. Build an **accuracy test** early and re-run it after every change to the sound matcher.

## Step 1 — Get the assets and data

- **Game data:** `https://abibuilder.com/merchant` has the merchant data: crate types (cargo types), map profiles → maps, prices, loot groups with group weights, items with item weights, sizes, values, and which pick-up sound each item uses. Write a script (`tools/gen-data.js`, run with Node) that downloads that page, parses it (`merchantData.js`, shared with the app), validates it, and writes a generated `data.js`. Never hand-edit `data.js`.
- **Reference sounds:** abibuilder.com also hosts the game's item sounds as `.ogg` files. The app downloads them on demand and caches them in `%LOCALAPPDATA%\<AppName>\sounds`.
- **Real in-game recordings:** the GitHub project `neverh8me/abi-merchant-helper` (GPL-3.0) has in-game recordings of the sounds (including drop sounds). Read them from a **pinned commit** at runtime and cache them. Reimplement ideas from that project in your own code — don't copy its code — and credit it in the README.
- **Purchase data:** the same project has a public, read-only purchase base. Use it (plus your own purchases on this PC) to refine odds.
- **Item pictures:** fetch from abibuilder and cache.
- **Automatic updates:** the app re-fetches the merchant page every few hours (serve the cached copy when offline). If the parsed data is valid and differs from what's in use, store it and offer to switch.
- **Maps:** one entry per map + mode. Keep a `RETIRED_MAPS` list for maps not in the current season, and hide profiles that list no maps until someone identifies them. Ask me which maps are in the current season.

## Step 2 — App shape

- A **single-file Windows exe** written in C# (.NET Framework 4.x, compiled with the built-in `csc.exe`, so no extra installs). The web files (HTML/JS/CSS) are compiled in as resources.
- The exe runs a local web server on `127.0.0.1:<port>` and opens the UI in a **Chrome/Edge `--app` window** (own `--user-data-dir`, background throttling disabled so it keeps listening when not focused).
- Tray icon: Open, Hide/show window (keeps listening), Mini window, Start with Windows (HKCU Run key), Desktop shortcut, Exit.
- `tools/build.ps1`: compile to a temp file, ask the running copy to quit (`/api/quit`), swap the exe, restart it. The open window notices the new build id (`/api/ping`) and reloads.
- Flags: `--dev` (serve web files from disk), `--server-only`. Log file in `%LOCALAPPDATA%\<AppName>\app.log`.
- No code signing (Windows SmartScreen: *More info → Run anyway*).

## Step 3 — Detecting that the game is running

- Find the game **only from the system's process list and window list**: look for the process `UAGame.exe` by name (make the name overridable with an env var), then use `EnumWindows` to find its visible top-level window. Never call `OpenProcess` on it.
- `/api/state` returns the game window's rect, the cursor position in the game's client pixels, the left mouse button state, whether the cursor is visible (it's hidden while aiming in a raid), and whether the game is focused — all read-only Windows calls (`GetCursorInfo`, `GetAsyncKeyState`, `GetForegroundWindow`, etc.).
- The UI shows a live status: game not running / running / merchant open.
- The game should be in **borderless window** mode for screen reading. Support multi-monitor and 4K.

## Step 4 — Getting the game's audio

- **Main way: Windows process loopback** (Windows 11, build 20348+). Call `ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ...)` with `AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid of UAGame.exe, INCLUDE_TARGET_PROCESS_TREE } }`. That captures **only the game's own audio** (no Discord, no music). Stream it as 48 kHz mono float32 to the web UI at `/api/loopback?source=game`.
- **Fallback:** WASAPI loopback of one output device (`/api/devices` lists them; user picks under Settings).
- The UI runs the recogniser in a **Web Worker** so the window never freezes.

## Step 5 — Recognising the sound

- **Onset detector:** broadband plus 4 band channels (about 40–900, 900–2500, 2500–4500, 4500–11000 Hz), 5 ms hops. A hit is a sudden jump of several dB over the quietest level of the last ~40 ms, above an adaptive noise floor, with ~250 ms debounce. Sensitivity setting.
- **Pick-up sounds only** by default. The desk clock sound is easily confused, so it needs a near-perfect match.
- **Stage 1 — band-split matched filter** (resample to 24 kHz, ~5 bands up to 11.5 kHz, energy-weighted, baseline-corrected per reference). Accept only with a clear score and a clear margin over the runner-up.
- **Stage 2 — spectrogram fallback** that tolerates pitch/EQ changes, with a noise-aware distance threshold. Otherwise ignore the hit.
- **Crate filter:** once a crate is chosen, try only the sounds that crate (and size) can make; fall back to all sounds only when the best allowed match is clearly worse, and flag it "not from this crate?".
- **Close calls:** return near-equal candidates as weighted alternatives; the odds blend their items with the crate's own odds.
- **Drop confirmation:** for ~4 s after a pick-up, compare new hits with that sound's drop recording; a match marks the detection "confirmed by drop". Drops never start a detection on their own.
- **Learning:** keep each hit's raw audio for a few minutes; when I buy that crate, store the clip (IndexedDB, newest few per sound) as an extra reference for the item I actually got.
- **Accuracy test page** (`tools/eval.html`): every pick-up sound × several conditions (volume, EQ, noise, overlapping voice chat), plus non-cargo sounds and 30 s of voice chat that must produce **zero** reports. Show right / wrong / false alarms.

## Step 6 — Reading the merchant screen

Only while the cursor is visible:
- `/api/frame?x=&y=&w=&h=&scale=` — picture of a region of the game window (fractions of the client area), taken as a desktop copy.
- `/api/ocr` — **Windows built-in OCR** (`Windows.Media.Ocr`) on a region → lines and word boxes.
- When the cursor rests on a crate: measure the crate outline right away (before the tooltip covers it) → size; after ~350 ms OCR the tooltip → crate type (fuzzy match to the known names) and price (snap to a real pool price).
- Every few seconds OCR the top of the panel: "Purchase"/"Sell" → merchant open; "spent X … obtained [item]" → log the purchase automatically (with Undo) when it matches a crate I dragged recently and the item fits; if unsure, ask "Was it you?".
- **F8 hotkey** saves a full game-window PNG + cursor state to `%LOCALAPPDATA%\<AppName>\snapshots`, so screen reading can be tuned on real screenshots. Expect screen reading to be a rough draft until tuned on those.
- `tools/screen-test.html` runs screen reading on saved images.

## Step 7 — Odds and verdict

- A crate = (map profile, cargo type, price). It rolls a loot group by group weight, then an item by item weight. The heard sound and the crate size narrow that down; renormalise.
- Real purchases refine it (treat the merchant data as worth ~20 purchases, then add the public base + my own).
- **EV** = Σ p × value (choose hand-in or market value). Show red chance, chance of profit, and the 10th–90th percentile range of value ("80%: a – b").
- Verdict: BUY / GAMBLE / SKIP with red and profit gauges.

## Step 8 — Layout (dark, polished, high-end)

- Dark theme with CSS tokens on `:root` (near-black background, slightly lighter panels, gold accent for reds/highlights, green good / orange warn / red bad, rounded 14 px panels, Segoe UI Variable font).
- **Top bar:** map picker, crate picker, live status (game / audio / merchant).
- **Main grid of panels:**
  - Crate panel — crate type + size buttons, each size showing its red chance.
  - Sound card — the heard sound, with close-call alternatives and "confirmed by drop".
  - Verdict card — BUY/GAMBLE/SKIP, red and profit gauges, EV, 80% range.
  - Items panel — cards for the possible items with picture, share %, value; reds highlighted.
  - Best buys + **raid plan** — purchases per raid setting (2, 3 or 4 with perks; selling limited to 3); rank hovered crates by strategy (Max profit / Red hunting / Safe), star the top ones, show total expected profit and chance of ≥ 1 red.
  - Session summary — purchases, spent, gained, CSV export.
- **Settings drawer** (slides in from the right): audio source/device, sensitivity, value type, purchases per raid, start with Windows, update data, and a **self-check** (`/api/selfcheck`: Windows build, game window found and borderless, capture not black, OCR available, F8 working, sound cache) in plain language.
- **Mini window** (`mini.html`): small always-on-top window that mirrors the main one over a `BroadcastChannel` (does no listening itself).
- Optional chimes on a red / good buy.
- `?demo` URL fills the screen with a sample situation for screenshots.

## Step 9 — README

Document the files, how to build, every endpoint, how recognition and odds work, the "hands off the game" section, credits to neverh8me/abi-merchant-helper and abibuilder.com, and requirements (Windows 11, Chrome or Edge, English Windows OCR, borderless window).
