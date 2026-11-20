ABI FIELD MERCHANT COMPANION
============================
Tells you what a Field Merchant mystery crate in Arena Breakout: Infinite can contain,
by recognising the sound it makes when you drag it - plus the real odds and whether it's worth buying.

SETUP (one time)
----------------
1. Right-click the zip > Extract All... into a normal folder (e.g. Documents\ABI Field Merchant).
   Do NOT run it from inside the zip.
2. Double-click "Create-Desktop-Shortcut.vbs" for a Desktop shortcut (optional).
3. Run "Launch-ABI-Companion.exe".
   Windows may say "Windows protected your PC" because the app isn't code-signed:
   click "More info" > "Run anyway". (Full source is in Launcher.cs.)

Needs: Windows 11 (Windows 10 works by picking an output device under the gear icon), Google Chrome or Microsoft Edge.
The first start downloads the game's 76 item sounds (~0.5 MB) once; after that it works offline
apart from item pictures. Nothing is installed; delete the folder to remove it.

USING IT
--------
1. Pick your MAP and the CRATE you're looking at (type + price).
   Optional: pick the crate's SIZE in your inventory (1x2 and 2x1 count as the same) - this narrows
   the possible items a lot. Set it back to "Any" for the next crate if you don't know the size.
2. Drag the crate in your inventory. The sound number appears by itself, with every item that
   crate can contain for that sound, the chance of each, and BUY / GAMBLE / SKIP.

- It listens ONLY to the game's own audio - not Discord, music or your microphone - and keeps
  working while the game is in front. It starts when Arena Breakout is running.
- It only shows a sound when it's sure. Gunshots, footsteps and other game sounds are ignored.
- If it didn't catch a drag, drag again, or choose the sound yourself from the drop-down.
- ▶ pick up / ▶ drop play the real sound so you can double-check by ear.
- ⚙ (top right): sensitivity, and an option to listen to a whole output device instead
  (only needed if your Windows can't do game-only capture).
- The app lives in the system tray while running: right-click the tray icon > Exit to stop it.
