/* Kept debug harness (not part of npm test): manual.html + ALL real scripts in
   jsdom — real HTML parsing, real scripts, real capture/bubble event flow, real
   pdf-lib. pdf.js is a smoke-style stand-in (jsdom has no Worker), canvas 2d a
   tolerant Proxy, URL/files APIs shimmed — pixels don't matter here, wiring
   does. Use when something passes app-smoke but fails in the browser.
   Run: node tools/dom-repro.mjs (needs jsdom in node_modules) */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(import.meta.url);

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdom: ' + (e && e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + String(a[0] && a[0].message || a[0])));
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e && e.message)));

const html = readFileSync(new URL('./manual.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/manual.html', virtualConsole: vc, runScripts: 'dangerously' });
const { window } = dom;
const { document } = window;
window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

// tolerant canvas 2d: known methods no-op, everything else undefined (like a real ctx prop)
const METHODS = new Set(('save,restore,beginPath,closePath,moveTo,lineTo,rect,arc,ellipse,fill,stroke,clip,fillRect,strokeRect,clearRect,fillText,strokeText,drawImage,setTransform,resetTransform,translate,scale,rotate,transform,setLineDash,createLinearGradient,createRadialGradient,createPattern,putImageData,getImageData,measureText').split(','));
window.Element.prototype.scrollIntoView = function () {};
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};
window.HTMLCanvasElement.prototype.getContext = function () {
  const el = this;
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return el;
      if (k === 'measureText') return () => ({ width: 10 });
      if (METHODS.has(k)) return () => {};
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
};

const scripts = ['vendor/pdf.min.js', 'vendor/pdf-lib.min.js', 'session.js', 'converter.js', 'review.js', 'app-manual.js'];
for (const f of scripts) {
  try {
    window.eval(readFileSync(new URL('./' + f, import.meta.url), 'utf8'));
    console.log('LOADED', f);
  } catch (e) { console.log('LOAD-FAIL', f, '-', e.message); process.exit(1); }
  if (f === 'vendor/pdf.min.js') {
    // jsdom has no Worker and Node-pdf.js insists on its worker bundle: install a
    // proven smoke-style pdf.js stand-in — DOM, scripts, events, pdf-lib stay real.
    const pg = () => ({
      getViewport: ({ scale }) => ({ width: 595.28 * scale, height: 841.89 * scale, scale }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {}
    });
    window.pdfjsLib = {
      GlobalWorkerOptions: {},
      OPS: { paintImageXObject: 85, transform: 12 },
      getDocument: ({ data }) => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => pg(), destroy: () => {} }) })
    };
    console.log('pdfjs stubbed (smoke-style)');
  }
}
window.pdfjsLib.GlobalWorkerOptions.workerSrc = '';   // Node: use built-in fake worker, don't require() a URL
console.log('pdfjsLib:', typeof window.pdfjsLib, '| PDFLib:', typeof window.PDFLib,
  '| NotesSession:', typeof window.NotesSession, '| PageReview:', typeof window.PageReview,
  '| NotesConverter:', typeof window.NotesConverter);

// DOMContentLoaded may already have fired during construction; ensure review's inject ran
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
console.log('reviewBtn present:', !!document.getElementById('reviewBtn'));

// feed a real file through the real input (same trick review.js apply() uses)
const pdfBytes = new Uint8Array(readFileSync(new URL('./test/fixtures/notes-2p.pdf', import.meta.url)));
const inp = document.getElementById('fileInput');
const file = new window.File([pdfBytes], 'notes-2p.pdf', { type: 'application/pdf' });
// isolate the hang: arrayBuffer vs pdf.js (race each against a timeout)
{
  const race = (p, ms, tag) => Promise.race([p.then((v) => tag + '=OK:' + (v && v.byteLength !== undefined ? v.byteLength : v)), new Promise((r) => setTimeout(() => r(tag + '=TIMEOUT'), ms))]).catch((e) => tag + '=ERR:' + e.message);
  console.log(await race(file.arrayBuffer(), 3000, 'arrayBuffer'));
  try {
    const t = Date.now();
    const doc = await Promise.race([
      window.pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 5000))
    ]);
    console.log('getDocument=OK pages=' + doc.numPages + ' in ' + (Date.now() - t) + 'ms');
    doc.destroy();
  } catch (e) { console.log('getDocument=' + e.message); }
}
Object.defineProperty(inp, 'files', { value: [file], configurable: true });
inp.dispatchEvent(new window.Event('change', { bubbles: true }));
const t0 = Date.now();
while (document.getElementById('fbName').textContent !== 'notes-2p.pdf' && Date.now() - t0 < 8000)
  await new Promise((r) => setTimeout(r, 50));
console.log('afterLoad fbName:', JSON.stringify(document.getElementById('fbName').textContent),
  '| fbPages:', JSON.stringify(document.getElementById('fbPages').textContent),
  '| reviewBtn.hidden:', document.getElementById('reviewBtn') && document.getElementById('reviewBtn').hidden);
console.log('fileError:', JSON.stringify(document.getElementById('fileError').textContent),
  '| pstatus:', JSON.stringify(document.getElementById('pstatus').textContent));
console.log('ERRORS-SO-FAR:', errors.length ? '\n  - ' + errors.join('\n  - ') : '(none)');
if (document.getElementById('fbName').textContent !== 'notes-2p.pdf') { console.log('INTAKE-FAILED — stopping'); process.exit(2); }

// open the review overlay for real
document.getElementById('reviewBtn').click();
await new Promise((r) => setTimeout(r, 1500));
const ovVisible = (() => { const ov = document.querySelector('.pr-overlay'); return ov ? String(ov.hidden) : 'NO-OVERLAY'; })();
console.log('overlay hidden:', ovVisible, '| prCur:', document.getElementById('prCur').textContent);

// real keyboard events through the real capture/bubble flow
const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
key('ArrowRight');
await new Promise((r) => setTimeout(r, 800));
console.log('after ArrowRight prCur:', document.getElementById('prCur').textContent);
key('Delete');
await new Promise((r) => setTimeout(r, 300));
console.log('after Delete delChip hidden:', document.getElementById('prDelCount').hidden,
  '| text:', JSON.stringify(document.getElementById('prDelCount').textContent));

// apply with a DataTransfer stand-in (jsdom lacks it; browsers have it)
window.DataTransfer = class {
  constructor() { this.files = []; this.items = { add: (f) => { this.files.push(f); } }; }
};
Object.defineProperty(document.getElementById('fileInput'), 'files', { value: [], writable: true, configurable: true });
document.getElementById('prApply').click();
const t1 = Date.now();
while (Date.now() - t1 < 8000) {
  await new Promise((r) => setTimeout(r, 100));
  if (document.querySelector('.pr-overlay').hidden) break;
}
console.log('after Apply overlay hidden:', document.querySelector('.pr-overlay').hidden,
  '| fbName:', JSON.stringify(document.getElementById('fbName').textContent),
  '| applyBtn:', JSON.stringify(document.getElementById('prApply').textContent.slice(0, 30)),
  '| applyDisabled:', document.getElementById('prApply').disabled);
document.getElementById('goBtn').click();
const t2 = Date.now();
while (document.getElementById('result').hidden && Date.now() - t2 < 8000)
  await new Promise((r) => setTimeout(r, 100));
console.log('PACKED:', JSON.stringify(document.getElementById('rsMeta').textContent));
console.log('ERRORS:', errors.length ? '\n  - ' + errors.join('\n  - ') : '(none)');
