/* ============ Notes2A4 · Invert Lab — 1:1 PDF colour inversion ============
   Standalone app: does NOT touch NotesConverter. Renders each page with
   pdf.js, flips every channel (255 − v), writes a same-size page into a new
   pdf-lib document. Everything stays in this tab. */
(function () {
  'use strict';

  var BUILD = 3;
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
    styleNeg: $('styleNeg'), styleInk: $('styleInk'), stylePure: $('stylePure'),
    keepColour: $('optKeepColour'), keepColourRow: $('keepColourRow')
  };

  function dpi() { return opt.dpi220.checked ? 220 : (opt.dpi150.checked ? 150 : 96); }
  function fmt() { return opt.fmtPng.checked ? 'png' : 'jpeg'; }
  function inkMode() { return (opt.styleInk.checked || (opt.stylePure && opt.stylePure.checked)) && window.NotesConverter && NotesConverter.printSaver; }
  function pureMode() { return !!(opt.stylePure && opt.stylePure.checked); }
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
  function styleName() { return pureMode() ? 'pure b&w' : (inkMode() ? 'black ink' : 'true negative'); }
  function invSig() {
    return [Math.round(dpi()), fmt(), styleName(), keepColour() ? 1 : 0, opt.skip.checked ? 1 : 0].join('|');
  }
  function syncAfterRestore() { if (opt.keepColourRow) syncKeepColourRow(); }
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

  async function renderPreview() {
    if (!state.doc) return;
    var gen = ++state.gen;
    var figures = document.querySelectorAll('.sheet-fig');
    var f1 = figures[0], f2 = figures[1];
    f1.hidden = f2.hidden = false;
    f1.classList.add('loading'); f2.classList.add('loading');
    try {
      var vp = (await state.doc.getPage(1)).getViewport({ scale: 1 });
      var sc = 320 / Math.max(1, vp.width);
      var c1 = $('pv1');
      await renderPageScaled(1, sc, c1);
      if (gen !== state.gen) return;
      var c2 = $('pv2');
      c2.width = c1.width; c2.height = c1.height;
      var x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.drawImage(c1, 0, 0);
      var id = x2.getImageData(0, 0, c2.width, c2.height);
      if (inkMode()) {
        var hm = NotesConverter.printSaver.hqMap(id, c2.width, c2.height, true, keepColour(), pureMode());
        x2.putImageData(new ImageData(hm.imageData.data, c2.width, c2.height), 0, 0);
      } else {
        invertPixels(id, true);
        x2.putImageData(id, 0, 0);
      }
      (await state.doc.getPage(1)).cleanup();
    } finally {
      f1.classList.remove('loading'); f2.classList.remove('loading');
    }
  }

  /* ---------- per-page raster + invert (same SSAA guard as the print engine) ---------- */
  async function rasterInverted(pgNum) {
    var pg = await state.doc.getPage(pgNum);
    var vp1 = pg.getViewport({ scale: 1 });
    var outSc = dpi() / 72;
    var bigW = Math.round(vp1.width * outSc * 2), bigH = Math.round(vp1.height * outSc * 2);
    var ss = (bigW * bigH <= 34000000 && bigW <= 16000 && bigH <= 16000) ? 2 : 1;   // 2× supersample → area-averaged down
    var W = Math.max(2, Math.round(vp1.width * outSc)), H = Math.max(2, Math.round(vp1.height * outSc));
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(vp1.width * outSc * ss));
    cv.height = Math.max(2, Math.round(vp1.height * outSc * ss));
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: cx, viewport: pg.getViewport({ scale: outSc * ss }) }).promise;
    pg.cleanup();
    var idat = cx.getImageData(0, 0, cv.width, cv.height);
    var blank = invertPixels(idat, false);            // scan-only: is the page pure white?
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    if (inkMode()) {                                  // same ink-bias mapping the Print-Saver engine uses
      var hm = NotesConverter.printSaver.hqMap(idat, W, H, true, keepColour(), pureMode());
      out.getContext('2d').putImageData(new ImageData(hm.imageData.data, W, H), 0, 0);
    } else {
      invertPixels(idat, true);                       // true negative — colours included
      cx.putImageData(idat, 0, 0);
      var ox = out.getContext('2d');
      ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
      ox.drawImage(cv, 0, 0, W, H);
    }
    cv.width = cv.height = 0;                          // release big buffer early
    return { canvas: out, blank: blank };
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
    goBtn.disabled = true; result.hidden = true;
    pBox.hidden = false; pFill.style.width = '2%'; pStatus.textContent = 'measuring pages…';
    var prevCard = document.querySelector('.card.prev');
    if (prevCard) prevCard.classList.add('busy');
    var t0 = performance.now();
    var skip = opt.skip.checked, n = state.pages;
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
          r = await rasterInverted(i);
          bytes = await canvasBytes(r.canvas);
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
        if (r) NotesFX.liveShow(r.canvas, 'page ' + i + ' / ' + n + ' · ' + styleName() + (blank && skip ? ' · blank' : ''));
        if (r) { r.canvas.width = r.canvas.height = 0; }
        pFill.style.width = (4 + i / n * 90).toFixed(1) + '%';
        pStatus.textContent = 'page ' + i + ' of ' + n + ' · ' + styleName() + ' · ' + (fmt() === 'png' ? 'png' : 'jpeg') + ' ' + Math.round(dpi()) + ' dpi' +
          (r ? (blank && skip ? ' · blank kept white' : '') : ' · from checkpoint');
        NotesFX.titleProgress(i, n);
        await NotesFX.uiYield();                                      // throttle-proof: full speed in background tabs
      }
      state.reusedPages = reused;
      pStatus.textContent = 'writing file…';
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

      await makeThumbs(saved, n);
      if (sessReady()) {
        NotesSession.saveResult({
          bytes: saved, name: dl.download, kind: inkMode() ? 'ink' : 'negative',
          info: { in: n, out: n, meta: $('rsMeta').textContent }
        });
        NotesSession.runClear();
        sessNote('Saved · ' + n + ' page' + (n === 1 ? '' : 's') + ' flipped — reloading keeps this result and the download link.');
      }
      result.hidden = false;
      if (prevCard) prevCard.classList.remove('busy');
      if (window.NotesFX) NotesFX.toast(n + ' pages flipped · sizes identical · still on-device');
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
    } catch (err) {
      pStatus.textContent = 'failed: ' + (err && err.message || err);
      NotesFX.titleDone(false); NotesFX.liveDone();
      if (prevCard) prevCard.classList.remove('busy');
      console.error(err);
    }
    goBtn.disabled = false;
  }

  /* ---------- thumbs of the OUTPUT pdf ---------- */
  async function makeThumbs(bytes, n) {
    thumbs.innerHTML = '';
    if (state.out.doc) { try { state.out.doc.destroy(); } catch (e) {} }
    var doc = state.out.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(0) }).promise;
    var show = Math.min(n, 6);
    for (var i = 1; i <= show; i++) {
      var pg = await doc.getPage(i);
      var w0 = pg.getViewport({ scale: 1 }).width;
      var vp = pg.getViewport({ scale: 170 / w0 });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      var img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.alt = 'Inverted page ' + i + ' preview';
      thumbs.appendChild(img);
      pg.cleanup();
    }
    if (n > show) {
      var more = document.createElement('p');
      more.style.cssText = 'color:var(--faint);font-size:.78rem;grid-column:1/-1';
      more.textContent = '+ ' + (n - show) + ' more pages in the downloaded PDF';
      thumbs.appendChild(more);
    }
  }

  /* ---------- options + reset ---------- */
  [opt.dpi96, opt.dpi150, opt.dpi220, opt.fmtJpg, opt.fmtPng, opt.skip, opt.styleNeg, opt.styleInk, opt.stylePure, opt.keepColour].forEach(function (el) {
    if (el) el.addEventListener('change', schedulePreview);
  });
  [opt.styleNeg, opt.styleInk, opt.stylePure].forEach(function (el) { if (el) el.addEventListener('change', syncKeepColourRow); });
  syncKeepColourRow();

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
