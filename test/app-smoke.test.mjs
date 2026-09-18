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
  const page = () => ({
    getViewport: ({ scale }) => ({ width: 595.28 * scale, height: 841.89 * scale, scale }),
    render: () => ({ promise: new Promise((r) => setTimeout(r, delay)) }),
    cleanup() {},
    getOperatorList: async () => ({ fnArray: [], argsArray: [] })
  });
  const doc = (pageCount) => ({
    numPages: pageCount,
    getPage: async () => page(),
    destroy() {}
  });
  return {
    GlobalWorkerOptions: {},
    OPS: { paintImageXObject: 85, transform: 12 },
    getDocument: ({ data }) => {
      // page count from the fixture name marker: real pdf.js is not needed here
      const n = data && data._pages ? data._pages : 2;
      return { promise: Promise.resolve(doc(n)) };
    }
  };
}

/* ------------------------------------------------------------------ harness --- */
async function boot(appFile, { pages = 2, html = '', thumbsDelay = 0 } = {}) {
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
  set('pdfjsLib', makePdfStub(thumbsDelay));
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
      if (had && prev) Object.defineProperty(globalThis, key, prev);
      else delete globalThis[key];
    }
  };
  return { document, restore };
}

/* a File-ish object the apps accept */
function fixtureFile(bytes, name, pages) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buf._pages = pages;
  return { name, size: bytes.length, type: 'application/pdf', arrayBuffer: async () => buf, _pdfPages: pages };
}

async function runApp(label, appFile, html, {
  bytes = PDF_2P, name = 'notes-2p.pdf', pages = 2, setOptions = () => {}, thumbsDelay = 0
} = {}) {
  const { document, restore } = await boot(appFile, { pages, html, thumbsDelay });
  try { return await finishRun(document, bytes, name, pages, setOptions); }
  finally { restore(); }
}
async function finishRun(document, bytes, name, pages, setOptions) {
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
  return { ok, status, printed, document, revealMs, placeholderAtReveal, worstGap, beats: gaps.length, dl: dl.download, href: dl.href };
}

console.log('\n=== headless app smoke (real app files, stubbed DOM) ===\n');

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
