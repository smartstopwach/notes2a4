/* ============ Notes2A4 — premium interaction layer ============
   Topbar state · CSS-3D tilt + cursor light on hero stages ·
   kinetic count-ups · toast system.
   Opt-in via data attributes. Zero cost on touch / reduced-motion
   devices: everything bails to static instantly. */
(function () {
  'use strict';

  var mq = window.matchMedia ? window.matchMedia.bind(window) : null;
  var REDUCE = mq && mq('(prefers-reduced-motion: reduce)').matches;
  var FINE = mq && mq('(hover: hover) and (pointer: fine)').matches;

  /* ---------- topbar: solidifies once the page scrolls ---------- */
  var tb = document.querySelector('.topbar');
  if (tb) {
    var wasScrolled = null;
    var onScroll = function () {
      var s = (window.scrollY || document.documentElement.scrollTop || 0) > 8;
      if (s !== wasScrolled) { wasScrolled = s; tb.classList.toggle('scrolled', s); }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- 3D tilt + cursor light (mouse only, rAF-batched) ---------- */
  if (FINE && !REDUCE) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tilt]'), function (host) {
      var stage = host.querySelector('.anim-stage,.fu-stage,.iv-stage');
      var sheet = host.querySelector('.anim-sheet,.fu-sheet,.iv-card.ic1');
      if (!stage) return;
      var raf = 0, tx = 0, ty = 0, lx = -1, ly = -1;

      function apply() {
        raf = 0;
        stage.style.setProperty('--ry', (tx * 6.5).toFixed(2) + 'deg');
        stage.style.setProperty('--rx', (-ty * 4.5).toFixed(2) + 'deg');
        if (sheet) {
          if (lx >= 0) {
            sheet.style.setProperty('--mx', (lx * 100).toFixed(1) + '%');
            sheet.style.setProperty('--my', (ly * 100).toFixed(1) + '%');
          } else { sheet.style.removeProperty('--mx'); sheet.style.removeProperty('--my'); }
        }
      }
      host.addEventListener('pointermove', function (e) {
        var r = host.getBoundingClientRect();
        tx = (e.clientX - r.left) / r.width - .5;
        ty = (e.clientY - r.top) / r.height - .5;
        if (sheet) {
          var s = sheet.getBoundingClientRect();
          lx = Math.min(1, Math.max(0, (e.clientX - s.left) / Math.max(1, s.width)));
          ly = Math.min(1, Math.max(0, (e.clientY - s.top) / Math.max(1, s.height)));
        }
        if (!raf) raf = requestAnimationFrame(apply);
      }, { passive: true });
      host.addEventListener('pointerleave', function () {
        tx = ty = 0; lx = ly = -1;
        if (!raf) raf = requestAnimationFrame(apply);
      });
    });
  }

  /* ---------- kinetic numbers: data-count="from:to" [data-delay] ---------- */
  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (el) {
    var parts = String(el.getAttribute('data-count')).split(':');
    var from = parseInt(parts[0], 10), to = parseInt(parts[1], 10);
    var delay = parseInt(el.getAttribute('data-delay') || '300', 10);
    if (REDUCE || isNaN(from) || isNaN(to)) { el.textContent = to; return; }
    el.textContent = from;
    setTimeout(function () {
      var t0 = 0;
      function tick(ts) {
        if (!t0) t0 = ts;
        var p = Math.min(1, (ts - t0) / 900);
        el.textContent = Math.round(from + (to - from) * easeOutExpo(p));
        if (p < 1) requestAnimationFrame(tick);
        else {
          el.textContent = to;
          if (el.id === 'halfs') {           /* the moment the sheet halves — a light pop */
            el.style.transition = 'transform .35s var(--ease-out)';
            el.style.transform = 'scale(1.16)';
            setTimeout(function () { el.style.transform = ''; }, 40);
          }
        }
      }
      requestAnimationFrame(tick);
    }, delay);
  });

  /* ---------- toasts (small confirmations; errors stay inline with role=alert) ---------- */
  window.NotesFX = window.NotesFX || {};

  /* ---------- throttle-proof UI yield ----------
     Long convert loops must yield so the page can paint — but setTimeout(0) is
     clamped to ~1000ms in BACKGROUND tabs, making a 200-sheet job crawl the
     moment the user switches away. Fix:
       · tab hidden  → resolve immediately (nothing to paint anyway; run full speed)
       · tab visible → MessageChannel macrotask — yields to the event loop for
         rendering but is exempt from background-timer clamping (no 4ms/1s floors). */
  var _yieldChan = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  var _yieldQueue = [];
  if (_yieldChan) {
    _yieldChan.port1.onmessage = function () {
      var r = _yieldQueue.shift();
      if (r) r();
    };
  }
  NotesFX.uiYield = function () {
    if (document.hidden || !_yieldChan) return Promise.resolve();
    return new Promise(function (resolve) {
      _yieldQueue.push(resolve);
      _yieldChan.port2.postMessage(0);
    });
  };

  /* ---------- tab-title progress (visible from other tabs) ---------- */
  var _title0 = null;
  NotesFX.titleProgress = function (done, total) {
    if (_title0 === null) _title0 = document.title;
    document.title = '\u23f3 ' + Math.round(done / total * 100) + '% \u00b7 ' + _title0;
  };
  NotesFX.titleDone = function (ok) {
    if (_title0 === null) return;
    document.title = (ok === false ? '\u26a0\ufe0f ' : '\u2705 ') + _title0;
    var t0 = _title0; _title0 = null;
    setTimeout(function () { if (document.title.slice(2).trim() === t0) document.title = t0; }, 4000);
  };

  /* ---------- live conversion preview ----------
     A floating HD panel that shows every page the moment it is processed —
     the exact canvas the engine just produced (invert / print-saver output),
     so you watch the conversion happen page by page. Click to enlarge. */
  var _lp = null;
  function _lpBuild() {
    if (_lp) return _lp;
    var css = [
      '.nfx-live{position:fixed;right:18px;bottom:18px;z-index:900;background:#10141f;border:1px solid #2c3548;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:.55rem;width:min(300px,42vw);transition:width .25s ease;cursor:zoom-in}',
      '.nfx-live.big{width:min(760px,72vw);cursor:zoom-out}',
      '.nfx-live-head{display:flex;align-items:center;gap:.5rem;padding:0 .2rem .45rem}',
      '.nfx-live-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;animation:nfxpulse 1.1s ease-in-out infinite}',
      '@keyframes nfxpulse{50%{opacity:.35}}',
      '.nfx-live-lab{color:#cdd7e8;font:600 .78rem system-ui;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nfx-live-x{cursor:pointer;border:0;background:none;color:#7b879c;font:700 .9rem system-ui;padding:0 .2rem}',
      '.nfx-live-x:hover{color:#e8ecf5}',
      '.nfx-live canvas{display:block;width:100%;border-radius:8px;background:#fff}'
    ].join('\n');
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var root = document.createElement('div');
    root.className = 'nfx-live'; root.hidden = true;
    root.innerHTML = '<div class="nfx-live-head"><span class="nfx-live-dot"></span>' +
      '<span class="nfx-live-lab"></span><button class="nfx-live-x" type="button" title="hide">✕</button></div><canvas></canvas>';
    document.body.appendChild(root);
    var closed = { v: false };
    root.querySelector('.nfx-live-x').addEventListener('click', function (e) {
      e.stopPropagation(); root.hidden = true; closed.v = true;
    });
    root.addEventListener('click', function () { root.classList.toggle('big'); });
    _lp = { root: root, lab: root.querySelector('.nfx-live-lab'), canvas: root.querySelector('canvas'), closed: closed };
    return _lp;
  }
  /* Show the just-processed page. srcCanvas is copied immediately (HD backing
     store, up to ~1100px wide) so the caller may free it right after. */
  NotesFX.liveShow = function (srcCanvas, label) {
    if (document.hidden) return;                       // hidden tab: skip paints, keep speed
    var lp = _lpBuild();
    if (lp.closed.v) return;                           // user dismissed it for this job
    lp.root.hidden = false;
    lp.lab.textContent = label || '';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.min(srcCanvas.width, Math.round(1100 * Math.max(dpr / 2, 1)));
    var h = Math.max(1, Math.round(w * srcCanvas.height / srcCanvas.width));
    lp.canvas.width = w; lp.canvas.height = h;
    var cx = lp.canvas.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(srcCanvas, 0, 0, w, h);
  };
  NotesFX.liveDone = function () {
    if (!_lp) return;
    _lp.closed.v = false;                              // re-arm for the next job
    var r = _lp.root;
    setTimeout(function () { r.hidden = true; r.classList.remove('big'); }, 1600);
  };

  /* ---------- multi-PDF merge ----------
     Drop or pick SEVERAL PDFs at once: they are stitched into one document
     (in the order given) with pdf-lib, then flow through the normal
     single-file pipeline. Returns { file, parts } or throws. */
  NotesFX.mergePdfs = async function (files, onStep) {
    var pdfs = Array.prototype.filter.call(files, function (f) {
      return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    });
    if (pdfs.length === 0) throw new Error('no PDF files');
    if (pdfs.length === 1) return { file: pdfs[0], parts: 1 };
    var out = await window.PDFLib.PDFDocument.create();
    var total = 0;
    for (var i = 0; i < pdfs.length; i++) {
      if (onStep) onStep(i + 1, pdfs.length, pdfs[i].name);
      var bytes = new Uint8Array(await pdfs[i].arrayBuffer());
      if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') {
        throw new Error('"' + pdfs[i].name + '" is not a valid PDF');
      }
      var doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      var idx = doc.getPageIndices();
      var pages = await out.copyPages(doc, idx);
      for (var p = 0; p < pages.length; p++) out.addPage(pages[p]);
      total += idx.length;
      await NotesFX.uiYield();
    }
    var merged = await out.save({ useObjectStreams: true });
    var base = pdfs[0].name.replace(/\.pdf$/i, '');
    var name = base + ' +' + (pdfs.length - 1) + ' more.pdf';
    NotesFX.toast(pdfs.length + ' PDFs merged \u00b7 ' + total + ' pages \u00b7 order kept');
    return { file: new File([merged], name, { type: 'application/pdf' }), parts: pdfs.length };
  };

  NotesFX.toast = function (msg, ms) {
    var wrap = document.getElementById('toasts');
    if (!wrap) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span></span>';
    t.querySelector('span').textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 380);
    }, ms || 2600);
  };
})();
