/* ============ Notes2A4 · Invert Lab — 1:1 PDF colour inversion ============
   Standalone app: does NOT touch NotesConverter. Renders each page with
   pdf.js, flips every channel (255 − v), writes a same-size page into a new
   pdf-lib document. Everything stays in this tab. */
(function () {
  'use strict';

  var BUILD = 7;
  console.info('[Notes2A4] app-invert.js build', BUILD, '· 1:1 colour flip + black-ink mode');
  if (typeof window.PDFLib === 'undefined' || typeof window.pdfjsLib === 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:99;background:#7f1d1d;color:#fecaca;padding:.7rem 1.1rem;border-radius:12px;font:600 .9rem system-ui;border:1px solid #b91c1c';
      bar.textContent = '⚠ Stale cache detected — press Ctrl+Shift+R (hard refresh).';
      document.body.appendChild(bar);
    });
    return;
  }

  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  var PDFLibns = window.PDFLib;

  var $ = function (id) { return document.getElementById(id); };

  var state = { bytes: null /* Uint8Array — .length = byte size */, name: '', doc: null, pages: 0, sizes: [], out: { url: '', doc: null }, gen: 0 };

  /* ---------- refs ---------- */
  var dz = $('dropzone'), fileInput = $('fileInput'), fileErr = $('fileError');
  var wb = $('workbench'), result = $('result'), thumbs = $('thumbs');
  var goBtn = $('goBtn'), pBox = $('progressBox'), pFill = $('pfill'), pStatus = $('pstatus');
  var opt = {
    dpi96: $('dpi96'), dpi150: $('dpi150'), dpi220: $('dpi220'),
    fmtJpg: $('fmtJpg'), fmtPng: $('fmtPng'), skip: $('optSkip'),
    styleNeg: $('styleNeg'), styleInk: $('styleInk'), stylePure: $('stylePure'), styleVec: $('styleVec'),
    dpiFld: $('dpiFld'), fmtFld: $('fmtFld'), skipRow: $('skipRow'),
    keepColour: $('optKeepColour'), keepColourRow: $('keepColourRow')
  };

  function dpi() { return opt.dpi220.checked ? 220 : (opt.dpi150.checked ? 150 : 96); }
  function fmt() { return opt.fmtPng.checked ? 'png' : 'jpeg'; }
  function inkMode() { return (opt.styleInk.checked || (opt.stylePure && opt.stylePure.checked)) && window.NotesConverter && NotesConverter.printSaver; }
  function pureMode() { return !!(opt.stylePure && opt.stylePure.checked); }
  /* exact vector 255 - c: no rasterising, the flip is applied to the PDF content
     itself (blend mode Difference), so the output matches a dedicated inversion
     tool pixel for pixel while text stays vector */
  function vectorMode() { return !!(opt.styleVec && opt.styleVec.checked); }
  function keepColour() { return !!(opt.keepColour && opt.keepColour.checked); }
  function syncKeepColourRow() { if (opt.keepColourRow) opt.keepColourRow.hidden = !opt.styleInk.checked; }  // pure mode: no colour row (everything is 0/255)
  function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function showError(m) { fileErr.hidden = false; fileErr.textContent = m; }
  function clearError() { fileErr.hidden = true; fileErr.textContent = ''; }

  /* ---------- reload-proof session: source + options + result + page checkpoints ---------- */
  var SESS_SEL = '#workbench input, #workbench select';
  var restoring = false;
  var sessBar = $('sessBar'), sessMsg = $('sessMsg'), sessGo = $('sessGo');
  function sessReady() { return !!(window.NotesSession && NotesSession.supported()); }
  function sessNote(msg, showGo) {
    if (!sessBar) return;
    sessBar.hidden = false;
    if (sessMsg) sessMsg.textContent = msg;
    if (sessGo) sessGo.hidden = !showGo;
  }
  function sessKill() {
    if (sessReady()) NotesSession.clearAll();
    if (sessBar) sessBar.hidden = true;
  }
  function styleName() {
    if (vectorMode()) return 'true negative (exact vector)';
    return pureMode() ? 'pure b&w' : (inkMode() ? 'black ink' : 'true negative');
  }
  function invSig() {
    return [Math.round(dpi()), fmt(), styleName(), keepColour() ? 1 : 0, opt.skip.checked ? 1 : 0].join('|');
  }
  function syncAfterRestore() { if (opt.keepColourRow) syncKeepColourRow(); syncVectorRows(); }
  function syncVectorRows() {
    var v = vectorMode();
    if (opt.dpiFld) opt.dpiFld.hidden = v;          // Sharpness / Encoding / Skip blank are raster-only
    if (opt.fmtFld) opt.fmtFld.hidden = v;
    if (opt.skipRow) opt.skipRow.hidden = v;
  }
  async function restoreResult(meta) {
    var url = await NotesSession.resultUrl();
    if (!url) return;
    state.out.url = url;
    var dl = $('dlBtn');
    dl.href = url; dl.download = meta.name;
    $('openBtn').href = url;
    $('rsIn').textContent = $('rsOut').textContent = state.pages || '';
    $('rsMeta').textContent = (meta.info && meta.info.meta ? meta.info.meta + ' · ' : '') +
      'restored from this browser — no re-conversion needed · ' + fmtMB(meta.size);
    result.hidden = false;
    if (meta.size <= (NotesSession.THUMB_LIMIT || 96 * 1048576) && state.pages) {
      try { await makeThumbs(await NotesSession.resultBytes(), state.pages); } catch (e) {}
    }
  }

  /* ---------- core: invert a pixel buffer in place; returns blankness ----------
     blank = every RGB channel ≥ 252 (a pure white page — nothing to flip). */
  function invertPixels(idat, flip) {
    var d = idat.data, blank = true;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (blank && (r < 252 || g < 252 || b < 252)) blank = false;
      if (flip) { d[i] = 255 - r; d[i + 1] = 255 - g; d[i + 2] = 255 - b; }
    }
    return blank;
  }

  /* ---------- file input ---------- */
  dz.addEventListener('click', function (e) { if (!e.target.closest('button')) fileInput.click(); });
  dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', function (e) {
    var fs = e.dataTransfer && e.dataTransfer.files;
    if (fs && fs.length) loadFiles(fs);
  });
  fileInput.addEventListener('change', function () { if (fileInput.files.length) loadFiles(fileInput.files); });

  /* Accept one PDF — or several: they are merged in order, then loaded as one. */
  async function loadFiles(files) {
    if (files.length === 1) return loadFile(files[0]);
    clearError();
    var ordered = await NotesFX.orderPdfs(files);      // arrange up/down before merging
    if (!ordered) return;                              // cancelled
    if (ordered.length === 1) return loadFile(ordered[0]);
    pBox.hidden = false; pFill.style.width = '10%';
    try {
      var m = await NotesFX.mergePdfs(ordered, function (d, t, nm) {
        pFill.style.width = (10 + d / t * 80).toFixed(0) + '%';
        pStatus.textContent = 'merging ' + d + ' of ' + t + ' \u00b7 ' + nm;
      });
      await loadFile(m.file);
    } catch (err) {
      pBox.hidden = true;
      showError('Could not merge PDFs (' + (err && err.message || err) + ').');
    }
  }

  async function loadFile(f) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { showError('Please pick a .pdf file.'); return; }
    clearError();
    var buf = await f.arrayBuffer();
    var u8 = new Uint8Array(buf);
    if (u8.length < 5 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== '%PDF') {
      showError('Invalid or corrupted PDF.'); return;
    }
    state.bytes = u8; state.name = f.name;
    pStatus.textContent = 'reading…'; pBox.hidden = false; pFill.style.width = '20%';
    try {
      if (state.doc) { try { state.doc.destroy(); } catch (e) {} }
      var task = pdfjsLib.getDocument({ data: u8.slice(0) });
      state.doc = await task.promise;
      state.pages = state.doc.numPages;
      state.sizes = [];
      for (var i = 1; i <= state.pages; i++) {
        var pg = await state.doc.getPage(i);
        var vp = pg.getViewport({ scale: 1 });
        state.sizes.push({ w: vp.width, h: vp.height });
        pg.cleanup();
      }
      pBox.hidden = true;
      if (window.PageReview) PageReview.setSource(u8, f.name);
      afterLoad();
      if (sessReady() && !restoring) {
        NotesSession.saveFiles([{ name: state.name, bytes: state.bytes }]);
        NotesSession.runClear();
        sessNote('Saved in this browser — reload, close or crash, this file and your settings stay.');
      }
      if (window.NotesFX) NotesFX.toast(state.pages + ' pages measured — 1:1 ready, nothing uploaded');
    } catch (err) {
      pBox.hidden = true;
      showError('Could not open this PDF (' + (err && err.message || 'password-protected or damaged') + ').');
    }
  }

  function afterLoad() {
    dz.hidden = true; wb.hidden = false; result.hidden = true;
    var n = state.pages;
    $('fbName').textContent = state.name;
    $('fbPages').textContent = n + (n === 1 ? ' page' : ' pages');
    $('fbRatio').textContent = 'sizes locked ✓';
    $('fbOut').textContent = '→ ' + n + ' pages (1:1)';
    $('goIn').textContent = n;
    goBtn.disabled = false;
    renderPreview();
    wb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- preview: page 1, original vs inverted ---------- */
  var pvTimer = null;
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 120); }

  async function renderPageScaled(pgNum, scale, canvas) {
    var pg = await state.doc.getPage(pgNum);
    var vp = pg.getViewport({ scale: scale });
    canvas.width = Math.max(2, Math.round(vp.width));
    canvas.height = Math.max(2, Math.round(vp.height));
    var cx = canvas.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: cx, viewport: vp }).promise;
    pg.cleanup();
    return cx;
  }

  /* target backing pixels for a preview canvas: its real on-screen size × dpr
     (the old fixed 320 px made every preview upscaled and soft) */
  function previewPx(canvas, cssWOverride) {
    var cssW = cssWOverride ||
      Math.max(320, (canvas.parentElement && canvas.parentElement.clientWidth) || canvas.clientWidth || 380);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.min(3600, Math.max(320, Math.round(cssW * dpr)));
  }

  async function paintInvertPreview(c1, c2, pageNum, cssWOverride) {
    var vp = (await state.doc.getPage(pageNum)).getViewport({ scale: 1 });
    await renderPageScaled(pageNum, previewPx(c1, cssWOverride) / Math.max(1, vp.width), c1);
    c2.width = c1.width; c2.height = c1.height;
    var x2 = c2.getContext('2d', { willReadFrequently: true });
    x2.imageSmoothingEnabled = true; x2.imageSmoothingQuality = 'high';
    x2.drawImage(c1, 0, 0);
    if (inkMode() && !vectorMode()) {                 // vector mode = plain 255 - c, same as the PDF it produces
      var hm = await NotesConverter.printSaver.hqMapAsync(
        function (y0, rows) { return x2.getImageData(0, y0, c2.width, rows); },
        c2.width, c2.height, c2.width, c2.height, true, keepColour(), pureMode(),
        { band: 192, progress: function () { return NotesFX.uiPaint(); } });   // banded: previews stay snappy too
      x2.putImageData(new ImageData(hm.imageData.data, c2.width, c2.height), 0, 0);
    } else {
      var id = x2.getImageData(0, 0, c2.width, c2.height);
      invertPixels(id, true);
      x2.putImageData(id, 0, 0);
    }
    (await state.doc.getPage(pageNum)).cleanup();
  }

  async function renderPreview() {
    if (!state.doc) return;
    var gen = ++state.gen;
    var figures = document.querySelectorAll('.sheet-fig');
    var f1 = figures[0], f2 = figures[1];
    f1.hidden = f2.hidden = false;
    f1.classList.add('loading'); f2.classList.add('loading');
    f1.style.cursor = 'zoom-in'; f2.style.cursor = 'zoom-in';
    try {
      await paintInvertPreview($('pv1'), $('pv2'), 1);
      if (gen !== state.gen) return;
      wireZoom();
    } finally {
      f1.classList.remove('loading'); f2.classList.remove('loading');
    }
    renderPageStrip(gen);                        // then every page of the result, small
  }

  /* ---------- every page of the result as a small tile ----------
     Fills the preview column (it used to be one tall empty card) and shows what the
     flip does to every page, not just the first one. Cancelled on any change. */

  /* a run and the preview strip must not fight over the CPU: the strip stops,
     says so, and is finished off once the result is on screen */
  function renderStripAgain() {
    if (typeof renderSheetStrip === 'function') renderSheetStrip(state.gen);
    else if (typeof renderPageStrip === 'function') renderPageStrip(state.gen);
  }
  function resumePreviewStrip() {
    if (!state.stripPaused) return;
    state.stripPaused = false;
    setTimeout(function () {
      if (!state.doc || goBtn.disabled || document.hidden) return;
      renderStripAgain();
    }, 400);
  }
  var stripToken = 0;
  async function renderPageStrip(gen) {
    var host = $('prevStrip');
    if (!host || !state.doc) return;
    var my = ++stripToken;
    var total = state.pages;
    var show = Math.min(total, 24);
    var strip = (window.NotesFX && NotesFX.thumbStrip)
      ? NotesFX.thumbStrip(host, show, 'drawing all ' + total + ' page' + (total === 1 ? '' : 's') + '\u2026')
      : null;
    var scratch = document.createElement('canvas');
    for (var i = 1; i <= show; i++) {
      if (my !== stripToken || gen !== state.gen) return;                     // changed under us
      if (document.hidden) {                                                  // tab in the background: no point
        if (strip) strip.prune('previews paused \u2014 they finish when you come back to this tab');
        NotesFX.whenVisible().then(function () { if (my === stripToken) renderStripAgain(); });
        return;
      }
      if (goBtn.disabled || state.running) {                                  // a run has started: stop cleanly
        if (strip) strip.prune('previews paused while the PDF is being made \u2014 they come back when it finishes');
        state.stripPaused = true;
        return;
      }
      var fig = document.createElement('figure');
      var cv = document.createElement('canvas');
      var cap = document.createElement('figcaption');
      cap.textContent = 'page ' + i + ' \u00b7 ' + styleName();
      fig.appendChild(cv); fig.appendChild(cap);
      await paintInvertPreview(scratch, cv, i, 168);      // cv = the flipped page, exactly as the PDF gets it
      if (my !== stripToken || gen !== state.gen) return;
      if (strip) strip.place(fig, i - 1);
      await NotesFX.uiYield();
    }
    if (strip) strip.note(total + ' page' + (total === 1 ? '' : 's') + ' in the finished PDF' +
      (total > show ? ' \u00b7 first ' + show + ' shown' : '') + ' \u00b7 click a big preview to enlarge');
  }

  /* Click a preview → HD view: original or flipped, same engine as the real PDF. */
  function wireZoom() {
    var figures = document.querySelectorAll('.sheet-fig');
    [[figures[0], 'original'], [figures[1], 'flipped']].forEach(function (pair) {
      var fig = pair[0], which = pair[1];
      if (!fig || fig.dataset.zoomWired) return;
      fig.dataset.zoomWired = '1';
      fig.title = 'Click for an HD look at page 1';
      var hint = document.createElement('span');
      hint.className = 'zoom-hint'; hint.textContent = '\u2922 click to enlarge';
      fig.appendChild(hint);
      fig.addEventListener('click', function () {
        if (!state.doc) return;
        var vp = state.sizes[0] || { w: 595, h: 842 };
        NotesFX.zoomSheet({
          aspect: vp.w / vp.h,
          caption: 'page 1 \u00b7 ' + which + ' \u00b7 HD render, same engine as the PDF' +
            (which === 'flipped' ? ' \u00b7 ' + styleName() + ' \u00b7 ' + Math.round(dpi()) + ' dpi' : ''),
          render: function (cv) {
            var scratch = document.createElement('canvas');        // the half that is not being shown
            var cssW = cv.parentElement.clientWidth || 1200;
            return which === 'flipped'
              ? paintInvertPreview(scratch, cv, 1, cssW)           // scratch = original, cv = flipped
              : paintInvertPreview(cv, scratch, 1, cssW);          // cv = original
          }
        });
      });
    });
  }

  /* ---------- per-page raster + invert (same SSAA guard as the print engine) ---------- */
  async function rasterInverted(pgNum, sub) {
    var pg = await state.doc.getPage(pgNum);
    var vp1 = pg.getViewport({ scale: 1 });
    var outSc = dpi() / 72;
    var bigW = Math.round(vp1.width * outSc * 2), bigH = Math.round(vp1.height * outSc * 2);
    var ss = (bigW * bigH <= 34000000 && bigW <= 16000 && bigH <= 16000) ? 2 : 1;   // 2× supersample → area-averaged down
    var W = Math.max(2, Math.round(vp1.width * outSc)), H = Math.max(2, Math.round(vp1.height * outSc));
    var bw = Math.max(2, Math.round(vp1.width * outSc * ss)), bh = Math.max(2, Math.round(vp1.height * outSc * ss));
    /* The page is rendered in horizontal strips — one giant 32 Mpx pdf.js call was
       the longest block in the whole run (that is what froze the tab). offsetY is
       a whole number of device pixels, so the strips are rasterised exactly like
       the rows of a full-page render; the pixels do not change. */
    var stripRows = Math.max(ss, ss * 96);
    var renderStrip = async function (y0, rows) {
      var cv = document.createElement('canvas');
      cv.width = bw; cv.height = rows;
      var cx = cv.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, bw, rows);
      await pg.render({ canvasContext: cx, viewport: pg.getViewport({ scale: outSc * ss, offsetY: -y0 }) }).promise;
      var id = cx.getImageData(0, 0, bw, rows);
      cv.width = 0; cv.height = 0;                                  // release the strip immediately
      return id;
    };
    var blank = true, out = document.createElement('canvas');
    out.width = W; out.height = H;
    var hook = { band: stripRows, progress: async function (f, phase) { if (sub) sub(f, phase); await NotesFX.uiPaint(); } };
    /* the old behaviour, kept as a safety net: one canvas, one render call */
    var fullCanvas = async function () {
      var cv = document.createElement('canvas');
      cv.width = bw; cv.height = bh;
      var cx = cv.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, bw, bh);
      await NotesFX.uiPaint(true);
      await pg.render({ canvasContext: cx, viewport: pg.getViewport({ scale: outSc * ss }) }).promise;
      return { canvas: cv, ctx: cx };
    };
    if (sub) sub(0, 'rendering');
    await NotesFX.uiPaint(true);                // let the bar move before the first strip
    /* Off-thread first: the per-pixel map over the whole page and the JPEG/PNG
       encode are what froze the tab. The worker does both on the strips we hand
       over; if it cannot, the main-thread path below does exactly the same maths. */
    if (window.NotesRaster && NotesRaster.supported()) {
      var wmime = fmt() === 'png' ? 'image/png' : 'image/jpeg';
      try {
        if (inkMode()) {
          var wi = await NotesRaster.mapPage({
            kind: 'hq', auto: true, keepColour: keepColour(), pure: pureMode(),
            bw: bw, bh: bh, W: W, H: H, band: stripRows, trackBlank: true, provider: renderStrip,
            encode: { mime: wmime, quality: 0.94, previewMax: 720 },
            onProgress: function (done, total) { if (sub) sub(done / total, 'binarising'); },
            onStrip: function () { return NotesFX.uiPaint(); }
          });
          pg.cleanup();
          return { bytes: new Uint8Array(wi.bytes), blank: !!wi.blank, blankTracked: true, preview: previewOf(wi.preview) };
        }
        /* plain 255 − c: the flipped page is assembled on the main thread (the
           browser's smooth downscale is part of the look), the encode — the long
           part for JPEG — goes to the worker */
        var bigW2 = document.createElement('canvas');
        bigW2.width = bw; bigW2.height = bh;
        var bx2 = bigW2.getContext('2d', { willReadFrequently: true });
        var blank2 = true;
        for (var wy = 0; wy < bh; wy += stripRows) {
          var wrows = Math.min(stripRows, bh - wy);
          var wid = await renderStrip(wy, wrows);
          if (blank2) blank2 = invertPixels(wid, false);
          invertPixels(wid, true);
          bx2.putImageData(wid, 0, wy);
          if (sub) sub((wy + wrows) / bh, 'flip');
          await NotesFX.uiPaint();
        }
        var ox2 = out.getContext('2d', { willReadFrequently: true });
        ox2.imageSmoothingEnabled = true; ox2.imageSmoothingQuality = 'high';
        ox2.drawImage(bigW2, 0, 0, W, H);
        bigW2.width = bigW2.height = 0;
        var rgba = out.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
        var enc = await NotesRaster.encode({ rgba: rgba, W: W, H: H, encode: { mime: wmime, quality: 0.94, previewMax: 720 } });
        pg.cleanup();
        return { bytes: new Uint8Array(enc.bytes), blank: blank2, blankTracked: true, preview: previewOf(enc.preview) };
      } catch (err) {
        console.warn('raster worker could not do this page, using the main thread:', err);
      }
    }
    if (inkMode()) {                            // same ink-bias mapping the Print-Saver engine uses
      var stripFeed = function (y0, rows) {
        return renderStrip(y0, rows).then(function (id) {
          if (blank) blank = invertPixels(id, false);              // scan-only: is the page pure white?
          return id;
        });
      };
      var hm;
      try {
        hm = await NotesConverter.printSaver.hqMapAsync(stripFeed, bw, bh, W, H, true, keepColour(), pureMode(), hook);
      } catch (err) {
        console.warn('strip rendering unavailable, falling back to a full-page render:', err);
        blank = true;
        var fat = await fullCanvas();
        hm = await NotesConverter.printSaver.hqMapAsync(function (y0, rows) {
          var id = fat.ctx.getImageData(0, y0, bw, rows);
          if (blank) blank = invertPixels(id, false);
          return id;
        }, bw, bh, W, H, true, keepColour(), pureMode(), hook);
        fat.canvas.width = 0; fat.canvas.height = 0;
      }
      out.getContext('2d').putImageData(new ImageData(hm.imageData.data, W, H), 0, 0);
    } else {
      /* true negative — colours included. The flipped page is assembled at full
         supersampled size and scaled down once at the end, exactly as before. */
      var big = document.createElement('canvas');
      big.width = bw; big.height = bh;
      var bx = big.getContext('2d', { willReadFrequently: true });
      try {
        for (var y0 = 0; y0 < bh; y0 += stripRows) {
          var rows = Math.min(stripRows, bh - y0);
          var id2 = await renderStrip(y0, rows);
          if (blank) blank = invertPixels(id2, false);
          invertPixels(id2, true);
          bx.putImageData(id2, 0, y0);
          if (sub) sub((y0 + rows) / bh, 'flip');
          await NotesFX.uiPaint();
        }
      } catch (err) {
        console.warn('strip rendering unavailable, falling back to a full-page render:', err);
        blank = true;
        var fat2 = await fullCanvas();
        bx.fillStyle = '#fff'; bx.fillRect(0, 0, bw, bh);
        for (var y1 = 0; y1 < bh; y1 += stripRows) {
          var rows2 = Math.min(stripRows, bh - y1);
          var id3 = fat2.ctx.getImageData(0, y1, bw, rows2);
          if (blank) blank = invertPixels(id3, false);
          invertPixels(id3, true);
          bx.putImageData(id3, 0, y1);
          if (sub) sub((y1 + rows2) / bh, 'flip');
          await NotesFX.uiPaint();
        }
        fat2.canvas.width = 0; fat2.canvas.height = 0;
      }
      var ox = out.getContext('2d');
      ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
      ox.drawImage(big, 0, 0, W, H);
      big.width = big.height = 0;                                  // release big buffer early
    }
    pg.cleanup();
    return { canvas: out, blank: blank };
  }

  /* a small canvas from the worker's preview pixels (for the live view) */
  function previewCanvas(prev) {
    var cv = document.createElement('canvas');
    cv.width = prev.width; cv.height = prev.height;
    cv.getContext('2d').putImageData(new ImageData(prev.data, prev.width, prev.height), 0, 0);
    return cv;
  }

  function previewOf(prev) {
    return prev ? { data: new Uint8ClampedArray(prev.data), width: prev.w, height: prev.h } : null;
  }

  async function canvasBytes(canvas) {
    var mime = fmt() === 'png' ? 'image/png' : 'image/jpeg';
    var blob = await new Promise(function (res) { canvas.toBlob(res, mime, 0.94); });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* ---------- convert ---------- */
  goBtn.addEventListener('click', convert);

  async function convert() {
    if (!state.bytes || goBtn.disabled) return;
    goBtn.disabled = true; result.hidden = true; state.running = true;
    pBox.hidden = false; pFill.style.width = '2%'; pStatus.textContent = 'measuring pages…';
    var prevCard = document.querySelector('.card.prev');
    if (prevCard) prevCard.classList.add('busy');
    var t0 = performance.now();
    /* ---- progress: one place writes the bar, the status line and the tab title,
       so every phase reports the same way and they can never disagree. The
       estimate is smoothed (one slow page must not make it jump) and refreshed
       once a second, so it stays honest during a long phase as well. */
    var etaSmooth = null, lastStep = null, ticker = null;
    var etaOf = function (frac) {
      if (frac >= 0.999) return '';                      // finished: no estimate needed
      var elapsed = performance.now() - t0;
      if (!(frac > 0.005) || elapsed < 1500) return ' · estimating time left…';
      var left = (elapsed / frac) * (1 - frac);
      etaSmooth = (etaSmooth === null) ? left : (etaSmooth * 0.7 + left * 0.3);
      var txt = NotesFX.eta ? NotesFX.eta(etaSmooth) : '';
      return txt ? ' · ' + txt : '';
    };
    var setStep = function (frac, text, label) {
      lastStep = { frac: frac, text: text, label: label };
      pFill.style.width = (frac * 100).toFixed(1) + '%';
      pStatus.textContent = text + etaOf(frac);
      NotesFX.titleProgress(frac, 1, label);
    };
    var stopTicker = function () { if (ticker) { clearInterval(ticker); ticker = null; } };
    /* once a second: refresh the estimate (and the tab title) — this is what makes
       the run look alive from another tab, and it stays correct even while a long
       synchronous phase is in progress */
    ticker = setInterval(function () {
      if (lastStep && goBtn.disabled) setStep(lastStep.frac, lastStep.text, lastStep.label);
    }, 1000);
    var skip = opt.skip.checked, n = state.pages;
    setStep(0.02, 'measuring pages…', '');
    if (vectorMode()) {                              // exact vector 255 - c: instant, no raster, no checkpoints
      try {
        pStatus.textContent = 'applying 255 - c to the PDF itself…';
        if (sessReady()) { await NotesSession.runClear(); }
        var vres = await NotesConverter.vectorNegative(state.bytes);
        setStep(1, 'done', '');
        if (state.out.url) URL.revokeObjectURL(state.out.url);
        state.out.url = URL.createObjectURL(new Blob([vres.bytes], { type: 'application/pdf' }));
        var baseV = state.name.replace(/\.pdf$/i, '');
        var dlV = $('dlBtn');
        dlV.href = state.out.url; dlV.download = baseV + '-inverted.pdf';
        $('openBtn').href = state.out.url;
        $('rsIn').textContent = n;
        $('rsOut').textContent = n;
        $('rsMeta').textContent = n + (n === 1 ? ' page' : ' pages') +
          ' inverted 1:1 · true negative (exact vector, 255 − c per channel) · text stays sharp and selectable · sizes unchanged · ' +
          fmtMB(state.bytes.length) + ' → ' + fmtMB(vres.bytes.length) + ' · ' +
          ((performance.now() - t0) / 1000).toFixed(2) + 's · 100% on-device';
        renderThumbsSoon(vres.bytes, n);               // previews are background work
        result.hidden = false;                          // …so the Download button shows NOW
        if (prevCard) prevCard.classList.remove('busy');
        if (window.NotesFX) NotesFX.toast(n + ' pages flipped · exact 255 − c · vector kept');
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(function () { pBox.hidden = true; }, 900);
        if (sessReady()) {
          var metaV = $('rsMeta').textContent;
          NotesSession.saveResult({ bytes: vres.bytes, name: dlV.download, kind: 'vector-negative', info: { in: n, out: n, meta: metaV } }).then(function () {
            sessNote('Saved · ' + n + ' page' + (n === 1 ? '' : 's') + ' flipped (exact vector) — reloading keeps this result.');
          });
        }
      } catch (err) {
        stopTicker();
        pStatus.textContent = 'failed: ' + (err && err.message || err);
        if (prevCard) prevCard.classList.remove('busy');
        console.error(err);
      }
      stopTicker();
      state.running = false;
      goBtn.disabled = false;
      return;
    }
    var ck = false, hand = { have: 0 };
    if (sessReady()) {                                     // same settings ⇒ leftover pages are still good
      try { hand = await NotesSession.runBegin(invSig(), n, 'invert'); ck = true; } catch (e) { ck = false; }
      if (hand && hand.have) pStatus.textContent = 'resuming — ' + hand.have + ' page' + (hand.have === 1 ? '' : 's') + ' already done…';
    }
    try {
      var outDoc = await PDFLibns.PDFDocument.create();
      var skipped = 0, reused = 0;
      for (var i = 1; i <= n; i++) {
        var bytes = ck ? await NotesSession.pageGet(i - 1) : null;      // finished page from the last run
        var r = null, blank = false;
        if (bytes) { reused++; }
        else {
          r = await rasterInverted(i, function (f, phase) {
            setStep((i - 1 + f) / n * 0.88, 'page ' + i + ' of ' + n + ' · ' +
              (phase === 'rendering' || phase === 'downsample' ? 'rendering the page' : phase === 'flip' ? 'flipping colours' : phase === 'measure' ? 'measuring the ink' : 'binarising') +
              ' ' + Math.round(f * 100) + '%', 'page ' + i + ' of ' + n);
          });
          bytes = r.bytes || await canvasBytes(r.canvas);
          blank = !!r.blank;
          if (skip && blank) {          // blank page stays white: embed the un-inverted look (white sheet)
            var white = document.createElement('canvas'); white.width = 2; white.height = 2;
            var wx = white.getContext('2d'); wx.fillStyle = '#fff'; wx.fillRect(0, 0, 2, 2);
            bytes = await canvasBytes(white);
            skipped++;
          }
          if (ck) {
            await NotesSession.pagePut(i - 1, bytes);                    // survive a reload mid-run
            await NotesSession.runSave({ phase: 'invert', page: i, pages: n, kind: 'invert' });
          }
        }
        var img = (fmt() === 'png') ? await outDoc.embedPng(bytes) : await outDoc.embedJpg(bytes);
        var size = state.sizes[i - 1];
        var outPg = outDoc.addPage([size.w, size.h]);
        outPg.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h });
        if (r) {                                                       // the worker path brings pixels, not a canvas
          var liveCv = r.canvas || (r.preview ? previewCanvas(r.preview) : null);
          if (liveCv) NotesFX.liveShow(liveCv, 'page ' + i + ' / ' + n + ' · ' + styleName() + (blank && skip ? ' · blank' : ''));
          if (r.canvas) { r.canvas.width = r.canvas.height = 0; }
        }
        setStep(0.04 + i / n * 0.90, 'page ' + i + ' of ' + n + ' · ' + styleName() + ' · ' + (fmt() === 'png' ? 'png' : 'jpeg') + ' ' + Math.round(dpi()) + ' dpi' +
          (r ? (blank && skip ? ' · blank kept white' : '') : ' · from checkpoint'), 'page ' + i + ' of ' + n);
        NotesFX.titleProgress(i, n);
        await NotesFX.uiYield();                                      // throttle-proof: full speed in background tabs
      }
      state.reusedPages = reused;
      setStep(0.96, 'writing the file…', 'writing the file');
      var saved = await outDoc.save({ useObjectStreams: true });
      pFill.style.width = '100%'; pStatus.textContent = 'done';
      NotesFX.titleDone(); NotesFX.liveDone();
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([saved], { type: 'application/pdf' }));

      var base = state.name.replace(/\.pdf$/i, '');
      var dl = $('dlBtn');
      dl.href = state.out.url; dl.download = base + '-inverted.pdf';
      $('openBtn').href = state.out.url;

      $('rsIn').textContent = n;
      $('rsOut').textContent = n;
      $('rsMeta').textContent =
        n + (n === 1 ? ' page' : ' pages') + ' inverted 1:1 · ' + styleName() + ' · sizes unchanged · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(saved.length) + ' · ' + dpi() + ' dpi ' + (fmt() === 'png' ? 'PNG' : 'JPEG') +
        (skipped ? ' · ' + skipped + ' blank page' + (skipped === 1 ? '' : 's') + ' kept white' : '') + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device';

      /* show the result immediately; previews + the reload-proof save follow */
      renderThumbsSoon(saved, n);
      result.hidden = false;
      resumePreviewStrip();                        // previews paused for the run? finish them now
      if (prevCard) prevCard.classList.remove('busy');
      if (window.NotesFX) NotesFX.toast(n + ' pages flipped · sizes identical · still on-device');
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
      if (sessReady()) {
        var metaR = $('rsMeta').textContent;
        NotesSession.saveResult({
          bytes: saved, name: dl.download, kind: inkMode() ? 'ink' : 'negative',
          info: { in: n, out: n, meta: metaR }
        }).then(function () {                           // queued in order, so runClear still runs after
          NotesSession.runClear();
          sessNote('Saved · ' + n + ' page' + (n === 1 ? '' : 's') + ' flipped — reloading keeps this result and the download link.');
        });
      }
    } catch (err) {
      pStatus.textContent = 'failed: ' + (err && err.message || err);
      NotesFX.titleDone(false); NotesFX.liveDone();
      if (prevCard) prevCard.classList.remove('busy');
      console.error(err);
    }
    stopTicker();
    state.running = false;
    goBtn.disabled = false;
  }

  /* ---------- thumbs of the OUTPUT pdf ---------- */
  var thumbToken = 0;
  /* Previews must never hold back the result: placeholders appear instantly and
     the real pages swap themselves in one by one, in the background. */
  function renderThumbsSoon(bytes, n) {
    var mine = ++thumbToken;
    var strip = (window.NotesFX && NotesFX.thumbStrip) ? NotesFX.thumbStrip(thumbs, Math.min(n, 6)) : null;
    setTimeout(function () {
      if (mine !== thumbToken) return;
      makeThumbs(bytes, n, mine, strip).catch(function (e) { console.warn('previews:', e); });
    }, 30);
  }
  async function makeThumbs(bytes, n, token, strip) {
    var stale = function () { return token !== undefined && token !== thumbToken; };
    if (strip === undefined) thumbs.innerHTML = '';                 // restored-result path
    if (state.out.doc) { try { state.out.doc.destroy(); } catch (e) {} }
    var doc = state.out.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(0) }).promise;
    if (stale()) return;
    var show = Math.min(n, 6);
    for (var i = 1; i <= show; i++) {
      await NotesFX.parkWhileHidden();               // cosmetic: wait for the user to come back
      if (stale()) return;
      var pg = await doc.getPage(i);
      var w0 = pg.getViewport({ scale: 1 }).width;
      var vp = pg.getViewport({ scale: 170 / w0 });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      var img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.alt = 'Inverted page ' + i + ' preview';
      if (strip) strip.place(img, i - 1);
      else thumbs.appendChild(img);
      pg.cleanup();
      await NotesFX.uiPaint();                       // stay responsive while previews render
    }
    if (n > show) {
      var more = document.createElement('p');
      more.style.cssText = 'color:var(--faint);font-size:.78rem;grid-column:1/-1';
      more.textContent = '+ ' + (n - show) + ' more pages in the downloaded PDF';
      thumbs.appendChild(more);
    }
  }

  /* ---------- options + reset ---------- */
  [opt.dpi96, opt.dpi150, opt.dpi220, opt.fmtJpg, opt.fmtPng, opt.skip, opt.styleNeg, opt.styleInk, opt.stylePure, opt.styleVec, opt.keepColour].forEach(function (el) {
    if (el) el.addEventListener('change', schedulePreview);
  });
  [opt.styleNeg, opt.styleInk, opt.stylePure, opt.styleVec].forEach(function (el) {
    if (el) el.addEventListener('change', function () { syncKeepColourRow(); syncVectorRows(); });
  });
  syncKeepColourRow();
  syncVectorRows();

  function resetAll() {
    state.bytes = null; state.doc = null; state.pages = 0; state.sizes = [];
    if (state.out.url && !sessReady()) { URL.revokeObjectURL(state.out.url); state.out.url = ''; }
    if (sessReady()) { NotesSession.clearFiles(); NotesSession.clearResult(); NotesSession.runClear(); }
    if (sessBar) sessBar.hidden = true;
    fileInput.value = '';
    wb.hidden = true; dz.hidden = false; result.hidden = true; pBox.hidden = true; clearError();
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('resetBtn').addEventListener('click', resetAll);
  $('againBtn').addEventListener('click', resetAll);

  /* ---------- boot: pull back whatever the last session left in this browser ---------- */
  (async function bootSession() {
    if (!window.NotesSession) return;
    try { await NotesSession.init(); } catch (e) { return; }
    if (!sessReady()) return;
    if (sessGo) sessGo.addEventListener('click', function () { sessGo.hidden = true; convert(); });
    var forget = $('sessForget');
    if (forget) forget.addEventListener('click', function () { sessKill(); if (window.NotesFX) NotesFX.toast('This browser no longer keeps anything'); });
    NotesSession.autoSaveOpts($('workbench'), SESS_SEL);
    var savedOpts = await NotesSession.loadOpts();
    if (savedOpts && NotesSession.apply(savedOpts, NotesSession.collect(SESS_SEL))) syncAfterRestore();
    var files = await NotesSession.loadFiles();
    var meta = await NotesSession.loadResultMeta();
    if (!files.length) {
      if (meta) sessNote('Your last result (' + fmtMB(meta.size) + ') is still saved here — pick the PDF again to re-flip, or Forget to wipe it.', false);
      return;
    }
    restoring = true;
    await loadFile(NotesSession.toFile(files[0]));
    restoring = false;
    if (meta) await restoreResult(meta);
    var run = await NotesSession.runLoad();
    if (run && run.phase !== 'done' && run.pages) {
      var st = await NotesSession.pageStats();
      sessNote('Your last run stopped at page ' + run.page + ' of ' + run.pages + ' — press Continue and it carries on from there' +
        (st.count ? ' (' + st.count + ' page' + (st.count === 1 ? '' : 's') + ' already flipped are reused)' : '') + '.', true);
    } else if (meta) {
      sessNote('Restored — file, settings and your last result are all back. Reload-safe.');
    } else {
      sessNote('Restored — file and settings are back. Reload-safe.');
    }
    if (window.NotesFX) NotesFX.toast('Session restored from this browser');
  })();

  /* ---------- scroll reveal ---------- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.18 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
