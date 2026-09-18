/*!
 * Notes2A4 — raster worker client (main thread side)
 *
 * Keeps the tab smooth: the heavy pixel work of the print-saver / invert pipeline
 * (map over ~32 Mpx of supersampled pixels + PNG/JPEG encode) runs in
 * worker-raster.js. This file is only the plumbing — promise wrappers, a job
 * registry, timeouts and a sticky-failure switch.
 *
 * Every entry point REJECTS if the worker cannot do the job, and the apps then run
 * the very same work on the main thread (the banded/strip pipeline), so a browser
 * without workers — or a worker that fails to start — still converts normally,
 * just with the old, slower feel.
 *
 *   NotesRaster.supported()  → false once the worker has failed (so we stop trying)
 *   NotesRaster.mapPage({...})  → { bytes, preview, blank, inverted }
 *   NotesRaster.encode({...})   → { bytes, preview }   (encode an RGBA buffer)
 */
(function (root) {
  var WORKER_URL = 'worker-raster.js';
  /* the same cache-bust version the page used for its scripts, so a deploy
     cannot leave an old worker next to new app code */
  var VER = (function () {
    try {
      var sc = root.document && root.document.currentScript;
      var m = sc && sc.src && sc.src.match(/[?&]v=([\w.]+)/);
      return m ? m[1] : '0';
    } catch (e) { return '0'; }
  })();
  var w = null, seq = 0, dead = false, readyP = null, booted = false;
  var pending = {};

  function supported() { return !dead && typeof root.Worker === 'function'; }

  function dropPending(err) {
    for (var id in pending) { if (pending.hasOwnProperty(id)) settle(id, null, err); }
  }
  function settle(id, value, err) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (p.timer) clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }
  var bootReject = null;
  function fail(err) {
    dead = true; readyP = null; booted = false;
    try { if (w) w.terminate(); } catch (e) {}
    w = null;
    var e2 = err || new Error('raster worker unavailable');
    if (bootReject) { var r = bootReject; bootReject = null; r(e2); }   // a pending boot() must not hang
    dropPending(e2);
  }

  function boot() {
    if (dead) return Promise.reject(new Error('raster worker unavailable'));
    if (readyP) return readyP;
    readyP = new Promise(function (resolve, reject) {
      var ready = false, timer = setTimeout(function () { fail(new Error('raster worker did not start')); }, 8000);
      bootReject = reject;
      try {
        w = new root.Worker(WORKER_URL + '?v=' + VER);
      } catch (e) { clearTimeout(timer); return fail(e); }
      w.onmessage = function (e) {
        var m = e.data || {};
        if (m.cmd === 'ready') {
          if (!ready) { ready = true; booted = true; bootReject = null; clearTimeout(timer); resolve(w); }
          return;
        }
        if (m.cmd === 'progress') { dispatchProgress(m.id, m.done, m.total); return; }
        if (m.cmd === 'done') { settle(m.id, m); return; }
        if (m.cmd === 'error') { settle(m.id, null, new Error(m.message || 'raster worker error')); return; }
      };
      w.onerror = function (err) {
        var msg = (err && (err.message || err.filename)) || 'worker failed to load';
        if (!ready) { clearTimeout(timer); fail(new Error(msg)); }
        else { dead = true; dropPending(new Error(msg)); }        // a broken worker must not break conversions
      };
      try { w.postMessage({ cmd: 'ping' }); } catch (e) { clearTimeout(timer); fail(e); }
    });
    return readyP;
  }

  function wait(id, ms, onProgress) {
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      pending[id].timer = setTimeout(function () {
        settle(id, null, new Error('raster worker timeout'));
      }, ms);
    });
  }

  /* progress messages are delivered with the job's promise */
  function dispatchProgress(id, done, total) {
    var p = pending[id];
    if (p && p.onProgress) p.onProgress(done, total);
  }

  /**
   * Map one page: the caller hands over strips of the supersampled page (each
   * buffer is transferred, never copied) and gets back the encoded page.
   */
  async function mapPage(cfg) {
    await boot();
    var id = ++seq;
    var p = wait(id, 300000, cfg.onProgress);
    w.postMessage({
      cmd: 'begin', id: id, kind: cfg.kind === 'neg' ? 'neg' : 'hq',
      bw: cfg.bw, bh: cfg.bh, W: cfg.W, H: cfg.H,
      auto: !!cfg.auto, keepColour: !!cfg.keepColour, pure: !!cfg.pure, trackBlank: !!cfg.trackBlank
    });
    var band = cfg.band || 192;
    for (var y = 0; y < cfg.bh; y += band) {
      var rows = Math.min(band, cfg.bh - y);
      var px = cfg.provider(y, rows);
      if (px && typeof px.then === 'function') px = await px;
      var buf = px.data.buffer;
      w.postMessage({ cmd: 'strip', id: id, y0: y, rows: rows, data: buf }, [buf]);
      if (cfg.onStrip) await cfg.onStrip((y + rows) / cfg.bh);
    }
    w.postMessage({ cmd: 'finish', id: id, encode: cfg.encode || {} });
    return await p;
  }

  /** Encode an RGBA buffer that was produced on the main thread (the flip path). */
  async function encode(cfg) {
    await boot();
    var id = ++seq;
    var p = wait(id, 300000);
    w.postMessage({ cmd: 'encode', id: id, data: cfg.rgba.buffer, W: cfg.W, H: cfg.H, encode: cfg.encode || {} }, [cfg.rgba.buffer]);
    return await p;
  }

  root.NotesRaster = {
    supported: supported,
    mapPage: mapPage,
    encode: encode,
    url: WORKER_URL,
    _progress: dispatchProgress,
    _reset: function () { dead = false; readyP = null; }        // tests
  };
})(typeof self !== 'undefined' ? self : this);
