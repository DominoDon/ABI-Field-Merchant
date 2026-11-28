# Technical details

For developers and the curious. If you only want to use the app, see the [README](../README.md).

## Build
`powershell -ExecutionPolicy Bypass -File tools/build.ps1` → `ABI-Field-Merchant.exe` (the web files are compiled in
as resources). It compiles to a temp file, asks a running copy to quit (`/api/quit`), swaps the exe, and restarts it; an
open app window notices the new build id and reloads. The Desktop shortcut points at this exe, so it is always the latest.
Flags: `--server-only` (no window), `--dev` (serve web files from disk). Log: `%LOCALAPPDATA%\ABIFieldMerchant\app.log`.
`http://localhost:5173/?demo` fills the screen with a sample situation (nothing saved) — used for `docs/app-screenshot.png`.

Requirements for building: Windows with the .NET Framework 4.x C# compiler (ships with Windows). `tools/gen-data.js` needs Node.js.

## Files
| File | What it is |
|---|---|
| `Launcher.cs` → `ABI-Field-Merchant.exe` | Native host (C# .NET 4.x, single file). Serves the app on `127.0.0.1:5173`, game audio capture, game-window capture + Windows OCR, reference-sound cache, F8 snapshots, tray icon, Chrome/Edge `--app` window. |
| `index.html`, `app.js` | The app screen: top bar (map, crate, live status), crate + sizes with red chance, the heard sound (with close-call alternatives), verdict with red/profit gauges (red-chance confidence), ROI and 80% range, item cards, best buys + raid plan, your alert thresholds, session panel + CSV export, settings drawer (incl. self-check), prompts. |
| `views.js` | HTML for the decision strip (verdict · expected profit + ROI · red chance + confidence), the possible-contents rows and the Best buys rows. |
| `records.js` | The Settings > View dialogs: your purchase history and the learned sounds (with playback). |
| `session.js` | This play session's purchases: totals, best / worst buy, the "Copy for Discord" text. |
| `purchaseOdds.js` | Refines the odds with real purchase results (yours + the public neverh8me base). |
| `format.js` | Number / text formatting shared by the modules. |
| `mini.html` | The small always-on-top window; mirrors the main window over a BroadcastChannel (does no listening). |
| `merchantData.js` | Parses the abibuilder merchant page into the game data; used for automatic data updates and by `tools/gen-data.js`. |
| `audioListener.js` | Stream client, onset detector and the two-stage matcher (also used by `tools/eval.html`), plus `WorkerListener`, the window's handle on the audio worker. |
| `audioWorker.js` | Background worker that runs `audioListener.js` so the window never freezes. |
| `screen.js` | Merchant screen reading: tooltip OCR (incl. sale prices), crate size from the grid, grabbing a crate, purchase line. |
| `data.js` | Generated game data (sounds, items, cargo pools). **Do not edit** — run `tools/gen-data.js`. |
| `tools/gen-data.js` | Regenerates `data.js` from abibuilder.com/merchant (`node tools/gen-data.js`). |
| `tools/build.ps1` | Build (see below). `tools/make-icon.ps1` makes `app.ico`. |
| `tools/eval.html` | Accuracy test (`http://localhost:5173/tools/eval.html`, `?modes=band,broad`). |
| `tools/screen-test.html`, `tools/size-test.html` | Screen-reading tests on images in `tools/_test/` (need the exe with `--dev`). `size-test` uses frames from real merchant clips (`clip_*.png`, `tip_*.png`); they show other players' names, so they are git-ignored: put your own 2560×1440 frames there. |

## How it works (in detail)
**Exe endpoints**
- `/api/loopback?source=game` — Windows process loopback of `UAGame.exe`: only the game's own audio, 48 kHz mono float32.
  `/api/loopback?device=<id>` — fallback: loopback of one output device (`/api/devices` lists them).
- `/api/refsound/<Name>.ogg` — the game's item sounds from abibuilder.com; `/api/extrasound/<name>.wav` — 5 in-game
  recordings from a pinned commit of neverh8me/abi-merchant-helper. Both cached in `%LOCALAPPDATA%\ABIFieldMerchant\sounds`.
- `/api/state` — game window rect, cursor (client px), left button, cursor visible, focus.
  `/api/frame?x=&y=&w=&h=&scale=[&png]` — picture of a region (fractions of the client area).
  `/api/ocr?x=&y=&w=&h=&scale=` — Windows built-in OCR of a client-pixel region → lines and word boxes.
- F8 (global hotkey, falls back to key polling): full game-window PNG + cursor state → `%LOCALAPPDATA%\ABIFieldMerchant\snapshots`.
- `/api/ping` (build id), `/api/quit` (newer build taking over), `/api/game`.
- `/api/selfcheck` — Windows build, game window/borderless, capture not black, OCR, F8, sound cache → plain-language list.
- `/api/mini` — opens `mini.html` and pins it on top. `/api/autostart[?set=0|1]` — Start with Windows (HKCU Run key).
  Tray menu: Open, Hide/show window (keeps listening), Mini window, Start with Windows, Desktop shortcut, Exit.
- `/api/merchantpage` — abibuilder.com/merchant, cached 6 h (served stale when offline). The app parses it
  (`merchantData.js`), validates it, and when it differs from what's in use, stores it and offers to switch; a
  newer stored copy replaces the built-in data at the next start. `/api/icon/<id>.png` — item pictures, cached.

**Recognition (`audioListener.js`, in the worker)**
- Onset detector: broadband + 4 band channels (40–900, 900–2500, 2500–4500, 4500–11000 Hz), 5 ms hops; a hit is a jump of
  `12-7*sens` dB (bands +2) over the quietest of the last 40 ms, above an adaptive floor; 250 ms debounce; backlog capped.
- Pick-up sounds only by default; #31 (desk clock) needs a near-perfect match.
- Stage 1, band-split matched filter (24 kHz, 5 bands up to 11.5 kHz, energy-weighted, plus a low-band score), baseline-corrected per
  reference. Accept ≥ 0.55 (0.1 margin) or ≥ 0.30 (0.06 margin) when the spectrogram agrees; close calls go to the
  sound that fits the chosen crate size.
- Stage 2, spectrogram fallback (pitch/EQ tolerant), noise-aware distance ≤ 5 dB. Otherwise ignored.
- **Crate filter:** with a crate chosen, only the sounds it (and the chosen size) can make are tried first; it falls back
  to all sounds only when the best allowed match is clearly worse (wrong map/crate picked). Flagged "not from this crate?".
- **Close calls:** near-equal candidates come back as weighted alternatives; the app blends their items with the crate's
  own odds (P(item | crate, heard)) and shows the resulting shares.
- **Drop confirmation:** for 4 s after a pick-up, a hit is compared with that sound's drop recording; a match marks the
  detection "confirmed by drop" — drops never start a detection on their own.
- **Learning:** each detected hit's raw audio is kept for a few minutes; when you buy that crate, the clip is stored
  (IndexedDB, newest 6 per sound) as an extra reference for the sound of the item you actually got — only if that sound
  was among what was heard.
- `tools/eval.html`: 38 pick-up sounds × 9 conditions incl. voice chat → 321 right / 0 wrong; 0/32 non-cargo sounds;
  0 reports from 30 s of voice chat. All 76 of neverh8me's in-game recordings are recognised correctly.

**Screen (`screen.js`)** — only while the cursor is visible (hidden while aiming in a raid). On frames from real
merchant clips (`tools/size-test.html`): crate size 37/38, tooltip + sale price 4/4.
- **Size:** cursor resting on the merchant panel → a 1080p-sized copy around it. The grid's cell size and offset come
  from where frame lines sit (cell ≈ 64 px at that scale); then every 1–3 × 1–3 box holding the cursor's cell is scored
  (outline = frame line, inside = none). Each edge is sampled near both ends (the crate icon sits on inner grid
  lines), frame pixels must be clearly brighter than the panel (hovered crates show faint inner lines, ~+10 vs ~+60),
  and edges under the very dark tooltip are left out (it appears almost instantly, so it is usually on screen).
- **Tooltip:** OCR'd after ~350 ms → crate type (fuzzy match to the 19 names) + price line.
- **Sale prices:** discounted crates show "56,000 ~~70,000~~". The odds use the original (pool) price; the verdict,
  raid plan, purchase matching and logged purchases (`paid`) use what you pay. If OCR loses the struck-through number,
  the usual discounts (20 %, 10 %, 15 %, 25 %, 30 %, 50 %) are undone from the sale price to find a pool price.
- **Grabbing:** the left button going down on the crate just read (inside its measured outline, or near where its
  tooltip was read) → `drag` event. In the game the slot goes dark and a red footprint with "R Rotate" follows the
  cursor. A sound within 4 s belongs to the grabbed crate even if the cursor passes other crates. No size yet →
  measured at the press. Grabs are written to app.log.
- Every 2.5 s the top of the panel is OCR'd: "Purchase"/"Sell" → merchant open; "spent X Koen … obtained [item]"
  (shows other players' buys too) → **logged automatically** (with Undo) when X is what a crate you *dragged* in the
  last 90 s costs and the item fits that crate + sound + size; if it only matches a crate you hovered, the app asks
  "Was it you?".
- Seen on real clips, not used yet: "Purchase (3/4)" (buys left minus the cart), "Owned" (balance), the cart (F adds
  a crate; red band with a cart icon), the merchant's hint ("highest quality … N mystery cargo(s) worth over 180,000 Koen").

**Odds (`app.js`)**: a crate is (map profile, cargo type, price). It rolls a loot group by group weight, then an item by
item weight; the sound and size narrow it, renormalised. Real purchases refine it (merchant data counts as 20 purchases):
neverh8me's public purchase base (read-only) + your own (this PC). EV = Σ p·value (hand-in or market price).
The verdict shows the 10th–90th percentile of item value ("80%: a – b").

**Maps:** one entry per map + mode (from the data's profile → map lists). Maps not in the current season are hidden via
`RETIRED_MAPS` in `app.js` (now: Distorted Valley). Profiles 6 and 9 list no maps and stay hidden until identified.

**Raid plan (`app.js`)**: purchases per raid is a setting (2, 3 or 4 with perks; selling is still limited to 3). Hovered
crates are ranked by the chosen strategy — Max profit (expected profit), Red hunting (red chance), Safe (chance of
profit) — and the top crates for the purchases left are starred, with total expected profit and the chance of ≥ 1 red.

## Not planned
- **Code signing** — not doing it. Windows shows "Windows protected your PC" on first run: *More info → Run anyway*.
- **Own shared purchase base** (Cloudflare Worker + GitHub, like neverh8me's) — noted as possible, no plans to set it up.
  Today the app reads neverh8me's public base (read-only) and keeps your own purchases on your PC.

## Requirements
Windows 11 for game-only capture (process loopback needs build 20348+); otherwise pick an output device under ⚙.
Chrome or Edge. English Windows OCR (installed with English Windows). Game in **borderless window** for screen reading.
