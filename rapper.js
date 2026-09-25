/* ================= THE RAPPER — cover-up studio =================
   Draw covers over stamped TG-IDs, apply to all pages, export a clean copy.
   Coordinates: covers live in PDF points, top-left origin (see rapper-core.js).
   Only the pdf-lib writer flips Y. Preview renders via pdf.js, export via
   pdf-lib; pages with blur regions are re-rendered at the chosen dpi. */
(function () {
'use strict';
var RC = window.RapperCore;
var $ = function (id) { return document.getElementById(id); };

/* ---------- dom ---------- */
var fileEl = $('rp-file'), fnameEl = $('rp-fname'), stripEl = $('rp-strip');
var baseCv = $('rp-base'), overCv = $('rp-over'), layersEl = $('rp-layers'), boxEl = $('rp-box');
var bctx = baseCv.getContext('2d'), octx = overCv.getContext('2d');
var pnEl = $('rp-pn'), pcEl = $('rp-pc'), statusEl = $('rp-status');
var colorEl = $('rp-color'), hexEl = $('rp-hex'), swEl = $('rp-swatches'), recentEl = $('rp-recent');
var opEl = $('rp-op'), opV = $('rp-opv'), brEl = $('rp-br'), brV = $('rp-brv');
var blkEl = $('rp-blk'), blkV = $('rp-blkv');
var zvEl = $('rp-zv');
var dropEl = $('rp-drop'), errEl = $('rp-err'), workEl = $('rp-work');
var pagesEl = $('rp-pages'), covchipEl = $('rp-covchip');
var progEl = $('rp-progress'), pfillEl = $('rp-pfill'), pstatusEl = $('rp-pstatus'), petaEl = $('rp-peta');
var resEl = $('rp-result'), rsCovEl = $('rp-rsCov'), rsMetaEl = $('rp-rsMeta');
var dlEl = $('rp-dl'), openEl = $('rp-open'), toastsEl = $('toasts');

function toast(msg) {
  if (!toastsEl) return;
  var t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = msg;
  toastsEl.appendChild(t);
  setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 400); }, 3200);
}
function showErr(msg) {
  errEl.textContent = msg;
  errEl.hidden = !msg;
}

/* ---------- state ---------- */
var pdf = null, pdfName = '', origBytes = null, pageCount = 0, cur = 1;
var pageSizes = {};             // page -> {w, h} in pt
var covers = {};                // page -> [cover…]  (top-left pt space)
var tool = 'select', color = '#ffffff', opacity = 1, brushR = 12, blockPx = 12;
var zoom = 1, fitScale = 1, view = { scale: 1, w: 0, h: 0 };
var sel = null;                 // {id}
var undoStack = [], redoStack = [];
var renderToken = 0, thumbToken = 0, exporting = false;
var recent = [];
var uid = 1;

var SWATCHES = ['#ffffff', '#f8fafc', '#fef3c7', '#12172b', '#000000', '#b91c1c', '#1d4ed8', '#15803d'];
var BUILD = 'rapper/2';

function status(html) { statusEl.innerHTML = html; }
function pageCovers(p) { return covers[p] || (covers[p] = []); }
function findCover(p, id) {
  var list = covers[p] || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function totalCovers() {
  var n = 0, k;
  for (k in covers) n += covers[k].length;
  return n;
}

/* ---------- undo / redo (whole-model snapshots; docs here are small) ---------- */
function snap() { return JSON.stringify(covers); }
function pushUndo() {
  undoStack.push(snap());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}
function restore(json) {
  covers = JSON.parse(json);
  sel = null;
  drawOverlay(); refreshBadges(); refreshSummary();
}
function doUndo() {
  if (!undoStack.length) return;
  redoStack.push(snap());
  restore(undoStack.pop());
  status('Undone. <b>Redo:</b> Ctrl+Y');
}
function doRedo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  restore(redoStack.pop());
  status('Redone.');
}

/* ---------- coordinate helpers ---------- */
function pt2css(v) { return v * view.scale; }
function css2pt(v) { return v / view.scale; }
function evPos(e) {
  var r = overCv.getBoundingClientRect();
  return { x: (e.clientX - r.left), y: (e.clientY - r.top) };   // css px
}

/* ---------- file loading ---------- */
fileEl.addEventListener('change', function () {
  if (fileEl.files && fileEl.files[0]) loadFile(fileEl.files[0]);
  fileEl.value = '';
});
$('rp-choose').addEventListener('click', function (e) { e.stopPropagation(); fileEl.click(); });
dropEl.addEventListener('click', function () { fileEl.click(); });
dropEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileEl.click(); }
});
['dragover', 'drop'].forEach(function (ev) {
  dropEl.addEventListener(ev, function (e) {
    e.preventDefault();
    dropEl.classList.toggle('drag', ev === 'dragover');
    if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  boxEl.addEventListener(ev, function (e) {
    e.preventDefault();
    if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
});
dropEl.addEventListener('dragleave', function () { dropEl.classList.remove('drag'); });

async function loadFile(f) {
  if (!/pdf$/i.test(f.type || '') && !/\.pdf$/i.test(f.name || '')) {
    showErr('That is not a PDF — pick a .pdf file.');
    return;
  }
  showErr('');
  status('Opening <b>' + esc(f.name) + '</b>…');
  try {
    var buf = await f.arrayBuffer();
    origBytes = buf;
    pdfName = (f.name || 'notes.pdf').replace(/\.pdf$/i, '');
    var task = pdfjsLib.getDocument({ data: buf.slice(0) });
    pdf = await task.promise;
    pageCount = pdf.numPages;
    covers = {}; undoStack = []; redoStack = []; sel = null; cur = 1; zoom = 1;
    pageSizes = {};
    setTool('select');
    dropEl.hidden = true;
    workEl.hidden = false;
    resEl.hidden = true;
    fnameEl.textContent = f.name;
    pagesEl.textContent = pageCount + (pageCount === 1 ? ' page' : ' pages');
    pcEl.textContent = pageCount;
    await gotoPage(1);
    buildThumbs();
    refreshSummary();
    status('Loaded <b>' + pageCount + ' pages</b>. Draw on the page — <b>R</b> rect · <b>B</b> brush · <b>M</b> blur · <b>I</b> pick colour');
    workEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('[rapper] load', err);
    showErr('Could not open that PDF (' + (err && err.message || err) + '). Try another file.');
    status('Could not open that PDF. Try another file.');
  }
}
/* back to the dropzone */
function resetAll() {
  pdf = null; origBytes = null; pageCount = 0;
  covers = {}; undoStack = []; redoStack = []; sel = null;
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  workEl.hidden = true;
  resEl.hidden = true;
  progEl.hidden = true;
  dropEl.hidden = false;
  stripEl.innerHTML = '';
  showErr('');
}
$('rp-remove').addEventListener('click', resetAll);
$('rp-again').addEventListener('click', resetAll);
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/* ---------- page rendering ---------- */
async function gotoPage(n) {
  if (!pdf) return;
  cur = Math.max(1, Math.min(pageCount, n));
  pnEl.textContent = cur;
  sel = null;
  await renderPage();
  markThumb();
}
async function renderPage() {
  var my = ++renderToken;
  var page = await pdf.getPage(cur);
  if (my !== renderToken) return;
  var vp0 = page.getViewport({ scale: 1 });
  pageSizes[cur] = { w: vp0.width, h: vp0.height };
  var avail = Math.max(220, boxEl.clientWidth - 40);
  fitScale = avail / vp0.width;
  var scale = fitScale * zoom;
  /* keep canvases sane on huge sheets / deep zoom */
  var maxPx = 3600;
  if (vp0.width * scale > maxPx) scale = maxPx / vp0.width;
  if (vp0.height * scale > maxPx * 1.4) scale = (maxPx * 1.4) / vp0.height;
  var vp = page.getViewport({ scale: scale });
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  view = { scale: scale, w: vp.width, h: vp.height };
  [baseCv, overCv].forEach(function (cv) {
    cv.width = Math.round(vp.width * dpr);
    cv.height = Math.round(vp.height * dpr);
    cv.style.width = Math.round(vp.width) + 'px';
    cv.style.height = Math.round(vp.height) + 'px';
  });
  layersEl.style.width = Math.round(vp.width) + 'px';
  layersEl.style.height = Math.round(vp.height) + 'px';
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: bctx, viewport: vp }).promise;
  if (my !== renderToken) return;
  zvEl.textContent = Math.round(zoom * 100) + '%';
  drawOverlay();
}

/* ---------- overlay ---------- */
function drawOverlay() {
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, view.w, view.h);
  var list = covers[cur] || [];
  list.forEach(function (c) { drawCover(octx, c, false); });
  if (sel) {
    var c = findCover(cur, sel.id);
    if (c) drawCover(octx, c, true);
  }
}
function coverPath(ctx, c) {
  ctx.beginPath();
  if (c.type === 'ellipse') {
    ctx.ellipse(pt2css(c.x + c.w / 2), pt2css(c.y + c.h / 2),
      Math.abs(pt2css(c.w / 2)), Math.abs(pt2css(c.h / 2)), 0, 0, Math.PI * 2);
  } else if (c.type === 'brush') {
    /* union of discs along the stroke */
    (c.points || []).forEach(function (p, i) {
      var cx = pt2css(p[0]), cy = pt2css(p[1]);
      if (i) ctx.moveTo(cx + pt2css(c.radius), cy);
      ctx.arc(cx, cy, pt2css(c.radius), 0, Math.PI * 2);
    });
  } else {  /* rect + pixel preview box */
    var x = pt2css(Math.min(c.x, c.x + c.w)), y = pt2css(Math.min(c.y, c.y + c.h));
    ctx.rect(x, y, pt2css(Math.abs(c.w)), pt2css(Math.abs(c.h)));
  }
}
function drawCover(ctx, c, selected) {
  if (c.type === 'pixel') { drawPixelPreview(ctx, c); }
  else {
    ctx.save();
    ctx.globalAlpha = (c.opacity == null ? 1 : c.opacity);
    coverPath(ctx, c);
    ctx.fillStyle = c.color || '#fff';
    ctx.fill();
    ctx.restore();
  }
  if (!selected) return;
  /* selection frame + corner handles */
  var b = coverBounds(c);
  ctx.save();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(pt2css(b.x) - 3, pt2css(b.y) - 3, pt2css(b.w) + 6, pt2css(b.h) + 6);
  ctx.setLineDash([]);
  if (c.type !== 'brush') {
    ctx.fillStyle = '#fbbf24';
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(function (p) {
      ctx.fillRect(pt2css(p[0]) - 4, pt2css(p[1]) - 4, 8, 8);
    });
  }
  ctx.restore();
}
function coverBounds(c) {
  if (c.type === 'brush') {
    var xs = (c.points || []).map(function (p) { return p[0]; });
    var ys = (c.points || []).map(function (p) { return p[1]; });
    if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
    var r = c.radius || 8;
    var x0 = Math.min.apply(0, xs) - r, y0 = Math.min.apply(0, ys) - r;
    return { x: x0, y: y0, w: Math.max.apply(0, xs) - x0 + r, h: Math.max.apply(0, ys) - y0 + r };
  }
  return { x: Math.min(c.x, c.x + c.w), y: Math.min(c.y, c.y + c.h), w: Math.abs(c.w), h: Math.abs(c.h) };
}
/* mosaic preview: re-pixelate the base page under the region */
var pixTmp = null;
function drawPixelPreview(ctx, c) {
  var b = coverBounds(c);
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var dx = Math.round(pt2css(b.x) * dpr), dy = Math.round(pt2css(b.y) * dpr);
  var dw = Math.round(pt2css(b.w) * dpr), dh = Math.round(pt2css(b.h) * dpr);
  if (dw < 2 || dh < 2) return;
  dx = Math.max(0, Math.min(baseCv.width - 1, dx));
  dy = Math.max(0, Math.min(baseCv.height - 1, dy));
  dw = Math.min(baseCv.width - dx, dw); dh = Math.min(baseCv.height - dy, dh);
  try {
    var img = bctx.getImageData(dx, dy, dw, dh);
    /* preview blocks match export blocks: scale by (preview px/pt) / (export px/pt) */
    var dpiPrev = +((document.querySelector('input[name=rpdpi]:checked') || {}).value || 200);
    var blkPrev = Math.max(2, Math.round((c.block || 12) * (view.scale * dpr) / (dpiPrev / 72)));
    RC.pixelateRegion(img, { x: 0, y: 0, w: dw, h: dh }, blkPrev);
    if (!pixTmp) pixTmp = document.createElement('canvas');
    pixTmp.width = dw; pixTmp.height = dh;
    pixTmp.getContext('2d').putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixTmp, pt2css(b.x), pt2css(b.y), pt2css(b.w), pt2css(b.h));
    ctx.restore();
  } catch (e) { /* tainted / tiny — show a hatch instead */
    ctx.save();
    ctx.fillStyle = 'rgba(251,191,36,.25)';
    ctx.fillRect(pt2css(b.x), pt2css(b.y), pt2css(b.w), pt2css(b.h));
    ctx.restore();
  }
  /* dashed amber frame so the region is visible while editing */
  ctx.save();
  ctx.strokeStyle = 'rgba(251,191,36,.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(pt2css(b.x), pt2css(b.y), pt2css(b.w), pt2css(b.h));
  ctx.restore();
}

/* ---------- thumbnails ---------- */
async function buildThumbs() {
  var my = ++thumbToken;
  stripEl.innerHTML = '';
  var frag = document.createDocumentFragment();
  var figs = [];
  for (var p = 1; p <= pageCount; p++) {
    (function (pg) {
      var fig = document.createElement('figure');
      fig.className = 'rp-thumb' + (pg === cur ? ' cur' : '');
      fig.dataset.pg = pg;
      var cv = document.createElement('canvas');
      cv.width = 96; cv.height = 136;
      var cap = document.createElement('figcaption');
      cap.textContent = pg;
      var badge = document.createElement('span');
      badge.className = 'n'; badge.hidden = true; badge.textContent = '0';
      fig.appendChild(cv); fig.appendChild(cap); fig.appendChild(badge);
      fig.addEventListener('click', function () { gotoPage(pg); });
      frag.appendChild(fig);
      figs[pg] = { fig: fig, cv: cv, badge: badge };
    })(p);
  }
  stripEl.appendChild(frag);
  for (var q = 1; q <= pageCount; q++) {
    if (my !== thumbToken) return;
    try {
      var page = await pdf.getPage(q);
      var vp0 = page.getViewport({ scale: 1 });
      pageSizes[q] = { w: vp0.width, h: vp0.height };
      var s = 96 / vp0.width;
      var vp = page.getViewport({ scale: s });
      var cv = figs[q].cv;
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      var cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
    } catch (e) { /* leave the placeholder */ }
    if (my !== thumbToken) return;
  }
  refreshBadges();
}
function markThumb() {
  Array.prototype.forEach.call(stripEl.children, function (fig) {
    fig.classList.toggle('cur', +fig.dataset.pg === cur);
  });
  var curFig = stripEl.querySelector('.rp-thumb.cur');
  if (curFig) curFig.scrollIntoView({ block: 'nearest' });
}
function refreshBadges() {
  Array.prototype.forEach.call(stripEl.children, function (fig) {
    var n = (covers[+fig.dataset.pg] || []).length;
    var b = fig.querySelector('.n');
    b.hidden = !n; b.textContent = n;
  });
}
function refreshSummary() {
  var n = totalCovers();
  covchipEl.textContent = n + (n === 1 ? ' cover' : ' covers');
  $('rp-go').disabled = !n;
}

/* ---------- tools ---------- */
var toolBtns = Array.prototype.slice.call(document.querySelectorAll('.rp-toolbtn'));
function setTool(t) {
  tool = t;
  toolBtns.forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
  overCv.dataset.tool = t;
  var hints = {
    select: 'Click a cover to select · drag to move · corners resize · <b>Del</b> removes',
    rect: 'Drag a rectangle over the stamp — release to wrap it',
    ellipse: 'Drag an ellipse over the stamp — release to wrap it',
    brush: 'Paint over the stamp — release to finish the stroke',
    pixel: 'Drag a box — the area inside becomes a mosaic blur',
    drop: 'Click anywhere on the page to sample that exact colour'
  };
  if (pdf) status(hints[t] || '');
}
toolBtns.forEach(function (b) { b.addEventListener('click', function () { setTool(b.dataset.t); }); });

/* ---------- colour ---------- */
function setColor(hex, fromDrop) {
  color = hex;
  colorEl.value = hex;
  hexEl.textContent = hex;
  Array.prototype.forEach.call(swEl.children, function (b) {
    b.classList.toggle('on', b.dataset.c === hex);
  });
  /* live-recolour the selection */
  if (sel) {
    var c = findCover(cur, sel.id);
    if (c && c.type !== 'pixel') { pushUndo(); c.color = hex; drawOverlay(); }
  }
  if (fromDrop) {
    if (recent.indexOf(hex) < 0) {
      recent.unshift(hex); recent = recent.slice(0, 10);
      renderRecent();
    }
  }
}
SWATCHES.forEach(function (hex) {
  var b = document.createElement('button');
  b.className = 'rp-sw' + (hex === color ? ' on' : '');
  b.style.background = hex; b.title = hex; b.dataset.c = hex;
  b.addEventListener('click', function () { setColor(hex); });
  swEl.appendChild(b);
});
colorEl.addEventListener('input', function () { setColor(colorEl.value); });
function renderRecent() {
  recentEl.innerHTML = '';
  recent.forEach(function (hex) {
    var b = document.createElement('button');
    b.className = 'rp-sw'; b.style.background = hex; b.title = hex;
    b.addEventListener('click', function () { setColor(hex); });
    recentEl.appendChild(b);
  });
}
function sampleAt(cssX, cssY) {
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var dx = Math.round(cssX * dpr), dy = Math.round(cssY * dpr);
  if (dx < 0 || dy < 0 || dx >= baseCv.width || dy >= baseCv.height) return null;
  try {
    var d = bctx.getImageData(dx, dy, 1, 1).data;
    return RC.rgb255ToHex(d[0], d[1], d[2]);
  } catch (e) { return null; }
}

/* sliders */
opEl.addEventListener('input', function () {
  opacity = opEl.value / 100; opV.textContent = opEl.value + '%';
  if (sel) {
    var c = findCover(cur, sel.id);
    if (c && c.type !== 'pixel') { c.color = c.color; c.opacity = opacity; drawOverlay(); }
  }
});
/* snapshot BEFORE the drag mutates anything, so one undo restores pre-drag state */
opEl.addEventListener('pointerdown', function () { if (sel) pushUndo(); });
opEl.addEventListener('keydown', function () { if (sel) pushUndoKey(); });
var lastKeySnap = 0;
function pushUndoKey() {
  var now = Date.now();
  if (now - lastKeySnap > 800) { lastKeySnap = now; pushUndo(); }
}
brEl.addEventListener('input', function () { brushR = +brEl.value / 2; brV.textContent = brEl.value + ' pt'; });
blkEl.addEventListener('input', function () { blockPx = +blkEl.value; blkV.textContent = blkEl.value + ' px'; });

/* ---------- pointer editing ---------- */
var drag = null;   // {mode, cover, startPt, orig, corner}
overCv.style.touchAction = 'none';
overCv.addEventListener('pointerdown', onDown);
overCv.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
/* double-click / double-tap a cover to delete it (touch has no Del key) */
overCv.addEventListener('dblclick', function (e) {
  if (!pdf || exporting || tool !== 'select') return;
  var pos = evPos(e);
  var hi = RC.hitCover(covers[cur] || [], css2pt(pos.x), css2pt(pos.y), 10 / view.scale);
  if (hi >= 0) {
    pushUndo();
    covers[cur].splice(hi, 1);
    sel = null;
    drawOverlay(); refreshBadges(); refreshSummary();
    status('Cover deleted. <span class="cov">Undo:</span> Ctrl+Z');
  }
});

function onDown(e) {
  if (!pdf || exporting) return;
  overCv.setPointerCapture && overCv.setPointerCapture(e.pointerId);
  var pos = evPos(e);
  var pt = { x: css2pt(pos.x), y: css2pt(pos.y) };

  if (tool === 'drop') {
    var hex = sampleAt(pos.x, pos.y);
    if (hex) { setColor(hex, true); status('Sampled <b>' + hex + '</b> — now draw with it. Tool: <b>Rect</b>?'); setTool('rect'); }
    return;
  }
  if (tool === 'select') {
    /* resize handle first */
    if (sel) {
      var c0 = findCover(cur, sel.id);
      var corner = c0 && c0.type !== 'brush' ? hitCorner(c0, pt) : null;
      if (corner) { pushUndo(); drag = { mode: 'resize', cover: c0, corner: corner, start: pt, orig: { x: c0.x, y: c0.y, w: c0.w, h: c0.h } }; return; }
    }
    var list = covers[cur] || [];
    var hi = RC.hitCover(list, pt.x, pt.y, 10 / view.scale);   /* core returns an INDEX */
    if (hi >= 0) {
      var hit = list[hi];
      sel = { id: hit.id };
      pushUndo();
      var orig = hit.type === 'brush'
        ? { points: hit.points.map(function (p) { return [p[0], p[1]]; }) }
        : { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
      drag = { mode: 'move', cover: hit, start: pt, orig: orig, moved: false };
      drawOverlay();
    } else { sel = null; drawOverlay(); }
    return;
  }
  /* create tools */
  pushUndo();
  if (tool === 'brush') {
    var st = { id: 'c' + (uid++), type: 'brush', points: [[pt.x, pt.y]], radius: brushR, color: color, opacity: opacity };
    pageCovers(cur).push(st);
    drag = { mode: 'brush', cover: st };
  } else {
    var nc = { id: 'c' + (uid++), type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: color, opacity: opacity };
    if (tool === 'pixel') nc.block = blockPx;
    pageCovers(cur).push(nc);
    drag = { mode: 'create', cover: nc, start: pt };
  }
  sel = { id: drag.cover.id };
  drawOverlay();
}
function onMove(e) {
  if (!pdf) return;
  var pos = evPos(e);
  var pt = { x: css2pt(pos.x), y: css2pt(pos.y) };
  if (!drag) {
    /* hover cursor for select tool */
    if (tool === 'select' && sel) {
      var c = findCover(cur, sel.id);
      overCv.style.cursor = (c && c.type !== 'brush' && hitCorner(c, pt)) ? 'nwse-resize' : '';
    } else if (tool === 'select') {
      overCv.style.cursor = RC.hitCover(covers[cur] || [], pt.x, pt.y, 10 / view.scale) >= 0 ? 'move' : '';
    }
    return;
  }
  var c = drag.cover;
  if (drag.mode === 'create') {
    c.x = Math.min(drag.start.x, pt.x);
    c.y = Math.min(drag.start.y, pt.y);
    c.w = Math.abs(pt.x - drag.start.x);
    c.h = Math.abs(pt.y - drag.start.y);
  } else if (drag.mode === 'brush') {
    var last = c.points[c.points.length - 1];
    if (Math.hypot(pt.x - last[0], pt.y - last[1]) > 1.5 / view.scale) c.points.push([pt.x, pt.y]);
  } else if (drag.mode === 'move') {
    var dxm = pt.x - drag.start.x, dym = pt.y - drag.start.y;
    if (Math.abs(dxm) + Math.abs(dym) > 0) drag.moved = true;
    if (c.type === 'brush') {
      c.points = drag.orig.points.map(function (p) { return [p[0] + dxm, p[1] + dym]; });
    } else { c.x = drag.orig.x + dxm; c.y = drag.orig.y + dym; }
  } else if (drag.mode === 'resize') {
    var o = drag.orig, cn = drag.corner;
    var x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (cn[0] === 'w') x1 = pt.x; else x2 = pt.x;
    if (cn[1] === 'n') y1 = pt.y; else y2 = pt.y;
    c.x = Math.min(x1, x2); c.y = Math.min(y1, y2);
    c.w = Math.max(1, Math.abs(x2 - x1)); c.h = Math.max(1, Math.abs(y2 - y1));
  }
  drawOverlay();
}
function onUp() {
  if (!drag) return;
  var c = drag.cover, mode = drag.mode, moved = drag.moved;
  drag = null;
  overCv.style.cursor = '';
  /* discard accidental dots on shape tools */
  if (mode === 'create' && c.type !== 'brush' && (c.w < 3 || c.h < 3)) {
    covers[cur] = (covers[cur] || []).filter(function (k) { return k.id !== c.id; });
    sel = null;
    undoStack.pop();   /* creation never happened */
  } else if ((mode === 'move' && !moved) || mode === undefined) {
    undoStack.pop();   /* click without a drag: no mutation, drop the snapshot */
  }
  drawOverlay(); refreshBadges(); refreshSummary();
}
function hitCorner(c, pt) {
  var b = coverBounds(c), tol = 8 / view.scale;
  var near = function (px, py) { return Math.abs(pt.x - px) < tol && Math.abs(pt.y - py) < tol; };
  if (near(b.x, b.y)) return 'nw';
  if (near(b.x + b.w, b.y)) return 'ne';
  if (near(b.x, b.y + b.h)) return 'sw';
  if (near(b.x + b.w, b.y + b.h)) return 'se';
  return null;
}
function deleteSel() {
  if (!sel) return;
  pushUndo();
  covers[cur] = (covers[cur] || []).filter(function (k) { return k.id !== sel.id; });
  sel = null;
  drawOverlay(); refreshBadges(); refreshSummary();
}

/* ---------- batch actions ---------- */
$('rp-all').addEventListener('click', function () {
  if (!pdf) return;
  /* smart source: current page if it has covers, else the first page that does —
     so the button never "does nothing" just because you browsed to another page */
  var found = RC.chooseApplySource(covers, cur, pageCount);
  if (!found) {
    status('No covers anywhere yet — draw on any page first, then apply to all.');
    toast('Draw a cover first ✏️');
    return;
  }
  pushUndo();
  var tmpl = RC.cloneCovers(found.covers);
  for (var p = 1; p <= pageCount; p++) {
    if (p === found.page) continue;
    covers[p] = RC.cloneCovers(tmpl).map(function (c) { c.id = 'c' + (uid++); return c; });
  }
  drawOverlay(); refreshBadges(); refreshSummary();
  var msg = 'Applied <b>' + tmpl.length + ' cover' + (tmpl.length > 1 ? 's' : '') + '</b> from page ' +
    found.page + ' to all <b>' + pageCount + ' pages</b>';
  status(msg + '. <span class="cov">Undo:</span> Ctrl+Z');
  toast('✓ ' + tmpl.length + ' cover' + (tmpl.length > 1 ? 's' : '') + ' → all ' + pageCount + ' pages');
});
$('rp-clear1').addEventListener('click', function () {
  if (!pdf || !(covers[cur] || []).length) return;
  pushUndo();
  covers[cur] = []; sel = null;
  drawOverlay(); refreshBadges(); refreshSummary();
  status('Cleared page ' + cur + '.');
});
$('rp-clearall').addEventListener('click', function () {
  if (!pdf || !totalCovers()) return;
  pushUndo();
  covers = {}; sel = null;
  drawOverlay(); refreshBadges(); refreshSummary();
  status('Cleared every cover on every page.');
});

/* ---------- nav / zoom / history buttons ---------- */
$('rp-prev').addEventListener('click', function () { gotoPage(cur - 1); });
$('rp-next') && $('rp-next').addEventListener('click', function () { gotoPage(cur + 1); });
$('rp-zin').addEventListener('click', function () { setZoom(zoom * 1.25); });
$('rp-zout').addEventListener('click', function () { setZoom(zoom / 1.25); });
$('rp-zfit').addEventListener('click', function () { setZoom(1); });
$('rp-undo').addEventListener('click', doUndo);
$('rp-redo').addEventListener('click', doRedo);
$('rp-del').addEventListener('click', deleteSel);
function setZoom(z) {
  zoom = Math.max(0.25, Math.min(4, z));
  renderPage();
}

/* ---------- focus mode: whole viewport becomes the editor ---------- */
var focusBtn = $('rp-focus');
function setFocus(on) {
  var want = (on === undefined) ? !document.body.classList.contains('rp-focus') : !!on;
  document.body.classList.toggle('rp-focus', want);
  focusBtn.innerHTML = want ? '✕ Exit' : '⛶ Focus';
  focusBtn.title = want ? 'Exit full-screen edit (Esc)' : 'Full-screen edit (F)';
  if (want) status('Focus mode — tools on the left, big page on the right. <b>Esc</b> exits.');
  if (pdf) renderPage();   /* refit the page to its new (much bigger) box */
}
focusBtn.addEventListener('click', function () { setFocus(); });

/* ---------- keyboard ---------- */
document.addEventListener('keydown', function (e) {
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if (e.key === 'Escape') { setFocus(false); return; }
  if (!pdf || exporting) return;
  var k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 'r') setTool('rect');
  else if (k === 'e') setTool('ellipse');
  else if (k === 'b') setTool('brush');
  else if (k === 'm') setTool('pixel');
  else if (k === 'i') setTool('drop');
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
  else if (k === 'arrowleft') { e.preventDefault(); gotoPage(cur - 1); }
  else if (k === 'arrowright') { e.preventDefault(); gotoPage(cur + 1); }
  else if (k === 'f') setFocus();
  else if (k === '+' || k === '=') setZoom(zoom * 1.25);
  else if (k === '-' || k === '_') setZoom(zoom / 1.25);
  else if (k === '0') setZoom(1);
});

/* ---------- export ---------- */
var lastUrl = null;
$('rp-go').addEventListener('click', doExport);

async function doExport() {
  if (!pdf || exporting) return;
  var n = totalCovers();
  if (!n) { status('Nothing to export — draw some covers first.'); return; }
  exporting = true;
  var dpi = +((document.querySelector('input[name=rpdpi]:checked') || {}).value || 200);
  var fmt = ((document.querySelector('input[name=rpfmt]:checked') || {}).value || 'jpg');
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  progEl.hidden = false;
  resEl.hidden = true;
  setProg(2, 'preparing ' + n + ' covers…', '');
  var t0 = performance.now();
  try {
    var out = await PDFLib.PDFDocument.load(origBytes.slice(0));
    var pages = out.getPages();
    var rasterCount = 0;
    for (var p = 1; p <= pageCount; p++) {
      var list = covers[p] || [];
      if (!list.length) continue;
      var el = (performance.now() - t0) / 1000;
      var eta = p > 1 ? (' · ~' + Math.ceil(el / (p - 1) * (pageCount - p + 1)) + 's left') : '';
      setProg(2 + 96 * (p - 1) / pageCount, 'page ' + p + ' / ' + pageCount + '…', eta);
      var pg = pages[p - 1];
      var size = pg.getSize();
      if (RC.hasRaster(list)) {
        rasterCount++;
        await bakeRasterPage(out, pg, p, list, dpi, size, fmt);
      }
      RC.applyVectorCovers(pg, list, size.height);
      if (p % 2 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    setProg(98, 'saving…', '');
    var bytes = await out.save();
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    lastUrl = url;
    var name = pdfName + '-rapper.pdf';
    var secs = ((performance.now() - t0) / 1000).toFixed(1);
    setProg(100, 'done in ' + secs + 's', '');
    progEl.hidden = true;
    resEl.hidden = false;
    rsCovEl.textContent = n;
    rsMetaEl.textContent = pageCount + ' pages · ' +
      (rasterCount ? rasterCount + ' re-rendered at ' + dpi + ' dpi (' + fmt.toUpperCase() + ')' : 'all covers vector — text stays selectable');
    dlEl.href = url; dlEl.download = name;
    openEl.href = url;
    status('Wrapped <b>' + n + ' covers</b> into <b>' + esc(name) + '</b>.');
    toast('✓ <b>' + n + ' covers</b> baked into ' + esc(name));
    resEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error('[rapper] export', err);
    status('Export failed: ' + esc(err && err.message || err));
    progEl.hidden = true;
  } finally {
    exporting = false;
  }
}
function setProg(pct, msg, eta) {
  pfillEl.style.width = Math.round(pct) + '%';
  pstatusEl.textContent = msg;
  petaEl.textContent = eta || '';
}
/* re-render one page at export dpi, mosaic its pixel regions, embed over the original */
async function bakeRasterPage(out, pg, p, list, dpi, size, fmt) {
  var page = await pdf.getPage(p);
  var scale = dpi / 72;
  var vp = page.getViewport({ scale: scale });
  var cv = document.createElement('canvas');
  cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  var cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: cx, viewport: vp }).promise;
  var img = cx.getImageData(0, 0, cv.width, cv.height);
  list.forEach(function (c) {
    if (c.type !== 'pixel') return;
    var b = coverBounds(c);
    RC.pixelateRegion(img, {
      x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale
    }, c.block || 12);
  });
  cx.putImageData(img, 0, 0);
  var blob = await new Promise(function (res) {
    if (fmt === 'png') cv.toBlob(res, 'image/png');
    else cv.toBlob(res, 'image/jpeg', 0.93);
  });
  var ab = await blob.arrayBuffer();
  var emb = fmt === 'png' ? await out.embedPng(ab) : await out.embedJpg(ab);
  pg.drawImage(emb, { x: 0, y: 0, width: size.width, height: size.height });
}

/* ---------- scroll reveal (same pattern as the other apps — without this,
   every .reveal block stays at opacity:0 and the page looks blank) ---------- */
if ('IntersectionObserver' in window) {
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { threshold: 0.18 });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
} else {
  document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
}

console.info('[rapper] ' + BUILD + ' ready');
})();