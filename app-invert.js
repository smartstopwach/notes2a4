/* ============ Notes2A4 · Invert Lab — 1:1 PDF colour inversion ============
   Standalone app: does NOT touch NotesConverter. Renders each page with
   pdf.js, flips every channel (255 − v), writes a same-size page into a new
   pdf-lib document. Everything stays in this tab. */
(function () {
  'use strict';

  var BUILD = 1;
  console.info('[Notes2A4] app-invert.js build', BUILD, '· 1:1 colour flip');
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
    fmtJpg: $('fmtJpg'), fmtPng: $('fmtPng'), skip: $('optSkip')
  };

  function dpi() { return opt.dpi220.checked ? 220 : (opt.dpi150.checked ? 150 : 96); }
  function fmt() { return opt.fmtPng.checked ? 'png' : 'jpeg'; }
  function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function showError(m) { fileErr.hidden = false; fileErr.textContent = m; }
  function clearError() { fileErr.hidden = true; fileErr.textContent = ''; }

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
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

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
      afterLoad();
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
      invertPixels(id, true);
      x2.putImageData(id, 0, 0);
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
    var blank = invertPixels(idat, true);
    cx.putImageData(idat, 0, 0);
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var ox = out.getContext('2d');
    ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
    ox.drawImage(cv, 0, 0, W, H);
    cv.width = cv.height = 0;                        // release big buffer early
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
    try {
      var outDoc = await PDFLibns.PDFDocument.create();
      var skipped = 0;
      for (var i = 1; i <= n; i++) {
        var r = await rasterInverted(i);
        var bytes = await canvasBytes(r.canvas);
        var img = (fmt() === 'png') ? await outDoc.embedPng(bytes) : await outDoc.embedJpg(bytes);
        var size = state.sizes[i - 1];
        var outPg = outDoc.addPage([size.w, size.h]);
        if (skip && r.blank) {          // blank page stays white: embed the un-inverted look (white sheet)
          var white = document.createElement('canvas'); white.width = 2; white.height = 2;
          var wx = white.getContext('2d'); wx.fillStyle = '#fff'; wx.fillRect(0, 0, 2, 2);
          img = (fmt() === 'png') ? await outDoc.embedPng(await canvasBytes(white)) : await outDoc.embedJpg(await canvasBytes(white));
          skipped++;
        }
        outPg.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h });
        r.canvas.width = r.canvas.height = 0;
        pFill.style.width = (4 + i / n * 90).toFixed(1) + '%';
        pStatus.textContent = 'page ' + i + ' of ' + n + ' · ' + (fmt() === 'png' ? 'png' : 'jpeg') + ' ' + Math.round(dpi()) + ' dpi' + (r.blank && skip ? ' · blank kept white' : '');
        await new Promise(function (res) { setTimeout(res, 0); });   // keep the UI alive
      }
      pStatus.textContent = 'writing file…';
      var saved = await outDoc.save({ useObjectStreams: true });
      pFill.style.width = '100%'; pStatus.textContent = 'done';
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([saved], { type: 'application/pdf' }));

      var base = state.name.replace(/\.pdf$/i, '');
      var dl = $('dlBtn');
      dl.href = state.out.url; dl.download = base + '-inverted.pdf';
      $('openBtn').href = state.out.url;

      $('rsIn').textContent = n;
      $('rsOut').textContent = n;
      $('rsMeta').textContent =
        n + (n === 1 ? ' page' : ' pages') + ' inverted 1:1 · sizes unchanged · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(saved.length) + ' · ' + dpi() + ' dpi ' + (fmt() === 'png' ? 'PNG' : 'JPEG') +
        (skipped ? ' · ' + skipped + ' blank page' + (skipped === 1 ? '' : 's') + ' kept white' : '') + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device';

      await makeThumbs(saved, n);
      result.hidden = false;
      if (prevCard) prevCard.classList.remove('busy');
      if (window.NotesFX) NotesFX.toast(n + ' pages flipped · sizes identical · still on-device');
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
    } catch (err) {
      pStatus.textContent = 'failed: ' + (err && err.message || err);
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
  [opt.dpi96, opt.dpi150, opt.dpi220, opt.fmtJpg, opt.fmtPng, opt.skip].forEach(function (el) {
    el.addEventListener('change', schedulePreview);
  });

  function resetAll() {
    state.bytes = null; state.doc = null; state.pages = 0; state.sizes = [];
    if (state.out.url) { URL.revokeObjectURL(state.out.url); state.out.url = ''; }
    fileInput.value = '';
    wb.hidden = true; dz.hidden = false; result.hidden = true; pBox.hidden = true; clearError();
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('resetBtn').addEventListener('click', resetAll);
  $('againBtn').addEventListener('click', resetAll);

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
