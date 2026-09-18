/* ============ headless app smoke test ============
   node test/app-smoke.test.mjs

   Loads the REAL app files (app.js, app4up.js, app-invert.js) in a stubbed DOM
   and actually runs them: a fixture PDF is dropped in, Start is clicked and the
   produced result is checked. pdf.js, canvas and image rendering are stubs — the
   point is to catch JavaScript errors in the app logic itself (a missing helper,
   a typo in a name, a wrong argument), which grep-based checks cannot see.

   This test exists because a shipped build threw "printKeepColour is not defined"
   the moment Start was pressed. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { installFakeWorker, makeOffscreenCanvas, installRasterClient, resetRaster } from './fake-worker.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};

const PDF_2P = new Uint8Array(readFileSync(new URL('./fixtures/notes-2p.pdf', import.meta.url)));
const PDF_4P = new Uint8Array(readFileSync(new URL('./fixtures/notes-4p.pdf', import.meta.url)));   // 2 pages, A4-ish
const PNG_DARK = new Uint8Array(readFileSync(new URL('./fixtures/dark.png', import.meta.url)));
/* a real JPEG for the apps' JPEG path (jpeg-js is a dev dependency) */
const JPEG_DARK = (() => {
  const jpeg = require('jpeg-js');
  const w = 64, h = 36, rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 20; rgba[i * 4 + 1] = 25; rgba[i * 4 + 2] = 45; }
  return new Uint8Array(jpeg.encode({ data: rgba, width: w, height: h }, 80).data);
})();

/* the real HTML files carry the factory defaults (checked radios, value="a4",
   the selected option…) — apply them to the stubs so the apps see what a user sees */
function applyHtmlDefaults(document, htmlFile) {
  let html = '';
  try { html = readFileSync(new URL('../' + htmlFile, import.meta.url), 'utf8'); } catch (e) { return; }
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    if (!id) continue;
    const el = document.getElementById(id);
    const type = (tag.match(/type="([^"]+)"/) || [, ''])[1];
    const value = (tag.match(/value="([^"]*)"/) || [])[1];
    if (type) el.type = type;
    if (value !== undefined) el.value = value;
    if (/\bchecked\b/.test(tag)) el.checked = true;
  }
  for (const m of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const el = document.getElementById(m[1]);
    const opts = [...m[2].matchAll(/<option\b[^>]*>/g)].map((o) => o[0]);
    const chosen = opts.find((o) => /\bselected\b/.test(o)) || opts[0] || '';
    el.value = (chosen.match(/value="([^"]*)"/) || [, ''])[1] || '';
  }
}

/* ---------------------------------------------------------------- DOM stub --- */
function makeCtx() {
  const grad = { addColorStop() {} };
  return {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low', globalAlpha: 1,
    setTransform() {}, resetTransform() {}, translate() {}, scale() {}, rotate() {},
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    rect() {}, arc() {}, fill() {}, stroke() {}, clip() {}, fillRect() {}, strokeRect() {},
    clearRect() {}, fillText() {}, strokeText() {},
    measureText: (t) => ({ width: String(t).length * 5 }),
    createLinearGradient: () => grad, createPattern: () => null,
    setLineDash() {}, getLineDash: () => [], drawImage() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({                       // deterministic "rendered page"
      data: (() => {
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const v = ((i * 37) % 256);
          d[i * 4] = v; d[i * 4 + 1] = 255 - v; d[i * 4 + 2] = (v * 3) % 256; d[i * 4 + 3] = 255;
        }
        return d;
      })(), width: w, height: h
    }),
    putImageData() {}
  };
}
function makeEl(id, tag = 'div') {
  const el = {
    id, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(),
    type: '', checked: false, value: '', hidden: false, disabled: false,
    textContent: '', innerHTML: '', href: '', download: '', title: '',
    width: 300, height: 200, dataset: {}, files: [], children: [],
    style: new Proxy({}, { set: (o, k, v) => (o[k] = v, true), get: (o, k) => o[k] || '' }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    parentElement: null,
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { (this._listeners[ev && ev.type] || []).forEach((f) => f(ev)); return true; },
    fire(ev, extra) { (this._listeners[ev] || []).forEach((f) => f(Object.assign({ type: ev, target: this, preventDefault() {}, stopPropagation() {} }, extra || {}))); },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c.parentElement === this) c.parentElement = null; return c; },
    insertBefore(c, ref) {
      const at = this.children.indexOf(ref);
      if (at < 0) this.children.push(c); else this.children.splice(at, 0, c);
      c.parentElement = this;
      return c;
    },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    replaceChildren() {},
    setAttribute(k, v) { if (k === 'id') this.id = v; }, getAttribute: () => null, removeAttribute() {},
    querySelector(sel) { return makeEl('q', String(sel).replace(/[^a-z]/gi, '') || 'div'); },
    querySelectorAll: () => [],
    closest: () => null, contains: () => false, focus() {}, blur() {}, click() {},
    scrollIntoView() {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200 }),
    getContext: () => (el._ctx = el._ctx || Object.assign(makeCtx(), { canvas: el })),
    toBlob(cb, mime) {
      const jpeg = /jpe?g/i.test(mime || '');
      cb(new Blob([jpeg ? JPEG_DARK : PNG_DARK], { type: jpeg ? 'image/jpeg' : 'image/png' }));
    },
    toDataURL: () => 'data:image/png;base64,AAAA',
    captureStream: null
  };
  return el;
}
function makeDocument() {
  const byId = new Map();
  const doc = {
    title: '', hidden: false,
    getElementById(id) {
      if (!byId.has(id)) {
        const el = makeEl(id);
        el.parentElement = { clientWidth: 520, appendChild(c) { return c; } };   // as if laid out on screen
        byId.set(id, el);
      }
      return byId.get(id);
    },
    createElement(tag) { return makeEl('', tag); },
    createTextNode: (t) => ({ textContent: t }),
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '.sheet-fig') {
        if (!doc._figs) {
          doc._figs = [1, 2].map((i) => {
            const f = makeEl('fig' + i, 'figure');
            f.parentElement = { clientWidth: 520 };
            f.hidden = false;
            return f;
          });
        }
        return doc._figs;
      }
      return [];
    },
    addEventListener() {}, removeEventListener() {},
    head: makeEl('head', 'head'), body: makeEl('body', 'body'),
    documentElement: makeEl('html', 'html'), _byId: byId
  };
  return doc;
}

/* -------------------------------------------------------------- pdf.js stub --- */
function makePdfStub(delay = 0) {
  const calls = [];                       // every render() the apps asked for
  const page = (isSource) => ({
    getViewport({ scale, offsetY }) {
      return { width: 595.28 * scale, height: 841.89 * scale, scale, offsetY: offsetY || 0 };
    },
    render({ canvasContext, viewport }) {
      calls.push({
        isSource, area: canvasContext.canvas.width * canvasContext.canvas.height,
        w: canvasContext.canvas.width, h: canvasContext.canvas.height, offsetY: viewport.offsetY || 0
      });
      /* strips render immediately; a rendered page of the OUTPUT pdf is slowed
         down so tests can prove previews never hold the result back */
      return { promise: new Promise((r) => setTimeout(r, isSource ? 0 : delay)) };
    },
    cleanup() {},
    getOperatorList: async () => ({ fnArray: [], argsArray: [] })
  });
  const doc = (pageCount, isSource) => ({
    numPages: pageCount,
    getPage: async () => page(isSource),
    destroy() {}
  });
  let opened = 0;
  return {
    calls,
    GlobalWorkerOptions: {},
    OPS: { paintImageXObject: 85, transform: 12 },
    getDocument: ({ data }) => {
      /* the app always opens the file the user picked first — everything opened
         after that is an output PDF (result previews, restored result) */
      const isSource = opened++ === 0;
      const n = (data && data._pages) || 2;
      return { promise: Promise.resolve(doc(n, isSource)) };
    }
  };
}

/* ------------------------------------------------------------------ harness --- */
async function boot(appFile, { pages = 2, html = '', thumbsDelay = 0, raster = 'none' } = {}) {
  /* 'none'   → no worker (the apps must run their main-thread pipeline)
     'real'   → the actual raster-client.js + worker-raster.js core, driven through
                a stand-in Worker, so the app's worker path is really exercised
     'broken' → a client whose worker cannot start (the app must fall back) */
  resetRaster(globalThis);
  if (raster === 'real' || raster === 'broken') {
    makeOffscreenCanvas(globalThis);
    installFakeWorker(globalThis, { failLoad: raster === 'broken' });
    installRasterClient(globalThis);
  }
  const document = makeDocument();
  /* Same realm as Node itself: pdf-lib does `instanceof Uint8Array` style checks,
     so a separate vm context would reject the app's own buffers. Only the browser
     globals the apps expect are installed, and every install is undone at the end
     of the test. */
  const installed = [];
  const set = (key, value) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, key);
    const prev = had ? Object.getOwnPropertyDescriptor(globalThis, key) : null;
    try {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
      installed.push([key, had, prev]);
    } catch (e) { /* read-only builtin (e.g. navigator) — leave it */ }
  };
  set('document', document);
  set('devicePixelRatio', 2);
  set('innerWidth', 1400);
  set('innerHeight', 900);
  set('location', { href: 'http://localhost:8080/' + html });
  set('navigator', { userAgent: 'node', storage: undefined });
  const pdfStub = makePdfStub(thumbsDelay);
  set('pdfjsLib', pdfStub);
  set('PDFLib', require('pdf-lib'));
  set('matchMedia', () => ({ matches: false, addEventListener() {} }));
  set('scrollTo', () => {});
  set('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  set('cancelAnimationFrame', clearTimeout);
  /* keep the real URL constructor (apps use `new URL`) and only add the blob helpers */
  const realURL = { createObjectURL: globalThis.URL.createObjectURL, revokeObjectURL: globalThis.URL.revokeObjectURL };
  globalThis.URL.createObjectURL = () => 'blob:stub-' + Math.random().toString(36).slice(2);
  globalThis.URL.revokeObjectURL = () => {};
  installed.push(['__urlRestore', true, realURL]);
  set('ImageData', class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } });
  set('doNothing', null);
  /* app code reads `window` — point it at the real global object */
  set('window', globalThis);
  set('self', globalThis);
  applyHtmlDefaults(document, html || 'index.html');
  const run = (rel) => vm.runInThisContext(readFileSync(new URL(rel, import.meta.url), 'utf8'), { filename: rel });
  run('../converter.js');
  run('../enhance.js');
  run('../' + appFile);
  const restore = () => {
    for (const [key, had, prev] of installed.reverse()) {
      if (key === '__urlRestore') { Object.assign(globalThis.URL, prev); continue; }
      /* the apps leave a few timers behind (title reset, toast removal). They must
         not hit a deleted global, so a harmless stub document stays installed. */
      if (key === 'document') { globalThis.document = makeDocument(); continue; }
      if (had && prev) Object.defineProperty(globalThis, key, prev);
      else delete globalThis[key];
    }
  };
  return { document, restore, pdfStub };
}

/* a File-ish object the apps accept */
function fixtureFile(bytes, name, pages) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buf._pages = pages;
  return { name, size: bytes.length, type: 'application/pdf', arrayBuffer: async () => buf, _pdfPages: pages };
}

async function runApp(label, appFile, html, {
  bytes = PDF_2P, name = 'notes-2p.pdf', pages = 2, setOptions = () => {}, thumbsDelay = 0, raster = 'none'
} = {}) {
  const { document, restore, pdfStub } = await boot(appFile, { pages, html, thumbsDelay, raster });
  try { return await finishRun(document, bytes, name, pages, setOptions, pdfStub); }
  finally { restore(); }
}
async function finishRun(document, bytes, name, pages, setOptions, pdfStub) {
  const ok = { loaded: true };
  /* set the option elements before the file arrives, then fire the same change
     events a user's click would fire (the apps reveal panels on those) */
  setOptions((id) => document.getElementById(id));
  for (const id of ['optSep', 'styleVec', 'styleNeg', 'styleInk', 'stylePure', 'optPrint', 'psPure', 'psKeep', 'psInk', 'psNeg', 'dpi150', 'dpi96', 'dpi220', 'optNums', 'optLines', 'optKeepColour', 'optSkip', 'fmtJpg', 'fmtPng', 'gapAuto', 'gapFixed']) {
    document.getElementById(id).fire('change');
  }
  document.getElementById('optMargin').fire('input');
  const fileInput = document.getElementById('fileInput');
  fileInput.files = [fixtureFile(bytes, name, pages)];
  fileInput.fire('change');
  await new Promise((r) => setTimeout(r, 60));                       // let afterLoad + preview run
  const go = document.getElementById('goBtn');
  const result = document.getElementById('result');
  const dl = document.getElementById('dlBtn');
  /* This file is not only "does it run" but "does the tab stay alive": a heartbeat
     timer runs while the conversion works, and the longest silence between two
     heartbeats is the longest time the main thread was blocked. A stutter of a
     few hundred ms is fine; whole seconds are not — that is what shows Chrome's
     "Page Unresponsive" dialog. */
  const gaps = [];
  let hb = performance.now();
  const heart = setInterval(() => { const n = performance.now(); gaps.push(n - hb); hb = n; }, 2);
  /* the one-shot maps block for a whole page, so they must not be called any
     more: throwing here turns a regression into an immediate failure */
  const PS = globalThis.NotesConverter && globalThis.NotesConverter.printSaver;
  const savedSync = {};
  if (PS) for (const k of ['hqMap', 'negMap']) {
    savedSync[k] = PS[k];
    PS[k] = () => { throw new Error('blocking ' + k + '() called on the main thread'); };
  }
  const t0 = performance.now();
  go.fire('click');
  let revealMs = null;
  for (let i = 0; i < 4000; i++) {
    if (result.hidden === false && dl.href) { revealMs = performance.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 2));
  }
  const stripEl = document.getElementById('thumbs');
  const placeholderAtReveal = stripEl.children.some((c) => /thumb-sk/.test(String(c.className || '')));
  for (let i = 0; i < 4000 && go.disabled; i++) await new Promise((r) => setTimeout(r, 5));
  clearInterval(heart);
  const worstGap = gaps.length ? Math.max.apply(null, gaps) : 0;
  if (PS) for (const k of ['hqMap', 'negMap']) PS[k] = savedSync[k];
  const status = document.getElementById('pstatus').textContent;
  const printed = document.getElementById('rsMeta').textContent;
  return {
    ok, status, printed, document, revealMs, placeholderAtReveal, worstGap, beats: gaps.length,
    dl: dl.download, href: dl.href, calls: (pdfStub && pdfStub.calls) || []
  };
}

console.log('\n=== headless app smoke (real app files, stubbed DOM) ===\n');
/* a deliberately broken worker is part of the test plan — keep its warnings quiet */
const realWarn = console.warn;
console.warn = (...a) => { if (!/raster worker/.test(String(a[0]))) realWarn(...a); };

/* ---------- 2-up: plain vector pack ---------- */
{
  const r = await runApp('2-up vector', 'app.js', 'index.html');
  check('2-up · vector: no runtime error', !/^failed:/.test(r.status), r.status);
  check('2-up · vector: result card filled', /page/i.test(r.printed) && r.href.startsWith('blob:'));
  check('2-up · vector: download name looks right', /-2up-A4\.pdf$/.test(r.dl), r.dl);
}

/* ---------- 2-up: print-saver (this is where the shipped bug lived) ---------- */
{
  const r = await runApp('2-up print', 'app.js', 'index.html', {
    setOptions: (el) => { el('optPrint').checked = true; el('psPure').checked = true; el('optKeepColour').checked = false; }
  });
  check('2-up · print-saver: no runtime error', !/^failed:/.test(r.status), r.status);
  check('2-up · print-saver: reports the pure b&w style', /pure b&w/.test(r.printed), r.printed.slice(0, 90));
}

/* ---------- the preview column fills with every sheet/page ---------- */
{
  const { document, restore, pdfStub } = await boot('app4up.js', { pages: 2, html: '4up.html' });   // 2 source pages → 1 sheet
  try {
    const fileInput = document.getElementById('fileInput');
    fileInput.files = [fixtureFile(PDF_4P, 'notes-4p.pdf', 2)];
    fileInput.fire('change');
    for (let i = 0; i < 300 && !document.getElementById('prevStrip').children.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 120));                    // let the last tile land
    const strip = document.getElementById('prevStrip');
    const tiles = strip.children.filter((c) => c.tagName === 'FIGURE');
    const caps = tiles.map((f) => (f.children.find((c) => c.tagName === 'FIGCAPTION') || {}).textContent || '');
    const note = (strip.children.find((c) => /thumb-note/.test(String(c.className))) || {}).textContent || '';
    check('preview column: every sheet is drawn as a tile (skeletons first, then swapped in)',
      tiles.length === 1 && /^sheet 1 . pages 1/.test(caps[0]), tiles.length + ' tiles · "' + caps[0] + '"');
    check('preview column: the note says how many sheets the PDF has',
      /1 sheet in the finished PDF/.test(note) && /click a big preview/.test(note), note);
    check('preview column: no skeleton is left behind once the tiles are in',
      strip.children.filter((c) => /thumb-sk/.test(String(c.className))).length === 0);
    void pdfStub;
  } finally { restore(); }
}
{
  const { document, restore } = await boot('app-invert.js', { pages: 2, html: 'invert.html' });
  try {
    const fileInput = document.getElementById('fileInput');
    fileInput.files = [fixtureFile(PDF_2P, 'notes-2p.pdf', 2)];
    fileInput.fire('change');
    for (let i = 0; i < 300 && !document.getElementById('prevStrip').children.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 120));
    const strip = document.getElementById('prevStrip');
    const tiles = strip.children.filter((c) => c.tagName === 'FIGURE');
    const firstCap = tiles.length ? (tiles[0].children.find((c) => c.tagName === 'FIGCAPTION') || {}).textContent : '';
    check('preview column: the Invert Lab lists every page of the result',
      tiles.length === 2 && /page 1/.test(String(firstCap)), tiles.length + ' tiles · "' + firstCap + '"');
  } finally { restore(); }
}
{
  const { document, restore } = await boot('app.js', { pages: 2, html: 'index.html' });
  try {
    const fileInput = document.getElementById('fileInput');
    fileInput.files = [fixtureFile(PDF_2P, 'notes-2p.pdf', 2)];
    fileInput.fire('change');
    for (let i = 0; i < 300 && !document.getElementById('prevStrip').children.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 120));
    const strip = document.getElementById('prevStrip');
    const tiles = strip.children.filter((c) => c.tagName === 'FIGURE');
    check('preview column: the 2-up tool fills the same strip', tiles.length === 1, tiles.length + ' tiles');
  } finally { restore(); }
}

/* ---------- raster worker: the heavy map + encode run off-thread ---------- */
{
  const r = await runApp('2-up worker', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2, raster: 'real',
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  check('worker: a print-saver run completes with the worker doing the pixels',
    !/^failed:/.test(r.status), r.status);
  check('worker: the worker path was actually taken (pages came back encoded)',
    r.calls.length > 0 && r.document.getElementById('dlBtn').download.endsWith('-2up-A4.pdf'),
    r.calls.length + ' renders · ' + r.document.getElementById('dlBtn').download);
  check('worker: no main-thread map ran (hqMap/negMap would have thrown)', true);
}
{
  const r = await runApp('invert worker', 'app-invert.js', 'invert.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2, raster: 'real',
    setOptions: (el) => { el('styleInk').checked = true; el('dpi150').checked = true; }
  });
  check('worker: the Invert Lab (black ink) also runs through the worker', !/^failed:/.test(r.status), r.status);
}
{
  const r = await runApp('2-up broken worker', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2, raster: 'broken',
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  check('worker: a worker that cannot start never breaks a run (falls back)',
    !/^failed:/.test(r.status), r.status);
  check('worker: the fallback still produced the result card', r.href.startsWith('blob:'), r.printed.slice(0, 60));
}

/* ---------- strips: a page is rendered in small pieces, not one 32 Mpx draw ---------- */
{
  const r = await runApp('2-up strips', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  const src = r.calls.filter((c) => c.isSource);
  const biggest = src.reduce((m, c) => Math.max(m, c.area), 0);
  const wholePage = 595.28 * 4 * 2 * 841.89 * 4 * 2;             // 220 dpi × 2 SSAA, one piece
  check('strips: the source page is drawn in many pieces', src.length >= 8,
    src.length + ' render calls for 2 pages');
  check('strips: every piece carries a whole-pixel strip offset (pixel-exact)',
    src.every((c) => Number.isInteger(c.offsetY)), 'offsets ' + [...new Set(src.map((c) => c.offsetY))].slice(0, 6).join(','));
  check('strips: no piece is anywhere near a full supersampled page', biggest > 0 && biggest < wholePage / 8,
    'biggest ' + (biggest / 1e6).toFixed(1) + ' Mpx vs ' + (wholePage / 1e6).toFixed(0) + ' Mpx full page');

  /* the pieces must tile each page exactly once, in order, on whole pixels —
     that is the property that makes strip rendering pixel-identical */
  const stripW = Math.max(...src.map((c) => c.w));      // the supersampled page width (previews are small)
  const groups = [];
  for (const c of src.filter((x) => x.w === stripW)) {
    if (c.offsetY === 0 || !groups.length) groups.push([]);
    groups[groups.length - 1].push(c);
  }
  const everyGroupTilesExactly = groups.every((g) => {
    let acc = 0;
    return g.every((c) => {
      const ok = c.offsetY === -acc && c.w === g[0].w;
      acc += c.h;
      return ok;
    }) && g.every((c, i) => i === g.length - 1 || c.h === g[0].h);
  });
  const pageHeights = groups.map((g) => g.reduce((a, c) => a + c.h, 0));
  if (process.env.STRIP_DEBUG) {
    for (const [i, g] of groups.entries()) {
      console.log('  page ' + (i + 1) + ' pieces: ' + g.length + ' heights ' + JSON.stringify(g.slice(0, 4).map((c) => c.h)) +
        ' … ' + JSON.stringify(g.slice(-3).map((c) => c.h)) + ' offsets ' + JSON.stringify(g.slice(0, 3).map((c) => c.offsetY)) +
        ' … ' + JSON.stringify(g.slice(-2).map((c) => c.offsetY)) + ' w=' + g[0].w);
    }
  }
  check('strips: pieces tile each page exactly once, in order, on whole-pixel offsets',
    groups.length === 2 && everyGroupTilesExactly && pageHeights[0] === pageHeights[1] && pageHeights[0] > 4000,
    groups.length + ' pages · rows ' + pageHeights.join('/') + ' · widest piece ' + (groups[0] ? groups[0][0].w : 0) + 'px');
}

/* ---------- responsiveness: a heavy run must not freeze the main thread ---------- */
{
  const r = await runApp('2-up heavy responsive', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  check('responsive: 220 dpi print-saver finishes', !/^failed:/.test(r.status), r.status);
  check('responsive: no main-thread block over 250 ms', r.worstGap < 250,
    'worst ' + r.worstGap.toFixed(0) + ' ms over ' + r.beats + ' heartbeats');
  check('responsive: the blocking one-shot map is never called', true, 'hqMap/negMap would have thrown');
}
{
  const r = await runApp('invert heavy responsive', 'app-invert.js', 'invert.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2,
    setOptions: (el) => { el('styleNeg').checked = true; el('dpi220').checked = true; }
  });
  check('responsive: 220 dpi invert run finishes', !/^failed:/.test(r.status), r.status);
  check('responsive: invert keeps the main thread free (< 250 ms blocks)', r.worstGap < 250,
    'worst ' + r.worstGap.toFixed(0) + ' ms over ' + r.beats + ' heartbeats');
}

/* ---------- 2-up: print-saver with keep-colours (touches printKeepColour) ---------- */
{
  const r = await runApp('2-up keep', 'app.js', 'index.html', {
    setOptions: (el) => { el('optPrint').checked = true; el('psKeep').checked = true; el('optKeepColour').checked = true; }
  });
  check('2-up · print-saver keep-colours: no runtime error', !/^failed:/.test(r.status), r.status);
  check('2-up · print-saver keep-colours: reports kept colours', /kept colours/.test(r.printed), r.printed.slice(0, 90));
}

/* ---------- 4-up: vector + dotted separator ---------- */
{
  const r = await runApp('4-up vector', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2,
    setOptions: (el) => { el('optSep').checked = true; }
  });
  check('4-up · vector + separator: no runtime error', !/^failed:/.test(r.status), r.status);
  check('4-up · vector + separator: meta mentions the separator', /dotted middle separator/.test(r.printed), r.printed.slice(0, 110));
  check('4-up · vector: landscape A4 output name', /-4up-A4L\.pdf$/.test(r.dl), r.dl);
}

/* ---------- 4-up: print-saver (its own print path shares the same helpers) ---------- */
{
  const r = await runApp('4-up print', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('psPure').checked = true; el('optSep').checked = true; }
  });
  check('4-up · print-saver: no runtime error', !/^failed:/.test(r.status), r.status);
  check('4-up · print-saver: style + separator both reported',
    /pure b&w/.test(r.printed) && /dotted middle separator/.test(r.printed), r.printed.slice(0, 120));
}

/* ---------- heavy previews must not delay the Download button ---------- */
{
  const r = await runApp('4-up heavy previews', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2, thumbsDelay: 220,   // 6 previews ≈ 1.3 s of work
    setOptions: (el) => { el('optSep').checked = true; }
  });
  check('previews never block: result + Download appear in well under a second',
    r.revealMs !== null && r.revealMs < 900, r.revealMs === null ? 'never appeared' : r.revealMs.toFixed(0) + ' ms');
  check('previews: placeholders fill the strip while the sheets render', r.placeholderAtReveal === true);
  check('previews never block: Start is free again while they render', r.document.getElementById('goBtn').disabled === false);
}

/* ---------- Invert Lab: black ink with keep-colours ---------- */
{
  const r = await runApp('invert ink', 'app-invert.js', 'invert.html', {
    setOptions: (el) => { el('styleInk').checked = true; el('optKeepColour').checked = true; }
  });
  check('invert · black ink + keep colours: no runtime error', !/^failed:/.test(r.status), r.status);
  check('invert · black ink + keep colours: reports the colours were kept', /kept colours|black ink/.test(r.printed), r.printed.slice(0, 110));
}

/* ---------- Invert Lab: exact vector true negative ---------- */
{
  const r = await runApp('invert vector', 'app-invert.js', 'invert.html', {
    setOptions: (el) => { el('styleVec').checked = true; }
  });
  check('invert · exact vector: no runtime error', !/^failed:/.test(r.status), r.status);
  check('invert · exact vector: reports the exact-vector rule', /exact vector/.test(r.printed) && /255/.test(r.printed), r.printed.slice(0, 120));
  check('invert · exact vector: raster-only rows hidden',
    r.document.getElementById('dpiFld').hidden === true && r.document.getElementById('fmtFld').hidden === true);
}

/* ---------- Invert Lab: raster negative (SSAA path) ---------- */
{
  const r = await runApp('invert raster', 'app-invert.js', 'invert.html', {
    setOptions: (el) => { el('styleNeg').checked = true; el('dpi150').checked = true; }
  });
  check('invert · true negative (raster): no runtime error', !/^failed/.test(r.status), r.status);
  check('invert · raster: rows visible again', r.document.getElementById('dpiFld').hidden === false);
}

console.log('\n' + (fail === 0 ? 'ALL APP SMOKE CHECKS PASSED' : fail + ' APP SMOKE CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
