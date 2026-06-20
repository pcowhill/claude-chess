/*
 * app.js — UI controller for Claude Chess.
 *
 * Responsibilities: setup screen, board rendering, click + drag + keyboard
 * input, promotion UI, clocks, move history / captured / FEN / PGN panels,
 * driving the AI (via Web Worker with a main-thread fallback), and autosave.
 *
 * Depends on chess.js (ChessEngine) and ai.js (ChessAI), loaded before this.
 */
(function () {
  'use strict';

  var CE = window.ChessEngine;
  var AI = window.ChessAI;
  var WHITE = CE.WHITE, BLACK = CE.BLACK;
  var KING = CE.KING;
  var FLAG_CAPTURE = CE.FLAG_CAPTURE, FLAG_PROMO = CE.FLAG_PROMO;
  var rankOf = CE.rankOf, fileOf = CE.fileOf, makeSq = CE.makeSq;
  var pieceType = CE.pieceType, colorOf = CE.colorOf, opponent = CE.opponent;
  var squareName = CE.squareName;

  var GAME_KEY = 'claudeChess.game.v1';
  var PREFS_KEY = 'claudeChess.prefs.v1';

  var GLYPH = { 1: ['♙', '♟'], 2: ['♘', '♞'], 3: ['♗', '♝'],
    4: ['♖', '♜'], 5: ['♕', '♛'], 6: ['♔', '♚'] };
  var TYPE_NAME = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };
  var PROMO_LETTER = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };

  function glyph(piece) { return GLYPH[pieceType(piece)][colorOf(piece)]; }
  function colorKey(c) { return c === WHITE ? 'white' : 'black'; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- Application state ----------------------------------------------------
  var S = {
    chess: null,
    settings: { difficulty: 'medium', colorChoice: 'random', untimed: true },
    humanColor: WHITE,
    startFen: CE.START_FEN,
    startTurn: WHITE,
    startFullmove: 1,
    flipped: false,
    selected: null,
    legalForSelected: [],
    lastMove: null,
    gameOver: false,
    resultObj: null,
    thinking: false,
    botRequestId: 0,
    worker: null,
    workerOK: false,
    workerFailed: false,
    pendingBot: null,
    clock: { white: 0, black: 0, increment: 0, untimed: true, active: WHITE, running: false, lastTick: 0 },
    clockTimer: null,
    focusSquare: makeSq(1, 4),
    drag: null,
    prefs: { theme: 'dark', board: 'classic' }
  };

  var cellMap = {}; // square index -> cell element
  var el = {};      // cached DOM references

  // ---- Initialisation -------------------------------------------------------
  function init() {
    cacheDom();
    loadPrefs();
    applyPrefs();
    wireEvents();
    initWorker();

    var saved = readGame();
    if (saved && !saved.gameOver && saved.moves && saved.moves.length >= 0 && saved.started) {
      el.resumePanel.hidden = false;
      S._savedGame = saved;
    } else {
      el.resumePanel.hidden = true;
    }
    showSetup();
  }

  function cacheDom() {
    var ids = ['setup-screen', 'game-screen', 'setup-form', 'resume-panel', 'resume-btn', 'discard-btn',
      'custom-time', 'custom-minutes', 'custom-increment', 'board', 'board-wrap', 'promotion',
      'status-turn', 'status-detail', 'toast', 'sr-live',
      'clock-top', 'clock-top-label', 'clock-top-time', 'clock-bottom', 'clock-bottom-label', 'clock-bottom-time',
      'captured-top', 'captured-bottom', 'move-history', 'fen-input',
      'new-game-btn', 'undo-btn', 'resign-btn', 'flip-btn',
      'copy-fen-btn', 'load-fen-btn', 'copy-pgn-btn', 'board-select', 'theme-toggle'];
    ids.forEach(function (id) { el[camel(id)] = document.getElementById(id); });
  }
  function camel(id) { return id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  function wireEvents() {
    // Setup form
    el.setupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      startNewGame(readSetup());
    });
    el.setupForm.querySelectorAll('input[name=time]').forEach(function (r) {
      r.addEventListener('change', function () {
        el.customTime.hidden = el.setupForm.querySelector('input[name=time]:checked').value !== 'custom';
      });
    });
    el.resumeBtn.addEventListener('click', function () { if (S._savedGame) loadGame(S._savedGame); });
    el.discardBtn.addEventListener('click', function () {
      try { localStorage.removeItem(GAME_KEY); } catch (e) {}
      S._savedGame = null; el.resumePanel.hidden = true;
    });

    // Controls
    el.newGameBtn.addEventListener('click', function () { showSetupPrefill(); });
    el.undoBtn.addEventListener('click', undoMove);
    el.resignBtn.addEventListener('click', resign);
    el.flipBtn.addEventListener('click', function () { S.flipped = !S.flipped; buildBoard(); renderAll(); renderClocks(); renderCaptured(); });
    el.themeToggle.addEventListener('click', function () {
      S.prefs.theme = S.prefs.theme === 'dark' ? 'light' : 'dark'; applyPrefs(); savePrefs();
    });
    el.boardSelect.addEventListener('change', function () {
      S.prefs.board = el.boardSelect.value; applyPrefs(); savePrefs();
    });

    el.copyFenBtn.addEventListener('click', function () { copyText(S.chess.fen(), 'FEN copied'); });
    el.copyPgnBtn.addEventListener('click', function () { copyText(buildPgn(), 'PGN copied'); });
    el.loadFenBtn.addEventListener('click', loadFenFromInput);

    // Board input
    el.board.addEventListener('pointerdown', onPointerDown);
    el.board.addEventListener('pointermove', onPointerMove);
    el.board.addEventListener('pointerup', onPointerUp);
    el.board.addEventListener('pointercancel', onPointerCancel);
    el.board.addEventListener('keydown', onBoardKeydown);

    window.addEventListener('beforeunload', save);
  }

  function initWorker() {
    try {
      S.worker = new Worker('engine-worker.js');
      S.worker.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'ready') {
          S.workerOK = true;
          if (S.pendingBot) { var p = S.pendingBot; S.pendingBot = null; sendToWorker(p.reqId, p.fen, p.opts); }
        } else if (d.type === 'result') {
          if (d.id === S.botRequestId) applyBotMove(d.move);
        } else if (d.type === 'error') {
          console.warn('Engine worker error, using main-thread fallback:', d.error);
          if (d.id === S.botRequestId) fallbackSearch(d.id, S.chess.fen(), botOptions());
        }
      };
      S.worker.onerror = function (err) {
        console.warn('Worker failed to load; using main-thread AI fallback.', err && err.message);
        S.workerFailed = true; S.workerOK = false;
        if (S.pendingBot) { var p = S.pendingBot; S.pendingBot = null; fallbackSearch(p.reqId, p.fen, p.opts); }
      };
      // Safety timeout: if the worker never reports ready, fall back.
      setTimeout(function () {
        if (!S.workerOK && !S.workerFailed) {
          S.workerFailed = true;
          if (S.pendingBot) { var p = S.pendingBot; S.pendingBot = null; fallbackSearch(p.reqId, p.fen, p.opts); }
        }
      }, 2500);
    } catch (e) {
      console.warn('Could not create Web Worker; using main-thread AI fallback.', e && e.message);
      S.worker = null; S.workerFailed = true;
    }
  }

  // ---- Screens --------------------------------------------------------------
  function showSetup() { el.setupScreen.hidden = false; el.gameScreen.hidden = true; }
  function showSetupPrefill() {
    // Reflect current settings into the form before showing it.
    setRadio('difficulty', S.settings.difficulty);
    setRadio('color', S.settings.colorChoice);
    setRadio('time', S.settings.timeLabel || (S.settings.untimed ? 'untimed' : 'custom'));
    el.customTime.hidden = (S.settings.timeLabel || '') !== 'custom';
    showSetup();
  }
  function setRadio(name, value) {
    var r = el.setupForm.querySelector('input[name=' + name + '][value="' + value + '"]');
    if (r) r.checked = true;
  }
  function showGame() { el.setupScreen.hidden = true; el.gameScreen.hidden = false; }

  function readSetup() {
    var difficulty = el.setupForm.querySelector('input[name=difficulty]:checked').value;
    var time = el.setupForm.querySelector('input[name=time]:checked').value;
    var color = el.setupForm.querySelector('input[name=color]:checked').value;
    var settings = { difficulty: difficulty, colorChoice: color, timeLabel: time };
    if (time === 'untimed') {
      settings.untimed = true; settings.minutes = 0; settings.increment = 0;
    } else if (time === 'custom') {
      settings.untimed = false;
      settings.minutes = clamp(parseInt(el.customMinutes.value, 10) || 10, 1, 180);
      settings.increment = clamp(parseInt(el.customIncrement.value, 10) || 0, 0, 60);
    } else {
      settings.untimed = false;
      var parts = time.split('+');
      settings.minutes = parseInt(parts[0], 10);
      settings.increment = parseInt(parts[1], 10);
    }
    return settings;
  }

  // ---- New game / load ------------------------------------------------------
  function startNewGame(settings, fen) {
    S.settings = settings;
    if (settings.colorChoice === 'white') S.humanColor = WHITE;
    else if (settings.colorChoice === 'black') S.humanColor = BLACK;
    else S.humanColor = Math.random() < 0.5 ? WHITE : BLACK;

    S.startFen = fen || CE.START_FEN;
    S.chess = new CE.Chess(S.startFen);
    S.startTurn = S.chess.turn;
    S.startFullmove = S.chess.fullmove;
    if (fen) S.humanColor = S.chess.turn; // when loading a FEN, human plays side to move

    S.flipped = (S.humanColor === BLACK);
    S.selected = null; S.legalForSelected = []; S.lastMove = null;
    S.gameOver = false; S.resultObj = null; S.thinking = false;
    S.botRequestId++;
    S.focusSquare = S.humanColor === WHITE ? makeSq(1, 4) : makeSq(6, 4);

    // Clock setup
    var ms = (settings.minutes || 0) * 60000;
    S.clock = {
      white: ms, black: ms, increment: (settings.increment || 0) * 1000,
      untimed: !!settings.untimed, active: S.chess.turn, running: false, lastTick: 0
    };

    showGame();
    buildBoard();
    renderAll();
    renderHistory();
    renderCaptured();
    renderClocks();
    updateFenInput();
    updateStatus();
    el.boardSelect.value = S.prefs.board;
    startClocks();
    save();

    if (S.chess.turn !== S.humanColor) requestBotMove();
  }

  function loadGame(data) {
    try {
      S.settings = data.settings || S.settings;
      S.humanColor = data.humanColor;
      S.startFen = data.startFen || CE.START_FEN;
      S.chess = new CE.Chess(S.startFen);
      S.startTurn = S.chess.turn;
      S.startFullmove = S.chess.fullmove;
      (data.moves || []).forEach(function (m) { S.chess.move({ from: m.from, to: m.to, promotion: m.promotion || 'q' }); });
      S.flipped = !!data.flipped;
      S.selected = null; S.legalForSelected = [];
      var h = S.chess.history;
      S.lastMove = h.length ? { from: h[h.length - 1].move.from, to: h[h.length - 1].move.to } : null;
      S.gameOver = !!data.gameOver; S.resultObj = data.resultObj || null;
      S.thinking = false; S.botRequestId++;
      S.focusSquare = S.humanColor === WHITE ? makeSq(1, 4) : makeSq(6, 4);

      var c = data.clock || { untimed: true };
      S.clock = {
        white: c.white || 0, black: c.black || 0, increment: c.increment || 0,
        untimed: !!c.untimed, active: S.chess.turn, running: false, lastTick: 0
      };

      showGame();
      buildBoard();
      renderAll(); renderHistory(); renderCaptured(); renderClocks(); updateFenInput(); updateStatus();
      el.boardSelect.value = S.prefs.board;

      if (!S.gameOver) {
        startClocks();
        if (S.chess.turn !== S.humanColor) requestBotMove();
      }
    } catch (e) {
      console.error('Failed to resume saved game:', e);
      showSetup();
    }
  }

  // ---- Board construction & rendering --------------------------------------
  function visualToSquare(vr, vc) {
    return S.flipped ? makeSq(vr, 7 - vc) : makeSq(7 - vr, vc);
  }
  function squareToVisual(sq) {
    var r = rankOf(sq), f = fileOf(sq);
    return S.flipped ? { vr: r, vc: 7 - f } : { vr: 7 - r, vc: f };
  }

  function buildBoard() {
    el.board.innerHTML = '';
    cellMap = {};
    for (var vr = 0; vr < 8; vr++) {
      var row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      for (var vc = 0; vc < 8; vc++) {
        var sq = visualToSquare(vr, vc);
        var cell = document.createElement('div');
        var light = ((rankOf(sq) + fileOf(sq)) % 2) === 1;
        cell.className = 'cell ' + (light ? 'light' : 'dark');
        cell.dataset.square = sq;
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = (sq === S.focusSquare) ? 0 : -1;

        var dot = document.createElement('span');
        dot.className = 'dot';
        cell.appendChild(dot);

        if (vc === 0) {
          var rl = document.createElement('span');
          rl.className = 'coord rank'; rl.textContent = (rankOf(sq) + 1);
          cell.appendChild(rl);
        }
        if (vr === 7) {
          var fl = document.createElement('span');
          fl.className = 'coord file'; fl.textContent = String.fromCharCode(97 + fileOf(sq));
          cell.appendChild(fl);
        }
        row.appendChild(cell);
        cellMap[sq] = cell;
      }
      el.board.appendChild(row);
    }
  }

  function findMoveTo(sq) {
    for (var i = 0; i < S.legalForSelected.length; i++) {
      if (S.legalForSelected[i].to === sq) return S.legalForSelected[i];
    }
    return null;
  }

  function renderAll() { for (var sq = 0; sq < 64; sq++) updateCell(sq); }

  function updateCell(sq) {
    var cell = cellMap[sq];
    if (!cell) return;
    cell.classList.remove('selected', 'last-move', 'legal-move', 'legal-capture', 'in-check', 'focused');

    var piece = S.chess.board[sq];
    var span = cell.querySelector('.piece');
    if (piece) {
      if (!span) { span = document.createElement('span'); span.className = 'piece'; cell.appendChild(span); }
      span.textContent = glyph(piece);
      span.className = 'piece ' + (colorOf(piece) === WHITE ? 'white' : 'black');
      span.style.opacity = '';
    } else if (span) {
      span.remove();
    }

    if (S.selected === sq) cell.classList.add('selected');
    var legalMv = (S.selected !== null) ? findMoveTo(sq) : null;
    if (legalMv) cell.classList.add((legalMv.flags & FLAG_CAPTURE) ? 'legal-capture' : 'legal-move');
    if (S.lastMove && (sq === S.lastMove.from || sq === S.lastMove.to)) cell.classList.add('last-move');
    if (!S.gameOver && piece && pieceType(piece) === KING &&
      colorOf(piece) === S.chess.turn && S.chess.isCheck()) cell.classList.add('in-check');

    cell.tabIndex = (sq === S.focusSquare) ? 0 : -1;
    if (sq === S.focusSquare) cell.classList.add('focused');
    cell.setAttribute('aria-label', squareLabel(sq, piece, legalMv));
  }

  function squareLabel(sq, piece, legalMv) {
    var base = squareName(sq) + ', ' + (piece ? (colorKey(colorOf(piece)) + ' ' + TYPE_NAME[pieceType(piece)]) : 'empty');
    if (legalMv) base += ', legal ' + ((legalMv.flags & FLAG_CAPTURE) ? 'capture' : 'move');
    return base;
  }

  // ---- Selection & input ----------------------------------------------------
  function interactable() {
    return S.chess && !S.gameOver && !S.thinking && S.chess.turn === S.humanColor;
  }

  function selectSquare(sq) {
    S.selected = sq;
    S.legalForSelected = S.chess.generateLegalMoves().filter(function (m) { return m.from === sq; });
    renderAll();
  }
  function clearSelection() { S.selected = null; S.legalForSelected = []; renderAll(); }

  function isLegalTarget(from, to) {
    if (S.selected !== from) return false;
    return !!findMoveTo(to);
  }

  function handleActivate(sq) {
    if (!interactable()) return;
    var piece = S.chess.board[sq];
    if (S.selected !== null) {
      if (isLegalTarget(S.selected, sq)) { tryMove(S.selected, sq); return; }
      if (sq === S.selected) { clearSelection(); return; }
    }
    if (piece && colorOf(piece) === S.humanColor) selectSquare(sq);
    else clearSelection();
  }

  // Pointer (mouse/touch) handling: supports click-to-move and drag-and-drop.
  function onPointerDown(e) {
    var cell = e.target.closest ? e.target.closest('.cell') : null;
    if (!cell) return;
    var sq = parseInt(cell.dataset.square, 10);
    setFocus(sq);
    if (!interactable()) return;

    if (S.selected !== null && isLegalTarget(S.selected, sq)) { tryMove(S.selected, sq); return; }

    var piece = S.chess.board[sq];
    if (piece && colorOf(piece) === S.humanColor) {
      var wasSelected = (S.selected === sq);
      selectSquare(sq);
      S.drag = { active: false, from: sq, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, wasSelected: wasSelected, ghost: null };
      try { el.board.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    } else {
      clearSelection();
    }
  }

  function onPointerMove(e) {
    if (!S.drag) return;
    var dx = e.clientX - S.drag.startX, dy = e.clientY - S.drag.startY;
    if (!S.drag.active) {
      if (Math.sqrt(dx * dx + dy * dy) < 6) return;
      beginDragVisual();
    }
    positionGhost(e.clientX, e.clientY);
    highlightDragOver(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (!S.drag) return;
    var drag = S.drag; S.drag = null;
    try { el.board.releasePointerCapture(drag.pointerId); } catch (_) {}
    clearDragOver();
    if (drag.active) {
      if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
      var target = cellFromPoint(e.clientX, e.clientY);
      if (target) {
        var to = parseInt(target.dataset.square, 10);
        if (isLegalTarget(drag.from, to)) { renderAll(); tryMove(drag.from, to); return; }
      }
      renderAll(); // snap back, keep selection
    } else if (drag.wasSelected) {
      clearSelection(); // tapped the already-selected piece again
    }
  }

  function onPointerCancel() {
    if (!S.drag) return;
    if (S.drag.ghost && S.drag.ghost.parentNode) S.drag.ghost.parentNode.removeChild(S.drag.ghost);
    S.drag = null;
    clearDragOver();
    renderAll();
  }

  function beginDragVisual() {
    S.drag.active = true;
    var cell = cellMap[S.drag.from];
    var pieceSpan = cell && cell.querySelector('.piece');
    if (!pieceSpan) return;
    var rect = cell.getBoundingClientRect();
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.fontSize = (rect.height * 0.82) + 'px';
    var g = document.createElement('span');
    g.className = pieceSpan.className;
    g.textContent = pieceSpan.textContent;
    ghost.appendChild(g);
    document.body.appendChild(ghost);
    S.drag.ghost = ghost;
    pieceSpan.style.opacity = '0';
  }

  function positionGhost(x, y) {
    if (S.drag && S.drag.ghost) { S.drag.ghost.style.left = x + 'px'; S.drag.ghost.style.top = y + 'px'; }
  }

  function cellFromPoint(x, y) {
    var elx = document.elementFromPoint(x, y);
    return elx && elx.closest ? elx.closest('.cell') : null;
  }
  var lastDragOver = null;
  function highlightDragOver(x, y) {
    var cell = cellFromPoint(x, y);
    if (cell === lastDragOver) return;
    clearDragOver();
    if (cell && cell.classList.contains('cell')) { cell.classList.add('drag-over'); lastDragOver = cell; }
  }
  function clearDragOver() { if (lastDragOver) { lastDragOver.classList.remove('drag-over'); lastDragOver = null; } }

  // ---- Keyboard navigation --------------------------------------------------
  function setFocus(sq) {
    if (sq === S.focusSquare) return;
    var prev = cellMap[S.focusSquare];
    if (prev) { prev.tabIndex = -1; prev.classList.remove('focused'); }
    S.focusSquare = sq;
    var cell = cellMap[sq];
    if (cell) { cell.tabIndex = 0; cell.classList.add('focused'); }
  }

  function onBoardKeydown(e) {
    var v = squareToVisual(S.focusSquare);
    var handled = true;
    switch (e.key) {
      case 'ArrowUp': v.vr = clamp(v.vr - 1, 0, 7); break;
      case 'ArrowDown': v.vr = clamp(v.vr + 1, 0, 7); break;
      case 'ArrowLeft': v.vc = clamp(v.vc - 1, 0, 7); break;
      case 'ArrowRight': v.vc = clamp(v.vc + 1, 0, 7); break;
      case 'Enter': case ' ': case 'Spacebar':
        handleActivate(S.focusSquare); e.preventDefault(); return;
      case 'Escape': clearSelection(); return;
      default: handled = false;
    }
    if (handled) {
      var sq = visualToSquare(v.vr, v.vc);
      setFocus(sq);
      var cell = cellMap[sq];
      if (cell) cell.focus();
      e.preventDefault();
    }
  }

  // ---- Move execution -------------------------------------------------------
  function tryMove(from, to) {
    var cands = S.chess.generateLegalMoves().filter(function (m) { return m.from === from && m.to === to; });
    if (cands.length === 0) { flashIllegal(); return; }
    if (cands.length > 1 && (cands[0].flags & FLAG_PROMO)) {
      showPromotion(from, to, function (letter) { executeHumanMove(from, to, letter); });
    } else {
      var promo = (cands[0].flags & FLAG_PROMO) ? PROMO_LETTER[cands[0].promotion] : null;
      executeHumanMove(from, to, promo);
    }
  }

  function executeHumanMove(from, to, promoLetter) {
    var applied = S.chess.move({ from: from, to: to, promotion: promoLetter || 'q' });
    if (!applied) { flashIllegal(); return; }
    S.selected = null; S.legalForSelected = [];
    onMoveMade(applied);
  }

  function onMoveMade(applied) {
    S.lastMove = { from: applied.from, to: applied.to };
    S.selected = null; S.legalForSelected = [];
    setFocus(applied.to);
    clockOnMove(colorOf(applied.piece));
    renderAll(); renderHistory(); renderCaptured(); updateFenInput(); updateStatus();
    announce(colorOf(applied.piece), applied.san);
    save();
    if (checkGameEnd()) return;
    if (S.chess.turn !== S.humanColor) requestBotMove();
  }

  function checkGameEnd() {
    var r = S.chess.result();
    if (r) { endGame(r); return true; }
    return false;
  }

  function endGame(r) {
    S.gameOver = true; S.resultObj = r; S.thinking = false;
    stopClocks();
    S.selected = null; S.legalForSelected = [];
    renderAll(); updateStatus(); save();
    announceEnd(r);
  }

  // ---- Promotion UI ---------------------------------------------------------
  function showPromotion(from, to, onChoose) {
    var color = S.humanColor;
    el.promotion.innerHTML = '';
    [5, 4, 3, 2].forEach(function (type) { // Q R B N
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = GLYPH[type][color];
      b.setAttribute('aria-label', 'Promote to ' + TYPE_NAME[type]);
      b.className = 'piece ' + (color === WHITE ? 'white' : 'black');
      b.addEventListener('click', function () {
        el.promotion.hidden = true;
        onChoose(PROMO_LETTER[type]);
      });
      el.promotion.appendChild(b);
    });
    el.promotion.hidden = false;
    var first = el.promotion.querySelector('button');
    if (first) first.focus();
    // Escape cancels
    el.promotion.onkeydown = function (ev) {
      if (ev.key === 'Escape') { el.promotion.hidden = true; clearSelection(); }
    };
  }

  // ---- AI driving -----------------------------------------------------------
  function botOptions() {
    return { difficulty: S.settings.difficulty, repetition: plainRepetition() };
  }
  function plainRepetition() {
    var r = {};
    var rep = S.chess.repetition;
    for (var k in rep) r[k] = rep[k];
    return r;
  }

  function requestBotMove() {
    if (S.gameOver || !S.chess || S.chess.turn === S.humanColor) return;
    S.thinking = true; updateStatus();
    var reqId = ++S.botRequestId;
    var fen = S.chess.fen();
    var opts = botOptions();
    dispatchBot(reqId, fen, opts);
  }

  function dispatchBot(reqId, fen, opts) {
    if (S.worker && !S.workerFailed) {
      if (S.workerOK) sendToWorker(reqId, fen, opts);
      else S.pendingBot = { reqId: reqId, fen: fen, opts: opts }; // flush on ready/fail
    } else {
      fallbackSearch(reqId, fen, opts);
    }
  }
  function sendToWorker(reqId, fen, opts) {
    S.worker.postMessage({ type: 'search', id: reqId, fen: fen, options: opts });
  }
  function fallbackSearch(reqId, fen, opts) {
    // Yield so the "thinking" status paints before the (blocking) search runs.
    setTimeout(function () {
      if (reqId !== S.botRequestId) return;
      var move;
      try { move = AI.chooseMove(fen, opts); }
      catch (e) { console.error('AI error', e); move = null; }
      if (reqId === S.botRequestId) applyBotMove(move);
    }, 30);
  }

  function applyBotMove(move) {
    S.thinking = false;
    if (S.gameOver) return;
    if (!move) { updateStatus(); checkGameEnd(); return; }
    var applied = S.chess.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    if (!applied) {
      // Safety net — should never happen, but never let the bot stall the game.
      console.error('Bot returned an illegal move; choosing a legal one instead.', move);
      var legal = S.chess.generateLegalMoves();
      if (!legal.length) { checkGameEnd(); return; }
      var r = legal[0];
      applied = S.chess.move({ from: r.from, to: r.to, promotion: 'q' });
    }
    onMoveMade(applied);
  }

  // ---- Clocks ---------------------------------------------------------------
  function startClocks() {
    stopClocks();
    if (S.clock.untimed || S.gameOver) { renderClocks(); return; }
    S.clock.running = true;
    S.clock.lastTick = Date.now();
    S.clockTimer = setInterval(tickClock, 200);
    renderClocks();
  }
  function stopClocks() {
    S.clock.running = false;
    if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; }
  }
  function tickClock() {
    if (!S.clock.running || S.clock.untimed) return;
    var now = Date.now();
    var dt = now - S.clock.lastTick;
    S.clock.lastTick = now;
    var key = colorKey(S.clock.active);
    S.clock[key] -= dt;
    if (S.clock[key] <= 0) {
      S.clock[key] = 0;
      renderClocks();
      handleTimeout(S.clock.active);
      return;
    }
    renderClocks();
  }
  function clockOnMove(moverColor) {
    if (S.clock.untimed) return;
    S.clock[colorKey(moverColor)] += S.clock.increment;
    S.clock.active = S.chess.turn;
    S.clock.lastTick = Date.now();
    renderClocks();
  }
  function handleTimeout(flagged) {
    stopClocks();
    var opp = opponent(flagged);
    if (S.chess.hasInsufficientMatingMaterial(opp)) {
      endGame({ over: true, result: '1/2-1/2', reason: 'timeout vs insufficient material', winner: null });
    } else {
      endGame({ over: true, result: opp === WHITE ? '1-0' : '0-1', reason: 'timeout', winner: opp });
    }
  }

  function renderClocks() {
    var bottom = bottomColor();
    var top = opponent(bottom);
    el.clockBottomLabel.textContent = capital(colorKey(bottom));
    el.clockTopLabel.textContent = capital(colorKey(top));
    el.clockBottomTime.textContent = S.clock.untimed ? '∞' : fmtTime(S.clock[colorKey(bottom)]);
    el.clockTopTime.textContent = S.clock.untimed ? '∞' : fmtTime(S.clock[colorKey(top)]);

    toggleClass(el.clockBottom, 'active', !S.gameOver && S.clock.active === bottom);
    toggleClass(el.clockTop, 'active', !S.gameOver && S.clock.active === top);
    toggleClass(el.clockBottom, 'low', !S.clock.untimed && S.clock[colorKey(bottom)] < 20000);
    toggleClass(el.clockTop, 'low', !S.clock.untimed && S.clock[colorKey(top)] < 20000);
  }
  function fmtTime(ms) {
    if (ms < 0) ms = 0;
    if (ms < 20000) {
      var sec = Math.floor(ms / 1000);
      var tenth = Math.floor((ms % 1000) / 100);
      return sec + '.' + tenth;
    }
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60), s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- Status / panels ------------------------------------------------------
  function bottomColor() { return S.flipped ? opponent(S.humanColor) : S.humanColor; }

  function updateStatus() {
    if (S.gameOver && S.resultObj) {
      var r = S.resultObj;
      var head = r.result === '1-0' ? 'White wins' : r.result === '0-1' ? 'Black wins' : 'Draw';
      el.statusTurn.textContent = head;
      el.statusDetail.textContent = r.reason ? capital(r.reason) : '';
      el.statusDetail.classList.remove('thinking');
      return;
    }
    el.statusTurn.textContent = (S.chess.turn === WHITE ? 'White' : 'Black') + ' to move' +
      (S.chess.turn === S.humanColor ? ' (you)' : ' (bot)');
    if (S.thinking) {
      el.statusDetail.textContent = 'Bot is thinking';
      el.statusDetail.classList.add('thinking');
    } else {
      el.statusDetail.classList.remove('thinking');
      el.statusDetail.textContent = S.chess.isCheck() ? 'Check!' : '';
    }
  }

  function renderHistory() {
    var sans = S.chess.sanHistory();
    var html = '';
    var moveNumber = S.startFullmove;
    var idx = 0;
    if (S.startTurn === BLACK && sans.length > 0) {
      html += historyRow(moveNumber, '…', sans[0], sans.length - 1 === 0);
      idx = 1; moveNumber++;
    }
    for (; idx < sans.length; idx += 2) {
      var isLastW = idx === sans.length - 1;
      var isLastB = (idx + 1) === sans.length - 1;
      html += historyRow(moveNumber, escapeHtml(sans[idx]), sans[idx + 1] ? escapeHtml(sans[idx + 1]) : '', isLastW, isLastB);
      moveNumber++;
    }
    el.moveHistory.innerHTML = html;
    el.moveHistory.scrollTop = el.moveHistory.scrollHeight;
  }
  function historyRow(num, w, b, lastW, lastB) {
    return '<li class="movenum">' + num + '.</li>' +
      '<span class="san' + (lastW ? ' current' : '') + '">' + w + '</span>' +
      '<span class="san' + (lastB ? ' current' : '') + '">' + b + '</span>';
  }

  function renderCaptured() {
    var start = { 1: 8, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1 };
    var onBoard = { 0: {}, 1: {} };
    onBoard[0] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    onBoard[1] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    var matW = 0, matB = 0;
    var val = AI.PIECE_VALUE;
    for (var sq = 0; sq < 64; sq++) {
      var p = S.chess.board[sq];
      if (!p) continue;
      var t = pieceType(p), c = colorOf(p);
      onBoard[c][t]++;
      if (t !== KING) { if (c === WHITE) matW += val[t]; else matB += val[t]; }
    }
    // Captured by white = black's missing pieces, and vice-versa.
    var capByWhite = capturedList(start, onBoard[BLACK], BLACK);
    var capByBlack = capturedList(start, onBoard[WHITE], WHITE);
    var advWhite = Math.round((matW - matB) / 100);

    var bottom = bottomColor();
    var bottomCap = bottom === WHITE ? capByWhite : capByBlack;
    var topCap = bottom === WHITE ? capByBlack : capByWhite;
    var bottomAdv = bottom === WHITE ? advWhite : -advWhite;

    el.capturedBottom.innerHTML = bottomCap + advBadge(bottomAdv);
    el.capturedTop.innerHTML = topCap + advBadge(-bottomAdv);
  }
  function capturedList(start, onBoard, color) {
    var out = '';
    [5, 4, 3, 2, 1].forEach(function (t) {
      var missing = Math.max(0, start[t] - onBoard[t]);
      for (var i = 0; i < missing; i++) {
        out += '<span class="cap-piece ' + (color === WHITE ? 'white' : 'black') + '">' + GLYPH[t][color] + '</span>';
      }
    });
    return out;
  }
  function advBadge(adv) { return adv > 0 ? '<span class="adv">+' + adv + '</span>' : ''; }

  function updateFenInput() {
    if (document.activeElement !== el.fenInput) el.fenInput.value = S.chess.fen();
  }

  // ---- FEN / PGN ------------------------------------------------------------
  function buildPgn() {
    var diff = (AI.DIFFICULTIES[S.settings.difficulty] || {}).label || S.settings.difficulty;
    var headers = {
      Event: 'Claude Chess', Site: 'Local (offline)', Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: '-',
      White: S.humanColor === WHITE ? 'Human' : 'Claude Chess Bot (' + diff + ')',
      Black: S.humanColor === BLACK ? 'Human' : 'Claude Chess Bot (' + diff + ')',
      Result: S.resultObj ? S.resultObj.result : '*'
    };
    return S.chess.pgn(headers);
  }

  function loadFenFromInput() {
    var fen = el.fenInput.value.trim();
    if (!fen) return;
    try {
      var test = new CE.Chess(fen); // validate
      if (test.kings[WHITE] === -1 || test.kings[BLACK] === -1) throw new Error('missing king');
      var settings = Object.assign({}, S.settings);
      startNewGame(settings, test.fen());
      showToast('Position loaded', false);
    } catch (e) {
      showToast('Invalid FEN', true);
      updateFenInput();
    }
  }

  // ---- Controls -------------------------------------------------------------
  function resign() {
    if (!S.chess || S.gameOver) return;
    endGame({ over: true, result: S.humanColor === WHITE ? '0-1' : '1-0', reason: 'resignation', winner: opponent(S.humanColor) });
  }

  function undoMove() {
    if (!S.chess || S.chess.history.length === 0) return;
    S.botRequestId++; // cancel any in-flight bot search
    S.thinking = false;
    S.gameOver = false; S.resultObj = null;

    S.chess.undo();
    while (S.chess.history.length > 0 && S.chess.turn !== S.humanColor) S.chess.undo();

    var h = S.chess.history;
    S.lastMove = h.length ? { from: h[h.length - 1].move.from, to: h[h.length - 1].move.to } : null;
    S.selected = null; S.legalForSelected = [];
    renderAll(); renderHistory(); renderCaptured(); updateFenInput(); updateStatus();
    if (!S.clock.untimed) { S.clock.active = S.chess.turn; S.clock.lastTick = Date.now(); if (!S.clock.running) startClocks(); else renderClocks(); }
    save();

    if (S.chess.turn !== S.humanColor) requestBotMove();
  }

  // ---- Persistence ----------------------------------------------------------
  function save() {
    if (!S.chess) return;
    try {
      var moves = S.chess.history.map(function (h) {
        return { from: h.move.from, to: h.move.to, promotion: (h.move.flags & FLAG_PROMO) ? PROMO_LETTER[h.move.promotion] : null };
      });
      var data = {
        started: true,
        startFen: S.startFen,
        moves: moves,
        settings: S.settings,
        humanColor: S.humanColor,
        flipped: S.flipped,
        clock: { white: S.clock.white, black: S.clock.black, increment: S.clock.increment, untimed: S.clock.untimed },
        gameOver: S.gameOver,
        resultObj: S.resultObj,
        ts: Date.now()
      };
      localStorage.setItem(GAME_KEY, JSON.stringify(data));
    } catch (e) { /* storage may be unavailable; ignore */ }
  }
  function readGame() {
    try { return JSON.parse(localStorage.getItem(GAME_KEY)); } catch (e) { return null; }
  }
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREFS_KEY));
      if (p) { S.prefs.theme = p.theme || S.prefs.theme; S.prefs.board = p.board || S.prefs.board; }
    } catch (e) {}
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); } catch (e) {}
  }
  function applyPrefs() {
    document.documentElement.setAttribute('data-theme', S.prefs.theme);
    document.documentElement.setAttribute('data-board', S.prefs.board);
    if (el.boardSelect) el.boardSelect.value = S.prefs.board;
  }

  // ---- Misc UI helpers ------------------------------------------------------
  function announce(color, san) {
    el.srLive.textContent = capital(colorKey(color)) + ' played ' + san;
  }
  function announceEnd(r) {
    var head = r.result === '1-0' ? 'White wins' : r.result === '0-1' ? 'Black wins' : 'Draw';
    el.srLive.textContent = 'Game over. ' + head + (r.reason ? ' by ' + r.reason : '') + '.';
  }
  var toastTimer = null;
  function showToast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    el.toast.style.color = isError ? '' : 'var(--good)';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 1600);
  }
  function flashIllegal() {
    showToast('Illegal move', true);
    el.toast.style.color = '';
    el.board.classList.remove('shake');
    void el.board.offsetWidth; // reflow to restart animation
    el.board.classList.add('shake');
    setTimeout(function () { el.board.classList.remove('shake'); }, 350);
  }

  function copyText(text, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(okMsg, false);
      } catch (e) { showToast('Copy failed', true); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast(okMsg, false); }, fallback);
    } else { fallback(); }
  }

  function toggleClass(node, cls, on) { if (node) node.classList.toggle(cls, !!on); }
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ---- Go -------------------------------------------------------------------
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
