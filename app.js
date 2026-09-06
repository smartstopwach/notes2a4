/* ============ Notes2A4 — app frontend ============ */
(function () {
  'use strict';

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
    per2: $('per2'), per4: $('per4'),
    paper: $('optPaper'), margin: $('optMargin'),
    gapAuto: $('gapAuto'), gapFixed: $('gapFixed'), gap: $('optGap'),
    lines: $('optLines'), nums: $('optNums')
  };

  /* ---------- helpers ---------- */
  function perSheet() { return opt.per4.checked ? 4 : 2; }
  function readOptions() {
    return NotesConverter.normalize({
      perSheet: perSheet(),
      paper: opt.paper.value,
      margin: parseFloat(opt.margin.value) * MM,
      gapMode: opt.gapFixed.checked ? 'fixed' : 'auto',
      gap: parseFloat(opt.gap.value) * MM,
      lines: opt.lines.checked,
      pageNumbers: opt.nums.checked
    });
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
    $('fbName').textContent = state.name;
    $('fbPages').textContent = state.pages + (state.pages === 1 ? ' page' : ' pages');
    var w9 = 16 / 9, tol = 0.07, allWide = true, anyWide = false;
    state.sizes.forEach(function (s) {
      var ar = s.w / s.h;
      if (Math.abs(ar - w9) / w9 <= tol) anyWide = true; else allWide = false;
    });
    $('fbRatio').textContent = allWide ? '16:9 ✓' : (anyWide ? 'mixed aspects — auto-fit' : 'auto-fit');
    goBtn.disabled = false;
    updateModeUI();
    renderPreview();
    wb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* sheet counts, chips, labels and option visibility for the current mode */
  function updateModeUI() {
    var per = perSheet();
    var n = state.pages;
    var sheets = n ? Math.ceil(n / per) : 0;
    $('fbOut').textContent = n
      ? '→ ' + sheets + ' ' + (per === 4 ? 'landscape ' : '') + 'sheet' + (sheets === 1 ? '' : 's') +
        ' (−' + Math.round((1 - sheets / n) * 100) + '%)'
      : '→ — sheets';
    $('fbOdd').hidden = (n % per === 0);
    $('goIn').textContent = n || '—';
    $('goOut').textContent = sheets || '—';
    $('linesRow').hidden = (per === 4);
    if (per === 4 && opt.lines.checked) opt.lines.checked = false;
    updateGapLabel();
  }

  /* ---------- options wiring ---------- */
  var pvTimer = null;
  function schedulePreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(renderPreview, 120);
    updateModeUI();
  }
  function updateGapLabel() {
    $('vMargin').textContent = parseFloat(opt.margin.value) + ' mm';
    var quad = perSheet() === 4;
    if (opt.gapFixed.checked) {
      $('vGap').textContent = quad
        ? 'Custom: ' + parseFloat(opt.gap.value) + ' mm cross-gutters between the four cells.'
        : 'Custom: ' + parseFloat(opt.gap.value) + ' mm of white space between the two slides.';
    } else {
      $('vGap').textContent = quad
        ? 'Auto: even slim gutters; the 2 × 2 block is centered on the landscape sheet.'
        : 'Auto: slides stay flush top & bottom, remaining white space lands in the middle.';
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
  [opt.per2, opt.per4].forEach(function (r) { r.addEventListener('change', schedulePreview); });
  $('useQuadBtn').addEventListener('click', function () {
    opt.per4.checked = true;
    $('convert').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (state.pages) schedulePreview(); else updateGapLabel();
  });

  /* ---------- live preview (same geometry engine as converter) ---------- */
  async function renderPreview() {
    if (!state.doc) return;
    var gen = ++state.gen;
    var opts = readOptions();
    var page = NotesConverter.sheetSize(opts);
    var figures = document.querySelectorAll('.sheet-fig');
    for (var s = 0; s < 2; s++) {
      var fig = figures[s], canvas = $('pv' + (s + 1));
      if (s * opts.perSheet >= state.pages) { fig.hidden = true; continue; }
      fig.hidden = false;
      await paintSheetPreview(canvas, page, opts, s);
      if (gen !== state.gen) return; // superseded
    }
  }

  async function paintSheetPreview(canvas, page, opts, sIdx) {
    var per = opts.perSheet;
    var base = sIdx * per, idxs = [];
    for (var c = 0; c < per && base + c < state.pages; c++) idxs.push(base + c);
    var L = NotesConverter.layoutForSheet(idxs.map(function (i) { return state.sizes[i]; }), opts, page);

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
      ctx.drawImage(off,
        box.x * pxPerPt,
        (page.h - box.y - box.height) * pxPerPt,
        box.width * pxPerPt, box.height * pxPerPt
      );
    }
    var q = per === 4 ? 1.2 : 1.5;
    for (var ci = 0; ci < idxs.length; ci++) {
      await slide(idxs[ci] + 1, L.slides[ci], q);
    }

    if (opts.lines && per === 2) {
      ctx.strokeStyle = '#c3cbd9'; ctx.lineWidth = 0.8;
      for (var i = 0; i < L.lines.length; i++) {
        var yPx = (page.h - L.lines[i]) * pxPerPt;
        var x0 = (L.gap.x + 10) * pxPerPt, x1 = (L.gap.x + L.gap.w - 10) * pxPerPt;
        ctx.beginPath(); ctx.moveTo(x0, yPx); ctx.lineTo(x1, yPx); ctx.stroke();
      }
    }
    if (opts.pageNumbers) {
      var sheets = Math.ceil(state.pages / per);
      var txt = (sIdx + 1) + ' / ' + sheets;
      ctx.fillStyle = '#7a869e'; ctx.font = '7px system-ui';
      if (per === 4) {
        var tw4 = ctx.measureText(txt).width;
        ctx.fillText(txt, (cssW - tw4) / 2, (page.h - L.gutterCenterY) * pxPerPt + 3);
      } else if (opts.lines) {
        ctx.fillText(txt, (L.gap.x + 10) * pxPerPt, (page.h - L.gap.y - L.gap.h + 12) * pxPerPt + 6);
      } else {
        var tw = ctx.measureText(txt).width;
        ctx.fillText(txt, (cssW - tw) / 2, (page.h - L.gap.y - 5) * pxPerPt - 4);
      }
    }
  }

  /* ---------- convert ---------- */
  goBtn.addEventListener('click', convert);

  async function convert() {
    if (!state.bytes || goBtn.disabled) return;
    goBtn.disabled = true; result.hidden = true;
    pBox.hidden = false; pFill.style.width = '2%'; pStatus.textContent = 'embedding pages…';
    var t0 = performance.now();
    try {
      var res = await NotesConverter.build(state.bytes, readOptions(), function (d, t) {
        pFill.style.width = (6 + d / t * 88).toFixed(1) + '%';
        pStatus.textContent = 'sheet ' + d + ' of ' + t + '…';
        return new Promise(function (r) { setTimeout(r, 0); });
      });
      pFill.style.width = '100%'; pStatus.textContent = 'done';
      state.out.bytes = res.bytes;
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' }));

      var base = state.name.replace(/\.pdf$/i, '');
      var paper = opt.paper.value.toUpperCase();
      var dl = $('dlBtn');
      dl.href = state.out.url; dl.download = base + '-2up-' + paper + '.pdf';
      $('openBtn').href = state.out.url;

      $('rsIn').textContent = res.sourcePages;
      $('rsOut').textContent = res.sheets;
      var orient = res.pageWH.w > res.pageWH.h ? 'landscape' : 'portrait';
      $('rsMeta').textContent =
        res.sourcePages + (res.sourcePages === 1 ? ' page' : ' pages') + ' packed into ' + res.sheets + ' ' +
        NotesConverter.PAPERS[opt.paper.value].label.split(' (')[0] + ' ' + orient + ' sheets · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(res.bytes.length) + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device';

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
