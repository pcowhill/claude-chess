# CLAUDE.md — project guide for Claude Code

Offline, static, single-page **browser chess game vs a local AI**. Everything is
hand-written; correctness of chess rules is the top priority.

## Hard constraints (do not break)
- **No runtime third-party code or network at runtime.** No libraries, npm
  packages loaded by the page, CDNs, external APIs, web fonts, or chess engines
  (no Stockfish/chess.js). The game must work fully offline.
- **Local bundled assets ARE allowed** — files committed to the repo (e.g. the
  SVG piece images under `assets/`) are fine. Just reference them by relative
  path; never fetch from a remote URL at runtime.
- **Must work from `file://`.** Therefore use **classic scripts**, not ES
  modules (`import`/`export` break under `file://` in most browsers). Shared
  code is attached to the global object via an IIFE.
- **The Web Worker has a main-thread fallback** (some browsers block workers on
  `file://`). Keep both paths working.
- Dev-only tooling (e.g. Playwright for screenshots) is acceptable **locally**
  but must be git-ignored and never referenced by the shipped game.

## Architecture / files
| File | Role |
|---|---|
| `chess.js` | Core rules engine: board state, legal move generation, make/unmake, check/checkmate/draw logic, FEN/SAN/PGN, Zobrist. **No DOM, no AI.** Exposed as `ChessEngine`. |
| `ai.js` | AI: evaluation + negamax/alpha-beta, iterative deepening, quiescence, transposition table, difficulty tuning. Depends on `chess.js`. Exposed as `ChessAI`. |
| `engine-worker.js` | Web Worker; `importScripts('chess.js','ai.js')` then runs searches off-thread. |
| `app.js` | UI controller: rendering, click/drag/keyboard input, promotion UI, clocks, panels, persistence, drives the AI (worker + fallback). |
| `index.html` / `styles.css` | Single-page UI (setup screen + game screen), responsive, themeable. |
| `tests.html` / `test.js` | Browser- and Node-runnable test suite (no external framework). |
| `assets/pieces/cburnett/` | SVG piece set (`wK,wQ,wR,wB,wN,wP,bK…bP.svg`). See its `CREDITS.md`. |

**Shared-module pattern:** `chess.js`/`ai.js` wrap an IIFE
`(function(global){ … })(typeof self !== 'undefined' ? self : this)` and attach
`global.ChessEngine` / `global.ChessAI` (and `module.exports` for Node). This is
why the same files power the page, the worker, the tests, and `node`.

## Run it
- Open `index.html` directly, **or** serve statically (preferred, enables the
  worker): `python -m http.server` → http://localhost:8000/

## Test & validate (keep these green)
```bash
node --check chess.js && node --check ai.js && node --check app.js \
  && node --check engine-worker.js && node --check test.js
node test.js          # full suite; exits non-zero on failure
```
Browser: open `tests.html`. Move generation is validated with **perft** node
counts against reference positions (incl. Kiwipete) — do not regress these.

Invariants worth re-checking after any engine change:
- perft counts still match; `node test.js` passes.
- **AI only ever returns legal moves** (there is a test + a defensive fallback).

## Screenshots (no browser is bundled)
Only `chromedriver` exists in the base image — there is **no Chrome/Chromium**.
To capture screenshots, install a headless browser locally (dev-only, requires
network) and drive a local server, e.g.:
```bash
npm i -D playwright && npx playwright install chromium   # gitignored
python -m http.server &                                  # serve the site
# then a short Node/Playwright script: goto localhost:8000, screenshot #board
```
Do not commit `node_modules/` or the browser download.

## Where the UI renders pieces (useful for visual changes)
- `app.js`: `GLYPH` map + `glyph(piece)`, `updateCell(sq)` (creates/updates the
  per-square `<span class="piece white|black">`), `beginDragVisual()` (drag
  ghost), `showPromotion()` (promotion buttons), `renderCaptured()` /
  `capturedList()` (captured-piece display).
- `styles.css`: `.piece`, `.piece.white/.black`, `.cell` (font-size sets piece
  size), `.drag-ghost`, `.cap-piece`.
- Move application paths: human moves go through `onMoveMade()`, bot moves
  through `applyBotMove()`; both call `renderAll()`. Drag drops go through
  `onPointerUp` → `tryMove`. The existing from/to highlight is the `.last-move`
  class (`--hl-last` in `styles.css`).

## Conventions
- Vanilla, ES5-friendly JS (the engine avoids modern-only syntax for broad
  compatibility); no build step; keep code commented and readable.
- Correct chess rules > UI polish > tests > AI strength > extra niceties.
- Branch/commit/push per the session's git instructions; don't open a PR unless
  asked.
