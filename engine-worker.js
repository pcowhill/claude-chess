/*
 * engine-worker.js — Runs the AI search off the main thread so the UI never
 * freezes while the bot is thinking.
 *
 * Loads the shared engine + AI via importScripts (relative to this file). The
 * page (app.js) creates this worker and falls back to a main-thread search if
 * the worker cannot be created (e.g. some browsers block workers on file://).
 *
 * Protocol:
 *   page -> worker:  { type: 'search', id, fen, options }
 *   worker -> page:  { type: 'result', id, move }
 *                    { type: 'error',  id, error }
 *                    { type: 'ready' }
 */

try {
  importScripts('chess.js', 'ai.js');
} catch (e) {
  // If imports fail the page will detect the error event and use the fallback.
  // Re-throwing surfaces the failure to worker.onerror.
  throw e;
}

self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === 'search') {
    try {
      var move = self.ChessAI.chooseMove(data.fen, data.options || {});
      self.postMessage({ type: 'result', id: data.id, move: move });
    } catch (err) {
      self.postMessage({ type: 'error', id: data.id, error: String(err && err.message || err) });
    }
  } else if (data.type === 'ping') {
    self.postMessage({ type: 'ready' });
  }
};

// Announce readiness so the page knows the worker + imports loaded successfully.
self.postMessage({ type: 'ready' });
