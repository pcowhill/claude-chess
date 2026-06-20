# Claude Chess

A fully self-contained, offline browser chess game where you play against a
built‑in chess bot. **Vanilla HTML, CSS, and JavaScript only** — no third‑party
libraries, npm packages, CDNs, images, fonts, web fonts, APIs, or external chess
engines. Every chess rule, all move generation, the game state, and the AI are
implemented from scratch in the code in this repository. The game never makes a
network call.

Pieces are rendered with Unicode glyphs (♔ ♕ ♖ ♗ ♘ ♙ / ♚ ♛ ♜ ♝ ♞ ♟), not images.

---

## Quick start

### Option 1 — open the file directly
Just open **`index.html`** in a modern browser (double‑click it, or
`File ▸ Open`). The game is fully playable this way.

> Note: some browsers refuse to start a **Web Worker** from a `file://` URL.
> The game detects this automatically and falls back to running the AI on the
> main thread, so it still works — the only difference is that on the hardest
> levels the UI may pause briefly while the bot thinks. See
> [Web Worker & fallback](#web-worker--fallback).

### Option 2 — run a local static server (recommended)
Running through a tiny static server enables the Web Worker, which keeps the UI
perfectly smooth even while the bot is calculating:

```bash
# from the project directory
python -m http.server
# then open http://localhost:8000/
```

Any static file server works (`npx serve`, `php -S localhost:8000`, etc.). No
build step is required — the files are served exactly as they are.

---

## How to play

1. On the **setup screen**, choose a **difficulty**, a **time control**, and a
   **piece color** (Random is the default), then press **Start Game**.
2. Move pieces by **clicking** (click a piece, then a highlighted square) or by
   **dragging and dropping**. You can also use the **keyboard** (see below).
3. Use the side panel for **New Game**, **Undo**, **Resign**, **Flip board**,
   the move list, clocks, captured pieces, and FEN/PGN tools.

Your game (position, move history, clocks, settings, and UI preferences) is
**autosaved** to `localStorage`. If you reload with a game in progress, you'll be
offered **Resume Game** or **Start New Game**.

### Keyboard controls (accessibility)
- **Arrow keys** — move the focus square around the board
- **Enter / Space** — select the focused piece, then select a destination to move
- **Esc** — cancel the current selection / promotion
- **Tab** — move between the board and the controls
- Squares and pieces have screen‑reader labels (e.g. *"e4, white pawn"*), legal
  moves are announced and shown with shape‑based markers (dots/rings, not color
  alone), and moves/results are announced via ARIA live regions.

---

## Difficulty levels

All four levels share **one** engine with different tuning (search depth, time
budget, evaluation noise, and blunder rate) — they are not four separate bots.

| Level | Rough ELO* | Behaviour |
|-------|-----------|-----------|
| **Easy** | ~600 | Shallow search, near‑instant moves, frequent imperfect moves and occasional obvious blunders |
| **Medium** | ~1100 | Modest search (≈0.5 s), occasional mistakes |
| **Hard** | ~1600 | Deeper search (≈1–2 s) with quiescence, few mistakes |
| **Impossible** | "2000+ style"* | Deepest feasible search (~3–5 s max), no intentional mistakes, strongest move it can find |

\* **These are rough educational estimates, not promises.** "Impossible" is the
strongest bot reasonably achievable inside a dependency‑free static browser
project — it is **not** a true rated engine and not Stockfish‑level.

### How the AI works
- **Negamax** search with **alpha‑beta pruning**
- **Iterative deepening** with a per‑move **time budget**
- **Quiescence search** (captures/promotions; full evasions when in check) to
  reduce the horizon effect
- **Transposition table** (Zobrist‑hashed) per search
- **Move ordering**: transposition‑table move, MVV‑LVA captures, killer moves,
  history heuristic
- **Evaluation**: material + tapered piece‑square tables + bishop pair +
  doubled/isolated pawn penalties + passed‑pawn bonuses
- **Difficulty tuning**: depth/time caps plus evaluation noise and a blunder
  probability for the lower levels

The search only ever picks from **legal** moves, and there is a defensive
fallback in the UI that substitutes a legal move if the engine ever returned an
illegal one (it shouldn't).

---

## Features

- Full standard chess rules (see [Correctness](#correctness--testing))
- Difficulty selection (Easy / Medium / Hard / Impossible)
- Time controls: Untimed, 5+0, 10+0, 15+10, and custom minutes + increment, with
  increment added after each move and loss‑on‑time handling
- **Timeout vs. insufficient material is scored as a draw**
- Color selection: Random (default) / White / Black
- Responsive layout for desktop and mobile
- Click‑to‑move **and** drag‑and‑drop (mouse and touch)
- Legal‑move highlighting with shape‑based indicators
- Promotion selection UI (with underpromotion)
- Non‑intrusive illegal‑move feedback (toast + board shake, no alert popups)
- Captured pieces display and material advantage
- Move history in standard algebraic notation (SAN)
- Status panel: turn, check/checkmate/stalemate/draw, clocks, and bot thinking
  status
- New Game, Resign, Undo Last Move
- Theme toggle (light/dark) and a board color selector
- FEN display, Copy FEN, Load FEN (for testing/debugging positions), Copy PGN
- Autosave and resume via `localStorage`
- Keyboard navigation and screen‑reader support

---

## Web Worker & fallback

`engine-worker.js` runs the AI search off the main thread so the interface stays
responsive while the bot thinks.

- If the worker loads successfully (typically when served over `http://`), it is
  used for all AI searches.
- If the page is opened from `file://` and the browser blocks the worker (or it
  otherwise fails to load), the app **automatically falls back** to running the
  same AI on the main thread. A short delay lets the "thinking" status paint
  first; the UI may briefly pause during deep searches on the hardest level.

Either way the bot plays identically — only *where* the search runs changes.

---

## Correctness & testing

Correct rules and legal move generation are the project's top priority. Move
generation is validated with **perft** node counts against well‑known reference
positions (initial position, "Kiwipete", and other standard tricky positions),
which exercises castling, en passant (including the en‑passant discovered‑check
edge case), promotions, and pins.

### Running the tests in a browser
Open **`tests.html`** (directly or via the local server) — for example
`http://localhost:8000/tests.html`. You'll see a green/red summary and a
per‑test pass/fail breakdown. There is also a **Run tests** link in the game's
header. No external test framework is used.

The suite covers: initial legal moves, piece movement rules, illegal‑move
rejection (including pins), check, checkmate, stalemate, castling rules
(through/out of check, blocked squares, lost rights), en passant, promotion and
underpromotion, threefold repetition, the fifty‑move rule, insufficient
material, FEN generation/parsing, SAN disambiguation, PGN generation, clock
timeout behaviour (including the timeout‑vs‑insufficient‑material draw),
make/unmake + Zobrist consistency, undo behaviour, AI move legality across all
difficulties, AI tactics (mate‑in‑one and winning a hanging piece), and a random
color‑assignment sanity check.

### Running checks from the command line
The shared engine/AI/test files also run under Node, which is handy for CI‑style
validation:

```bash
node --check chess.js
node --check ai.js
node --check app.js
node --check engine-worker.js
node --check test.js

node test.js      # runs the full suite and exits non-zero on any failure
```

---

## File overview

| File | Purpose |
|------|---------|
| `index.html` | Single‑page app markup: setup screen and game screen |
| `styles.css` | All styling: responsive layout, theming, board palettes, indicators |
| `chess.js` | **Core rules engine** — board state, legal move generation, make/unmake, check/checkmate/draw logic, FEN/SAN/PGN, Zobrist hashing. No DOM, no AI. |
| `ai.js` | **AI** — evaluation + negamax/alpha‑beta search, iterative deepening, quiescence, transposition table, difficulty tuning. Depends on `chess.js`. |
| `engine-worker.js` | Web Worker wrapper that runs the AI off the main thread (`importScripts` of `chess.js` + `ai.js`) |
| `app.js` | UI controller — rendering, click/drag/keyboard input, promotion UI, clocks, panels, persistence, and driving the AI with worker + fallback |
| `tests.html` | Browser test runner page |
| `test.js` | The test suite (also runnable with `node test.js`) |
| `README.md` | This file |

`chess.js` and `ai.js` are shared, DOM‑free modules so the **same** code powers
the page, the Web Worker, and the tests (loaded as classic scripts via
`<script>` / `importScripts` so everything works from `file://`).

---

## Known limitations

- **Bot strength is approximate.** The ELO labels are rough estimates. The
  engine is a clean, readable from‑scratch implementation, not a state‑of‑the‑art
  engine; "Impossible" typically searches to roughly depth 6–8 in the time budget.
- **Repetition awareness inside search is approximate.** Exact threefold and
  fifty‑move detection are correct at the game level (and tested). Within the
  AI's look‑ahead, repetition is detected along the current search line and at
  the root using the live game's position counts, which catches the common cases
  but is not a full repetition model.
- **Insufficient‑material rule choice.** Automatic draws are awarded for K vs K,
  K+minor vs K, and same‑colored‑bishop K+B vs K+B. For the
  timeout‑vs‑insufficient‑material rule, a side is considered unable to mate if it
  has no pawns/rooks/queens and at most one minor piece (so K+N+N vs K is treated
  as *able* to mate and is not auto‑drawn). This is a reasonable, commonly used
  interpretation.
- **Unicode pieces depend on system fonts.** Rendering uses your OS's symbol
  font; glyphs are styled with fills and outlines for contrast on both square
  colors, but exact appearance varies by platform.
- **`localStorage` required for autosave.** In private/incognito modes that block
  storage, the game still plays but won't persist across reloads.
- **Custom positions and the move counter.** Loading an arbitrary FEN starts a
  fresh game from that position; captured‑piece tallies assume the standard
  starting material, so they may look off for non‑standard starting positions.
