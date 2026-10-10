/* Notes2A4 — Manual mode. You draw the template: 2/3/4 slots on a portrait or
   landscape A4 sheet, drag-move + corner-resize on canvas, then the whole PDF
   packs into your layout as pure vector. 100% on-device. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  var NC = window.NotesConverter || {};
  var TPL_KEY = 'notes2a4.manual.tpl.v1';

  /* ---------- state ---------- */
  var state = {
    bytes: null, name: '', doc: null, sizes: [], pages: 0,
    out: { bytes: null, url: '' },
    running: false
  };
  var tpl = { orient: 'portrait', boxes: null };   // boxes: normalized [{x,y,w,h}]
  var thumbs = { doc: null, cache: [], gen: 0 };    // per-page render cache

  /* ---------- element refs ---------- */
  var dz = $('dropzone'), fileInput = $('fileInput'), fileErr = $('fileError');
  var wb = $('workbench'), result = $('result');
  var goBtn = $('goBtn'), pBox = $('progressBox'), pFill = $('pfill'),
      pStatus = $('pstatus'), pEta = $('pEta');
  var canvas = $('tplCanvas'), ctx = canvas.getContext('2d');
  var ui = {
    oriP: $('oriP'), oriL: $('oriL'),
    slot2: $('slot2'), slot3: $('slot3'), slot4: $('slot4'),
    tplReset: $('tplReset')
  };

  /* ---------- helpers ---------- */
  function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function showError(msg) { fileErr.hidden = false; fileErr.textContent = msg; }
  function clearError() { fileErr.hidden = true; }
  function slotCount() {
    if (ui.slot4.checked) return 4;
    if (ui.slot3.checked) return 3;
    return 2;
  }
  function orient() { return ui.oriL.checked ? 'landscape' : 'portrait'; }

  /* ---------- reload-proof session (file + result; template lives in localStorage) ---------- */
  var SESS_SEL = '#workbench input';
  var restoring = false;
  var sessBar = $('sessBar'), sessMsg = $('sessMsg');
  function sessReady() { return !!(window.NotesSession && NotesSession.supported()); }
  function sessNote(msg) {
    if (!sessBar) return;
    sessBar.hidden = false;
    if (sessMsg) sessMsg.textContent = msg;
  }
  function sessKill() {
    if (sessReady()) NotesSession.clearAll();
    if (sessBar) sessBar.hidden = true;
  }

  /* ---------- template store ---------- */
  function saveTpl() {
    try {
      localStorage.setItem(TPL_KEY, JSON.stringify({ orient: orient(), boxes: tpl.boxes }));
    } catch (e) { /* private mode: builder still works, just not remembered */ }
  }
  function loadTpl() {
    try {
      var t = JSON.parse(localStorage.getItem(TPL_KEY) || 'null');
      if (t && (t.orient === 'portrait' || t.orient === 'landscape') &&
          Array.isArray(t.boxes) && t.boxes.length >= 2 && t.boxes.length <= 4 &&
          t.boxes.every(function (b) {
            return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h);
          })) {
        (t.orient === 'landscape' ? ui.oriL : ui.oriP).checked = true;
        var n = t.boxes.length;
        (n === 4 ? ui.slot4 : n === 3 ? ui.slot3 : ui.slot2).checked = true;
        tpl.orient = t.orient;
        tpl.boxes = t.boxes.map(function (b) { return NC.clampBox(b); });
        return true;
      }
    } catch (e) { /* corrupted entry: fall through to defaults */ }
    return false;
  }
  function resetTpl() {
    tpl.orient = orient();
    tpl.boxes = NC.defaultTile(slotCount(), tpl.orient);
    saveTpl();
  }

  /* ---------- intake ---------- */
  function handleFiles(files) {
    if (files && files.length) handleFile(files[0]);
  }
  async function handleFile(file) {
    clearError();
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      showError('That doesn\u2019t look like a PDF — please drop a .pdf file.'); return;
    }
    if (file.size > 400 * 1048576) {
      showError('File is over 400 MB — your browser tab may struggle. Try splitting it first.'); return;
    }
    pStatus.textContent = 'reading…'; pBox.hidden = false; pFill.style.width = '20%';
    if (pEta) pEta.textContent = '';
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
      thumbs.doc = doc; thumbs.cache = []; thumbs.gen++;   // new file ⇒ fresh renders
      pBox.hidden = true;
      afterLoad();
      if (sessReady() && !restoring) {
        NotesSession.saveFiles([{ name: state.name, bytes: state.bytes }]);
        sessNote('Saved in this browser — reload, close or crash, this file and your template stay.');
      }
    } catch (err) {
      pBox.hidden = true;
      showError('Could not open this PDF (' + (err && err.message || 'password-protected or damaged') + ').');
    }
  }

  function updateCounts() {
    var n = state.pages, k = slotCount();
    var sheets = Math.ceil(n / k);
    $('fbOut').textContent = '→ ' + sheets + ' sheet' + (sheets === 1 ? '' : 's') +
      ' (−' + Math.round((1 - sheets / n) * 100) + '%)';
    $('fbOdd').hidden = n % k === 0;
    $('goIn').textContent = n; $('goOut').textContent = sheets;
  }

  function afterLoad() {
    dz.hidden = true; wb.hidden = false; result.hidden = true;
    $('fbName').textContent = state.name;
    var n = state.pages;
    $('fbPages').textContent = n + (n === 1 ? ' page' : ' pages');
    updateCounts();
    goBtn.disabled = false;
    fitCanvas();
    ensureThumbs(slotCount());
    wb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- template canvas ---------- */
  var AR_P = 1 / Math.SQRT2, AR_L = Math.SQRT2;   // A-series aspect ratios
  function sheetAR() { return orient() === 'landscape' ? AR_L : AR_P; }
  function fitCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = Math.min(canvas.parentElement.clientWidth || 460, 460);
    var cssH = Math.round(cssW / sheetAR());
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  var rszT = null;
  if (window.addEventListener) window.addEventListener('resize', function () {
    clearTimeout(rszT);
    rszT = setTimeout(function () { if (!wb.hidden) fitCanvas(); }, 150);
  });

  /* first-N source pages, rendered small for the builder — async, cached per file */
  function ensureThumbs(k) {
    if (!state.doc) return;
    var mine = thumbs.gen;
    for (var i = 0; i < k; i++) {
      if (thumbs.cache[i] || i >= state.pages) continue;
      (function (idx) {
        state.doc.getPage(idx + 1).then(function (pg) {
          if (mine !== thumbs.gen) { pg.cleanup(); return; }
          var vw = pg.getViewport({ scale: 1 });
          var sc = 240 / vw.width;
          var vp = pg.getViewport({ scale: sc });
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(vp.width));
          c.height = Math.max(1, Math.round(vp.height));
          pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
            pg.cleanup();
            if (mine !== thumbs.gen) return;
            thumbs.cache[idx] = c;
            draw();
          });
        }).catch(function () { /* a page that won't render still packs as vector */ });
      })(i);
    }
  }

  var HANDLE = 11;   // corner-grab square, CSS px
  function corners(r) {
    return {
      nw: [r.x, r.y], ne: [r.x + r.w, r.y],
      sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h]
    };
  }
  function toPx(b) {
    var W = canvas.width / (Math.min(window.devicePixelRatio || 1, 2));
    var H = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
    return { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H };
  }

  /* slot k in READING order shows source page k — the numbers on screen are the pack order */
  function draw() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = canvas.width / dpr, H = canvas.height / dpr;
    if (!W || !tpl.boxes) return;
    var order = NC.slotOrder(tpl.boxes);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(20,28,54,.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    order.forEach(function (bi, rank) {
      var b = tpl.boxes[bi], r = toPx(b);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.fillStyle = '#eef1fb';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      var tc = thumbs.cache[rank];
      if (tc) {
        /* contain-fit, like the pack itself: never cropped, never squashed */
        var s = Math.min(r.w / tc.width, r.h / tc.height);
        var dw = tc.width * s, dh = tc.height * s;
        ctx.drawImage(tc, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
      }
      ctx.restore();
      var sel = (drag && drag.bi === bi);
      ctx.strokeStyle = sel ? '#10b981' : '#34d399';
      ctx.lineWidth = sel ? 2.5 : 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      /* rank badge: ① slot takes page 1, ② page 2 … */
      var label = String(rank + 1);
      ctx.font = '700 13px system-ui,sans-serif';
      var tw = ctx.measureText(label).width;
      var bx = r.x + 6, by = r.y + 6, bw = tw + 14, bh = 20;
      ctx.fillStyle = 'rgba(13,20,40,.88)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 10); else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 7, by + bh / 2 + 0.5);
      if (rank < state.pages) {
        ctx.fillStyle = 'rgba(13,20,40,.55)';
        ctx.font = '600 10px system-ui,sans-serif';
        ctx.fillText('p.' + (rank + 1), bx + bw + 5, by + bh / 2 + 0.5);
      }
      /* corner handles */
      var cs = corners(r);
      ctx.fillStyle = sel ? '#10b981' : '#fff';
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      Object.keys(cs).forEach(function (k) {
        var px = cs[k][0], py = cs[k][1];
        ctx.beginPath();
        ctx.rect(px - HANDLE / 2, py - HANDLE / 2, HANDLE, HANDLE);
        ctx.fill();
        ctx.stroke();
      });
    });
  }

  /* ---------- drag: move inside, resize on corners ---------- */
  var drag = null;
  function evtPos(e) {
    var rc = canvas.getBoundingClientRect();
    return { x: e.clientX - rc.left, y: e.clientY - rc.top };
  }
  function hitTest(p) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = canvas.width / dpr, H = canvas.height / dpr;
    for (var i = tpl.boxes.length - 1; i >= 0; i--) {
      var r = toPx(tpl.boxes[i]), cs = corners(r), k;
      for (k in cs) {
        if (Math.abs(p.x - cs[k][0]) <= HANDLE && Math.abs(p.y - cs[k][1]) <= HANDLE)
          return { bi: i, mode: k };
      }
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
        return { bi: i, mode: 'move' };
    }
    return null;
  }
  function cursorFor(hit) {
    if (!hit) return 'default';
    if (hit.mode === 'move') return 'move';
    return (hit.mode === 'nw' || hit.mode === 'se') ? 'nwse-resize' : 'nesw-resize';
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (!tpl.boxes || state.running) return;
    var hit = hitTest(evtPos(e));
    if (!hit) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { bi: hit.bi, mode: hit.mode, last: evtPos(e) };
    canvas.style.cursor = cursorFor(hit);
    draw();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!tpl.boxes) return;
    var p = evtPos(e);
    if (!drag) { canvas.style.cursor = cursorFor(hitTest(p)); return; }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = canvas.width / dpr, H = canvas.height / dpr;
    var dx = (p.x - drag.last.x) / W, dy = (p.y - drag.last.y) / H;
    drag.last = p;
    var b = tpl.boxes[drag.bi];
    tpl.boxes[drag.bi] = drag.mode === 'move'
      ? NC.boxMove(b, dx, dy)
      : NC.boxResize(b, drag.mode, dx, dy);
    draw();
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'default';
    saveTpl();
    draw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---------- builder controls ---------- */
  [ui.oriP, ui.oriL].forEach(function (r) {
    r.addEventListener('change', function () {
      /* normalized boxes: the flip keeps every box exactly where it is */
      tpl.orient = orient();
      saveTpl();
      fitCanvas();
    });
  });
  [ui.slot2, ui.slot3, ui.slot4].forEach(function (r) {
    r.addEventListener('change', function () {
      resetTpl();            // a new slot count starts from even tiles
      updateCounts();
      ensureThumbs(slotCount());
      fitCanvas();
    });
  });
  ui.tplReset.addEventListener('click', function () {
    resetTpl();
    ensureThumbs(slotCount());
    fitCanvas();
  });
  function syncAfterRestore() {
    if (!tpl.boxes || tpl.boxes.length !== slotCount()) resetTpl();
    else { tpl.orient = orient(); saveTpl(); }
    updateCounts();
    ensureThumbs(slotCount());
    fitCanvas();
  }

  /* ---------- pack ---------- */
  async function convert() {
    if (!state.bytes || goBtn.disabled || state.running) return;
    if (!NC.manualPack) { showError('Converter failed to load — reload the page and try again.'); return; }
    goBtn.disabled = true; result.hidden = true; state.running = true;
    pBox.hidden = false;
    var t0 = performance.now();
    pFill.style.width = '2%';
    pStatus.textContent = 'embedding pages…';
    if (pEta) pEta.textContent = '';
    try {
      var res = await NC.manualPack(
        state.bytes,
        { orient: orient(), boxes: tpl.boxes },
        function (d, t) {
          pFill.style.width = (d / t * 100).toFixed(1) + '%';
          pStatus.textContent = 'sheet ' + d + ' of ' + t;
        }
      );
      pFill.style.width = '100%';
      pStatus.textContent = 'done';
      state.out.bytes = res.bytes;
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' }));
      var base = state.name.replace(/\.pdf$/i, '');
      var dl = $('dlBtn');
      dl.href = state.out.url;
      dl.download = base + '-manual-A4.pdf';
      $('openBtn').href = state.out.url;
      $('rsIn').textContent = res.sourcePages;
      $('rsOut').textContent = res.sheets;
      $('rsMeta').textContent =
        res.sourcePages + (res.sourcePages === 1 ? ' page' : ' pages') + ' packed into ' +
        res.sheets + ' A4 sheet' + (res.sheets === 1 ? '' : 's') +
        ' (' + slotCount() + ' slots, ' + orient() + ') · ' +
        fmtMB(state.bytes.length) + ' → ' + fmtMB(res.bytes.length) + ' · ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's · 100% on-device';
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(function () { pBox.hidden = true; }, 900);
      if (sessReady()) {
        var meta2 = $('rsMeta').textContent;
        NotesSession.saveResult({
          bytes: res.bytes, name: dl.download, kind: 'manual',
          info: { in: res.sourcePages, out: res.sheets, meta: meta2 }
        }).then(function () {
          sessNote('Saved · ' + res.sheets + ' sheet' + (res.sheets === 1 ? '' : 's') +
            ' ready — reloading keeps this result and the download link.');
        });
      }
    } catch (err) {
      pStatus.textContent = 'failed: ' + (err && err.message || err);
      console.error(err);
    }
    state.running = false;
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', convert);

  async function restoreResult(meta) {
    try {
      var rec = await NotesSession.loadResult();
      if (!rec) return;
      state.out.bytes = rec.bytes;
      if (state.out.url) URL.revokeObjectURL(state.out.url);
      state.out.url = URL.createObjectURL(new Blob([rec.bytes], { type: 'application/pdf' }));
      var dl = $('dlBtn');
      dl.href = state.out.url;
      dl.download = rec.name || 'notes-manual-A4.pdf';
      $('openBtn').href = state.out.url;
      if (meta.info) {
        $('rsIn').textContent = meta.info.in;
        $('rsOut').textContent = meta.info.out;
        $('rsMeta').textContent = meta.info.meta + ' · restored from this browser, no re-conversion needed';
      } else {
        $('rsMeta').textContent = 'Saved result — ' + fmtMB(meta.size) + ' PDF restored from this browser.';
      }
      result.hidden = false;
    } catch (e) { console.warn('restore:', e); }
  }

  /* ---------- intake events ---------- */
  $('chooseBtn').addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
  dz.addEventListener('click', function (e) { if (e.target.tagName !== 'BUTTON') fileInput.click(); });
  dz.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () { if (fileInput.files.length) handleFiles(fileInput.files); });

  /* ---------- reset ---------- */
  function resetAll() {
    if (state.out.url && !sessReady()) URL.revokeObjectURL(state.out.url);
    if (sessReady()) { NotesSession.clearFiles(); NotesSession.clearResult(); }
    if (sessBar) sessBar.hidden = true;
    state.bytes = null; state.out = { bytes: null, url: '' };
    thumbs.cache = []; thumbs.gen++;
    fileInput.value = '';
    wb.hidden = true; dz.hidden = false; result.hidden = true; pBox.hidden = true; clearError();
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('resetBtn').addEventListener('click', resetAll);
  $('againBtn').addEventListener('click', resetAll);

  /* ---------- boot ---------- */
  if (!loadTpl()) resetTpl();
  (async function bootSession() {
    if (!window.NotesSession) return;
    try { await NotesSession.init(); } catch (e) { return; }
    if (!sessReady()) return;
    var forget = $('sessForget');
    if (forget) forget.addEventListener('click', sessKill);
    NotesSession.autoSaveOpts($('workbench'), SESS_SEL);
    var savedOpts = await NotesSession.loadOpts();
    if (savedOpts && NotesSession.apply(savedOpts, NotesSession.collect(SESS_SEL))) syncAfterRestore();
    var files = await NotesSession.loadFiles();
    var meta = await NotesSession.loadResultMeta();
    if (!files.length) {
      if (meta) sessNote('Your last result (' + fmtMB(meta.size) + ') is still saved here — pick the PDF again to re-pack, or Forget to wipe it.');
      return;
    }
    restoring = true;
    await handleFile(NotesSession.toFile(files[0]));
    restoring = false;
    if (meta) await restoreResult(meta);
    if (meta) sessNote('Restored — file, template and your last result are all back. Reload-safe.');
    else sessNote('Restored — file and template are back. Reload-safe.');
  })();

  /* ---------- scroll reveal ---------- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
