/* ============ Notes2A4 — 4-up Studio (landscape, pair columns) ============ */
(function () {
  'use strict';
  var BUILD = 7;
  console.info('[Notes2A4] app4up.js build', BUILD, '· 4-up landscape studio (demo-exact geometry)');
  if (typeof NotesConverter === 'undefined' || !NotesConverter.quadLayout) {
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

  var state = { bytes: null, name: '', doc: null, sizes: [], pages: 0, out: { doc: null, url: '' }, gen: 0 };
  var dz = $('dropzone'), fileInput = $('fileInput'), fileErr = $('fileError');
  var wb = $('workbench'), result = $('result'), thumbs = $('thumbs');
  var goBtn = $('goBtn'), pBox = $('progressBox'), pFill = $('pfill'), pStatus = $('pstatus'),
      pEta = $('pEta');
  var opt = { paper: $('optPaper'), margin: $('optMargin'), gapAuto: $('gapAuto'), gapFixed: $('gapFixed'), gap: $('optGap'), lines: $('optLines'), nums: $('optNums'),
    numOpts: $('numOpts'), numStart: $('numStart'),
    np: { gap: $('npGap'), tl: $('npTL'), tc: $('npTC'), tr: $('npTR'), bl: $('npBL'), bc: $('npBC'), br: $('npBR') },
    nf: { frac: $('nfFrac'), plain: $('nfPlain'), page: $('nfPage'), dash: $('nfDash'), of: $('nfOf') },
    ns: { s: $('nsS'), m: $('nsM'), l: $('nsL') },
    sep: $('optSep') };
  function sepLineVal() { return (opt.sep && opt.sep.checked) ? 'v' : 'off'; }   // the middle line is vertical: top → bottom
  function numPosVal() { var p = opt.np; for (var k in p) if (p[k] && p[k].checked) return k; return 'gap'; }
  function numFmtVal() { var p = opt.nf; for (var k in p) if (p[k] && p[k].checked) return k; return 'frac'; }
  function numSizeVal() { return opt.ns.l && opt.ns.l.checked ? 11 : (opt.ns.s && opt.ns.s.checked ? 6.5 : 8); }

  function readOptions() {
    return NotesConverter.normalize({
      perSheet: 4,
      paper: opt.paper.value,
      margin: parseFloat(opt.margin.value) * MM,
      gapMode: opt.gapFixed.checked ? 'fixed' : 'auto',
      gap: parseFloat(opt.gap.value) * MM,
      lines: opt.lines.checked,
      pageNumbers: opt.nums.checked,
      sepLine: sepLineVal(),
      numPos: numPosVal(), numFmt: numFmtVal(),
      numStart: parseInt(opt.numStart.value, 10) || 1, numSize: numSizeVal()
    });
  }
  var printEls = { on: $('optPrint'), auto: $('optAutoInv'), opts: $('psOpts'), d96: $('dpi96'), d150: $('dpi150'), d220: $('dpi220'), sInk: $('psInk'), sPure: $('psPure'), sKeep: $('psKeep'), sNeg: $('psNeg') };
  function printMode() { return !!(printEls.on && printEls.on.checked); }
  function printDpi() { return printEls.d220 && printEls.d220.checked ? 220 : (printEls.d96 && printEls.d96.checked ? 96 : 150); }
  function printAuto() { return printEls.auto.checked; }
  function printStyle() {
    if (printEls.sNeg && printEls.sNeg.checked) return 'neg';
    if (printEls.sKeep && printEls.sKeep.checked) return 'keep';
    if (printEls.sPure && printEls.sPure.checked) return 'pure';
    return 'ink';
  }
  /* Keep-colours checkbox — part of the run signature, so an interrupted
     Print-Saver run is only resumed when the colour rule is unchanged too. */
  function printKeepColour() { return !!(printEls.sKeep && printEls.sKeep.checked); }
  /* One entry point for all three colour styles: ink / keep / neg (true negative). */
  /* The map is fed one band of the supersampled canvas at a time, and every band
     hands control back to the browser — this is what keeps the tab responsive
     while a 33-page print-saver run is binarising pages. Same maths, same output
     (the Node tests compare the banded result with the one-shot result byte for
     byte). */
  async function printMapAsync(provider, bw, bh, W, H, hooks) {
    var st = printStyle();
    if (st === 'neg') return NotesConverter.printSaver.negMapAsync(provider, bw, bh, W, H, printAuto(), hooks);
    return NotesConverter.printSaver.hqMapAsync(provider, bw, bh, W, H, printAuto(), st === 'keep', st === 'pure', hooks);
  }
  function refreshPrintBadge() {
    var el = $('fbOut'); if (!el) return;
    var t = el.textContent.replace(' · ◐print', '');
    if (printMode()) el.textContent = t + ' · ◐print';
  }
  function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function showError(m) { fileErr.hidden = false; fileErr.textContent = m; }
  function clearError() { fileErr.hidden = true; }

  /* ---------- reload-proof session: source + options + result + checkpoints ---------- */
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
  function printSig() {
    return [printDpi(), printStyle(), printAuto() ? 1 : 0, printKeepColour() ? 1 : 0].join('|');
  }
  function syncAfterRestore() {
    if (opt.gap) opt.gap.disabled = opt.gapAuto.checked;
    if (printEls.opts && printEls.on) printEls.opts.hidden = !printEls.on.checked;
    if (opt.numOpts && opt.nums) opt.numOpts.hidden = !opt.nums.checked;
    if (opt.margin) opt.margin.dispatchEvent(new Event('input'));
  }
  async function restoreResult(meta) {
    var url = await NotesSession.resultUrl();
    if (!url) return;
    state.out.url = url;
    var dl = $('dlBtn');
    dl.href = url; dl.download = meta.name;
    $('openBtn').href = url;
    if (meta.info) {
      $('rsIn').textContent = meta.info.in;
      $('rsOut').textContent = meta.info.out;
      $('rsMeta').textContent = meta.info.meta + ' · restored from this browser, no re-conversion needed';
    } else {
      $('rsMeta').textContent = 'Saved result — ' + fmtMB(meta.size) + ' PDF restored from this browser.';
    }
    result.hidden = false;
    if (meta.size <= (NotesSession.THUMB_LIMIT || 96 * 1048576) && meta.info && meta.info.out) {
      try { await makeThumbs(await NotesSession.resultBytes(), meta.info.out); } catch (e) {}
    }
  }

  /* ---------- intake ---------- */
  $('chooseBtn').addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
  dz.addEventListener('click', function (e) { if (e.target.tagName !== 'BUTTON') fileInput.click(); });
  dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragover', 'dragenter'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
  dz.addEventListener('drop', function (e) { var fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) handleFiles(fs); });
  fileInput.addEventListener('change', function () { if (fileInput.files.length) handleFiles(fileInput.files); });

  /* Accept one PDF — or several: they are merged in order, then loaded as one. */
  async function handleFiles(files) {
    if (files.length === 1) return handleFile(files[0]);
    clearError();
    var ordered = await NotesFX.orderPdfs(files);      // arrange up/down before merging
    if (!ordered) return;                              // cancelled
    if (ordered.length === 1) return handleFile(ordered[0]);
    pBox.hidden = false; pFill.style.width = '10%';
    try {
      var m = await NotesFX.mergePdfs(ordered, function (d, t, nm) {
        pFill.style.width = (10 + d / t * 80).toFixed(0) + '%';
        pStatus.textContent = 'merging ' + d + ' of ' + t + ' \u00b7 ' + nm;
      });
      await handleFile(m.file);
    } catch (err) {
      pBox.hidden = true;
      showError('Could not merge PDFs (' + (err && err.message || err) + ').');
    }
  }

  async function handleFile(file) {
    clearError();
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { showError('That doesn’t look like a PDF — please drop a .pdf file.'); return; }
    if (file.size > 400 * 1048576) { showError('File is over 400 MB — your browser tab may struggle. Try splitting it first.'); return; }
    pBox.hidden = false; pFill.style.width = '20%'; pStatus.textContent = 'reading…';
    var buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length < 5 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== '%PDF') { pBox.hidden = true; showError('Invalid or corrupted PDF.'); return; }
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
      if (window.PageReview) PageReview.setSource(buf, file.name);
      afterLoad();
      if (sessReady() && !restoring) {
        NotesSession.saveFiles([{ name: state.name, bytes: state.bytes }]);
        NotesSession.runClear();
        sessNote('Saved in this browser — reload, close or crash, this file and your settings stay.');
      }
      if (window.NotesFX) NotesFX.toast(state.pages + ' pages parsed — nothing was uploaded');
    } catch (err) {
      pBox.hidden = true;
      showError('Could not open this PDF (' + (err && err.message || 'password-protected or damaged') + ').');
    }
  }

  function afterLoad() {
    dz.hidden = true; wb.hidden = false; result.hidden = true;
    $('fbName').textContent = state.name;
    $('fbPages').textContent = state.pages + (state.pages === 1 ? ' page' : ' pages');
    var w9 = 16 / 9, tol = 0.07, allWide = true, anyWide = false;
    state.sizes.forEach(function (s) {
      var ar = s.w / s.h;
      if (Math.abs(ar - w9) / w9 <= tol) anyWide = true; else allWide = false;
    });
    $('fbRatio').textContent = allWide ? '16:9 ✓' : (anyWide ? 'mixed aspects — auto-fit' : 'auto-fit');
    updateModeUI();
    renderPreview();
    wb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateModeUI() {
    var n = state.pages, sheets = n ? Math.ceil(n / 4) : 0;
    $('fbOut').textContent = n ? '→ ' + sheets + ' landscape sheet' + (sheets === 1 ? '' : 's') + ' (−' + Math.round((1 - sheets / n) * 100) + '%)' : '→ — sheets';
    $('fbPartial').hidden = !n || n % 4 === 0;
    $('goIn').textContent = n || '—';
    $('goOut').textContent = sheets || '—';
    $('vMargin').textContent = parseFloat(opt.margin.value) + ' mm';
    $('vGap').textContent = opt.gapFixed.checked
      ? 'Custom: ' + parseFloat(opt.gap.value) + ' mm band between the rows (block centred).'
      : 'Auto: rows pinned to top & bottom edges — leftover band lands in the middle, shared by both columns.';
    goBtn.disabled = false;
    refreshPrintBadge();
  }

  var pvTimer = null;
  function schedule() { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 120); updateModeUI(); }
  [opt.paper, opt.margin, opt.gap, opt.lines, opt.nums, opt.gapAuto, opt.gapFixed].forEach(function (el) {
    el.addEventListener(el.type === 'radio' || el.type === 'checkbox' ? 'change' : 'input', schedule);
  });
    // numbering options: reveal panel with the checkbox, refresh preview on any change
  function sepListeners(sched) { if (opt.sep) opt.sep.addEventListener('change', sched); }
  function numListeners(sched) {
    if (!opt.numOpts) return;
    opt.nums.addEventListener('change', function () { opt.numOpts.hidden = !opt.nums.checked; });
    opt.numOpts.hidden = !opt.nums.checked;
    var els = [opt.numStart];
    for (var k in opt.np) els.push(opt.np[k]);
    for (var k2 in opt.nf) els.push(opt.nf[k2]);
    for (var k3 in opt.ns) els.push(opt.ns[k3]);
    els.forEach(function (el) { if (el) el.addEventListener('change', sched); });
    if (opt.numStart) opt.numStart.addEventListener('input', sched);
  }
  printListeners(schedule);
  numListeners(schedule);
  sepListeners(schedule);

  /* ---------- live preview (same engine as the final PDF) ---------- */
  async function renderPreview() {
    if (!state.doc) return;
    var gen = ++state.gen;
    var opts = readOptions();
    var page = NotesConverter.sheetSize(opts);
    var figures = document.querySelectorAll('.sheet-fig');
    for (var s = 0; s < 2; s++) {
      var fig = figures[s], canvas = $('pv' + (s + 1));
      if (s * 4 >= state.pages) { fig.hidden = true; fig.classList.remove('loading'); continue; }
      fig.hidden = false; fig.classList.add('loading');
      fig.style.cursor = 'zoom-in';
      await paintSheet(canvas, page, opts, s);
      fig.classList.remove('loading');
      wireZoom();
      if (gen !== state.gen) return;
    }
    renderSheetStrip(gen);                       // then every sheet, small, in the background
  }

  /* ---------- every sheet as a small tile ----------
     The preview column used to be one tall empty card (the options column is much
     longer), which looked broken. It now shows all sheets: tiny, in order, drawn
     one at a time so the UI stays free, and cancelled the moment anything changes. */

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
  async function renderSheetStrip(gen) {
    var host = $('prevStrip');
    if (!host || !state.doc) return;
    var my = ++stripToken;
    var total = Math.ceil(state.pages / 4);
    var show = Math.min(total, 24);
    var opts = readOptions(), page = NotesConverter.sheetSize(opts);
    var strip = (window.NotesFX && NotesFX.thumbStrip)
      ? NotesFX.thumbStrip(host, show, 'drawing all ' + total + ' sheet' + (total === 1 ? '' : 's') + '…')
      : null;
    for (var s = 0; s < show; s++) {
      if (my !== stripToken || gen !== state.gen) return;                     // changed under us
      if (document.hidden) {                                                  // tab in the background: no point
        if (strip) strip.prune('previews paused \u2014 they finish when you come back to this tab');
        NotesFX.whenVisible().then(function () { if (my === stripToken) renderStripAgain(); });
        return;
      }
      if (goBtn.disabled || state.running) {                                  // a run has started: stop cleanly
        if (strip) strip.prune('previews paused while the PDF is being made \— they come back when it finishes');
        state.stripPaused = true;
        return;
      }
      var fig = document.createElement('figure');
      var cv = document.createElement('canvas');
      var cap = document.createElement('figcaption');
      var first = s * 4 + 1, last = Math.min(state.pages, s * 4 + 4);
      cap.textContent = 'sheet ' + (s + 1) + ' · ' + (first === last ? 'page ' + first : 'pages ' + first + '–' + last);
      fig.appendChild(cv); fig.appendChild(cap);
      await paintSheet(cv, page, opts, s, 168);
      if (my !== stripToken || gen !== state.gen) return;
      if (strip) strip.place(fig, s);
      await NotesFX.uiYield();
    }
    if (strip) strip.note(total + ' sheet' + (total === 1 ? '' : 's') + ' in the finished PDF' +
      (total > show ? ' · first ' + show + ' shown' : '') + ' · click a big preview to enlarge');
  }

  /* Click a preview sheet → HD view rendered by the same engine as the PDF. */
  function wireZoom() {
    var figs = document.querySelectorAll('.sheet-fig');
    figs.forEach(function (fig, sIdx) {
      if (fig.dataset.zoomWired) return;
      fig.dataset.zoomWired = '1';
      fig.style.cursor = 'zoom-in';
      fig.title = 'Click for an HD look at this sheet';
      var hint = document.createElement('span');
      hint.className = 'zoom-hint'; hint.textContent = '\u2922 click to enlarge';
      fig.appendChild(hint);
      fig.addEventListener('click', function () {
        if (!state.doc || sIdx * 4 >= state.pages) return;
        var opts = readOptions();
        var page = NotesConverter.sheetSize(opts);
        var base = sIdx * 4, ids = [];
        for (var c = 0; c < 4 && base + c < state.pages; c++) ids.push(base + c);
        NotesFX.zoomSheet({
          aspect: page.w / page.h,
          caption: 'sheet ' + (sIdx + 1) + ' \u00b7 pages ' + (base + 1) + '\u2013' + (base + ids.length) +
            ' \u00b7 HD render, same engine as the PDF' + (printMode() ? ' \u00b7 ' + printDpi() + ' dpi b&w' : ''),
          render: function (cv) { return paintSheet(cv, page, opts, sIdx, cv.parentElement.clientWidth || 1200); }
        });
      });
    });
  }

  async function paintSheet(canvas, page, opts, sIdx, cssWOverride) {
    var base = sIdx * 4, idxs = [];
    for (var c = 0; c < 4 && base + c < state.pages; c++) idxs.push(base + c);
    var L = NotesConverter.quadLayout(idxs.map(function (i) { return state.sizes[i]; }), opts, page);

    var cssW = cssWOverride || Math.max(260, canvas.parentElement.clientWidth || 320);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var pxPerPt = cssW / page.w;
    canvas.style.width = '100%';
    canvas.style.aspectRatio = page.w + ' / ' + page.h;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * (page.h / page.w) * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cssW, canvas.height / dpr);

    async function slide(pageIdx1, box) {
      if (!box) return;
      var pdfPage = await state.doc.getPage(pageIdx1);
      var vw = pdfPage.getViewport({ scale: 1 }).width;
      // device-pixel target: ignoring dpr here made every 4-up panel upscaled (blurry)
      var vp = pdfPage.getViewport({ scale: Math.max(40, box.width * pxPerPt * dpr) / vw });
      var off = document.createElement('canvas');
      off.width = Math.round(vp.width); off.height = Math.round(vp.height);
      await pdfPage.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      pdfPage.cleanup();
      if (printMode()) {
        var octx = off.getContext('2d');
        var hmP = await printMapAsync(
          function (y0, rows) { return octx.getImageData(0, y0, off.width, rows); },
          off.width, off.height, off.width, off.height,
          { band: 192, progress: function () { return NotesFX.uiPaint(); } });
        octx.putImageData(new ImageData(hmP.imageData.data, off.width, off.height), 0, 0);
      }
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, box.x * pxPerPt, (page.h - box.y - box.height) * pxPerPt, box.width * pxPerPt, box.height * pxPerPt);
    }
    for (var ci = 0; ci < idxs.length; ci++) await slide(idxs[ci] + 1, L.slides[ci]);

    if (opts.lines) {
      ctx.strokeStyle = '#c3cbd9'; ctx.lineWidth = 0.8;
      for (var i = 0; i < L.lines.length; i++) {
        var yPx = (page.h - L.lines[i]) * pxPerPt;
        ctx.beginPath();
        ctx.moveTo((L.gap.x + 10) * pxPerPt, yPx);
        ctx.lineTo((L.gap.x + L.gap.w - 10) * pxPerPt, yPx);
        ctx.stroke();
      }
    }
    var segs = NotesConverter.sepLines(L, opts, page);   // identical helper the PDF build uses
    if (segs.length) {
      ctx.save();
      ctx.setLineDash([0.9 * pxPerPt, 3.2 * pxPerPt]);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 1.1 * pxPerPt);
      for (var gi = 0; gi < segs.length; gi++) {
        ctx.beginPath();
        ctx.moveTo(segs[gi].x1 * pxPerPt, (page.h - segs[gi].y1) * pxPerPt);
        ctx.lineTo(segs[gi].x2 * pxPerPt, (page.h - segs[gi].y2) * pxPerPt);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (opts.pageNumbers && (opts.numPos !== 'gap' || L.gap.h >= 12)) { // mirror of converter build() guard
      var sheets = Math.ceil(state.pages / 4);
      var txt = NotesConverter.numText(sIdx, sheets, opts);
      var fpx = opts.numSize * pxPerPt;
      ctx.fillStyle = '#7a869e'; ctx.font = fpx.toFixed(2) + 'px system-ui';
      var twPt = ctx.measureText(txt).width / pxPerPt;
      var pp = NotesConverter.numPlace(opts.numPos, L, page, twPt, opts.numSize, opts);
      ctx.fillText(txt, pp.x * pxPerPt, (page.h - pp.y) * pxPerPt);
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
  async function printRasterPage(pg, sub) {
    var dpi = printDpi(), want = dpi / 72;
    var cap = await nativePP(pg);
    var mul = dpi >= 200 ? 3 : (dpi >= 120 ? 2 : 1);
    var vp1 = pg.getViewport({ scale: 1 });
    var outSc = cap > 0 ? Math.min(Math.max(cap, 0.5) * mul, 4) : want;
    var lW = Math.round(vp1.width * outSc * 2), lH = Math.round(vp1.height * outSc * 2);
    var ss = (lW * lH <= 34000000 && lW <= 16000 && lH <= 16000) ? 2 : 1;   // area-based: 220 tier keeps SSAA
    var outW = pg.getViewport({ scale: outSc });
    var W = Math.max(2, Math.round(outW.width)), H = Math.max(2, Math.round(outW.height));
    var bw = Math.max(2, Math.round(vp1.width * outSc * ss));       // supersampled size
    var bh = Math.max(2, Math.round(vp1.height * outSc * ss));
    /* Render the supersampled page in horizontal STRIPS instead of one giant
       canvas. A 220 dpi A4 page is 4762×6736 = 32 Mpx — drawing that in a single
       pdf.js call blocks the main thread for seconds, which is what produces the
       "Page Unresponsive" dialog. offsetY counts whole device pixels, so a strip
       is rasterised exactly like those rows of the full page: the pixels are the
       same, only the timing changes (and the 128 MB canvas is never allocated). */
    var stripRows = Math.max(ss, ss * 96);
    var hook = { band: stripRows, progress: async function (f, phase) { if (sub) sub(f, phase); await NotesFX.uiPaint(); } };
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
    var tag2 = cap > 0 ? 'HQ ' + mul + '\u00d7 supersampled ' + W + 'px' : 'vector-sharp ' + Math.round(outSc * 72) + ' dpi';
    var st = printStyle();
    /* Off-thread first: the map over ~32 Mpx and the PNG encode are the heavy,
       block-the-tab parts. The worker gets the strips (transferred, never copied)
       and hands back the encoded page; the main thread only draws them. */
    if (window.NotesRaster && NotesRaster.supported()) {
      try {
        var wres = await NotesRaster.mapPage({
          kind: st === 'neg' ? 'neg' : 'hq', auto: printAuto(), keepColour: st === 'keep', pure: st === 'pure',
          bw: bw, bh: bh, W: W, H: H, band: stripRows, provider: renderStrip,
          encode: { mime: 'image/png', previewMax: 720 },
          onProgress: function (done, total) { if (sub) sub(done / total, 'binarising'); },
          onStrip: function () { return NotesFX.uiPaint(); }
        });
        return {
          bytes: new Uint8Array(wres.bytes), blank: !!wres.blank, status: tag2,
          preview: wres.preview ? { data: new Uint8ClampedArray(wres.preview.data), width: wres.preview.w, height: wres.preview.h } : null
        };
      } catch (err) {
        console.warn('raster worker could not do this page, using the main thread:', err);
      }
    }
    var hm;
    if (sub) sub(0, 'rendering');
    await NotesFX.uiPaint(true);                // let the bar move before the first strip
    try {
      hm = await printMapAsync(renderStrip, bw, bh, W, H, hook);
    } catch (err) {                             // older pdf.js / odd page: one canvas, the old way
      console.warn('strip rendering unavailable, falling back to a full-page render:', err);
      var cvF = document.createElement('canvas');
      cvF.width = bw; cvF.height = bh;
      var cxF = cvF.getContext('2d', { willReadFrequently: true });
      cxF.fillStyle = '#fff'; cxF.fillRect(0, 0, bw, bh);
      await NotesFX.uiPaint(true);
      await pg.render({ canvasContext: cxF, viewport: pg.getViewport({ scale: outSc * ss }) }).promise;
      hm = await printMapAsync(function (y0, rows) { return cxF.getImageData(0, y0, bw, rows); }, bw, bh, W, H, hook);
      cvF.width = 0; cvF.height = 0;
    }
    var small = document.createElement('canvas');
    small.width = W; small.height = H;
    var sx = small.getContext('2d');
    sx.putImageData(new ImageData(hm.imageData.data, W, H), 0, 0);
    return { canvas: small, status: tag2, blank: false, bytes: null, preview: null };
  }

  async function buildPrintItems(onPage, checkpoint, setStep) {   // progress comes from convert(): it owns the clock
    var n = state.pages, items = new Array(n), reused = 0;
    for (var i = 0; i < n; i++) {
      if (checkpoint) {
        var hit = await NotesSession.pageGet(i);
        if (hit) {
          items[i] = { bytes: hit, w: state.sizes[i].w, h: state.sizes[i].h };
          reused++;
          if (onPage) await onPage(i + 1, n, 'checkpoint', true);
          continue;
        }
      }
      var pg = await state.doc.getPage(i + 1);
      var r = await printRasterPage(pg, function (f, phase) {
        setStep((i + f) / n * 0.6, 'page ' + (i + 1) + ' of ' + n + ' · ' +
          (phase === 'writing' ? 'writing the file' : (phase === 'rendering' || phase === 'downsample') ? 'rendering the page' : phase === 'measure' ? 'measuring the ink' : 'binarising') +
          ' ' + Math.round(f * 100) + '%', 'page ' + (i + 1) + ' of ' + n);
      });
      pg.cleanup();
      var liveCv = r.canvas || (r.preview ? previewCanvas(r.preview) : null);
      if (liveCv) NotesFX.liveShow(liveCv, 'page ' + (i + 1) + ' / ' + n + ' · ' + r.status);
      items[i] = {
        bytes: r.bytes || await canvasToPng(r.canvas),
        w: state.sizes[i].w, h: state.sizes[i].h
      };
      if (checkpoint) {
        await NotesSession.pagePut(i, items[i].bytes);
        await NotesSession.runSave({ phase: 'render', page: i + 1, pages: n, kind: 'print' });
      }
      if (onPage) await onPage(i + 1, n, r.status);
    }
    state.reusedPages = reused;
    return items;
  }
  /* a small canvas from the worker's preview pixels (for the live view) */
  function previewCanvas(prev) {
    var cv = document.createElement('canvas');
    cv.width = prev.width; cv.height = prev.height;
    cv.getContext('2d').putImageData(new ImageData(prev.data, prev.width, prev.height), 0, 0);
    return cv;
  }
  function canvasToPng(cv) {
    return new Promise(function (res2, rej) {
      cv.toBlob(function (bl) { bl.arrayBuffer().then(function (ab) { res2(new Uint8Array(ab)); }, rej); }, 'image/png');
    });
  }

  function printListeners(schedule) {
    if (!printEls.on) return;
    printEls.on.addEventListener('change', function () { printEls.opts.hidden = !printEls.on.checked; schedule(); refreshPrintBadge(); });
    [printEls.auto, printEls.d96, printEls.d150, printEls.d220, printEls.sInk, printEls.sPure, printEls.sKeep, printEls.sNeg].forEach(function (el) { if (el) el.addEventListener('change', schedule); });
  }
  /* ---------- convert ---------- */
  goBtn.addEventListener('click', convert);
  async function convert() {
    if (!state.bytes || goBtn.disabled) return;
    goBtn.disabled = true; result.hidden = true; state.running = true;
    pBox.hidden = false;
    var prevCard = document.querySelector('.card.prev');
    if (prevCard) prevCard.classList.add('busy');
    var t0 = performance.now();
    /* ---- progress: one place writes the bar, the status line and the tab title,
       so every phase reports the same way and they can never disagree. The
       estimate is smoothed (one slow page must not make it jump) and refreshed
       once a second, so it stays honest during a long phase as well. */
    var etaSmooth = null, etaReady = false, lastStep = null, ticker = null;
    /* a bare estimate string, not a fragment of the sentence: it is shown in its
       own chip next to the bar (legible at a glance) and in the tab title, which
       is the only progress a background tab can show */
    var etaText = function (frac) {
      etaReady = false;                                  // until a real estimate exists
      if (frac >= 0.999) return '';                      // finished: no estimate needed
      var elapsed = performance.now() - t0;
      if (!(frac > 0.005) || elapsed < 1500) return 'estimating time left…';
      var left = (elapsed / frac) * (1 - frac);
      etaSmooth = (etaSmooth === null) ? left : (etaSmooth * 0.7 + left * 0.3);
      var txt = NotesFX.eta ? NotesFX.eta(etaSmooth) : '';
      etaReady = !!txt;
      return txt;
    };
    var setEta = function (eta) {
      if (!pEta) return;
      pEta.textContent = eta || '';
      pEta.className = 'p-eta' + (eta && !etaReady ? ' est' : '');
    };
    var setStep = function (frac, text, label) {
      lastStep = { frac: frac, text: text, label: label };
      pFill.style.width = (frac * 100).toFixed(1) + '%';
      pStatus.textContent = text;                        // what is happening
      var eta = etaText(frac);
      setEta(eta);                                       // how long is left
      NotesFX.titleProgress(frac, 1, label, etaReady ? eta : '');
    };
    var stopTicker = function () { if (ticker) { clearInterval(ticker); ticker = null; } };
    /* once a second: refresh the estimate (and the tab title) — this is what makes
       the run look alive from another tab, and it stays correct even while a long
       synchronous phase is in progress */
    ticker = setInterval(function () {
      if (lastStep && goBtn.disabled) setStep(lastStep.frac, lastStep.text, lastStep.label);
    }, 1000);
    setStep(0.02, 'embedding pages…', '');            // the run has visibly started
    try {
      var res;
      var sig = printSig();
      var ck = false;
      if (printMode()) {
        if (sessReady()) {
          var hand = await NotesSession.runBegin(sig, state.pages, 'print');
          ck = true;
          if (hand.have) pStatus.textContent = 'resuming — ' + hand.have + ' page' + (hand.have === 1 ? '' : 's') + ' already rendered…';
        }
        if (pStatus.textContent.indexOf('resuming') < 0) pStatus.textContent = 'rendering pages…';
        var items = await buildPrintItems(function (d, t, st, cached) {
          setStep(d / t * 0.6, 'page ' + d + ' of ' + t + ' · ' + (cached ? 'from checkpoint' : 'binarising ' + (st || 'at ' + printDpi() + ' dpi…')),
            'page ' + d + ' of ' + t);
          return NotesFX.uiPaint();
        }, ck, setStep);
        setStep(0.65, 'packing sheets…', 'packing');
        if (sessReady()) await NotesSession.runSave({ phase: 'pack', page: state.pages, pages: state.pages, kind: 'print' });
        res = await NotesConverter.buildFromImages(items, readOptions(), function (d, t, phase) {
          var frac = d / t;
          setStep(0.65 + frac * 0.32,
            phase === 'writing' ? 'writing the file'
              : phase === 'encoding' ? 'placing page images ' + d + ' / ' + t
              : 'sheet ' + d + ' of ' + t,
            phase === 'writing' ? 'writing the file' : 'sheet ' + d + ' of ' + t);
          return NotesFX.uiPaint();                      // real frames, not just event-loop turns
        });
      } else {
        if (sessReady()) await NotesSession.runBegin(sig + '|vector', state.pages, 'vector');
        res = await NotesConverter.build(state.bytes, readOptions(), function (d, t) {
          setStep(0.06 + d / t * 0.88, 'sheet ' + d + ' of ' + t, 'sheet ' + d + ' of ' + t);
          if (sessReady() && (d === t || d % 4 === 0)) NotesSession.runSave({ phase: 'build', page: d, pages: t, kind: 'vector' });
          return NotesFX.uiPaint();                      // real frames, not just event-loop turns
        });
      }
      setStep(1, 'done', '');
      NotesFX.titleDone(); NotesFX.liveDone();
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' }));
      var base = state.name.replace(/\.pdf$/i, '');
      $('dlBtn').href = state.out.url;
      $('dlBtn').download = base + (printMode() ? '-print' : '') + '-4up-' + opt.paper.value.toUpperCase() + 'L.pdf';
      $('openBtn').href = state.out.url;
      $('rsIn').textContent = res.sourcePages;
      $('rsOut').textContent = res.sheets;
      $('rsMeta').textContent =
        res.sourcePages + (res.sourcePages === 1 ? ' page' : ' pages') + ' packed 4-per-sheet into ' + res.sheets + ' ' +
        NotesConverter.PAPERS[opt.paper.value].label.split(' (')[0] + ' landscape sheet' + (res.sheets === 1 ? '' : 's') + ' · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(res.bytes.length) + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device' + (printMode() ? ' · ◐ print-saver ' + printDpi() + ' dpi ' + ({ink:'b&w', pure:'pure b&w', keep:'kept colours', neg:'true negative'})[printStyle()] : '') +
        (sepLineVal() === 'off' ? '' : ' · dotted middle separator');
      /* the sheets are ready — show the result card and the Download button
         immediately, then fill in previews and the reload-proof save behind it */
      renderThumbsSoon(res.bytes, res.sheets);
      result.hidden = false;
      resumePreviewStrip();                        // previews paused for the run? finish them now
      if (prevCard) prevCard.classList.remove('busy');
      if (window.NotesFX) NotesFX.toast(res.sheets + ' landscape sheets ready · ' + (printMode() ? 'print-saver ' + printDpi() + ' dpi' : 'pure vector'));
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
      if (sessReady()) {
        var meta2 = $('rsMeta').textContent;
        NotesSession.saveResult({
          bytes: res.bytes, name: $('dlBtn').download, kind: printMode() ? 'print' : 'vector',
          info: { in: res.sourcePages, out: res.sheets, meta: meta2 }
        }).then(function () {                           // queued in order, so runClear still runs after
          NotesSession.runClear();
          sessNote('Saved · ' + res.sheets + ' sheet' + (res.sheets === 1 ? '' : 's') + ' ready — reloading keeps this result and the download link.');
        });
      }
    } catch (err) {
      stopTicker();
      pStatus.textContent = 'failed: ' + (err && err.message || err);
      setEta('');
      NotesFX.titleDone(false); NotesFX.liveDone();
      if (prevCard) prevCard.classList.remove('busy');
      console.error(err);
    }
    stopTicker();
    state.running = false;
    goBtn.disabled = false;
  }

  var thumbToken = 0;
  /* Previews must never hold back the result: placeholders appear instantly and
     the real sheets swap themselves in one by one, in the background. */
  function renderThumbsSoon(bytes, sheets) {
    var mine = ++thumbToken;
    var strip = (window.NotesFX && NotesFX.thumbStrip) ? NotesFX.thumbStrip(thumbs, Math.min(sheets, 6)) : null;
    setTimeout(function () {
      if (mine !== thumbToken) return;
      makeThumbs(bytes, sheets, mine, strip).catch(function (e) { console.warn('previews:', e); });
    }, 30);
  }
  async function makeThumbs(bytes, sheets, token, strip) {
    var stale = function () { return token !== undefined && token !== thumbToken; };
    if (strip === undefined) thumbs.innerHTML = '';                 // restored-result path
    if (state.out.doc) { try { state.out.doc.destroy(); } catch (e) {} }
    var doc = state.out.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(0) }).promise;
    if (stale()) return;
    var show = Math.min(sheets, 6);
    for (var i = 1; i <= show; i++) {
      await NotesFX.parkWhileHidden();               // cosmetic: wait for the user to come back
      if (stale()) return;
      var pg = await doc.getPage(i);
      var vp = pg.getViewport({ scale: 230 / pg.getViewport({ scale: 1 }).width });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (stale()) { try { pg.cleanup(); } catch (e) {} return; }
      var img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.alt = 'Packed 4-up sheet ' + i + ' preview';
      if (strip) strip.place(img, i - 1);
      else thumbs.appendChild(img);
      pg.cleanup();
      await NotesFX.uiPaint();                       // stay responsive while previews render
    }
    if (sheets > show) {
      var more = document.createElement('p');
      more.style.cssText = 'color:var(--faint);font-size:.78rem;grid-column:1/-1';
      more.textContent = '+ ' + (sheets - show) + ' more sheets in the downloaded PDF';
      thumbs.appendChild(more);
    }
  }

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
      if (meta) sessNote('Your last result (' + fmtMB(meta.size) + ') is still saved here — pick the PDF again to re-pack, or Forget to wipe it.', false);
      return;
    }
    restoring = true;
    await handleFile(NotesSession.toFile(files[0]));
    restoring = false;
    if (meta) await restoreResult(meta);
    var run = await NotesSession.runLoad();
    if (run && run.phase !== 'done' && run.pages) {
      var st = await NotesSession.pageStats();
      sessNote('Your last run stopped at page ' + run.page + ' of ' + run.pages + ' — press Continue and it carries on from there' +
        (st.count ? ' (' + st.count + ' page' + (st.count === 1 ? '' : 's') + ' already rendered are reused)' : '') + '.', true);
    } else if (meta) {
      sessNote('Restored — file, settings and your last result are all back. Reload-safe.');
    } else {
      sessNote('Restored — file and settings are back. Reload-safe.');
    }
    if (window.NotesFX) NotesFX.toast('Session restored from this browser');
  })();

  /* ---------- reset + reveal ---------- */
  function resetAll() {
    if (state.out.url && !sessReady()) URL.revokeObjectURL(state.out.url);
    if (sessReady()) { NotesSession.clearFiles(); NotesSession.clearResult(); NotesSession.runClear(); }
    if (sessBar) sessBar.hidden = true;
    state.bytes = null; state.out = { doc: null, url: '' };
    fileInput.value = '';
    wb.hidden = true; dz.hidden = false; result.hidden = true; pBox.hidden = true; clearError();
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('resetBtn').addEventListener('click', resetAll);
  $('againBtn').addEventListener('click', resetAll);

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
