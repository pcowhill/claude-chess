/*
 * chess.js — A from-scratch standard chess rules engine (no dependencies).
 *
 * This file contains NO DOM and NO AI code so it can be shared by:
 *   - the page (loaded via <script> in index.html / tests.html)
 *   - the Web Worker (loaded via importScripts in engine-worker.js)
 *
 * Board representation:
 *   - 64-element Int8Array, index = rank * 8 + file
 *   - rank 0 == chess rank "1" (White's home rank), rank 7 == rank "8"
 *   - file 0 == 'a', file 7 == 'h'
 *   - White pawns advance in the +8 direction, Black pawns in the -8 direction.
 *
 * Piece encoding (small integers):
 *   - EMPTY = 0
 *   - White: PAWN..KING = 1..6
 *   - Black: same type + 8  (so the "color bit" is 0x8)
 *   - pieceType(p) = p & 7 ; colorOf(p) = (p & 8) ? BLACK : WHITE
 *
 * Move object: { from, to, piece, captured, promotion, flags }
 */
(function (global) {
  'use strict';

  // ---- Constants -----------------------------------------------------------
  var EMPTY = 0;
  var PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  var WHITE = 0, BLACK = 1;
  var COLOR_BIT = 8;

  // Move flags (bitmask)
  var FLAG_NORMAL = 0;
  var FLAG_CAPTURE = 1;
  var FLAG_DOUBLE = 2;   // double pawn push
  var FLAG_EP = 4;       // en passant capture
  var FLAG_KCASTLE = 8;  // kingside castle
  var FLAG_QCASTLE = 16; // queenside castle
  var FLAG_PROMO = 32;   // promotion

  // Castling rights bits
  var CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

  // Useful square indices
  var A1 = 0, B1 = 1, C1 = 2, D1 = 3, E1 = 4, F1 = 5, G1 = 6, H1 = 7;
  var A8 = 56, B8 = 57, C8 = 58, D8 = 59, E8 = 60, F8 = 61, G8 = 62, H8 = 63;

  // Direction offsets in (dr, df) form
  var KNIGHT_DELTAS = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  var KING_DELTAS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  var BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  var ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ---- Small helpers -------------------------------------------------------
  function rankOf(sq) { return sq >> 3; }
  function fileOf(sq) { return sq & 7; }
  function makeSq(rank, file) { return rank * 8 + file; }
  function inBounds(rank, file) { return rank >= 0 && rank < 8 && file >= 0 && file < 8; }
  function pieceType(p) { return p & 7; }
  function colorOf(p) { return (p & COLOR_BIT) ? BLACK : WHITE; }
  function makePiece(type, color) { return color === BLACK ? (type | COLOR_BIT) : type; }
  function opponent(color) { return color === WHITE ? BLACK : WHITE; }

  function squareName(sq) {
    return String.fromCharCode(97 + fileOf(sq)) + String.fromCharCode(49 + rankOf(sq));
  }
  function squareFromName(name) {
    if (!name || name.length < 2) return -1;
    var file = name.charCodeAt(0) - 97;
    var rank = name.charCodeAt(1) - 49;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
    return makeSq(rank, file);
  }

  // FEN piece <-> integer maps
  var FEN_TO_PIECE = {
    P: makePiece(PAWN, WHITE), N: makePiece(KNIGHT, WHITE), B: makePiece(BISHOP, WHITE),
    R: makePiece(ROOK, WHITE), Q: makePiece(QUEEN, WHITE), K: makePiece(KING, WHITE),
    p: makePiece(PAWN, BLACK), n: makePiece(KNIGHT, BLACK), b: makePiece(BISHOP, BLACK),
    r: makePiece(ROOK, BLACK), q: makePiece(QUEEN, BLACK), k: makePiece(KING, BLACK)
  };
  var PIECE_TO_FEN = {};
  (function () {
    for (var k in FEN_TO_PIECE) { if (FEN_TO_PIECE.hasOwnProperty(k)) PIECE_TO_FEN[FEN_TO_PIECE[k]] = k; }
  })();
  var TYPE_TO_LETTER = { 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };

  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // ---- Zobrist hashing (used for the AI transposition table) ---------------
  // A small deterministic PRNG so tables are identical every load.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0);
    };
  }
  var ZOBRIST = (function () {
    var rng = mulberry32(0x1a2b3c4d);
    var pieceLo = [], pieceHi = [];
    for (var p = 0; p < 16; p++) {
      pieceLo[p] = []; pieceHi[p] = [];
      for (var s = 0; s < 64; s++) { pieceLo[p][s] = rng() | 0; pieceHi[p][s] = rng() | 0; }
    }
    var castleLo = [], castleHi = [];
    for (var c = 0; c < 16; c++) { castleLo[c] = rng() | 0; castleHi[c] = rng() | 0; }
    var epLo = [], epHi = [];
    for (var f = 0; f < 8; f++) { epLo[f] = rng() | 0; epHi[f] = rng() | 0; }
    return {
      pieceLo: pieceLo, pieceHi: pieceHi,
      castleLo: castleLo, castleHi: castleHi,
      epLo: epLo, epHi: epHi,
      sideLo: rng() | 0, sideHi: rng() | 0
    };
  })();

  // ---- Chess position class ------------------------------------------------
  function Chess(fen) {
    this.board = new Int8Array(64);
    this.turn = WHITE;
    this.castling = 0;
    this.ep = -1;          // en passant target square, or -1
    this.halfmove = 0;     // halfmove clock (for fifty-move rule)
    this.fullmove = 1;
    this.kings = [-1, -1]; // king square per color
    this.hashLo = 0;
    this.hashHi = 0;
    this.history = [];     // high-level move records {move, undo, san}
    this.repetition = Object.create(null); // position key -> count
    this.load(fen || START_FEN);
  }

  Chess.prototype.clone = function () {
    var c = new Chess(this.fen());
    // Copy history/repetition for accurate draw detection after cloning.
    c.history = this.history.slice();
    c.repetition = Object.create(null);
    for (var k in this.repetition) c.repetition[k] = this.repetition[k];
    return c;
  };

  // ---- FEN -----------------------------------------------------------------
  Chess.prototype.load = function (fen) {
    var parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Invalid FEN: ' + fen);
    var placement = parts[0];
    var rows = placement.split('/');
    if (rows.length !== 8) throw new Error('Invalid FEN board: ' + placement);

    this.board = new Int8Array(64);
    this.kings = [-1, -1];
    // FEN lists rank 8 first; our rank index 7 is rank 8.
    for (var r = 0; r < 8; r++) {
      var row = rows[r];
      var rankIndex = 7 - r;
      var file = 0;
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          var piece = FEN_TO_PIECE[ch];
          if (piece === undefined) throw new Error('Invalid FEN piece: ' + ch);
          if (file > 7) throw new Error('Invalid FEN: too many squares in rank');
          var sq = makeSq(rankIndex, file);
          this.board[sq] = piece;
          if (pieceType(piece) === KING) this.kings[colorOf(piece)] = sq;
          file++;
        }
      }
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;

    this.castling = 0;
    var rights = parts[2];
    if (rights.indexOf('K') !== -1) this.castling |= CASTLE_WK;
    if (rights.indexOf('Q') !== -1) this.castling |= CASTLE_WQ;
    if (rights.indexOf('k') !== -1) this.castling |= CASTLE_BK;
    if (rights.indexOf('q') !== -1) this.castling |= CASTLE_BQ;

    this.ep = parts[3] === '-' ? -1 : squareFromName(parts[3]);
    this.halfmove = parts.length > 4 ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts.length > 5 ? parseInt(parts[5], 10) || 1 : 1;

    this.history = [];
    this.repetition = Object.create(null);
    this._computeHash();
    this.repetition[this._repKey()] = 1;
    return this;
  };

  Chess.prototype.fen = function () {
    var rows = [];
    for (var r = 7; r >= 0; r--) {
      var row = '';
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = this.board[makeSq(r, f)];
        if (p === EMPTY) {
          empty++;
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          row += PIECE_TO_FEN[p];
        }
      }
      if (empty > 0) row += empty;
      rows.push(row);
    }
    var placement = rows.join('/');
    var turn = this.turn === WHITE ? 'w' : 'b';
    var rights = '';
    if (this.castling & CASTLE_WK) rights += 'K';
    if (this.castling & CASTLE_WQ) rights += 'Q';
    if (this.castling & CASTLE_BK) rights += 'k';
    if (this.castling & CASTLE_BQ) rights += 'q';
    if (rights === '') rights = '-';
    var ep = this.ep === -1 ? '-' : squareName(this.ep);
    return placement + ' ' + turn + ' ' + rights + ' ' + ep + ' ' + this.halfmove + ' ' + this.fullmove;
  };

  // Compact key for threefold repetition (placement + turn + castling + ep).
  Chess.prototype._repKey = function () {
    var rows = [];
    for (var r = 7; r >= 0; r--) {
      var row = '';
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = this.board[makeSq(r, f)];
        if (p === EMPTY) { empty++; }
        else { if (empty > 0) { row += empty; empty = 0; } row += PIECE_TO_FEN[p]; }
      }
      if (empty > 0) row += empty;
      rows.push(row);
    }
    // Only an ep square that can actually be captured matters, but including it
    // verbatim is the standard, safe behaviour and matches most implementations.
    return rows.join('/') + ' ' + (this.turn === WHITE ? 'w' : 'b') + ' ' + this.castling + ' ' + this.ep;
  };

  // ---- Zobrist helpers -----------------------------------------------------
  Chess.prototype._computeHash = function () {
    var lo = 0, hi = 0;
    for (var sq = 0; sq < 64; sq++) {
      var p = this.board[sq];
      if (p !== EMPTY) { lo ^= ZOBRIST.pieceLo[p][sq]; hi ^= ZOBRIST.pieceHi[p][sq]; }
    }
    lo ^= ZOBRIST.castleLo[this.castling]; hi ^= ZOBRIST.castleHi[this.castling];
    if (this.ep !== -1) { lo ^= ZOBRIST.epLo[fileOf(this.ep)]; hi ^= ZOBRIST.epHi[fileOf(this.ep)]; }
    if (this.turn === BLACK) { lo ^= ZOBRIST.sideLo; hi ^= ZOBRIST.sideHi; }
    this.hashLo = lo | 0; this.hashHi = hi | 0;
  };
  Chess.prototype._togglePiece = function (p, sq) {
    this.hashLo ^= ZOBRIST.pieceLo[p][sq];
    this.hashHi ^= ZOBRIST.pieceHi[p][sq];
  };

  // ---- Attack detection ----------------------------------------------------
  // Is `sq` attacked by any piece of color `byColor`?
  Chess.prototype.isSquareAttacked = function (sq, byColor) {
    var board = this.board;
    var r = rankOf(sq), f = fileOf(sq);

    // Pawn attacks: a pawn of byColor attacks diagonally "forward".
    // White pawns attack from one rank below; black pawns from one rank above.
    var pawnRank = byColor === WHITE ? r - 1 : r + 1;
    if (pawnRank >= 0 && pawnRank < 8) {
      var pawn = makePiece(PAWN, byColor);
      if (f - 1 >= 0 && board[makeSq(pawnRank, f - 1)] === pawn) return true;
      if (f + 1 < 8 && board[makeSq(pawnRank, f + 1)] === pawn) return true;
    }

    // Knight attacks
    var knight = makePiece(KNIGHT, byColor);
    for (var i = 0; i < 8; i++) {
      var nr = r + KNIGHT_DELTAS[i][0], nf = f + KNIGHT_DELTAS[i][1];
      if (inBounds(nr, nf) && board[makeSq(nr, nf)] === knight) return true;
    }

    // King attacks
    var king = makePiece(KING, byColor);
    for (var j = 0; j < 8; j++) {
      var kr = r + KING_DELTAS[j][0], kf = f + KING_DELTAS[j][1];
      if (inBounds(kr, kf) && board[makeSq(kr, kf)] === king) return true;
    }

    // Sliding: bishops/queens on diagonals
    var bishop = makePiece(BISHOP, byColor), queen = makePiece(QUEEN, byColor);
    for (var d = 0; d < 4; d++) {
      var dr = BISHOP_DIRS[d][0], df = BISHOP_DIRS[d][1];
      var cr = r + dr, cf = f + df;
      while (inBounds(cr, cf)) {
        var pc = board[makeSq(cr, cf)];
        if (pc !== EMPTY) {
          if (pc === bishop || pc === queen) return true;
          break;
        }
        cr += dr; cf += df;
      }
    }
    // Sliding: rooks/queens on files/ranks
    var rook = makePiece(ROOK, byColor);
    for (var d2 = 0; d2 < 4; d2++) {
      var dr2 = ROOK_DIRS[d2][0], df2 = ROOK_DIRS[d2][1];
      var cr2 = r + dr2, cf2 = f + df2;
      while (inBounds(cr2, cf2)) {
        var pc2 = board[makeSq(cr2, cf2)];
        if (pc2 !== EMPTY) {
          if (pc2 === rook || pc2 === queen) return true;
          break;
        }
        cr2 += dr2; cf2 += df2;
      }
    }
    return false;
  };

  Chess.prototype.kingSquare = function (color) { return this.kings[color]; };

  Chess.prototype.inCheck = function (color) {
    if (color === undefined) color = this.turn;
    var ks = this.kings[color];
    if (ks === -1) return false;
    return this.isSquareAttacked(ks, opponent(color));
  };

  // ---- Pseudo-legal move generation ---------------------------------------
  // Generates moves that follow piece movement rules but may leave the king in
  // check. `onlyCaptures` (used by quiescence search) restricts to captures and
  // promotions.
  Chess.prototype.generatePseudoLegal = function (onlyCaptures) {
    var moves = [];
    var board = this.board;
    var us = this.turn;
    var them = opponent(us);

    for (var sq = 0; sq < 64; sq++) {
      var piece = board[sq];
      if (piece === EMPTY || colorOf(piece) !== us) continue;
      var type = pieceType(piece);
      var r = rankOf(sq), f = fileOf(sq);

      if (type === PAWN) {
        this._genPawn(sq, r, f, piece, us, them, moves, onlyCaptures);
      } else if (type === KNIGHT) {
        this._genStep(sq, r, f, piece, KNIGHT_DELTAS, them, moves, onlyCaptures);
      } else if (type === KING) {
        this._genStep(sq, r, f, piece, KING_DELTAS, them, moves, onlyCaptures);
        if (!onlyCaptures) this._genCastle(sq, us, moves);
      } else if (type === BISHOP) {
        this._genSlide(sq, r, f, piece, BISHOP_DIRS, them, moves, onlyCaptures);
      } else if (type === ROOK) {
        this._genSlide(sq, r, f, piece, ROOK_DIRS, them, moves, onlyCaptures);
      } else if (type === QUEEN) {
        this._genSlide(sq, r, f, piece, BISHOP_DIRS, them, moves, onlyCaptures);
        this._genSlide(sq, r, f, piece, ROOK_DIRS, them, moves, onlyCaptures);
      }
    }
    return moves;
  };

  Chess.prototype._genPawn = function (sq, r, f, piece, us, them, moves, onlyCaptures) {
    var board = this.board;
    var dir = us === WHITE ? 1 : -1;
    var startRank = us === WHITE ? 1 : 6;
    var promoRank = us === WHITE ? 7 : 0;
    var oneR = r + dir;

    // Forward pushes (not captures, but included unless onlyCaptures w/o promo)
    if (inBounds(oneR, f) && board[makeSq(oneR, f)] === EMPTY) {
      var oneSq = makeSq(oneR, f);
      if (oneR === promoRank) {
        this._addPromotions(sq, oneSq, piece, EMPTY, FLAG_PROMO, moves);
      } else if (!onlyCaptures) {
        moves.push(this._mkMove(sq, oneSq, piece, EMPTY, 0, FLAG_NORMAL));
        // Double push
        if (r === startRank) {
          var twoR = r + 2 * dir;
          var twoSq = makeSq(twoR, f);
          if (board[twoSq] === EMPTY) {
            moves.push(this._mkMove(sq, twoSq, piece, EMPTY, 0, FLAG_DOUBLE));
          }
        }
      }
    }

    // Captures (including en passant)
    for (var df = -1; df <= 1; df += 2) {
      var cf = f + df;
      if (cf < 0 || cf > 7) continue;
      var capSq = makeSq(oneR, cf);
      if (!inBounds(oneR, cf)) continue;
      var target = board[capSq];
      if (target !== EMPTY && colorOf(target) === them) {
        if (oneR === promoRank) {
          this._addPromotions(sq, capSq, piece, target, FLAG_PROMO | FLAG_CAPTURE, moves);
        } else {
          moves.push(this._mkMove(sq, capSq, piece, target, 0, FLAG_CAPTURE));
        }
      } else if (capSq === this.ep && this.ep !== -1) {
        // En passant: captured pawn sits beside us, not on capSq.
        var capturedPawnSq = makeSq(r, cf);
        moves.push(this._mkMove(sq, capSq, piece, board[capturedPawnSq], 0, FLAG_EP | FLAG_CAPTURE));
      }
    }
  };

  Chess.prototype._addPromotions = function (from, to, piece, captured, flags, moves) {
    var promos = [QUEEN, ROOK, BISHOP, KNIGHT];
    for (var i = 0; i < 4; i++) {
      moves.push(this._mkMove(from, to, piece, captured, promos[i], flags));
    }
  };

  Chess.prototype._genStep = function (sq, r, f, piece, deltas, them, moves, onlyCaptures) {
    var board = this.board;
    for (var i = 0; i < deltas.length; i++) {
      var nr = r + deltas[i][0], nf = f + deltas[i][1];
      if (!inBounds(nr, nf)) continue;
      var to = makeSq(nr, nf);
      var target = board[to];
      if (target === EMPTY) {
        if (!onlyCaptures) moves.push(this._mkMove(sq, to, piece, EMPTY, 0, FLAG_NORMAL));
      } else if (colorOf(target) === them) {
        moves.push(this._mkMove(sq, to, piece, target, 0, FLAG_CAPTURE));
      }
    }
  };

  Chess.prototype._genSlide = function (sq, r, f, piece, dirs, them, moves, onlyCaptures) {
    var board = this.board;
    for (var i = 0; i < dirs.length; i++) {
      var dr = dirs[i][0], df = dirs[i][1];
      var cr = r + dr, cf = f + df;
      while (inBounds(cr, cf)) {
        var to = makeSq(cr, cf);
        var target = board[to];
        if (target === EMPTY) {
          if (!onlyCaptures) moves.push(this._mkMove(sq, to, piece, EMPTY, 0, FLAG_NORMAL));
        } else {
          if (colorOf(target) === them) moves.push(this._mkMove(sq, to, piece, target, 0, FLAG_CAPTURE));
          break;
        }
        cr += dr; cf += df;
      }
    }
  };

  Chess.prototype._genCastle = function (sq, us, moves) {
    var board = this.board;
    var them = opponent(us);
    if (us === WHITE) {
      if (sq !== E1) return;
      if (this.inCheck(WHITE)) return; // cannot castle out of check
      if ((this.castling & CASTLE_WK) &&
        board[F1] === EMPTY && board[G1] === EMPTY &&
        board[H1] === makePiece(ROOK, WHITE) &&
        !this.isSquareAttacked(F1, them) && !this.isSquareAttacked(G1, them)) {
        moves.push(this._mkMove(E1, G1, makePiece(KING, WHITE), EMPTY, 0, FLAG_KCASTLE));
      }
      if ((this.castling & CASTLE_WQ) &&
        board[D1] === EMPTY && board[C1] === EMPTY && board[B1] === EMPTY &&
        board[A1] === makePiece(ROOK, WHITE) &&
        !this.isSquareAttacked(D1, them) && !this.isSquareAttacked(C1, them)) {
        moves.push(this._mkMove(E1, C1, makePiece(KING, WHITE), EMPTY, 0, FLAG_QCASTLE));
      }
    } else {
      if (sq !== E8) return;
      if (this.inCheck(BLACK)) return;
      if ((this.castling & CASTLE_BK) &&
        board[F8] === EMPTY && board[G8] === EMPTY &&
        board[H8] === makePiece(ROOK, BLACK) &&
        !this.isSquareAttacked(F8, them) && !this.isSquareAttacked(G8, them)) {
        moves.push(this._mkMove(E8, G8, makePiece(KING, BLACK), EMPTY, 0, FLAG_KCASTLE));
      }
      if ((this.castling & CASTLE_BQ) &&
        board[D8] === EMPTY && board[C8] === EMPTY && board[B8] === EMPTY &&
        board[A8] === makePiece(ROOK, BLACK) &&
        !this.isSquareAttacked(D8, them) && !this.isSquareAttacked(C8, them)) {
        moves.push(this._mkMove(E8, C8, makePiece(KING, BLACK), EMPTY, 0, FLAG_QCASTLE));
      }
    }
  };

  Chess.prototype._mkMove = function (from, to, piece, captured, promotion, flags) {
    return { from: from, to: to, piece: piece, captured: captured, promotion: promotion, flags: flags };
  };

  // ---- Legal move generation ----------------------------------------------
  // Filter pseudo-legal moves by making each and checking the king is safe.
  // This correctly handles pins and the tricky en-passant discovered-check case.
  Chess.prototype.generateLegalMoves = function (onlyCaptures) {
    var pseudo = this.generatePseudoLegal(onlyCaptures);
    var legal = [];
    var us = this.turn;
    for (var i = 0; i < pseudo.length; i++) {
      var m = pseudo[i];
      var undo = this.makeMove(m);
      if (!this.isSquareAttacked(this.kings[us], opponent(us))) legal.push(m);
      this.unmakeMove(m, undo);
    }
    return legal;
  };

  // ---- Make / unmake (fast path used by search) ---------------------------
  Chess.prototype.makeMove = function (move) {
    var board = this.board;
    var us = this.turn;
    var from = move.from, to = move.to, piece = move.piece;

    var undo = {
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
      captured: move.captured,
      capturedSq: -1,
      kingFrom: -1
    };

    // Remove old ep / castling from hash; will re-add updated values at end.
    if (this.ep !== -1) {
      this.hashLo ^= ZOBRIST.epLo[fileOf(this.ep)];
      this.hashHi ^= ZOBRIST.epHi[fileOf(this.ep)];
    }
    this.hashLo ^= ZOBRIST.castleLo[this.castling];
    this.hashHi ^= ZOBRIST.castleHi[this.castling];

    var isCapture = (move.flags & FLAG_CAPTURE) !== 0;
    var isPawn = pieceType(piece) === PAWN;

    // Handle the captured piece (normal captures and en passant).
    if (move.flags & FLAG_EP) {
      var capturedPawnSq = makeSq(rankOf(from), fileOf(to));
      undo.capturedSq = capturedPawnSq;
      this._togglePiece(board[capturedPawnSq], capturedPawnSq);
      board[capturedPawnSq] = EMPTY;
    } else if (isCapture) {
      undo.capturedSq = to;
      this._togglePiece(board[to], to);
      // board[to] will be overwritten below
    }

    // Move the piece off `from`.
    this._togglePiece(piece, from);
    board[from] = EMPTY;

    // Place piece on `to` (handle promotion).
    var placed = piece;
    if (move.flags & FLAG_PROMO) {
      placed = makePiece(move.promotion, us);
    }
    this._togglePiece(placed, to);
    board[to] = placed;

    // Castling: move the rook too.
    if (move.flags & FLAG_KCASTLE) {
      if (us === WHITE) { this._moveRook(H1, F1, WHITE); } else { this._moveRook(H8, F8, BLACK); }
    } else if (move.flags & FLAG_QCASTLE) {
      if (us === WHITE) { this._moveRook(A1, D1, WHITE); } else { this._moveRook(A8, D8, BLACK); }
    }

    // Track king position.
    if (pieceType(piece) === KING) {
      undo.kingFrom = this.kings[us];
      this.kings[us] = to;
    }

    // Update castling rights.
    this.castling = this._updateCastling(this.castling, from, to, piece);

    // Update en passant target.
    if (move.flags & FLAG_DOUBLE) {
      this.ep = makeSq((rankOf(from) + rankOf(to)) / 2, fileOf(from));
    } else {
      this.ep = -1;
    }

    // Halfmove clock.
    if (isPawn || isCapture) this.halfmove = 0; else this.halfmove++;

    // Fullmove + turn.
    if (us === BLACK) this.fullmove++;
    this.turn = opponent(us);

    // Re-add updated ep/castling and flip side-to-move in hash.
    if (this.ep !== -1) {
      this.hashLo ^= ZOBRIST.epLo[fileOf(this.ep)];
      this.hashHi ^= ZOBRIST.epHi[fileOf(this.ep)];
    }
    this.hashLo ^= ZOBRIST.castleLo[this.castling];
    this.hashHi ^= ZOBRIST.castleHi[this.castling];
    this.hashLo ^= ZOBRIST.sideLo;
    this.hashHi ^= ZOBRIST.sideHi;

    return undo;
  };

  Chess.prototype._moveRook = function (fromSq, toSq, color) {
    var rook = makePiece(ROOK, color);
    this._togglePiece(rook, fromSq);
    this.board[fromSq] = EMPTY;
    this._togglePiece(rook, toSq);
    this.board[toSq] = rook;
  };

  Chess.prototype._updateCastling = function (castling, from, to, piece) {
    var type = pieceType(piece);
    if (type === KING) {
      if (colorOf(piece) === WHITE) castling &= ~(CASTLE_WK | CASTLE_WQ);
      else castling &= ~(CASTLE_BK | CASTLE_BQ);
    }
    // Rook moved from its home square.
    if (from === A1) castling &= ~CASTLE_WQ;
    else if (from === H1) castling &= ~CASTLE_WK;
    else if (from === A8) castling &= ~CASTLE_BQ;
    else if (from === H8) castling &= ~CASTLE_BK;
    // Rook captured on its home square.
    if (to === A1) castling &= ~CASTLE_WQ;
    else if (to === H1) castling &= ~CASTLE_WK;
    else if (to === A8) castling &= ~CASTLE_BQ;
    else if (to === H8) castling &= ~CASTLE_BK;
    return castling;
  };

  Chess.prototype.unmakeMove = function (move, undo) {
    var board = this.board;
    var us = opponent(this.turn); // side that moved
    var from = move.from, to = move.to, piece = move.piece;

    this.turn = us;
    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmove = undo.halfmove;
    this.fullmove = undo.fullmove;
    this.hashLo = undo.hashLo;
    this.hashHi = undo.hashHi;

    // Restore king position.
    if (pieceType(piece) === KING) this.kings[us] = undo.kingFrom;

    // Undo rook move for castling.
    if (move.flags & FLAG_KCASTLE) {
      if (us === WHITE) { board[H1] = makePiece(ROOK, WHITE); board[F1] = EMPTY; }
      else { board[H8] = makePiece(ROOK, BLACK); board[F8] = EMPTY; }
    } else if (move.flags & FLAG_QCASTLE) {
      if (us === WHITE) { board[A1] = makePiece(ROOK, WHITE); board[D1] = EMPTY; }
      else { board[A8] = makePiece(ROOK, BLACK); board[D8] = EMPTY; }
    }

    // Put the moving piece back (undo promotion automatically by using original).
    board[from] = piece;
    board[to] = EMPTY;

    // Restore captured piece.
    if (undo.capturedSq !== -1) {
      board[undo.capturedSq] = undo.captured;
    }
  };

  // ---- High-level move application (with SAN, history, repetition) --------
  // Accepts a move object (from generateLegalMoves) or a {from,to,promotion}
  // descriptor. Returns the applied move (with .san) or null if illegal.
  Chess.prototype.move = function (desc) {
    var legal = this.generateLegalMoves();
    var chosen = null;
    for (var i = 0; i < legal.length; i++) {
      var m = legal[i];
      if (m.from === desc.from && m.to === desc.to) {
        if (m.flags & FLAG_PROMO) {
          var want = desc.promotion ? this._promoType(desc.promotion) : QUEEN;
          if (m.promotion !== want) continue;
        }
        chosen = m;
        break;
      }
    }
    if (!chosen) return null;

    var san = this._toSan(chosen, legal);
    var undo = this.makeMove(chosen);
    // Append check / checkmate marker.
    if (this.inCheck(this.turn)) {
      san += this.generateLegalMoves().length === 0 ? '#' : '+';
    }
    var key = this._repKey();
    this.repetition[key] = (this.repetition[key] || 0) + 1;
    this.history.push({ move: chosen, undo: undo, san: san, key: key });
    return Object.assign({}, chosen, { san: san });
  };

  Chess.prototype._promoType = function (p) {
    if (typeof p === 'number') return p;
    switch (String(p).toLowerCase()) {
      case 'q': return QUEEN; case 'r': return ROOK;
      case 'b': return BISHOP; case 'n': return KNIGHT;
      default: return QUEEN;
    }
  };

  Chess.prototype.undo = function () {
    if (this.history.length === 0) return null;
    var rec = this.history.pop();
    var key = rec.key;
    if (this.repetition[key]) {
      this.repetition[key]--;
      if (this.repetition[key] <= 0) delete this.repetition[key];
    }
    this.unmakeMove(rec.move, rec.undo);
    return rec.move;
  };

  // ---- SAN generation ------------------------------------------------------
  Chess.prototype._toSan = function (move, legalMoves) {
    if (move.flags & FLAG_KCASTLE) return 'O-O';
    if (move.flags & FLAG_QCASTLE) return 'O-O-O';

    var type = pieceType(move.piece);
    var isCapture = (move.flags & FLAG_CAPTURE) !== 0;
    var san = '';

    if (type === PAWN) {
      if (isCapture) san += String.fromCharCode(97 + fileOf(move.from)) + 'x';
      san += squareName(move.to);
      if (move.flags & FLAG_PROMO) san += '=' + TYPE_TO_LETTER[move.promotion];
    } else {
      san += TYPE_TO_LETTER[type];
      // Disambiguation: are there other pieces of same type that can reach `to`?
      var sameFile = false, sameRank = false, ambiguous = false;
      for (var i = 0; i < legalMoves.length; i++) {
        var o = legalMoves[i];
        if (o !== move && o.to === move.to && pieceType(o.piece) === type && o.from !== move.from) {
          ambiguous = true;
          if (fileOf(o.from) === fileOf(move.from)) sameFile = true;
          if (rankOf(o.from) === rankOf(move.from)) sameRank = true;
        }
      }
      if (ambiguous) {
        if (!sameFile) san += String.fromCharCode(97 + fileOf(move.from));
        else if (!sameRank) san += String.fromCharCode(49 + rankOf(move.from));
        else san += squareName(move.from);
      }
      if (isCapture) san += 'x';
      san += squareName(move.to);
    }
    return san;
  };

  // ---- Game state queries --------------------------------------------------
  Chess.prototype.isCheck = function () { return this.inCheck(this.turn); };

  Chess.prototype.isCheckmate = function () {
    return this.inCheck(this.turn) && this.generateLegalMoves().length === 0;
  };

  Chess.prototype.isStalemate = function () {
    return !this.inCheck(this.turn) && this.generateLegalMoves().length === 0;
  };

  Chess.prototype.isFiftyMoveDraw = function () { return this.halfmove >= 100; };

  Chess.prototype.isThreefoldRepetition = function () {
    var key = this._repKey();
    return (this.repetition[key] || 0) >= 3;
  };

  // Count material to decide insufficient-material draws.
  Chess.prototype._materialCount = function () {
    var c = {
      whiteBishopsLight: 0, whiteBishopsDark: 0, blackBishopsLight: 0, blackBishopsDark: 0,
      whiteKnights: 0, blackKnights: 0, whiteOthers: 0, blackOthers: 0
    };
    for (var sq = 0; sq < 64; sq++) {
      var p = this.board[sq];
      if (p === EMPTY) continue;
      var t = pieceType(p), col = colorOf(p);
      var light = ((rankOf(sq) + fileOf(sq)) % 2) === 1;
      if (t === KING) continue;
      if (t === BISHOP) {
        if (col === WHITE) { if (light) c.whiteBishopsLight++; else c.whiteBishopsDark++; }
        else { if (light) c.blackBishopsLight++; else c.blackBishopsDark++; }
      } else if (t === KNIGHT) {
        if (col === WHITE) c.whiteKnights++; else c.blackKnights++;
      } else {
        if (col === WHITE) c.whiteOthers++; else c.blackOthers++;
      }
    }
    return c;
  };

  Chess.prototype.isInsufficientMaterial = function () {
    var c = this._materialCount();
    if (c.whiteOthers > 0 || c.blackOthers > 0) return false; // pawns/rooks/queens present
    var wB = c.whiteBishopsLight + c.whiteBishopsDark;
    var bB = c.blackBishopsLight + c.blackBishopsDark;
    var wMinors = wB + c.whiteKnights;
    var bMinors = bB + c.blackKnights;

    // K vs K
    if (wMinors === 0 && bMinors === 0) return true;
    // K + single minor vs K
    if (wMinors === 1 && bMinors === 0) return true;
    if (bMinors === 1 && wMinors === 0) return true;
    // K+B vs K+B with bishops on the same colour
    if (c.whiteKnights === 0 && c.blackKnights === 0 && wB === 1 && bB === 1) {
      var whiteOnLight = c.whiteBishopsLight === 1;
      var blackOnLight = c.blackBishopsLight === 1;
      if (whiteOnLight === blackOnLight) return true;
    }
    return false;
  };

  // True if `color` lacks the material to ever deliver checkmate.
  // Used for the "timeout = draw if opponent can't mate" rule.
  Chess.prototype.hasInsufficientMatingMaterial = function (color) {
    var c = this._materialCount();
    if (color === WHITE) {
      if (c.whiteOthers > 0) return false; // pawn/rook/queen can mate
      return (c.whiteBishopsLight + c.whiteBishopsDark + c.whiteKnights) <= 1;
    } else {
      if (c.blackOthers > 0) return false;
      return (c.blackBishopsLight + c.blackBishopsDark + c.blackKnights) <= 1;
    }
  };

  Chess.prototype.isDraw = function () {
    return this.isStalemate() || this.isFiftyMoveDraw() ||
      this.isThreefoldRepetition() || this.isInsufficientMaterial();
  };

  Chess.prototype.isGameOver = function () {
    return this.generateLegalMoves().length === 0 || this.isFiftyMoveDraw() ||
      this.isThreefoldRepetition() || this.isInsufficientMaterial();
  };

  // Returns a result descriptor or null if game is ongoing.
  Chess.prototype.result = function () {
    var legalCount = this.generateLegalMoves().length;
    if (legalCount === 0) {
      if (this.inCheck(this.turn)) {
        var winner = opponent(this.turn);
        return { over: true, result: winner === WHITE ? '1-0' : '0-1',
          reason: 'checkmate', winner: winner };
      }
      return { over: true, result: '1/2-1/2', reason: 'stalemate', winner: null };
    }
    if (this.isFiftyMoveDraw()) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule', winner: null };
    if (this.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'threefold repetition', winner: null };
    if (this.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material', winner: null };
    return null;
  };

  // ---- PGN generation ------------------------------------------------------
  Chess.prototype.pgn = function (headers) {
    var out = '';
    headers = headers || {};
    var order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    var used = {};
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      if (headers[k] !== undefined) { out += '[' + k + ' "' + headers[k] + '"]\n'; used[k] = true; }
    }
    for (var hk in headers) {
      if (headers.hasOwnProperty(hk) && !used[hk]) out += '[' + hk + ' "' + headers[hk] + '"]\n';
    }
    out += '\n';

    var body = '';
    // Determine the starting move number / side from history length isn't enough
    // if a FEN start was used; we assume standard start for PGN move numbers.
    var moveNum = 1;
    var firstColor = WHITE;
    // Reconstruct numbering from fullmove of the first record if available.
    var line = '';
    for (var j = 0; j < this.history.length; j++) {
      var rec = this.history[j];
      var whiteToMove = (j % 2 === 0) === (firstColor === WHITE);
      if (whiteToMove) line += moveNum + '. ';
      line += rec.san + ' ';
      if (!whiteToMove) moveNum++;
    }
    var res = this.result();
    var resultStr = res ? res.result : '*';
    line += resultStr;

    // Wrap lines at ~80 chars for nicer PGN output.
    var words = line.split(' ');
    var col = 0;
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      if (col + word.length + 1 > 80) { body += '\n'; col = 0; }
      body += (col === 0 ? '' : ' ') + word;
      col += word.length + (col === 0 ? 0 : 1);
    }
    return out + body + '\n';
  };

  // ---- Convenience accessors ----------------------------------------------
  Chess.prototype.get = function (sq) { return this.board[sq]; };
  Chess.prototype.turnColor = function () { return this.turn; };

  // SAN string list of the game so far.
  Chess.prototype.sanHistory = function () {
    var arr = [];
    for (var i = 0; i < this.history.length; i++) arr.push(this.history[i].san);
    return arr;
  };

  // ---- Export --------------------------------------------------------------
  var api = {
    Chess: Chess,
    // constants
    EMPTY: EMPTY, PAWN: PAWN, KNIGHT: KNIGHT, BISHOP: BISHOP, ROOK: ROOK, QUEEN: QUEEN, KING: KING,
    WHITE: WHITE, BLACK: BLACK,
    FLAG_NORMAL: FLAG_NORMAL, FLAG_CAPTURE: FLAG_CAPTURE, FLAG_DOUBLE: FLAG_DOUBLE,
    FLAG_EP: FLAG_EP, FLAG_KCASTLE: FLAG_KCASTLE, FLAG_QCASTLE: FLAG_QCASTLE, FLAG_PROMO: FLAG_PROMO,
    CASTLE_WK: CASTLE_WK, CASTLE_WQ: CASTLE_WQ, CASTLE_BK: CASTLE_BK, CASTLE_BQ: CASTLE_BQ,
    START_FEN: START_FEN,
    // helpers
    rankOf: rankOf, fileOf: fileOf, makeSq: makeSq, pieceType: pieceType, colorOf: colorOf,
    makePiece: makePiece, opponent: opponent, squareName: squareName, squareFromName: squareFromName
  };

  global.ChessEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : this);
