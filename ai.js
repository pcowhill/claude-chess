/*
 * ai.js — Local chess AI (no external engine).
 *
 * One shared engine, tuned per difficulty. Techniques used:
 *   - Negamax with alpha-beta pruning
 *   - Iterative deepening with a time budget
 *   - Transposition table (Zobrist-keyed, per-search)
 *   - Move ordering: TT move, MVV-LVA captures, killer moves, history heuristic
 *   - Quiescence search (captures/promotions, full evasions when in check)
 *   - Tapered piece-square-table evaluation with simple pawn-structure terms
 *   - Difficulty-specific depth, time, randomness and blunder behaviour
 *
 * Depends on ChessEngine (chess.js), available on the global object.
 */
(function (global) {
  'use strict';

  var CE = global.ChessEngine;
  if (!CE && typeof require !== 'undefined') { try { CE = require('./chess.js'); } catch (e) { /* not node */ } }
  if (!CE) throw new Error('ai.js requires chess.js (ChessEngine) to be loaded first');

  var PAWN = CE.PAWN, KNIGHT = CE.KNIGHT, BISHOP = CE.BISHOP, ROOK = CE.ROOK, QUEEN = CE.QUEEN, KING = CE.KING;
  var WHITE = CE.WHITE, BLACK = CE.BLACK;
  var FLAG_CAPTURE = CE.FLAG_CAPTURE, FLAG_PROMO = CE.FLAG_PROMO;
  var rankOf = CE.rankOf, fileOf = CE.fileOf, pieceType = CE.pieceType, colorOf = CE.colorOf;

  var MATE = 30000;
  var INF = 1000000;

  // Material values (centipawns).
  var PIECE_VALUE = [0, 100, 320, 330, 500, 900, 20000];

  // ---- Piece-square tables (visual order: a8..h8 first row, a1..h1 last) ----
  var PST_PAWN = [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0
  ];
  var PST_KNIGHT = [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50
  ];
  var PST_BISHOP = [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20
  ];
  var PST_ROOK = [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0
  ];
  var PST_QUEEN = [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20
  ];
  var PST_KING_MG = [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20
  ];
  var PST_KING_EG = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50
  ];

  var PST = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, null];

  // White reads the table mirrored (our index a1=0); black reads it directly.
  function pstWhite(table, sq) { return table[sq ^ 56]; }
  function pstBlack(table, sq) { return table[sq]; }

  // ---- Evaluation ----------------------------------------------------------
  // Returns a score in centipawns from White's point of view.
  function evaluateWhite(pos) {
    var board = pos.board;
    var mgWhite = 0, mgBlack = 0;
    var kingWhiteSq = -1, kingBlackSq = -1;
    var whiteBishops = 0, blackBishops = 0;
    var phase = 0;

    // Pawn file tracking for structure terms.
    var wPawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    var bPawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    var wPawnSquares = [];
    var bPawnSquares = [];

    for (var sq = 0; sq < 64; sq++) {
      var p = board[sq];
      if (p === 0) continue;
      var type = pieceType(p);
      var color = colorOf(p);

      if (color === WHITE) {
        mgWhite += PIECE_VALUE[type];
        if (type === KING) { kingWhiteSq = sq; }
        else if (type !== PAWN) mgWhite += pstWhite(PST[type], sq);
        else { mgWhite += pstWhite(PST_PAWN, sq); wPawnFiles[fileOf(sq)]++; wPawnSquares.push(sq); }
        if (type === BISHOP) whiteBishops++;
      } else {
        mgBlack += PIECE_VALUE[type];
        if (type === KING) { kingBlackSq = sq; }
        else if (type !== PAWN) mgBlack += pstBlack(PST[type], sq);
        else { mgBlack += pstBlack(PST_PAWN, sq); bPawnFiles[fileOf(sq)]++; bPawnSquares.push(sq); }
        if (type === BISHOP) blackBishops++;
      }

      if (type === KNIGHT || type === BISHOP) phase += 1;
      else if (type === ROOK) phase += 2;
      else if (type === QUEEN) phase += 4;
    }

    // Tapered king PST (24 = full middlegame, 0 = pure endgame).
    if (phase > 24) phase = 24;
    var mgW = phase / 24, egW = 1 - mgW;
    if (kingWhiteSq !== -1) {
      mgWhite += Math.round(mgW * pstWhite(PST_KING_MG, kingWhiteSq) + egW * pstWhite(PST_KING_EG, kingWhiteSq));
    }
    if (kingBlackSq !== -1) {
      mgBlack += Math.round(mgW * pstBlack(PST_KING_MG, kingBlackSq) + egW * pstBlack(PST_KING_EG, kingBlackSq));
    }

    // Bishop pair bonus.
    if (whiteBishops >= 2) mgWhite += 30;
    if (blackBishops >= 2) mgBlack += 30;

    // Pawn structure: doubled and isolated penalties.
    var f;
    for (f = 0; f < 8; f++) {
      if (wPawnFiles[f] > 1) mgWhite -= 12 * (wPawnFiles[f] - 1);
      if (bPawnFiles[f] > 1) mgBlack -= 12 * (bPawnFiles[f] - 1);
      if (wPawnFiles[f] > 0) {
        var wLeft = f > 0 ? wPawnFiles[f - 1] : 0;
        var wRight = f < 7 ? wPawnFiles[f + 1] : 0;
        if (wLeft === 0 && wRight === 0) mgWhite -= 15 * wPawnFiles[f];
      }
      if (bPawnFiles[f] > 0) {
        var bLeft = f > 0 ? bPawnFiles[f - 1] : 0;
        var bRight = f < 7 ? bPawnFiles[f + 1] : 0;
        if (bLeft === 0 && bRight === 0) mgBlack -= 15 * bPawnFiles[f];
      }
    }

    // Passed pawns: bonus scaled by how advanced the pawn is.
    var i, psq, pr, pf, passed, j, bsq;
    for (i = 0; i < wPawnSquares.length; i++) {
      psq = wPawnSquares[i]; pr = rankOf(psq); pf = fileOf(psq);
      passed = true;
      for (j = 0; j < bPawnSquares.length; j++) {
        bsq = bPawnSquares[j];
        if (Math.abs(fileOf(bsq) - pf) <= 1 && rankOf(bsq) > pr) { passed = false; break; }
      }
      if (passed) mgWhite += [0, 10, 20, 30, 50, 80, 120, 0][pr];
    }
    for (i = 0; i < bPawnSquares.length; i++) {
      psq = bPawnSquares[i]; pr = rankOf(psq); pf = fileOf(psq);
      passed = true;
      for (j = 0; j < wPawnSquares.length; j++) {
        bsq = wPawnSquares[j];
        if (Math.abs(fileOf(bsq) - pf) <= 1 && rankOf(bsq) < pr) { passed = false; break; }
      }
      if (passed) mgBlack += [0, 0, 120, 80, 50, 30, 20, 10][pr];
    }

    return mgWhite - mgBlack;
  }

  // ---- Search context ------------------------------------------------------
  function Searcher() {
    this.tt = null;
    this.killers = null;
    this.history = null;
    this.nodes = 0;
    this.startTime = 0;
    this.stopTime = 0;
    this.stopped = false;
    this.pathLo = [];
    this.pathHi = [];
  }

  var TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

  Searcher.prototype._timeUp = function () {
    if (this.stopped) return true;
    if ((this.nodes & 2047) === 0) {
      if (Date.now() >= this.stopTime) { this.stopped = true; return true; }
    }
    return false;
  };

  // Order moves to improve alpha-beta pruning.
  Searcher.prototype._scoreMove = function (m, ttMove, ply) {
    if (ttMove && m.from === ttMove.from && m.to === ttMove.to && m.promotion === ttMove.promotion) {
      return 1000000;
    }
    var score = 0;
    if (m.flags & FLAG_CAPTURE) {
      var victim = m.captured ? pieceType(m.captured) : PAWN;
      var attacker = pieceType(m.piece);
      score = 100000 + PIECE_VALUE[victim] * 10 - PIECE_VALUE[attacker];
    } else {
      var k = this.killers[ply];
      if (k) {
        if (k[0] && k[0].from === m.from && k[0].to === m.to) score = 90000;
        else if (k[1] && k[1].from === m.from && k[1].to === m.to) score = 80000;
      }
      if (score === 0) score = this.history[m.from * 64 + m.to] || 0;
    }
    if (m.flags & FLAG_PROMO) score += PIECE_VALUE[m.promotion];
    return score;
  };

  Searcher.prototype._orderMoves = function (moves, ttMove, ply) {
    var self = this;
    for (var i = 0; i < moves.length; i++) moves[i]._score = self._scoreMove(moves[i], ttMove, ply);
    moves.sort(function (a, b) { return b._score - a._score; });
  };

  // Detect repetition within the current search path (approximate, but catches
  // the engine shuffling pieces / repeating positions during calculation).
  Searcher.prototype._isRepetition = function (pos) {
    var lo = pos.hashLo, hi = pos.hashHi;
    for (var i = this.pathLo.length - 2; i >= 0; i -= 2) {
      if (this.pathLo[i] === lo && this.pathHi[i] === hi) return true;
    }
    return false;
  };

  Searcher.prototype.quiescence = function (pos, alpha, beta, ply) {
    this.nodes++;
    if (this._timeUp()) return 0;

    var inCheck = pos.inCheck(pos.turn);
    var standPat;
    var moves;

    if (inCheck) {
      // When in check, search all evasions (no stand-pat).
      standPat = -INF;
      moves = pos.generateLegalMoves(false);
      if (moves.length === 0) return -MATE + ply; // checkmate
    } else {
      standPat = (pos.turn === WHITE ? 1 : -1) * evaluateWhite(pos);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      moves = pos.generateLegalMoves(true); // captures + promotions
    }

    this._orderMoves(moves, null, ply);
    var best = standPat;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var u = pos.makeMove(m);
      var score = -this.quiescence(pos, -beta, -alpha, ply + 1);
      pos.unmakeMove(m, u);
      if (this.stopped) return 0;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  };

  Searcher.prototype.negamax = function (pos, depth, alpha, beta, ply) {
    this.nodes++;
    if (this._timeUp()) return 0;

    // Draw detections inside the tree (kept cheap; the evaluation already
    // scores bare-king material near zero, and game-level draw detection is
    // authoritative, so an O(64) insufficient-material scan per node is skipped).
    if (ply > 0) {
      if (pos.halfmove >= 100) return 0;
      if (this._isRepetition(pos)) return 0;
    }

    var alphaOrig = alpha;
    var key = (pos.hashLo >>> 0);
    var ttEntry = this.tt.get(key);
    var ttMove = null;
    if (ttEntry && ttEntry.hi === pos.hashHi) {
      ttMove = ttEntry.move;
      if (ttEntry.depth >= depth) {
        if (ttEntry.flag === TT_EXACT) return ttEntry.score;
        if (ttEntry.flag === TT_LOWER && ttEntry.score > alpha) alpha = ttEntry.score;
        else if (ttEntry.flag === TT_UPPER && ttEntry.score < beta) beta = ttEntry.score;
        if (alpha >= beta) return ttEntry.score;
      }
    }

    if (depth <= 0) return this.quiescence(pos, alpha, beta, ply);

    var moves = pos.generateLegalMoves(false);
    if (moves.length === 0) {
      return pos.inCheck(pos.turn) ? (-MATE + ply) : 0; // checkmate or stalemate
    }

    this._orderMoves(moves, ttMove, ply);

    var best = -INF;
    var bestMove = null;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var u = pos.makeMove(m);
      this.pathLo.push(pos.hashLo); this.pathHi.push(pos.hashHi);
      var score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1);
      this.pathLo.pop(); this.pathHi.pop();
      pos.unmakeMove(m, u);
      if (this.stopped) return 0;

      if (score > best) { best = score; bestMove = m; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        // Beta cutoff: update killers/history for quiet moves.
        if (!(m.flags & FLAG_CAPTURE)) {
          var k = this.killers[ply] || (this.killers[ply] = [null, null]);
          if (!k[0] || k[0].from !== m.from || k[0].to !== m.to) { k[1] = k[0]; k[0] = m; }
          this.history[m.from * 64 + m.to] = (this.history[m.from * 64 + m.to] || 0) + depth * depth;
        }
        break;
      }
    }

    // Store in transposition table.
    var flag = best <= alphaOrig ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
    this.tt.set(key, { hi: pos.hashHi, depth: depth, score: best, flag: flag, move: bestMove });

    return best;
  };

  // Search the root, returning per-move scores for difficulty-based selection.
  Searcher.prototype.searchRoot = function (pos, depth, prevBest, repetitionCounts) {
    var moves = pos.generateLegalMoves(false);
    this._orderMoves(moves, prevBest, 0);

    var alpha = -INF, beta = INF;
    var results = [];
    var bestMove = null, bestScore = -INF;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var u = pos.makeMove(m);
      this.pathLo.push(pos.hashLo); this.pathHi.push(pos.hashHi);

      var score;
      // Root-level repetition awareness using the real game's position counts.
      var repHit = false;
      if (repetitionCounts) {
        var rk = pos._repKey();
        if ((repetitionCounts[rk] || 0) + 1 >= 3) { score = 0; repHit = true; }
      }
      if (!repHit) score = -this.negamax(pos, depth - 1, -beta, -alpha, 1);

      this.pathLo.pop(); this.pathHi.pop();
      pos.unmakeMove(m, u);
      if (this.stopped) break;

      results.push({ move: m, score: score });
      if (score > bestScore) { bestScore = score; bestMove = m; }
      if (score > alpha) alpha = score;
    }

    return { move: bestMove, score: bestScore, results: results, complete: !this.stopped };
  };

  // ---- Difficulty configuration -------------------------------------------
  // noise: centipawn standard-deviation added when picking a root move.
  // blunder: probability of choosing a (weighted) clearly worse legal move.
  var DIFFICULTIES = {
    easy: { label: 'Easy', elo: '~600', maxDepth: 2, timeMs: 200, noise: 130, blunder: 0.30 },
    medium: { label: 'Medium', elo: '~1100', maxDepth: 3, timeMs: 500, noise: 55, blunder: 0.08 },
    hard: { label: 'Hard', elo: '~1600', maxDepth: 5, timeMs: 1500, noise: 18, blunder: 0.0 },
    impossible: { label: 'Impossible', elo: '2000+ style', maxDepth: 64, timeMs: 4000, noise: 0, blunder: 0.0 }
  };

  function gaussian() {
    // Box-Muller transform for ~N(0,1).
    var u = 1 - Math.random(), v = 1 - Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Choose a move from scored root results according to difficulty knobs.
  function pickMove(results, cfg) {
    if (results.length === 0) return null;
    if (results.length === 1) return results[0].move;

    // Occasional blunder: pick a weighted-random move biased away from the best.
    if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
      // Weight worse moves higher to simulate a human-ish mistake, but never
      // deliberately walk into immediate checkmate when alternatives exist.
      var sorted = results.slice().sort(function (a, b) { return b.score - a.score; });
      var pool = sorted.filter(function (r) { return r.score > -MATE + 100; });
      if (pool.length === 0) pool = sorted;
      // Pick from the weaker half when possible.
      var start = pool.length > 2 ? 1 : 0;
      var idx = start + Math.floor(Math.random() * (pool.length - start));
      return pool[idx].move;
    }

    // Apply Gaussian noise to scores and take the max (sharper play = less noise).
    var bestMove = results[0].move;
    var bestScore = -Infinity;
    for (var i = 0; i < results.length; i++) {
      var noisy = results[i].score + (cfg.noise > 0 ? gaussian() * cfg.noise : 0);
      if (noisy > bestScore) { bestScore = noisy; bestMove = results[i].move; }
    }
    return bestMove;
  }

  // ---- Public entry point --------------------------------------------------
  // Returns { from, to, promotion, san, score, depth, nodes, timeMs }.
  function chooseMove(fen, options) {
    options = options || {};
    var cfg = DIFFICULTIES[options.difficulty] || DIFFICULTIES.medium;
    // Allow explicit overrides (used by tests).
    var maxDepth = options.maxDepth || cfg.maxDepth;
    var timeMs = options.timeMs || cfg.timeMs;

    var pos = new CE.Chess(fen);
    var legal = pos.generateLegalMoves(false);
    if (legal.length === 0) return null;

    var searcher = new Searcher();
    searcher.tt = new Map();
    searcher.killers = [];
    searcher.history = new Int32Array(64 * 64);
    searcher.startTime = Date.now();
    searcher.stopTime = searcher.startTime + timeMs;

    var lastResult = null;
    var prevBest = null;
    var reachedDepth = 0;

    for (var depth = 1; depth <= maxDepth; depth++) {
      searcher.stopped = false;
      var res = searcher.searchRoot(pos, depth, prevBest, options.repetition);
      if (res.complete && res.move) {
        lastResult = res;
        prevBest = res.move;
        reachedDepth = depth;
        // Stop early on a found forced mate.
        if (Math.abs(res.score) >= MATE - 100) break;
      } else {
        break; // ran out of time mid-iteration; keep previous result
      }
      if (Date.now() >= searcher.stopTime) break;
    }

    if (!lastResult) {
      // Fallback: should not happen, but never return an illegal/no move.
      return formatMove(legal[0], pos, reachedDepth, searcher.nodes, searcher.startTime);
    }

    var chosen = pickMove(lastResult.results, cfg) || lastResult.move;
    return formatMove(chosen, pos, reachedDepth, searcher.nodes, searcher.startTime, lastResult.score);
  }

  function formatMove(m, pos, depth, nodes, startTime, score) {
    var promo = null;
    if (m.flags & FLAG_PROMO) {
      promo = ({ 2: 'n', 3: 'b', 4: 'r', 5: 'q' })[m.promotion] || 'q';
    }
    return {
      from: m.from, to: m.to, promotion: promo,
      depth: depth, nodes: nodes, score: score || 0,
      timeMs: Date.now() - startTime
    };
  }

  // ---- Export --------------------------------------------------------------
  var api = {
    chooseMove: chooseMove,
    evaluateWhite: evaluateWhite,
    DIFFICULTIES: DIFFICULTIES,
    PIECE_VALUE: PIECE_VALUE,
    Searcher: Searcher
  };
  global.ChessAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : this);
