/*!
 * Notes2A4 — raster worker
 *
 * The print-saver pipeline turns every page into ~32 Mpx of supersampled pixels
 * and then runs a per-pixel map over all of it. Doing that on the main thread is
 * what produced Chrome's "Page Unresponsive" dialog, so the pixels are shipped
 * here and the whole map + encode runs off-thread.
 *
 * The maths is not re-implemented: the pieces come from converter.js
 * (NotesConverter.printSaver.pieces), the very same functions the main thread and
 * the Node tests use, so a worker-built page is byte-identical to a page built
 * on the main thread.
 *
 * Protocol (main → worker)
 *   { cmd:'begin',  id, kind:'hq'|'neg', bw, bh, W, H, auto, keepColour, pure, trackBlank }
 *   { cmd:'strip',  id, y0, rows, data:<ArrayBuffer, transferred> }
 *   { cmd:'finish', id, encode:{ mime, quality, previewMax } }
 *   { cmd:'encode', id, data:<ArrayBuffer, transferred RGBA>, W, H, encode:{…} }
 *   { cmd:'cancel', id } · { cmd:'ping' }
 *
 * worker → main
 *   { cmd:'ready' } · { cmd:'progress', id, done, total }
 *   { cmd:'done', id, bytes, preview:{w,h,data}, blank, inverted, darkFrac }
 *   { cmd:'error', id, message }
 *
 * UMD so the Node tests can require() the core and drive it without a browser.
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else {
    root.NotesRasterCore = core;
    if (typeof importScripts === 'function') core.workerMain(root);      // we are inside a Worker
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /* pure white in the probe's sense — a page that is only paper */
  function stillBlank(data, blank) {
    if (!blank) return false;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] < 252 || data[i + 1] < 252 || data[i + 2] < 252) return false;
    }
    return true;
  }

  /**
   * One page being mapped. Strips arrive in order; nothing is decided per strip —
   * the page-wide luma fraction (auto mode) is only known at the end, exactly like
   * the main-thread version.
   */
  function MapJob(maps, o) {
    this.maps = maps;
    this.o = o;
    this.acc = o.kind === 'neg' ? maps.negAcc(o.W, o.H) : maps.hqAcc(o.W, o.H);
    this.st = o.kind === 'neg' ? { dark: 0, invert: true } : maps.hqSt(this.acc);
    this.blank = true;
    this.fed = 0;
  }
  MapJob.prototype.feed = function (y0, rows, data) {
    var o = this.o, maps = this.maps;
    if (o.trackBlank) this.blank = stillBlank(data, this.blank);
    if (o.kind === 'neg') maps.negFeed(this.acc, data, o.bw, y0, y0 + rows, o.bh);
    else maps.hqFeed(this.acc, data, o.bw, y0, y0 + rows, o.bh);
    this.fed += rows;
  };
  MapJob.prototype.finish = function () {
    var o = this.o, maps = this.maps, acc = this.acc, n = acc.n;
    var out = new Uint8ClampedArray(n * 4);
    if (o.kind === 'neg') {
      maps.negFinishA(acc, 0, o.H, this.st);
      this.st.invert = o.auto ? this.st.dark / n >= 0.5 : true;
      maps.negFinishB(acc, 0, o.H, this.st, out);
    } else {
      maps.hqFinishA(acc, 0, o.H, this.st);
      this.st.invert = o.auto ? this.st.dark / n >= 0.5 : true;
      maps.hqFinishB(acc, 0, o.H, this.st, out, !!o.keepColour, !!o.pure);
    }
    return {
      data: out, width: o.W, height: o.H,
      darkFrac: this.st.dark / n, inverted: this.st.invert, blank: this.blank
    };
  };

  /* ---------------------------------------------------------------- worker --- */
  function workerMain(root) {
    var jobs = {}, maps = null;
    function pieces() {
      if (!maps) {
        if (typeof root.importScripts === 'function' && !root.NotesConverter) {
          /* converter.js is a UMD module whose factory destructures pdf-lib at load
             time. The pixel pieces we need do not use it, but the module has to
             load — so pdf-lib is imported first, and if that is not possible a
             placeholder keeps the load from failing (nothing here calls it). */
          try { root.importScripts('vendor/pdf-lib.min.js'); } catch (e) { /* optional */ }
          if (!root.PDFLib) root.PDFLib = { PDFDocument: null, StandardFonts: null, rgb: null, LineCapStyle: null, BlendMode: null };
          root.importScripts('converter.js');
        }
        maps = root.NotesConverter.printSaver.pieces;
      }
      return maps;
    }
    /* encode an RGBA page + build a small preview for the live view */
    async function encodeRgba(rgba, W, H, enc) {
      enc = enc || {};
      var cv = new OffscreenCanvas(W, H);
      var cx = cv.getContext('2d');
      cx.putImageData(new ImageData(rgba, W, H), 0, 0);
      var blob = await cv.convertToBlob({ type: enc.mime || 'image/png', quality: enc.quality });
      var bytes = (await blob.arrayBuffer());
      var preview = null;
      var max = enc.previewMax || 720;
      if (max > 0) {
        var sc = Math.min(1, max / Math.max(W, H));
        var pw = Math.max(2, Math.round(W * sc)), ph = Math.max(2, Math.round(H * sc));
        var pc = new OffscreenCanvas(pw, ph);
        var px = pc.getContext('2d');
        px.imageSmoothingEnabled = true; px.imageSmoothingQuality = 'high';
        px.drawImage(cv, 0, 0, pw, ph);
        preview = { w: pw, h: ph, data: px.getImageData(0, 0, pw, ph).data.buffer };
      }
      return { bytes: bytes, preview: preview };
    }
    root.onmessage = async function (e) {
      var m = e.data || {};
      try {
        if (m.cmd === 'ping') { root.postMessage({ cmd: 'ready' }); return; }
        if (m.cmd === 'begin') {
          jobs[m.id] = new MapJob(pieces(), m);
          root.postMessage({ cmd: 'progress', id: m.id, done: 0, total: m.bh });
          return;
        }
        if (m.cmd === 'strip') {
          var job = jobs[m.id];
          if (!job) return;
          job.feed(m.y0, m.rows, new Uint8ClampedArray(m.data));
          root.postMessage({ cmd: 'progress', id: m.id, done: job.fed, total: job.o.bh });   // a strip message has no bh
          return;
        }
        if (m.cmd === 'finish') {
          var j2 = jobs[m.id];
          if (!j2) throw new Error('no such job');
          var res = j2.finish();
          delete jobs[m.id];
          var enc2 = await encodeRgba(res.data, res.width, res.height, m.encode);
          var t2 = [enc2.bytes];
          if (enc2.preview) t2.push(enc2.preview.data);
          root.postMessage({
            cmd: 'done', id: m.id, bytes: enc2.bytes, preview: enc2.preview,
            blank: res.blank, inverted: res.inverted, darkFrac: res.darkFrac
          }, t2);
          return;
        }
        if (m.cmd === 'encode') {                       // RGBA produced elsewhere (the 255−c flip path)
          var enc3 = await encodeRgba(new Uint8ClampedArray(m.data), m.W, m.H, m.encode);
          var t3 = [enc3.bytes];
          if (enc3.preview) t3.push(enc3.preview.data);
          root.postMessage({ cmd: 'done', id: m.id, bytes: enc3.bytes, preview: enc3.preview }, t3);
          return;
        }
        if (m.cmd === 'cancel') { delete jobs[m.id]; return; }
      } catch (err) {
        root.postMessage({ cmd: 'error', id: m.id, message: (err && err.message) || String(err) });
      }
    };
    root.postMessage({ cmd: 'ready' });
  }

  return { MapJob: MapJob, workerMain: workerMain, stillBlank: stillBlank };
});
