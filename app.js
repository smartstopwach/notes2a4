/* ============ Notes2A4 — app frontend ============ */
(function () {
  'use strict';

  // Build stamp: confirm in DevTools console that no stale cached app.js is running.
  var BUILD = 4;
  console.info('[Notes2A4] app.js build', BUILD, '· 2-up A4 packer (demo layout)');
  if (typeof NotesConverter === 'undefined' || !NotesConverter.sheetLayout) {
    document.addEventListener('DOMContentLoaded', function () {
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:99;background:#7f1d1d;color:#fecaca;padding:.7rem 1.1rem;border-radius:12px;font:600 .9rem system-ui;border:1px solid #b91c1c';
      bar.textContent = '⚠️ Stale cache detected — press Ctrl+Shift+R (hard refresh).';
      document.body.appendChild(bar);
    });
  }

  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var $ = function (id) { return document.getElementById(id); };
  var MM = NotesConverter.PT_PER_MM;

  var state = {
    bytes: null, name: '', doc: null,        // pdf.js source doc
    sizes: [], pages: 0,
    out: { bytes: null, doc: null, url: '' },
    gen: 0
  };

  /* ---------- element refs ---------- */
  var dz = $('dropzone'), fileInput = $('fileInput'), fileErr = $('fileError');
  var wb = $('workbench'), result = $('result'), thumbs = $('thumbs');
  var goBtn = $('goBtn'), pBox = $('progressBox'), pFill = $('pfill'), pStatus = $('pstatus');
  var opt = {
    paper: $('optPaper'), margin: $('optMargin'),
    gapAuto: $('gapAuto'), gapFixed: $('gapFixed'), gap: $('optGap'),
    lines: $('optLines'), nums: $('optNums')
  };

  /* ---------- helpers ---------- */
  function readOptions() {
    return NotesConverter.normalize({
      paper: opt.paper.value,
      margin: parseFloat(opt.margin.value) * MM,
      gapMode: opt.gapFixed.checked ? 'fixed' : 'auto',
      gap: parseFloat(opt.gap.value) * MM,
      lines: opt.lines.checked,
      pageNumbers: opt.nums.checked
    });
  }

  var printEls = { on: $('optPrint'), auto: $('optAutoInv'), opts: $('psOpts'), d96: $('dpi96'), d150: $('dpi150'), d220: $('dpi220') };
  function printMode() { return !!(printEls.on && printEls.on.checked); }
  function printDpi() { return printEls.d220 && printEls.d220.checked ? 220 : (printEls.d96 && printEls.d96.checked ? 96 : 150); }
  function printAuto() { return printEls.auto.checked; }
  function refreshPrintBadge() {
    var el = $('fbOut'); if (!el) return;
    var t = el.textContent.replace(' · ☾print', '');
    if (printMode()) el.textContent = t + ' · ☾print';
  }
  function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function showError(msg) {
    fileErr.hidden = false; fileErr.textContent = msg;
  }
  function clearError() { fileErr.hidden = true; }

  /* ---------- file intake ---------- */
  $('chooseBtn').addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
  dz.addEventListener('click', function (e) { if (e.target.tagName !== 'BUTTON') fileInput.click(); });
  dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  async function handleFile(file) {
    clearError();
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      showError('That doesn\u2019t look like a PDF — please drop a .pdf file.'); return;
    }
    if (file.size > 400 * 1048576) {
      showError('File is over 400 MB — your browser tab may struggle. Try splitting it first.'); return;
    }
    pStatus.textContent = 'reading…'; pBox.hidden = false; pFill.style.width = '20%';
    var buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length < 5 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== '%PDF') {
      pBox.hidden = true; showError('Invalid or corrupted PDF.'); return;
    }
    try {
      var doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      if (state.doc) state.doc.destroy();
      state.bytes = buf; state.name = file.name; state.doc = doc; state.pages = doc.numPages;
      state.sizes = [];
      for (var i = 1; i <= doc.numPages; i++) {
        var pg = await doc.getPage(i);
        var v = pg.getViewport({ scale: 1 });
        state.sizes.push({ w: v.width, h: v.height });
        pg.cleanup();
      }
      pBox.hidden = true;
      afterLoad();
    } catch (err) {
      pBox.hidden = true;
      showError('Could not open this PDF (' + (err && err.message || 'password-protected or damaged') + ').');
    }
  }

  function afterLoad() {
    dz.hidden = true; wb.hidden = false; result.hidden = true;
    var n = state.pages, sheets = Math.ceil(n / 2);
    $('fbName').textContent = state.name;
    $('fbPages').textContent = n + (n === 1 ? ' page' : ' pages');
    var w9 = 16 / 9, tol = 0.07, allWide = true, anyWide = false;
    state.sizes.forEach(function (s) {
      var ar = s.w / s.h;
      if (Math.abs(ar - w9) / w9 <= tol) anyWide = true; else allWide = false;
    });
    $('fbRatio').textContent = allWide ? '16:9 ✓' : (anyWide ? 'mixed aspects — auto-fit' : 'auto-fit');
    $('fbOut').textContent = '→ ' + sheets + ' sheet' + (sheets === 1 ? '' : 's') + ' (−' + Math.round((1 - sheets / n) * 100) + '%)';
    $('fbOdd').hidden = n % 2 === 0;
    $('goIn').textContent = n; $('goOut').textContent = sheets;
    goBtn.disabled = false;
    refreshPrintBadge();
    renderPreview();
    wb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- options wiring ---------- */
  var pvTimer = null;
  function schedulePreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(renderPreview, 120);
    updateGapLabel();
    var n = state.pages;
    $('fbOut').textContent = '→ ' + Math.ceil(n / 2) + ' sheets (−' + Math.round((1 - Math.ceil(n / 2) / n) * 100) + '%)';
  }
  function updateGapLabel() {
    $('vMargin').textContent = parseFloat(opt.margin.value) + ' mm';
    if (opt.gapFixed.checked) {
      $('vGap').textContent = 'Custom: ' + parseFloat(opt.gap.value) + ' mm of white space between the two slides.';
    } else {
      $('vGap').textContent = 'Auto: slides stay flush top & bottom, remaining white space lands in the middle.';
    }
  }
  opt.paper.addEventListener('change', schedulePreview);
  opt.margin.addEventListener('input', schedulePreview);
  opt.gap.addEventListener('input', schedulePreview);
  opt.lines.addEventListener('change', schedulePreview);
  opt.nums.addEventListener('change', schedulePreview);
  [opt.gapAuto, opt.gapFixed].forEach(function (r) {
    r.addEventListener('change', function () { opt.gap.disabled = opt.gapAuto.checked; schedulePreview(); });
  });
  printListeners(schedulePreview);

  /* ---------- live preview (same geometry engine as converter) ---------- */
  async function renderPreview() {
    if (!state.doc) return;
    var gen = ++state.gen;
    var opts = readOptions();
    var page = NotesConverter.PAPERS[opts.paper];
    var figures = document.querySelectorAll('.sheet-fig');
    for (var s = 0; s < 2; s++) {
      var fig = figures[s], canvas = $('pv' + (s + 1));
      var aIdx = 2 * s, bIdx = 2 * s + 1;
      if (aIdx >= state.pages) { fig.hidden = true; continue; }
      fig.hidden = false;
      await paintSheetPreview(canvas, page, opts, aIdx, bIdx);
      if (gen !== state.gen) return; // superseded
    }
  }

  async function paintSheetPreview(canvas, page, opts, aIdx, bIdx) {
    var L = NotesConverter.sheetLayout(
      state.sizes[aIdx],
      bIdx < state.pages ? state.sizes[bIdx] : null,
      opts, page
    );
    var cssW = Math.max(240, canvas.parentElement.clientWidth || 300);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var pxPerPt = cssW / page.w;
    canvas.style.width = '100%';
    canvas.style.aspectRatio = page.w + ' / ' + page.h;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * (page.h / page.w) * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cssW, canvas.height / dpr);

    async function slide(pageIdx1, box, quality) {
      if (!box) return;
      var pdfPage = await state.doc.getPage(pageIdx1);
      var vw = pdfPage.getViewport({ scale: 1 }).width;
      var targetPx = Math.max(40, Math.round(box.width * pxPerPt * quality));
      var vp = pdfPage.getViewport({ scale: targetPx / vw });
      var off = document.createElement('canvas');
      off.width = Math.round(vp.width); off.height = Math.round(vp.height);
      await pdfPage.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      pdfPage.cleanup();
      if (printMode()) {
        var octx = off.getContext('2d');
        var idat = octx.getImageData(0, 0, off.width, off.height);
        var hmP = NotesConverter.printSaver.hqMap(idat, idat.width, idat.height, printAuto());
        octx.putImageData(new ImageData(hmP.imageData.data, idat.width, idat.height), 0, 0);
      }
      ctx.drawImage(off,
        box.x * pxPerPt,
        (page.h - box.y - box.height) * pxPerPt,
        box.width * pxPerPt, box.height * pxPerPt
      );
    }
    await slide(aIdx + 1, L.top, 1.5);
    if (bIdx < state.pages) await slide(bIdx + 1, L.bottom, 1.5);

    if (opts.lines) {
      ctx.strokeStyle = '#c3cbd9'; ctx.lineWidth = 0.8;
      for (var i = 0; i < L.lines.length; i++) {
        var yPx = (page.h - L.lines[i]) * pxPerPt;
        var x0 = (L.gap.x + 10) * pxPerPt, x1 = (L.gap.x + L.gap.w - 10) * pxPerPt;
        ctx.beginPath(); ctx.moveTo(x0, yPx); ctx.lineTo(x1, yPx); ctx.stroke();
      }
    }
    if (opts.pageNumbers) {
      var sheets = Math.ceil(state.pages / 2);
      var txt = (aIdx / 2 + 1) + ' / ' + sheets;
      ctx.fillStyle = '#7a869e'; ctx.font = '7px system-ui';
      if (opts.lines) {
        ctx.fillText(txt, (L.gap.x + 10) * pxPerPt, (page.h - L.gap.y - L.gap.h + 12) * pxPerPt + 6);
      } else {
        var tw = ctx.measureText(txt).width;
        ctx.fillText(txt, (cssW - tw) / 2, (page.h - L.gap.y - 5) * pxPerPt - 4);
      }
    }
  }


  /* ---------- print-saver raster path ---------- */
  /* Native pixel density: px-per-pt of the dominant image on a page (0 = vector-ish). */
  async function nativePP(pg) {
    try {
      var ops = await pg.getOperatorList();
      var vp1 = pg.getViewport({ scale: 1 });
      var IM = pdfjsLib.OPS.paintImageXObject, TR = pdfjsLib.OPS.transform;
      var a = 0, best = 0, saw = false;
      for (var i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === TR) { var m = ops.argsArray[i]; if (m) { var mg = Math.hypot(m[0], m[1]); if (mg) a = mg; } }
        else if (ops.fnArray[i] === IM) {
          var A = ops.argsArray[i], iw = 0;
          if (A) {
            var o0 = A[0];
            if (o0 && typeof o0 === 'object') iw = o0.width || (o0.bitmap && o0.bitmap.width) || 0;
            else if (typeof A[1] === 'number') iw = A[1];           // older layout: [objId, w, h]
          }
          if (iw && a > 0) { best = Math.max(best, iw / a); saw = true; }   // px per pt
        }
      }
      return saw ? best : 0;
    } catch (e) { return 0; }
  }

  /* Rasterise a page for print-saver with HQ quality:
     - scans (cap>0): output at cap×tier px/pt (96dpi→1×, 150→2×, 220→3×),
       rendered at 2× that and area-averaged (SSAA) — smooth subpixel edges,
       no bilinear-mush upsampling, canvas kept within memory bounds
     - vector/text pages: full requested dpi, 2× supersampled when it fits
     The map (colours→solid black, dark→white, edges→grey ramp) is
     NotesConverter.printSaver.hqMap — the same function the Node tests run. */
  async function printRasterPage(pg) {
    var dpi = printDpi(), want = dpi / 72;
    var cap = await nativePP(pg);
    var mul = dpi >= 200 ? 3 : (dpi >= 120 ? 2 : 1);
    var vp1 = pg.getViewport({ scale: 1 });
    var outSc = cap > 0 ? Math.min(Math.max(cap, 0.5) * mul, 4) : want;
    var ss = (vp1.width * outSc * 2 <= 7600) ? 2 : 1;
    var outW = pg.getViewport({ scale: outSc });
    var W = Math.max(2, Math.round(outW.width)), H = Math.max(2, Math.round(outW.height));
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(vp1.width * outSc * ss));
    cv.height = Math.max(2, Math.round(vp1.height * outSc * ss));
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: cx, viewport: pg.getViewport({ scale: outSc * ss }) }).promise;
    var idat = cx.getImageData(0, 0, cv.width, cv.height);
    var hm = NotesConverter.printSaver.hqMap(idat, W, H, printAuto());
    var small = document.createElement('canvas');
    small.width = W; small.height = H;
    var sx = small.getContext('2d');
    sx.putImageData(new ImageData(hm.imageData.data, W, H), 0, 0);
    var tag = cap > 0 ? 'HQ ' + mul + '\u00d7 supersampled ' + W + 'px' : 'vector-sharp ' + Math.round(outSc * 72) + ' dpi';
    return { canvas: small, status: tag };
  }

  async function buildPrintItems(onPage) {
    var n = state.pages, items = new Array(n);
    for (var i = 0; i < n; i++) {
      var pg = await state.doc.getPage(i + 1);
      var r = await printRasterPage(pg);
      pg.cleanup();
      items[i] = {
        bytes: await new Promise(function (res2, rej) {
          r.canvas.toBlob(function (bl) { bl.arrayBuffer().then(function (ab) { res2(new Uint8Array(ab)); }, rej); }, 'image/png');
        }),
        w: state.sizes[i].w, h: state.sizes[i].h
      };
      if (onPage) await onPage(i + 1, n, r.status);
    }
    return items;
  }
  function printListeners(schedule) {
    if (!printEls.on) return;
    printEls.on.addEventListener('change', function () { printEls.opts.hidden = !printEls.on.checked; schedule(); refreshPrintBadge(); });
    [printEls.auto, printEls.d96, printEls.d150, printEls.d220].forEach(function (el) { el.addEventListener('change', schedule); });
  }
  /* ---------- convert ---------- */
  goBtn.addEventListener('click', convert);

  async function convert() {
    if (!state.bytes || goBtn.disabled) return;
    goBtn.disabled = true; result.hidden = true;
    pBox.hidden = false; pFill.style.width = '2%'; pStatus.textContent = 'embedding pages…';
    var t0 = performance.now();
    try {
      var res;
      if (printMode()) {
        pStatus.textContent = 'rendering pages…';
        var items = await buildPrintItems(function (d, t, st) {
          pFill.style.width = (d / t * 60).toFixed(1) + '%';
          pStatus.textContent = 'page ' + d + ' of ' + t + ' · binarising ' + (st || 'at ' + printDpi() + ' dpi…');
          return new Promise(function (r) { setTimeout(r, 0); });
        });
        pFill.style.width = '65%'; pStatus.textContent = 'packing sheets…';
        res = await NotesConverter.buildFromImages(items, readOptions(), function (d, t) {
          pFill.style.width = (65 + d / t * 32).toFixed(1) + '%';
          pStatus.textContent = 'sheet ' + d + ' of ' + t + '…';
          return new Promise(function (r) { setTimeout(r, 0); });
        });
      } else {
        res = await NotesConverter.build(state.bytes, readOptions(), function (d, t) {
          pFill.style.width = (6 + d / t * 88).toFixed(1) + '%';
          pStatus.textContent = 'sheet ' + d + ' of ' + t + '…';
          return new Promise(function (r) { setTimeout(r, 0); });
        });
      }
      pFill.style.width = '100%'; pStatus.textContent = 'done';
      state.out.bytes = res.bytes;
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' }));

      var base = state.name.replace(/\.pdf$/i, '');
      var paper = opt.paper.value.toUpperCase();
      var dl = $('dlBtn');
      dl.href = state.out.url; dl.download = base + (printMode() ? '-print' : '') + '-2up-' + paper + '.pdf';
      $('openBtn').href = state.out.url;

      $('rsIn').textContent = res.sourcePages;
      $('rsOut').textContent = res.sheets;
      $('rsMeta').textContent =
        res.sourcePages + (res.sourcePages === 1 ? ' page' : ' pages') + ' packed into ' + res.sheets + ' ' +
        NotesConverter.PAPERS[opt.paper.value].label.split(' (')[0] + ' sheets · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(res.bytes.length) + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device' + (printMode() ? ' · ☾ print-saver ' + printDpi() + ' dpi b&w' : '');

      await makeThumbs(res.bytes, res.sheets);
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
    } catch (err) {
      pStatus.textContent = 'failed: ' + (err && err.message || err);
      console.error(err);
    }
    goBtn.disabled = false;
  }

  async function makeThumbs(bytes, sheets) {
    thumbs.innerHTML = '';
    if (state.out.doc) { try { state.out.doc.destroy(); } catch (e) {} }
    var doc = state.out.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(0) }).promise;
    var show = Math.min(sheets, 6);
    for (var i = 1; i <= show; i++) {
      var pg = await doc.getPage(i);
      var w0 = pg.getViewport({ scale: 1 }).width;
      var vp = pg.getViewport({ scale: 170 / w0 });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      var img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.alt = 'Packed sheet ' + i + ' preview';
      thumbs.appendChild(img);
      pg.cleanup();
    }
    if (sheets > show) {
      var more = document.createElement('p');
      more.style.cssText = 'color:var(--faint);font-size:.78rem;grid-column:1/-1';
      more.textContent = '+ ' + (sheets - show) + ' more sheets in the downloaded PDF';
      thumbs.appendChild(more);
    }
  }

  /* ---------- reset ---------- */
  function resetAll() {
    if (state.out.url) URL.revokeObjectURL(state.out.url);
    state.bytes = null; state.out = { bytes: null, doc: null, url: '' };
    fileInput.value = '';
    wb.hidden = true; dz.hidden = false; result.hidden = true; pBox.hidden = true; clearError();
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('resetBtn').addEventListener('click', resetAll);
  $('againBtn').addEventListener('click', resetAll);

  /* ---------- scroll reveal ---------- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  updateGapLabel();
})();
