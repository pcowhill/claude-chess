/*
 * test.js — Browser- and Node-runnable test suite for Claude Chess.
 *
 * No external test libraries. Open tests.html in a browser to see pass/fail,
 * or run `node test.js` for a console report.
 */
(function () {
  'use strict';

  // Resolve engine + AI in either environment.
  var CE = (typeof window !== 'undefined' && window.ChessEngine) ||
    (typeof self !== 'undefined' && self.ChessEngine) ||
    (typeof require !== 'undefined' && require('./chess.js'));
  var AI = (typeof window !== 'undefined' && window.ChessAI) ||
    (typeof self !== 'undefined' && self.ChessAI) ||
    (typeof require !== 'undefined' && require('./ai.js'));

  var WHITE = CE.WHITE, BLACK = CE.BLACK;
  var FLAG_EP = CE.FLAG_EP, FLAG_PROMO = CE.FLAG_PROMO, FLAG_KCASTLE = CE.FLAG_KCASTLE, FLAG_QCASTLE = CE.FLAG_QCASTLE;
  var sqn = CE.squareFromName;

  // ---- Tiny test framework -------------------------------------------------
  var tests = [];
  var groups = {};
  function test(group, name, fn) { tests.push({ group: group, name: name, fn: fn }); }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function eq(actual, expected, msg) {
    if (actual !== expected) throw new Error((msg || 'values differ') + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }

  function mv(c, from, to, promo) {
    var m = c.move({ from: sqn(from), to: sqn(to), promotion: promo });
    assert(m, 'expected legal move ' + from + to + (promo ? ('=' + promo) : ''));
    return m;
  }
  function illegal(c, from, to) {
    var m = c.move({ from: sqn(from), to: sqn(to) });
    assert(m === null, 'expected illegal move ' + from + to + ' to be rejected');
  }
  function hasMove(c, from, to) {
    return c.generateLegalMoves().some(function (m) { return m.from === sqn(from) && m.to === sqn(to); });
  }
  function perft(pos, depth) {
    if (depth === 0) return 1;
    var moves = pos.generateLegalMoves();
    if (depth === 1) return moves.length;
    var n = 0;
    for (var i = 0; i < moves.length; i++) {
      var u = pos.makeMove(moves[i]);
      n += perft(pos, depth - 1);
      pos.unmakeMove(moves[i], u);
    }
    return n;
  }

  // ======================= TESTS =======================

  // --- Initial position & move generation ---
  test('Move generation', 'Initial position has 20 legal moves', function () {
    eq(new CE.Chess().generateLegalMoves().length, 20);
  });
  test('Move generation', 'Initial FEN is standard start position', function () {
    eq(new CE.Chess().fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });
  test('Move generation', 'perft(3) from start = 8902', function () {
    eq(perft(new CE.Chess(), 3), 8902);
  });
  test('Move generation', 'perft(2) Kiwipete = 2039 (castling/ep/pins)', function () {
    eq(perft(new CE.Chess('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 2), 2039);
  });

  // --- Piece movement rules ---
  test('Piece rules', 'Knight from b1 reaches a3 and c3 only', function () {
    var c = new CE.Chess();
    var kn = c.generateLegalMoves().filter(function (m) { return m.from === sqn('b1'); });
    var tos = kn.map(function (m) { return CE.squareName(m.to); }).sort();
    eq(JSON.stringify(tos), JSON.stringify(['a3', 'c3']));
  });
  test('Piece rules', 'Blocked bishop has no moves at start', function () {
    var c = new CE.Chess();
    eq(c.generateLegalMoves().filter(function (m) { return m.from === sqn('c1'); }).length, 0);
  });
  test('Piece rules', 'Pawn double-push only from start rank', function () {
    var c = new CE.Chess();
    assert(hasMove(c, 'e2', 'e4'), 'e2-e4 should be legal');
    mv(c, 'e2', 'e4'); mv(c, 'e7', 'e5');
    assert(!hasMove(c, 'e4', 'e6'), 'e4-e6 (double from non-start) must be illegal');
  });
  test('Piece rules', 'Rook slides along open lines', function () {
    // Ra1 with Ke1 on the board: a2-a8 (7) + b1,c1,d1 (3) = 10 moves.
    var c = new CE.Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    eq(c.generateLegalMoves().filter(function (m) { return m.from === sqn('a1'); }).length, 10);
  });

  // --- Illegal move rejection ---
  test('Legality', 'Pinned piece may move along the pin but not off it', function () {
    // White king e1, white rook e2 pinned by black rook e8.
    var c = new CE.Chess('4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1');
    illegal(c, 'e2', 'd2'); // moving off the e-file exposes the king
    assert(hasMove(c, 'e2', 'e7'), 'rook may slide along the pin');
    assert(hasMove(c, 'e2', 'e8'), 'rook may capture the pinner');
  });
  test('Legality', 'Must address check (only legal evasions allowed)', function () {
    // Back-rank style: white king e1 in check from rook e8; only king/block moves legal.
    var c = new CE.Chess('4r2k/8/8/8/8/8/8/4K3 w - - 0 1');
    illegal(c, 'e1', 'e2'); // staying on file still in check
    assert(hasMove(c, 'e1', 'd1') || hasMove(c, 'e1', 'f1') || hasMove(c, 'e1', 'd2') || hasMove(c, 'e1', 'f2'), 'king must be able to step off the file');
  });

  // --- Check / checkmate / stalemate ---
  test('Check', 'Check is detected', function () {
    var c = new CE.Chess('4r2k/8/8/8/8/8/8/4K3 w - - 0 1');
    assert(c.isCheck(), 'white should be in check');
  });
  test('Checkmate', "Fool's mate is checkmate", function () {
    var c = new CE.Chess();
    mv(c, 'f2', 'f3'); mv(c, 'e7', 'e5'); mv(c, 'g2', 'g4');
    var last = mv(c, 'd8', 'h4');
    assert(c.isCheckmate(), 'position should be checkmate');
    eq(last.san, 'Qh4#');
    eq(c.result().result, '0-1');
  });
  test('Stalemate', 'Classic stalemate is a draw', function () {
    var c = new CE.Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    assert(c.isStalemate(), 'black should be stalemated');
    assert(!c.isCheck(), 'stalemate is not check');
    eq(c.result().reason, 'stalemate');
  });

  // --- Castling ---
  test('Castling', 'Kingside and queenside available when legal', function () {
    var c = new CE.Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    assert(hasMove(c, 'e1', 'g1'), 'O-O should be available');
    assert(hasMove(c, 'e1', 'c1'), 'O-O-O should be available');
    var m = c.move({ from: sqn('e1'), to: sqn('g1') });
    assert(m.flags & FLAG_KCASTLE, 'should be flagged as kingside castle');
    eq(m.san, 'O-O');
    eq(CE.squareName(63), 'h8');
    eq(c.board[sqn('f1')], CE.makePiece(CE.ROOK, WHITE), 'rook should have jumped to f1');
  });
  test('Castling', 'Cannot castle through an attacked square', function () {
    var c = new CE.Chess('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1'); // rook f2 attacks f1
    assert(!hasMove(c, 'e1', 'g1'), 'O-O must be illegal (king passes f1)');
    assert(hasMove(c, 'e1', 'c1'), 'O-O-O still legal');
  });
  test('Castling', 'Cannot castle out of check', function () {
    var c = new CE.Chess('r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1'); // rook e2 checks e1
    assert(!hasMove(c, 'e1', 'g1') && !hasMove(c, 'e1', 'c1'), 'no castling while in check');
  });
  test('Castling', 'Cannot castle when squares are occupied', function () {
    var c = new CE.Chess('r3k2r/8/8/8/8/8/8/R2BK2R w KQkq - 0 1'); // bishop d1 blocks queenside
    assert(!hasMove(c, 'e1', 'c1'), 'O-O-O blocked by bishop');
    assert(hasMove(c, 'e1', 'g1'), 'O-O still available');
  });
  test('Castling', 'Rights are lost after the king moves', function () {
    var c = new CE.Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    mv(c, 'e1', 'e2');
    eq(c.castling & (CE.CASTLE_WK | CE.CASTLE_WQ), 0, 'white castling rights cleared');
  });

  // --- En passant ---
  test('En passant', 'En passant capture is available and removes the pawn', function () {
    var c = new CE.Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    assert(hasMove(c, 'e5', 'd6'), 'e5xd6 e.p. should be available');
    var m = c.move({ from: sqn('e5'), to: sqn('d6') });
    assert(m.flags & FLAG_EP, 'should be flagged en passant');
    eq(c.board[sqn('d5')], CE.EMPTY, 'captured pawn removed from d5');
    eq(c.board[sqn('d6')], CE.makePiece(CE.PAWN, WHITE), 'white pawn now on d6');
  });

  // --- Promotion ---
  test('Promotion', 'Pawn promotes to all four pieces (4 moves)', function () {
    var c = new CE.Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    var promos = c.generateLegalMoves().filter(function (m) { return m.from === sqn('a7') && (m.flags & FLAG_PROMO); });
    eq(promos.length, 4);
  });
  test('Promotion', 'Queen promotion places a queen', function () {
    var c = new CE.Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    mv(c, 'a7', 'a8', 'q');
    eq(c.board[sqn('a8')], CE.makePiece(CE.QUEEN, WHITE));
  });
  test('Promotion', 'Underpromotion to knight works', function () {
    var c = new CE.Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    var m = c.move({ from: sqn('a7'), to: sqn('a8'), promotion: 'n' });
    assert(m, 'underpromotion move should be legal');
    eq(c.board[sqn('a8')], CE.makePiece(CE.KNIGHT, WHITE));
    eq(m.san, 'a8=N');
  });

  // --- Threefold repetition ---
  test('Draws', 'Threefold repetition is detected', function () {
    var c = new CE.Chess();
    for (var i = 0; i < 2; i++) {
      mv(c, 'g1', 'f3'); mv(c, 'g8', 'f6'); mv(c, 'f3', 'g1'); mv(c, 'f6', 'g8');
    }
    assert(c.isThreefoldRepetition(), 'start position should have occurred three times');
    eq(c.result().reason, 'threefold repetition');
  });

  // --- Fifty-move rule ---
  test('Draws', 'Fifty-move rule triggers at 100 halfmoves', function () {
    var c = new CE.Chess('4k3/8/8/8/8/8/8/R3K3 w - - 99 1');
    assert(!c.isFiftyMoveDraw(), 'not yet drawn at 99');
    mv(c, 'a1', 'a2'); // quiet move -> halfmove 100
    assert(c.isFiftyMoveDraw(), 'fifty-move draw at 100 halfmoves');
  });

  // --- Insufficient material ---
  test('Draws', 'Insufficient material detection', function () {
    eq(new CE.Chess('8/8/8/4k3/8/8/4K3/8 w - - 0 1').isInsufficientMaterial(), true, 'K vs K');
    eq(new CE.Chess('8/8/8/4k3/8/8/4KN2/8 w - - 0 1').isInsufficientMaterial(), true, 'K+N vs K');
    eq(new CE.Chess('8/8/8/4k3/8/8/4KB2/8 w - - 0 1').isInsufficientMaterial(), true, 'K+B vs K');
    eq(new CE.Chess('8/8/8/4k3/8/8/4KR2/8 w - - 0 1').isInsufficientMaterial(), false, 'K+R vs K is NOT a draw');
    eq(new CE.Chess('5bk1/8/8/8/8/8/8/2B1K3 w - - 0 1').isInsufficientMaterial(), true, 'same-colour bishops');
    eq(new CE.Chess('4bk2/8/8/8/8/8/8/2B1K3 w - - 0 1').isInsufficientMaterial(), false, 'opposite-colour bishops');
    eq(new CE.Chess('8/8/8/4k3/8/8/3NKN2/8 w - - 0 1').isInsufficientMaterial(), false, 'K+N+N vs K');
  });

  // --- Clock timeout behaviour (rule logic) ---
  function timeoutResult(c, flagged) {
    var opp = CE.opponent(flagged);
    return c.hasInsufficientMatingMaterial(opp) ? 'draw' : (opp === WHITE ? '1-0' : '0-1');
  }
  test('Clock', 'Timeout loses when opponent can mate', function () {
    // Black flags; white has a rook -> white wins on time.
    var c = new CE.Chess('8/8/8/4k3/8/8/4KR2/8 b - - 0 1');
    eq(timeoutResult(c, BLACK), '1-0');
  });
  test('Clock', 'Timeout is a draw vs insufficient mating material', function () {
    // Black flags; white has only a king -> draw.
    eq(timeoutResult(new CE.Chess('8/8/8/4k3/8/8/4K3/8 b - - 0 1'), BLACK), 'draw');
    // Black flags; white has a lone knight -> still a draw (cannot mate).
    eq(timeoutResult(new CE.Chess('8/8/8/4k3/8/8/4KN2/8 b - - 0 1'), BLACK), 'draw');
  });

  // --- FEN generation / parsing ---
  test('FEN', 'Round-trips several positions', function () {
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 b - - 1 2',
      '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'
    ].forEach(function (f) { eq(new CE.Chess(f).fen(), f); });
  });

  // --- SAN / PGN ---
  test('SAN', 'Disambiguation by file (Rad1)', function () {
    // Black king on g8 (off the rooks' lines) so no spurious check marker.
    var c = new CE.Chess('6k1/8/8/4K3/8/8/8/R6R w - - 0 1');
    var m = c.move({ from: sqn('a1'), to: sqn('d1') });
    eq(m.san, 'Rad1');
  });
  test('PGN', 'PGN contains move numbers, SAN and result', function () {
    var c = new CE.Chess();
    mv(c, 'e2', 'e4'); mv(c, 'e7', 'e5'); mv(c, 'g1', 'f3');
    var pgn = c.pgn({ White: 'Human', Black: 'Bot', Result: '*' });
    assert(pgn.indexOf('1. e4 e5') !== -1, 'PGN body should read "1. e4 e5"');
    assert(pgn.indexOf('2. Nf3') !== -1, 'PGN should contain 2. Nf3');
    assert(pgn.indexOf('[White "Human"]') !== -1, 'PGN should include headers');
  });

  // --- Make/unmake & Zobrist consistency ---
  test('Engine', 'make/unmake restores position exactly (random play)', function () {
    var c = new CE.Chess();
    for (var i = 0; i < 40; i++) {
      var legal = c.generateLegalMoves();
      if (!legal.length) break;
      var before = c.fen();
      var beforeLo = c.hashLo, beforeHi = c.hashHi;
      var m = legal[(Math.random() * legal.length) | 0];
      var u = c.makeMove(m);
      c.unmakeMove(m, u);
      eq(c.fen(), before, 'FEN restored');
      assert(c.hashLo === beforeLo && c.hashHi === beforeHi, 'hash restored');
      // advance with a real (high-level) move to continue
      c.move({ from: m.from, to: m.to, promotion: 'q' });
    }
  });

  // --- Undo ---
  test('Undo', 'Undo restores the previous position and repetition state', function () {
    var c = new CE.Chess();
    mv(c, 'e2', 'e4'); mv(c, 'e7', 'e5');
    var fenBefore = c.fen();
    var keyCountBefore = c.isThreefoldRepetition();
    mv(c, 'g1', 'f3');
    c.undo();
    eq(c.fen(), fenBefore, 'position should match pre-move FEN');
    eq(c.isThreefoldRepetition(), keyCountBefore, 'repetition state consistent');
    eq(c.history.length, 2, 'history length decremented');
  });

  // --- AI legality & tactics ---
  test('AI', 'AI always returns a legal move', function () {
    var fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1'
    ];
    var diffs = ['easy', 'medium', 'hard', 'impossible'];
    fens.forEach(function (f) {
      diffs.forEach(function (d) {
        var c = new CE.Chess(f);
        var legal = c.generateLegalMoves();
        var m = AI.chooseMove(f, { difficulty: d, timeMs: 120, maxDepth: d === 'impossible' ? 4 : undefined });
        assert(m, 'AI returned a move for ' + d);
        assert(legal.some(function (x) { return x.from === m.from && x.to === m.to; }),
          'AI move must be legal (' + d + ', ' + f + ')');
      });
    });
  });
  test('AI', 'Finds mate in one', function () {
    var c = new CE.Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    var m = AI.chooseMove(c.fen(), { difficulty: 'impossible', maxDepth: 3, timeMs: 1000 });
    var applied = c.move({ from: m.from, to: m.to, promotion: m.promotion });
    assert(applied, 'mate move applied');
    assert(c.isCheckmate(), 'AI should have delivered checkmate; played ' + applied.san);
  });
  test('AI', 'Captures a free hanging queen', function () {
    var c = new CE.Chess('4k3/8/8/4q3/8/5N2/8/4K3 w - - 0 1');
    var m = AI.chooseMove(c.fen(), { difficulty: 'hard', maxDepth: 3, timeMs: 400 });
    eq(m.to, sqn('e5'), 'should capture the queen on e5');
  });

  // --- Random color assignment sanity ---
  function assignColor(choice) {
    if (choice === 'white') return WHITE;
    if (choice === 'black') return BLACK;
    return Math.random() < 0.5 ? WHITE : BLACK;
  }
  test('Setup', 'Color assignment: fixed choices are deterministic', function () {
    for (var i = 0; i < 20; i++) { eq(assignColor('white'), WHITE); eq(assignColor('black'), BLACK); }
  });
  test('Setup', 'Color assignment: random yields both colors', function () {
    var seen = { 0: 0, 1: 0 };
    for (var i = 0; i < 400; i++) seen[assignColor('random')]++;
    assert(seen[WHITE] > 0 && seen[BLACK] > 0, 'both colors should appear');
    assert(seen[WHITE] > 100 && seen[BLACK] > 100, 'distribution should be roughly balanced');
  });

  // ======================= RUNNER =======================
  function run() {
    var results = [];
    var pass = 0, fail = 0;
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      var rec = { group: t.group, name: t.name, ok: true, error: null };
      try { t.fn(); pass++; }
      catch (e) { rec.ok = false; rec.error = (e && e.message) || String(e); fail++; }
      results.push(rec);
      (groups[t.group] = groups[t.group] || []).push(rec);
    }
    return { results: results, pass: pass, fail: fail, total: tests.length };
  }

  function reportConsole(r) {
    var lines = [];
    Object.keys(groups).forEach(function (g) {
      lines.push('\n=== ' + g + ' ===');
      groups[g].forEach(function (rec) {
        lines.push('  ' + (rec.ok ? 'PASS' : 'FAIL') + '  ' + rec.name + (rec.ok ? '' : '\n        -> ' + rec.error));
      });
    });
    lines.push('\n' + r.pass + '/' + r.total + ' passed, ' + r.fail + ' failed.');
    console.log(lines.join('\n'));
  }

  function reportDom(r) {
    var summary = document.getElementById('summary');
    var container = document.getElementById('results');
    if (!summary || !container) return;
    summary.className = 'summary ' + (r.fail === 0 ? 'all-pass' : 'has-fail');
    summary.textContent = r.pass + ' / ' + r.total + ' tests passed' + (r.fail ? ' — ' + r.fail + ' FAILED' : ' — all green!');
    container.innerHTML = '';
    Object.keys(groups).forEach(function (g) {
      var section = document.createElement('section');
      section.className = 'group';
      var h = document.createElement('h2');
      var gfail = groups[g].filter(function (x) { return !x.ok; }).length;
      h.textContent = g + ' (' + (groups[g].length - gfail) + '/' + groups[g].length + ')';
      section.appendChild(h);
      groups[g].forEach(function (rec) {
        var row = document.createElement('div');
        row.className = 'case ' + (rec.ok ? 'pass' : 'fail');
        row.innerHTML = '<span class="badge">' + (rec.ok ? 'PASS' : 'FAIL') + '</span> ' +
          '<span class="case-name"></span>';
        row.querySelector('.case-name').textContent = rec.name;
        if (!rec.ok) {
          var err = document.createElement('pre');
          err.className = 'err';
          err.textContent = rec.error;
          row.appendChild(err);
        }
        section.appendChild(row);
      });
      container.appendChild(section);
    });
  }

  if (typeof document !== 'undefined' && document.getElementById('results')) {
    // Defer so the "Running tests…" message paints before the (blocking) run.
    var go = function () { reportDom(run()); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 50); });
    else setTimeout(go, 50);
  } else {
    var r = run();
    reportConsole(r);
    if (typeof process !== 'undefined' && process.exit) process.exit(r.fail === 0 ? 0 : 1);
  }
})();
