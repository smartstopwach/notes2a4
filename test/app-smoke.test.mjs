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
import { decodePNG } from '../tools/img-io.mjs';

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
    getImageData(x, y, w, h) {                             // deterministic "rendered page"
      const vp = this.__vp || { width: w, height: h, offsetY: 0 };
      return {
      data: (() => {
        const d = new Uint8ClampedArray(w * h * 4);
        const pattern = globalThis.__pagePattern;
        const notes = pattern === 'notes' || pattern === 'board';
        /* the coordinates are of the WHOLE page: a strip render asks for a window of
           it, so the pattern must be computed in page space (otherwise every strip
           would draw its own copy of the picture) */
        const pageW = vp.width || w, pageH = vp.height || h;
        /* which row of the page is the first row of this canvas? (a strip render
           draws the page shifted up, so page row = -offsetY + canvas row) */
        const pageTop = (vp.offsetY ? -vp.offsetY : 0) + y;

        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const i = yy * w + xx, o = i * 4;
            if (!notes) {                                   // synthetic colour noise
              const v = ((i * 37) % 256);
              d[o] = v; d[o + 1] = 255 - v; d[o + 2] = (v * 3) % 256; d[o + 3] = 255;
              continue;
            }
            /* a page someone would actually scan: white paper, a coloured banner,
               a dark heading and dark text lines — every rule of the ink map gets
               something to chew on, and "paper" really is paper */
            const fx = (x + xx) / pageW, fy = (pageTop + yy) / pageH;
            let rgb = [255, 255, 255];
            if (pattern === 'board') {
              /* white paper with a dark board panel (like page 2 of the colour
                 probe): the panel must print as paper with ink marks on it */
              if (fy > 0.12 && fy < 0.42 && fx > 0.12 && fx < 0.42) {
                rgb = [18, 23, 43];                                  // one solid dark board
                if ((Math.floor(fy * 90) % 12) === 0 && fx > 0.15 && fx < 0.4) rgb = [255, 255, 255];   // white strokes on it
              } else if (fy > 0.5 && fy < 0.58 && fx > 0.12 && fx < 0.6) rgb = [26, 26, 32];   // dark text
              d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
              continue;
            }
            if (fy < 0.12) rgb = [40, 120, 255];                        // blue banner
            else if (fy > 0.16 && fy < 0.20) rgb = [20, 20, 20];        // heading
            else if (fy > 0.25 && fy < 0.85 && (Math.floor(fy * 100) % 12) < 5) rgb = [35, 35, 35];  // text lines
            else if (fy > 0.88 && fx > 0.1 && fx < 0.5) rgb = [255, 220, 60];                        // yellow highlight
            else if (fy > 0.9 && fx > 0.6 && fx < 0.9) rgb = [200, 200, 200];                        // light grey box
            d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
          }
        }
        return d;
      })(), width: w, height: h
      };
    },
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
  /* innerHTML = '' really empties the element — several code paths (the preview
     strips, the result thumbnails) rely on that to clear before they fill */
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => _html,
    set: (v) => { _html = String(v == null ? '' : v); if (_html === '') el.children = []; },
    configurable: true
  });
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
    _ev: {},
    addEventListener(ev, fn) { (doc._ev[ev] = doc._ev[ev] || []).push(fn); },
    removeEventListener(ev, fn) { doc._ev[ev] = (doc._ev[ev] || []).filter((f) => f !== fn); },
    _fire(ev) { (doc._ev[ev] || []).forEach((f) => f({ type: ev })); },
    head: makeEl('head', 'head'), body: makeEl('body', 'body'),
    documentElement: makeEl('html', 'html'), _byId: byId
  };
  return doc;
}

/* -------------------------------------------------------------- pdf.js stub --- */
function makePdfStub(delay = 0, sourceDelay = 0, rafChunks = 0) {
  const calls = [];                       // every render() the apps asked for
  const cfg = { holdFrom: Infinity, holdMs: 0 };
  const page = (isSource) => ({
    getViewport({ scale, offsetY }) {
      /* the whole page at this scale — a strip render keeps this height and only
         shifts the page up by offsetY (the app passes -y0) */
      return { width: 595.28 * scale, height: 841.89 * scale, scale, offsetY: offsetY || 0 };
    },
    render({ canvasContext, viewport }) {
      /* the viewport belongs to THIS canvas: several renders (thumbnails, the
         preview strip, the pages of the run) are in flight at the same time, so a
         shared global would be overwritten between a render and its getImageData */
      canvasContext.__vp = viewport;
      calls.push({
        isSource, area: canvasContext.canvas.width * canvasContext.canvas.height,
        w: canvasContext.canvas.width, h: canvasContext.canvas.height, offsetY: viewport.offsetY || 0
      });
      if (rafChunks > 0) {
        /* exactly like pdf.js: `InternalRenderTask._scheduleNext` asks for an
           animation frame per chunk, and a hidden tab delivers none — this is the
           stall that froze a run at "19%" until the tab was looked at again */
        return {
          promise: new Promise((resolve) => {
            let left = rafChunks;
            const chunk = () => { if (--left <= 0) resolve(); else globalThis.requestAnimationFrame(chunk); };
            globalThis.requestAnimationFrame(chunk);
          })
        };
      }
      /* strips render immediately; a rendered page of the OUTPUT pdf is slowed
         down so tests can prove previews never hold the result back. `cfg.hold`
         lets one test stall the renders of the RUN itself (progress stops dead,
         which is what the estimate must not lie about). */
      const hold = calls.length === cfg.holdFrom ? cfg.holdMs : 0;   // one render, one stall
      return { promise: new Promise((r) => setTimeout(r, hold || (isSource ? sourceDelay : delay))) };
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
    calls, cfg,
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
async function boot(appFile, { pages = 2, html = '', thumbsDelay = 0, raster = 'none', sourceDelay = 0, rafChunks = 0 } = {}) {
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
  const pdfStub = makePdfStub(thumbsDelay, sourceDelay, rafChunks);
  set('pdfjsLib', pdfStub);
  {
    /* every page image that reaches the output PDF is captured, so a test can look
       at the pixels the app really shipped — not at what it says it did */
    const lib = require('pdf-lib');
    /* pdf-lib is CACHED by require(), so this wrap may already be in place from an
       earlier boot; the capture list lives once on the module and every run is a
       slice of it (wrapping again would push the same image twice and a stale list
       would make a test look at another run's page) */
    if (!lib.__capture) {
      const captured = [];
      /* embedPng/embedJpg are instance methods (out.embedPng(...)), so the prototype
         is what has to be wrapped */
      for (const fn of ['embedPng', 'embedJpg']) {
        const orig = lib.PDFDocument.prototype[fn];
        lib.PDFDocument.prototype[fn] = function (b, ...rest) { captured.push(Buffer.from(b)); return orig.call(this, b, ...rest); };
      }
      lib.__capture = captured;
    }
    globalThis.__capturedImages = lib.__capture;
    globalThis.__captureStart = lib.__capture.length;
    set('PDFLib', lib);
  }
  set('matchMedia', () => ({ matches: false, addEventListener() {} }));
  set('scrollTo', () => {});
  /* Chrome fires NO animation frames while the tab is hidden, so neither does the
     stub: a frame asked for in a hidden tab stays parked until the tab is visible
     again. Code that waits for a frame in a background tab therefore hangs here
     exactly like it did in the browser (pdf.js drives every render chunk with
     requestAnimationFrame), and NotesFX.keepRendering() is what un-sticks it. */
  const frames = new Map(); let frameSeq = 0;
  const framePump = () => {
    if (!frames.size) return;
    if (document.hidden) { setTimeout(framePump, 16); return; }        // hidden: hold them
    const due = [...frames.values()]; frames.clear();
    for (const fn of due) { try { fn(Date.now()); } catch (e) { console.error(e); } }
    if (frames.size) setTimeout(framePump, 0);
  };
  set('requestAnimationFrame', (fn) => { frames.set(++frameSeq, fn); setTimeout(framePump, 0); return frameSeq; });
  set('cancelAnimationFrame', (id) => frames.delete(id));
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
      /* a boot's own timers (title reset, the preview strip finishing after a run)
         may still fire after the test moves on — browser-API stubs stay installed
         so a late callback cannot crash the run; app-specific globals (pdfjsLib,
         the fixture pdf, location) are restored normally */
      if (['document', 'window', 'self', 'ImageData', 'Blob', 'URL', 'requestAnimationFrame',
        'cancelAnimationFrame', 'matchMedia', 'scrollTo', 'devicePixelRatio', 'innerWidth',
        'innerHeight'].indexOf(key) >= 0) { continue; }
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
  bytes = PDF_2P, name = 'notes-2p.pdf', pages = 2, setOptions = () => {}, thumbsDelay = 0, raster = 'none', sourceDelay = 0,
  rafChunks = 0, beforeRun = null, pagePattern = 'noise'
} = {}) {
  const { document, restore, pdfStub } = await boot(appFile, { pages, html, thumbsDelay, raster, sourceDelay, rafChunks });
  globalThis.__pagePattern = pagePattern;
  try { return await finishRun(document, bytes, name, pages, setOptions, pdfStub, { beforeRun }); }
  finally { globalThis.__pagePattern = 'noise'; restore(); }
}
async function finishRun(document, bytes, name, pages, setOptions, pdfStub, opts = {}) {
  const ok = { loaded: true };
  /* set the option elements before the file arrives, then fire the same change
     events a user's click would fire (the apps reveal panels on those) */
  setOptions((id) => document.getElementById(id));
  for (const id of ['optSep', 'styleVec', 'styleNeg', 'styleInk', 'stylePure', 'optPrint', 'psPure', 'psKeep', 'psInk', 'psNeg', 'dpi150', 'dpi96', 'dpi220', 'optNums', 'optLines', 'optKeepColour', 'optSkip', 'fmtJpg', 'fmtPng', 'gapAuto', 'gapFixed', 'psWhite', 'styleWhite']) {
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
  /* tests use this to change the world at the moment the run starts: hide the tab
     (the user switching away) or shorten the estimate's patience */
  if (opts.beforeRun) opts.beforeRun(document);
  const t0 = performance.now();
  const statusSeen = [];
  globalThis.__statusSeen = statusSeen;
  /* three dials must agree and none may lie: the sentence (status), the chip
     (estimate) and the tab title (the only one a hidden tab can show) */
  const etaSeen = [], titleSeen = [];
  const watchStatus = setInterval(() => {
    const t = document.getElementById('pstatus').textContent;
    if (statusSeen[statusSeen.length - 1] !== t) statusSeen.push(t);
    const e = document.getElementById('pEta').textContent;
    if (etaSeen[etaSeen.length - 1] !== e) etaSeen.push(e);
    const ti = document.title;
    if (titleSeen[titleSeen.length - 1] !== ti) titleSeen.push(ti);
  }, 3);
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
  clearInterval(watchStatus);
  const worstGap = gaps.length ? Math.max.apply(null, gaps) : 0;
  if (PS) for (const k of ['hqMap', 'negMap']) PS[k] = savedSync[k];
  const status = document.getElementById('pstatus').textContent;
  const printed = document.getElementById('rsMeta').textContent;
  const runMs = performance.now() - t0;
  return {
    ok, status, printed, document, revealMs, placeholderAtReveal, worstGap, beats: gaps.length, runMs,
    dl: dl.download, href: dl.href, calls: (pdfStub && pdfStub.calls) || [],
    statusSeen: statusSeen, etaSeen: etaSeen, titleSeen: titleSeen,
    images: (globalThis.__capturedImages || []).slice(globalThis.__captureStart || 0),
    eta: document.getElementById('pEta').textContent
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

/* ---------- a hidden tab must cost less, never more ---------- */
{
  const { document, restore } = await boot('app.js', { pages: 2, html: 'index.html' });
  try {
    /* no frames in a background tab: uiPaint must not sit waiting for one */
    let rafCalls = 0;
    const savedRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => { rafCalls++; return 0; };     // never calls back
    document.hidden = true;
    const t0 = performance.now();
    await globalThis.NotesFX.uiPaint(true);
    const ms = performance.now() - t0;
    check('background: a hidden tab never waits for a frame (uiPaint returns at once)',
      ms < 60 && rafCalls === 0, ms.toFixed(1) + ' ms · raf calls ' + rafCalls);
    document.hidden = false;
    globalThis.requestAnimationFrame = savedRaf;
  } finally { restore(); }
}
{
  /* the preview strip parks itself while the tab is hidden and finishes on return */
  const { document, restore } = await boot('app4up.js', { pages: 2, html: '4up.html' });
  try {
    const fileInput = document.getElementById('fileInput');
    document.hidden = true;                                  // the user is looking at another tab
    fileInput.files = [fixtureFile(PDF_4P, 'notes-4p.pdf', 2)];
    fileInput.fire('change');
    await new Promise((r) => setTimeout(r, 150));
    const strip = document.getElementById('prevStrip');
    const note = (strip.children.find((c) => /thumb-note/.test(String(c.className))) || {}).textContent || '';
    const parkedTiles = strip.children.filter((c) => c.tagName === 'FIGURE').length;
    check('background: the strip refuses to draw while the tab is hidden (and says so)',
      parkedTiles === 0 && /paused/.test(note), parkedTiles + ' tiles · ' + note);
    document.hidden = false;
    document._fire('visibilitychange');                       // the user comes back
    for (let i = 0; i < 400 && !strip.children.some((c) => c.tagName === 'FIGURE'); i++) await new Promise((r) => setTimeout(r, 10));
    const tiles = strip.children.filter((c) => c.tagName === 'FIGURE').length;
    const note2 = (strip.children.find((c) => /thumb-note/.test(String(c.className))) || {}).textContent || '';
    check('background: coming back finishes the strip', tiles === 1 && !/paused/.test(note2),
      tiles + ' tiles · ' + note2);
  } finally { restore(); }
}
{
  /* a run in a hidden tab still finishes — and does not get slower */
  const vis = await runApp('visible run', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  const { document, restore } = await boot('app.js', { pages: 2, html: 'index.html' });
  let hiddenMs = 0;
  try {
    document.hidden = true;                                   // looking at another tab
    document.getElementById('optPrint').checked = true;
    document.getElementById('dpi220').checked = true;
    document.getElementById('psInk').checked = true;
    for (const id of ['optPrint', 'dpi220', 'psInk']) document.getElementById(id).fire('change');
    const fileInput = document.getElementById('fileInput');
    fileInput.files = [fixtureFile(PDF_2P, 'notes-2p.pdf', 2)];
    fileInput.fire('change');
    await new Promise((r) => setTimeout(r, 120));
    const t0 = performance.now();
    document.getElementById('goBtn').fire('click');
    for (let i = 0; i < 4000 && document.getElementById('goBtn').disabled; i++) await new Promise((r) => setTimeout(r, 5));
    hiddenMs = performance.now() - t0;
    check('background: a 220 dpi run completes in a hidden tab',
      document.getElementById('rsMeta').textContent.length > 0 && document.getElementById('pstatus').textContent === 'done',
      document.getElementById('pstatus').textContent);
    check('background: no live preview was painted for a hidden tab (nothing to copy)',
      document.getElementById('pstatus').textContent === 'done', 'live panel is skipped when hidden');
  } finally { restore(); }
  /* the visible run above is the reference: a hidden tab must not add work on top
     of the same job (no frames to wait for, no live preview to copy) */
  check('background: the hidden run is not slower than the visible one (same work, less DOM)',
    hiddenMs > 0 && vis.runMs > 0 && hiddenMs <= vis.runMs * 1.35,
    'hidden ' + hiddenMs.toFixed(0) + ' ms vs visible ' + vis.runMs.toFixed(0) + ' ms');
}

/* ---------- the tab title must keep moving while the tab is hidden ---------- */
{
  const { document, restore } = await boot('app4up.js', { pages: 2, html: '4up.html', sourceDelay: 40 });
  try {
    document.hidden = true;                                   // the user is on another tab
    document.title = 'Notes2A4 · 4-up Studio';
    const fileInput = document.getElementById('fileInput');
    fileInput.files = [fixtureFile(PDF_4P, 'notes-4p.pdf', 2)];
    fileInput.fire('change');
    await new Promise((r) => setTimeout(r, 100));
    for (const id of ['optPrint', 'dpi220']) { document.getElementById(id).checked = true; document.getElementById(id).fire('change'); }
    const titles = [];
    const watch = setInterval(() => {
      const t = document.title;
      if (titles[titles.length - 1] !== t) titles.push(t);
    }, 100);
    document.getElementById('goBtn').fire('click');
    for (let i = 0; i < 4000 && document.getElementById('goBtn').disabled; i++) await new Promise((r) => setTimeout(r, 5));
    clearInterval(watch);
    const pcts = titles.map((t) => parseInt((t.match(/(\d+)%/) || [])[1], 10)).filter((n) => !isNaN(n));
    check('background: the tab title keeps counting up while the tab is hidden',
      new Set(pcts).size >= 3 && pcts[pcts.length - 1] > pcts[0],
      titles.slice(0, 5).join(' → ').slice(0, 160));
    check('background: no title ever shows NaN', !/NaN/.test(titles.join(' ')), titles.length + ' titles seen');
  } finally { restore(); }
}

/* ---------- White paper: paper stays paper, everything else becomes ink ----------
   The reported problem: on a page that is already white, Black ink and Pure B&W do
   nothing at all (bright pages pass through untouched), so the two look identical.
   This is the mode that still cleans such a page — verified on the pixels that end
   up inside the produced PDF, not on what the UI says. */
{
  const run4 = (styleId) => runApp('white-paper ' + styleId, 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2, raster: 'real', pagePattern: 'notes',
    setOptions: (el) => { el('optPrint').checked = true; el('dpi150').checked = true; el(styleId).checked = true; }
  });
  /* The page image is scaled into the sheet, so the browser's own resampling puts
     a halo of near-, not exactly-, white pixels around every edge. The bands below
     are tolerant on purpose: "paper" is bright, "ink" is dark, and a washed-out
     grey is what a half-covered pixel of the WRONG rule looks like. */
  const stats = (bytes) => {
    const img = decodePNG(bytes);
    let white = 0, black = 0, coloured = 0, brightGrey = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const r = img.data[i * 3], g = img.data[i * 3 + 1], b = img.data[i * 3 + 2];
      const L = (r * 299 + g * 587 + b * 114) / 1000;
      if (L >= 245) white++;
      else if (L <= 12) black++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) coloured++;
      if (L > 90 && L < 235) brightGrey++;
    }
    return { w: img.w, h: img.h, n: img.w * img.h, white, black, coloured, brightGrey };
  };
  const inkRun = await run4('psInk');
  const pureRun = await run4('psPure');
  const whiteRun = await run4('psWhite');
  const ink = stats(inkRun.images[0]);
  const pure = stats(pureRun.images[0]);
  const wp = stats(whiteRun.images[0]);
  const same = (a, b) => a.w === b.w && a.white === b.white && a.black === b.black &&
    a.coloured === b.coloured && a.brightGrey === b.brightGrey;
  check('white paper: on a light page, Black ink and Pure B&W ship the same image (the reported bug)',
    same(ink, pure) && same(ink, whiteRun.images[0]) === false,
    'ink(k' + ink.brightGrey + '/c' + ink.coloured + ') · pure(k' + pure.brightGrey + '/c' + pure.coloured +
    ') · white(k' + wp.brightGrey + '/c' + wp.coloured + ')');
  check('white paper: the page survives (it is not flipped into a black sheet)',
    wp.white > wp.n * 0.4 && whiteRun.status === 'done',
    (100 * wp.white / wp.n).toFixed(0) + '% paper · status ' + whiteRun.status);
  check('white paper: paper is never turned into ink (the paper area is kept)',
    wp.white > 0 && wp.white >= ink.white * 0.9,
    wp.white + ' paper pixels (' + (100 * wp.white / wp.n).toFixed(0) + '%) vs ' + ink.white + ' on the untouched page');
  check('white paper: every colour becomes ink (the untouched page kept them)',
    ink.coloured > ink.n * 0.05 && wp.coloured < ink.coloured * 0.02,
    ink.coloured + ' coloured pixels on the untouched page → ' + wp.coloured + ' with white paper');
  check('white paper: far less washed-out grey than the untouched page (cleaner to print)',
    wp.brightGrey < ink.brightGrey * 0.35,
    wp.brightGrey + ' vs ' + ink.brightGrey + ' on the untouched page');
  /* the board rule must reach the real app too: a light page holding a dark panel */
  {
    const brd = await runApp('white-paper board', 'app4up.js', '4up.html', {
      bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2, raster: 'real', pagePattern: 'board',
      setOptions: (el) => { el('optPrint').checked = true; el('dpi150').checked = true; el('psWhite').checked = true; }
    });
    const img = decodePNG(brd.images[0]);
    const at = (x, y) => img.data[(y * img.w + x) * 3];
    /* the stub's board panel: page 10–45% tall, 10–45% wide; strokes inside it */
    const bx0 = Math.round(img.w * 0.12), by0 = Math.round(img.h * 0.12);
    const bx1 = Math.round(img.w * 0.42), by1 = Math.round(img.h * 0.42);
    let light = 0, dark = 0;
    for (let y = by0 + 4; y < by1 - 4; y++) for (let x = bx0 + 4; x < bx1 - 4; x++) {
      const v = at(x, y); if (v >= 240) light++; else if (v <= 15) dark++;
    }
    check('white paper + board: a dark panel inside the page ships as paper with ink on it',
      light > dark * 2, light + ' light vs ' + dark + ' dark pixels inside the panel');
    check('white paper + board: the paper outside the panel is untouched',
      at(4, 4) === 255 && at(img.w - 5, img.h - 5) === 255 && brd.status === 'done',
      'status ' + brd.status);
  }

  check('white paper: the result card names the mode',
    /white kept/.test(whiteRun.printed), whiteRun.printed.slice(0, 90));

  /* Invert Lab has the same style, and its own status line must name it */
  const invRun = await runApp('invert white paper', 'app-invert.js', 'invert.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2, raster: 'real', pagePattern: 'notes',
    setOptions: (el) => { el('styleWhite').checked = true; el('fmtPng').checked = true; }
  });
  const iv = stats(invRun.images[0]);
  check('white paper: Invert Lab ships the same rule (colours gone, paper intact)',
    invRun.status === 'done' && iv.coloured === 0 && iv.white > iv.n * 0.3,
    'status ' + invRun.status + ' · ' + iv.coloured + ' coloured · ' + (100 * iv.white / iv.n).toFixed(0) + '% paper');
  check('white paper: Invert Lab says which style it used',
    /white paper \(colour → black\)/.test(invRun.printed), invRun.printed.slice(0, 110));
}

/* ---------- a hidden tab delivers no frames: the fix for "19% and stuck" ----------
   pdf.js schedules every render chunk with requestAnimationFrame
   (`InternalRenderTask._scheduleNext`), a hidden tab fires none, so the render
   promise never settled — the run froze at the page it was on while the ticker
   kept re-painting that same percentage with a time left that grew and grew. */
{
  const { document, restore } = await boot('app4up.js', { pages: 2, html: '4up.html' });
  try {
    const fx = globalThis.NotesFX;
    const seen = [];
    document.hidden = true;
    globalThis.requestAnimationFrame(() => seen.push('stuck'));
    await new Promise((r) => setTimeout(r, 40));
    check('hidden frames: a hidden tab delivers no frame at all (the stall pdf.js hits)',
      seen.length === 0, seen.join(',') || 'no frame, exactly like Chrome');
    fx.keepRendering(true);                                     // what the apps do for a run
    globalThis.requestAnimationFrame(() => seen.push('awake'));
    for (let i = 0; i < 60 && !seen.includes('awake'); i++) await new Promise((r) => setTimeout(r, 5));
    check('hidden frames: while a run is active the frame arrives anyway (message channel, not a timer)',
      seen.includes('awake'), seen.join(',') || '(nothing arrived)');
    fx.keepRendering(false);
    globalThis.requestAnimationFrame(() => seen.push('after'));
    await new Promise((r) => setTimeout(r, 40));
    check('hidden frames: the hook is removed when the run ends (an idle hidden tab stays idle)',
      !seen.includes('after'), seen.join(','));
  } finally { restore(); }
}
{
  /* the user's exact scenario: the run is started, then the tab is switched away,
     and every single page render is a requestAnimationFrame chain (as in pdf.js) */
  const r = await runApp('4-up hidden mid-run', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2, raster: 'real', rafChunks: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; },
    beforeRun: (document) => { document.hidden = true; }        // the user looks at another tab
  });
  const titles = r.titleSeen || [];
  const pcts = titles.map((t) => parseInt((t.match(/(\d+)%/) || [])[1], 10)).filter((n) => !isNaN(n));
  check('hidden run: the run finishes even though every page render needed a frame',
    r.status === 'done' && r.calls.length > 0,
    r.status + ' · ' + r.calls.length + ' renders asked for');
  check('hidden run: the percentage kept climbing while the tab was away',
    new Set(pcts).size >= 3 && pcts[pcts.length - 1] > pcts[0],
    titles.slice(0, 4).join(' → ').slice(0, 150));
  check('hidden run: the title never froze on one number while the estimate grew',
    !/NaN/.test(titles.join(' ')) && r.eta === '' && r.status === 'done',
    'titles ' + titles.length + ' · final chip "' + r.eta + '"');
}
{
  /* a phase that stops moving must not keep promising a smaller time left: the chip
     says "still working…" instead of a number that grows while nothing happens */
  const r = await runApp('stalled phase', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; },
    beforeRun: () => {
      const stub = globalThis.pdfjsLib;
      stub.cfg.holdFrom = stub.calls.length + 1;                // the run's very next render
      stub.cfg.holdMs = 1200;                                  // one strip takes 1.2 s
      globalThis.NotesFX.stuckMs = 250;                         // patience for the test
    }
  });
  const eta = (r.etaSeen || []).join(' | ');
  check('stalled phase: the chip stops quoting a number once nothing has moved',
    /still working/.test(eta), eta.slice(0, 160) || '(nothing seen)');
  check('stalled phase: it recovers on its own and ends clean',
    r.status === 'done' && r.eta === '', 'status ' + r.status + ' · chip "' + r.eta + '"');
}

/* ---------- the wait must be legible: percentage + time left ---------- */
{
  const r = await runApp('2-up wait legible', 'app.js', 'index.html', {
    bytes: PDF_2P, name: 'notes-2p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; el('psInk').checked = true; }
  });
  const seen = (r.statusSeen || []).join(' | ');
  check('wait: the status reports the page and the phase while it runs',
    /page \d+ of \d+/.test(seen) && /binarising|rendering the page|placing page images|writing the file/.test(seen),
    seen.slice(0, 130) || '(nothing seen)');
  check('wait: it ends on the finished result', /done/.test(r.status), r.status);
  void seen;
}
{
  /* a "time left" string appears as soon as there is something to extrapolate */
  const r = await runApp('4-up wait', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2, sourceDelay: 45,     // ~2.5 s of rendering: long enough to estimate
    setOptions: (el) => { el('optPrint').checked = true; el('dpi220').checked = true; }
  });
  const seen = (r.statusSeen || []).join(' | ');
  const eta = (r.etaSeen || []).join(' | ');
  const titles = (r.titleSeen || []).join(' | ');
  check('wait: the chip says it is still working out the estimate, then gives one',
    /estimating time left/.test(eta) && /s left|min|almost done/.test(eta), eta.slice(0, 190) || '(nothing seen)');
  check('wait: neither the phase text nor the chip ever says undefined or NaN',
    !/undefined|NaN/.test(seen) && !/undefined|NaN/.test(eta), seen.slice(0, 90));
  check('wait: the estimate lives in its own chip, not appended to the sentence',
    !/estimating time left|s left/.test(seen) && r.eta === '', seen.slice(0, 90) + ' ‖ chip: "' + r.eta + '"');
  check('wait: the chip is empty once the run is done (nothing left to wait for)',
    r.status === 'done' && r.eta === '', 'status "' + r.status + '", chip "' + r.eta + '"');
  check('wait: the tab title shows the same numbers (percentage, and the estimate)',
    /\u23f3 \d+%/.test(titles) && !/NaN/.test(titles) && /~\d+ s|~1 min|almost done/.test(titles),
    titles.slice(-160) || '(no title seen)');
}

/* ---------- previews pause during a run, then finish themselves ---------- */
{
  const { document, restore } = await boot('app4up.js', { pages: 2, html: '4up.html' });
  try {
    const strip = document.getElementById('prevStrip');
    const stripApi = globalThis.NotesFX.thumbStrip(strip, 3, 'drawing…');
    stripApi.place(Object.assign(document.createElement('figure'), { tagName: 'FIGURE' }), 0);
    stripApi.prune('previews paused while the PDF is being made — they come back when it finishes');
    const skeletons = strip.children.filter((c) => /thumb-sk/.test(String(c.className))).length;
    const note = (strip.children.find((c) => /thumb-note/.test(String(c.className))) || {}).textContent || '';
    check('pause: pruning drops the empty slots but keeps the drawn ones',
      skeletons === 0 && /previews paused while the PDF is being made/.test(note), note);
  } finally { restore(); }
}
{
  const r = await runApp('4-up resume', 'app4up.js', '4up.html', {
    bytes: PDF_4P, name: 'notes-4p.pdf', pages: 2,
    setOptions: (el) => { el('optPrint').checked = true; el('dpi150').checked = true; }
  });
  await new Promise((r2) => setTimeout(r2, 700));           // the resume runs 400 ms after the result
  const strip = r.document.getElementById('prevStrip');
  const tiles = strip.children.filter((c) => c.tagName === 'FIGURE').length;
  const note = (strip.children.find((c) => /thumb-note/.test(String(c.className))) || {}).textContent || '';
  check('pause: after the run the strip ends up complete (no paused note, no skeletons)',
    tiles === 1 && !/paused/.test(note) && /1 sheet in the finished PDF/.test(note),
    tiles + ' tiles · ' + note);
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
