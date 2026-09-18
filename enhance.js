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
  /* A yield that lets the browser actually PAINT. The message-channel yield above
     only returns to the event loop, which is not enough during a long pixel run:
     the progress bar and the live preview then look frozen even though input is
     processed. This one waits for a frame (at most one per ~90 ms, so the run is
     not slowed down), with a timeout guard so a hidden or throttled tab can never
     stall the conversion. */
  var _lastPaint = 0;
  NotesFX.uiPaint = function (force) {
    if (typeof requestAnimationFrame !== 'function' || document.hidden) return NotesFX.uiYield();
    var now = Date.now();
    if (!force && now - _lastPaint < 90) return NotesFX.uiYield();
    return new Promise(function (resolve) {
      var done = false;
      var fin = function () { if (done) return; done = true; _lastPaint = Date.now(); resolve(); };
      try { requestAnimationFrame(function () { setTimeout(fin, 0); }); } catch (e) { fin(); }
      setTimeout(fin, 120);                     // never hang the run on a throttled frame
    });
  };

  /* ---- background tabs ----------------------------------------------------
     A hidden tab must cost LESS, never more: no frames to wait for, no live
     preview to copy, no thumbnails to draw. Anything purely cosmetic waits until
     the user comes back. */
  NotesFX.hidden = function () { return !!document.hidden; };
  NotesFX.whenVisible = function () {
    if (!document.hidden) return Promise.resolve();
    return new Promise(function (resolve) {
      var h = function () {
        document.removeEventListener('visibilitychange', h);
        resolve();
      };
      document.addEventListener('visibilitychange', h);
    });
  };
  /* cosmetic work (result thumbnails) parks itself while the tab is away */
  NotesFX.parkWhileHidden = function () {
    return document.hidden ? NotesFX.whenVisible() : Promise.resolve();
  };

  /* ---- "time left" -------------------------------------------------------
     A run makes a promise the user can hold on to: "page 12 of 34 · ~40 s
     left" instead of a bar that just crawls. */
  NotesFX.eta = function (ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms <= 0) return '';
    var s = Math.round(ms / 1000);
    if (s <= 2) return 'almost done';
    if (s < 60) return '~' + s + ' s left';
    var m = Math.floor(s / 60), r = s - m * 60;
    return '~' + m + ' min' + (r >= 5 ? ' ' + r + ' s' : '') + ' left';
  };

  /* ---- result previews ----------------------------------------------------
     Rendering previews of a finished PDF can take tens of seconds (in
     print-saver mode every sheet holds four full-resolution images). Previews
     are a nice-to-have, so they are never allowed to delay the result: a
     placeholder grid appears at once and each preview swaps itself in as it
     finishes, leaving the page responsive. */
  NotesFX.thumbStrip = function (host, count, noteText) {
    host.innerHTML = '';
    var sks = [];
    for (var i = 0; i < count; i++) {
      var sk = document.createElement('div');
      sk.className = 'thumb-sk';
      host.appendChild(sk);
      sks.push(sk);
    }
    var note = document.createElement('p');
    note.className = 'thumb-note';
    note.textContent = noteText || 'previews loading… — the download is ready to use';
    host.appendChild(note);
    return {
      place: function (img, i) {                      // swap a preview into its slot
        var sk = sks[i];
        if (sk && sk.parentElement === host) host.insertBefore(img, sk);
        else host.appendChild(img);
        if (sk && sk.parentElement === host) host.removeChild(sk);
      },
      note: function (text) { note.textContent = text; },
      prune: function (text) {                        // drop the still-empty slots
        for (var j = 0; j < sks.length; j++) {
          if (sks[j].parentElement === host) host.removeChild(sks[j]);
        }
        if (text !== undefined) note.textContent = text;
      }
    };
  };

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
    if (document.hidden) return;                       // nobody can see the title now
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
      '.nfx-live canvas{display:block;width:100%;border-radius:8px;background:#fff}',
      '.nfx-live-sub{color:#8b96ad;font:500 .68rem system-ui;padding:.35rem .2rem 0;line-height:1.3}'
    ].join('\n');
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var root = document.createElement('div');
    root.className = 'nfx-live'; root.hidden = true;
    root.innerHTML = '<div class="nfx-live-head"><span class="nfx-live-dot"></span>' +
      '<span class="nfx-live-lab"></span><button class="nfx-live-x" type="button" title="hide">✕</button></div><canvas></canvas>' +
      '<div class="nfx-live-sub">this is the page going into the PDF at full resolution — the small tiles on the page are quick thumbnails</div>';
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

  /* ---------- multi-PDF order picker ----------
     Shown when several PDFs are dropped: a list where each file can be moved
     up / down (buttons or ↑↓ keys), removed, previewed by size — then merged
     in exactly the order shown. Resolves File[] or null (cancelled). */
  NotesFX.orderPdfs = function (files) {
    var list = Array.prototype.slice.call(files);
    return new Promise(function (resolve) {
      var css = [
        '.nfx-ord{position:fixed;inset:0;z-index:1100;background:rgba(8,10,18,.9);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:1rem}',
        '.nfx-ord-card{background:#12182a;border:1px solid #2c3548;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);width:min(560px,94vw);max-height:86vh;display:flex;flex-direction:column;font-family:system-ui}',
        '.nfx-ord-head{padding:1rem 1.2rem .6rem}',
        '.nfx-ord-head b{color:#e8ecf5;font-size:1.05rem}',
        '.nfx-ord-head small{display:block;color:#8b97ad;margin-top:.25rem;font-size:.8rem}',
        '.nfx-ord-list{overflow:auto;padding:.4rem .8rem;flex:1}',
        '.nfx-ord-row{display:flex;align-items:center;gap:.6rem;background:#1a2135;border:1px solid #2c3548;border-radius:11px;padding:.55rem .7rem;margin:.35rem 0;transition:transform .15s ease,opacity .15s ease}',
        '.nfx-ord-row.sel{border-color:#5b7bd8;box-shadow:0 0 0 2px rgba(91,123,216,.3)}',
        '.nfx-ord-num{flex:none;width:26px;height:26px;border-radius:50%;background:#2563eb;color:#fff;font:700 .8rem/26px system-ui;text-align:center}',
        '.nfx-ord-name{flex:1;min-width:0;color:#dbe3f0;font-size:.86rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.nfx-ord-size{color:#7b879c;font-size:.74rem;flex:none}',
        '.nfx-ord-btn{flex:none;cursor:pointer;border:1px solid #3a4356;background:#232b40;color:#cbd5e6;border-radius:8px;width:30px;height:30px;font:700 .95rem/1 system-ui}',
        '.nfx-ord-btn:hover{background:#2d3752}',
        '.nfx-ord-btn:disabled{opacity:.3;cursor:default}',
        '.nfx-ord-btn.del{color:#fda4a4;border-color:#5b2727}',
        '.nfx-ord-foot{display:flex;gap:.7rem;padding: .8rem 1.2rem 1.1rem;align-items:center}',
        '.nfx-ord-foot .keys{flex:1;color:#67738a;font-size:.72rem}',
        '.nfx-ord-foot .keys kbd{background:#1d2434;border:1px solid #39445c;border-radius:4px;padding:.05rem .35rem;font-size:.7rem}',
        '.nfx-ord-go{cursor:pointer;border:1px solid #15803d;background:#123421;color:#86efac;border-radius:10px;padding:.6rem 1.1rem;font:700 .88rem system-ui}',
        '.nfx-ord-go:hover{background:#174a2c}',
        '.nfx-ord-cancel{cursor:pointer;border:1px solid #3a4356;background:none;color:#9aa7bd;border-radius:10px;padding:.6rem 1rem;font:600 .85rem system-ui}'
      ].join('\n');
      var st = document.createElement('style'); st.textContent = css;
      var ov = document.createElement('div');
      ov.className = 'nfx-ord';
      ov.innerHTML = '<div class="nfx-ord-card"><div class="nfx-ord-head"><b>Arrange your PDFs</b>' +
        '<small>They will be merged top → bottom. Move files up / down until the order is right.</small></div>' +
        '<div class="nfx-ord-list"></div>' +
        '<div class="nfx-ord-foot"><span class="keys"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> merge</span>' +
        '<button class="nfx-ord-cancel" type="button">Cancel</button>' +
        '<button class="nfx-ord-go" type="button">Merge ' + list.length + ' PDFs ➜</button></div></div>';
      document.head.appendChild(st);
      document.body.appendChild(ov);
      var listEl = ov.querySelector('.nfx-ord-list');
      var goBtn = ov.querySelector('.nfx-ord-go');
      var sel = 0;

      function fmtMB(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
      function render() {
        listEl.innerHTML = '';
        list.forEach(function (f, i) {
          var row = document.createElement('div');
          row.className = 'nfx-ord-row' + (i === sel ? ' sel' : '');
          row.innerHTML = '<span class="nfx-ord-num">' + (i + 1) + '</span>' +
            '<span class="nfx-ord-name"></span><span class="nfx-ord-size">' + fmtMB(f.size) + '</span>' +
            '<button class="nfx-ord-btn up" type="button" title="move up" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
            '<button class="nfx-ord-btn dn" type="button" title="move down" ' + (i === list.length - 1 ? 'disabled' : '') + '>↓</button>' +
            '<button class="nfx-ord-btn del" type="button" title="remove from merge">✕</button>';
          row.querySelector('.nfx-ord-name').textContent = f.name;
          row.addEventListener('click', function () { sel = i; render(); });
          row.querySelector('.up').addEventListener('click', function (e) { e.stopPropagation(); move(i, i - 1); });
          row.querySelector('.dn').addEventListener('click', function (e) { e.stopPropagation(); move(i, i + 1); });
          row.querySelector('.del').addEventListener('click', function (e) {
            e.stopPropagation();
            list.splice(i, 1);
            if (sel >= list.length) sel = list.length - 1;
            if (list.length === 0) return finish(null);
            goBtn.textContent = 'Merge ' + (list.length === 1 ? 'this PDF ➜' : list.length + ' PDFs ➜');
            render();
          });
          listEl.appendChild(row);
        });
      }
      function move(i, j) {
        if (j < 0 || j >= list.length) return;
        var t = list[i]; list[i] = list[j]; list[j] = t;
        sel = j;
        render();
      }
      function onKey(e) {
        if (e.key === 'Escape') { finish(null); }
        else if (e.key === 'Enter') { finish(list.slice()); }
        else if (e.key === 'ArrowUp') { e.shiftKey ? move(sel, sel - 1) : (sel = Math.max(0, sel - 1), render()); }
        else if (e.key === 'ArrowDown') { e.shiftKey ? move(sel, sel + 1) : (sel = Math.min(list.length - 1, sel + 1), render()); }
        else return;
        e.preventDefault(); e.stopPropagation();
      }
      function finish(result) {
        document.removeEventListener('keydown', onKey, true);
        ov.remove(); st.remove();
        resolve(result);
      }
      ov.querySelector('.nfx-ord-cancel').addEventListener('click', function () { finish(null); });
      goBtn.addEventListener('click', function () { finish(list.slice()); });
      ov.addEventListener('click', function (e) { if (e.target === ov) finish(null); });
      document.addEventListener('keydown', onKey, true);
      render();
    });
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

  /* ---------- HD sheet zoom: click any preview sheet for a full-resolution look ----------
     cfg = { caption, render(canvas) } — render() must fill the canvas it is given,
     using the same engine as the real PDF. Sized to the viewport, up to 2× device
     pixels, so handwriting is readable exactly as it will print. */
  var zoomBox = null, zoomBusy = 0;
  function zoomClose() {
    if (!zoomBox) return;
    zoomBox.hidden = true;
    var cv = zoomBox.querySelector('.zoom-cv');
    if (cv) { cv.width = cv.height = 1; }        // release the big buffer
    document.body.classList.remove('zoom-lock');
  }
  NotesFX.zoomSheet = function (cfg) {
    if (!zoomBox) {
      zoomBox = document.createElement('div');
      zoomBox.id = 'zoomBox'; zoomBox.className = 'zoom-box'; zoomBox.hidden = true;
      zoomBox.innerHTML = '<div class="zoom-inner"><button type="button" class="zoom-x" aria-label="Close">\u00d7</button>' +
        '<canvas class="zoom-cv"></canvas><div class="zoom-cap"></div></div>';
      document.body.appendChild(zoomBox);
      zoomBox.addEventListener('click', function (e) {
        if (e.target === zoomBox || e.target.className === 'zoom-x') zoomClose();
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') zoomClose(); });
    }
    var inner = zoomBox.querySelector('.zoom-inner');
    var cv = zoomBox.querySelector('.zoom-cv');
    var cap = zoomBox.querySelector('.zoom-cap');
    var aspect = (cfg.aspect && cfg.aspect > 0) ? cfg.aspect : 1.414;       // w / h
    var maxW = Math.min(window.innerWidth - 28, 2000);
    var maxH = Math.min(window.innerHeight - 96, 1400);
    var cssW = Math.min(maxW, maxH * aspect);
    var cssH = cssW / aspect;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    while (cssW * dpr > 3600 && dpr > 1) dpr -= 0.25;                       // keep the pixel buffer sane
    inner.style.width = cssW + 'px';
    inner.style.height = cssH + 'px';
    cap.textContent = cfg.caption || '';
    cv.style.width = '100%'; cv.style.height = '100%';
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);  // the renderer may resize to the same value
    zoomBox.hidden = false;
    document.body.classList.add('zoom-lock');
    var mine = ++zoomBusy;
    Promise.resolve().then(function () { return cfg.render(cv); }).then(function () {
      if (mine !== zoomBusy) return;                                        // a newer zoom replaced this one
    }).catch(function (err) {
      if (mine !== zoomBusy) return;
      cap.textContent = 'Could not draw this sheet (' + (err && err.message || err) + ')';
      console.error(err);
    });
    return zoomBox;
  };
  NotesFX.closeZoom = zoomClose;

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
