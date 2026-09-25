/* ============ THE RAPPER core tests — cover maths + vector overlay writer ============
   node test/rapper.test.mjs       (needs pdf-lib in node_modules)
   The editor stores covers in TOP-LEFT pt space; only the pdf-lib writer flips
   to bottom-left. These checks pin that contract, the brush interpolation, the
   pixelate routine and the real overlay output (ops must exist in the PDF). */
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const RC = require('../rapper-core.js');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\n=== THE RAPPER core ===\n');

/* ---------- 1) colour helpers ---------- */
{
  const c = RC.hexToRgb01('#ff0000');
  check('hexToRgb01: pure red', c[0] === 1 && c[1] === 0 && c[2] === 0, c.join());
  check('hexToRgb01: 3-digit shorthand', RC.hexToRgb01('#0f0').join() === '0,1,0');
  check('hexToRgb01: junk in → white out', RC.hexToRgb01('nope').join() === '1,1,1');
  check('hexToRgb255: mid grey', RC.hexToRgb255('#808080').join() === '128,128,128');
  check('rgb255ToHex: round trip', RC.rgb255ToHex(18, 23, 43) === '#12172b', RC.rgb255ToHex(18, 23, 43));
}

/* ---------- 2) top-left → pdf-lib bottom-left ---------- */
{
  const r = RC.flipRect({ x: 10, y: 20, w: 100, h: 50 }, 842);
  check('flipRect: x/w untouched, y flipped', r.x === 10 && r.width === 100 && near(r.y, 842 - 20 - 50, 1e-9) && r.height === 50,
    JSON.stringify(r));
  const full = RC.flipRect({ x: 0, y: 0, w: 595.28, h: 841.89 }, 841.89);
  check('flipRect: full page maps to full page', near(full.x, 0, 1e-9) && near(full.y, 0, 1e-9) &&
    near(full.width, 595.28, 1e-9) && near(full.height, 841.89, 1e-9));
}

/* ---------- 3) brush interpolation: no dotted gaps ---------- */
{
  const dots = RC.brushCircles([[0, 0], [100, 0]], 10);
  let worst = 0;
  for (let i = 1; i < dots.length; i++) {
    worst = Math.max(worst, Math.hypot(dots[i].x - dots[i - 1].x, dots[i].y - dots[i - 1].y));
  }
  check('brushCircles: fast 100pt move is filled (gap ≤ r/2)', dots.length > 10 && worst <= 5.001,
    dots.length + ' dots · worst gap ' + worst.toFixed(2));
  check('brushCircles: endpoints kept', dots[0].x === 0 && dots[dots.length - 1].x === 100);
  check('brushCircles: empty stroke → no dots', RC.brushCircles([], 8).length === 0);
  check('brushCircles: single tap → one dot', RC.brushCircles([[5, 5]], 8).length === 1);
}

/* ---------- 4) pixelate: text becomes mush, outside untouched ---------- */
{
  const W = 40, H = 40;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {           // every pixel a different colour
    d[i * 4] = i % 256; d[i * 4 + 1] = (i * 3) % 256; d[i * 4 + 2] = (i * 7) % 256; d[i * 4 + 3] = 255;
  }
  const before = d.slice();
  RC.pixelateRegion({ data: d, w: W, h: H }, { x: 10, y: 10, w: 20, h: 20 }, 10);
  let blockUniform = true, outsideSame = true, insideChanged = false;
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) {   // first 10×10 block
    const o = (y * W + x) * 4;
    if (d[o] !== d[(10 * W + 10) * 4] || d[o + 1] !== d[(10 * W + 10) * 4 + 1]) blockUniform = false;
    if (d[o] !== before[o]) insideChanged = true;
  }
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (x < 10 || y < 10 || x >= 30 || y >= 30) {
      if (d[i * 4] !== before[i * 4]) outsideSame = false;
    }
  }
  check('pixelate: each block is one flat colour', blockUniform);
  check('pixelate: region really changed (mush, not original)', insideChanged);
  check('pixelate: everything outside the region is untouched', outsideSame);
  /* oversized region is clipped, never throws */
  let threw = false;
  try { RC.pixelateRegion({ data: d, w: W, h: H }, { x: -50, y: -50, w: 500, h: 500 }, 8); }
  catch (e) { threw = true; }
  check('pixelate: out-of-bounds region is clipped safely', threw === false);
}

/* ---------- 5) hasRaster routing ---------- */
{
  check('hasRaster: rect+ellipse+brush stay vector',
    RC.hasRaster([{ type: 'rect' }, { type: 'ellipse' }, { type: 'brush', points: [] }]) === false);
  check('hasRaster: one pixel region forces raster',
    RC.hasRaster([{ type: 'rect' }, { type: 'pixel', x: 0, y: 0, w: 9, h: 9 }]) === true);
  check('hasRaster: empty page has nothing to do', RC.hasRaster([]) === false && RC.hasRaster(null) === false);
}

/* ---------- 6) hit-testing ---------- */
{
  const covers = [
    { type: 'rect', x: 10, y: 10, w: 100, h: 50 },
    { type: 'ellipse', x: 50, y: 30, w: 100, h: 50 },
    { type: 'brush', points: [[300, 300], [310, 310]], radius: 6 }
  ];
  check('hitCover: topmost wins on overlap', RC.hitCover(covers, 60, 40) === 1);
  check('hitCover: only the rect here', RC.hitCover(covers, 20, 20) === 0);
  check('hitCover: brush hits near its points', RC.hitCover(covers, 305, 305) === 2);
  check('hitCover: empty space misses', RC.hitCover(covers, 500, 500) === -1);
}

/* ---------- 7) real overlay write: ops land in the PDF ---------- */
{
  const doc = await PDFDocument.create();
  const pg = doc.addPage([595.28, 841.89]);
  const n = RC.applyVectorCovers(pg, [
    { type: 'rect', x: 50, y: 700, w: 200, h: 40, color: '#ffffff', opacity: 1 },
    { type: 'ellipse', x: 50, y: 600, w: 120, h: 60, color: '#12172b', opacity: 0.5 },
    { type: 'brush', points: [[10, 10], [60, 10]], radius: 8, color: '#000000', opacity: 1 },
    { type: 'pixel', x: 0, y: 0, w: 50, h: 50 }          // raster-only: must be skipped here
  ], 841.89);
  check('applyVectorCovers: draws 3 vector covers, skips the pixel one', n === 3, 'drew=' + n);
  const bytes = await doc.save({ useObjectStreams: false });
  /* pdf-lib Flate-compresses content streams, so inflate them before looking
     for drawing ops (same technique as convert.test.mjs's dash-op check) */
  const { inflateSync } = await import('node:zlib');
  const buf = Buffer.from(bytes);
  const lat0 = buf.toString('latin1');
  let content = '';
  {
    let i = 0;
    while ((i = lat0.indexOf('stream', i)) >= 0) {
      let st = i + 6;
      if (lat0[st] === '\r') st++;
      if (lat0[st] === '\n') st++;
      const en = lat0.indexOf('endstream', st);
      if (en < 0) break;
      try { content += inflateSync(buf.subarray(st, en)).toString('latin1') + '\n'; } catch (e) {}
      i = en + 9;
    }
  }
  check('overlay: filled path ops present (m … l … h … f — how pdf-lib draws rects)',
    /\n0 0 m\n/.test(content) && /200 40 l/.test(content) && /\nh\n/.test(content) && /\nf\n/.test(content));
  check('overlay: rect translated to the flipped position (50 101.89)',
    /1 0 0 1 50 101\.889+ cm/.test(content), 'y = 841.89 − 700 − 40');
  check('overlay: opacity graphics state present (0.5 ellipse)', /\/CA 0\.5/.test(lat0) || /\/ca 0\.5/.test(lat0));
  const back = await PDFDocument.load(bytes);
  check('overlay: page size unchanged after covers', near(back.getPage(0).getWidth(), 595.28, 0.01) &&
    near(back.getPage(0).getHeight(), 841.89, 0.01));
  check('overlay: degenerate rect (0 size) is skipped, not drawn', (() => {
    const d2 = RC.applyVectorCovers(pg, [{ type: 'rect', x: 1, y: 1, w: 0, h: 0, color: '#fff' }], 841.89);
    return d2 === 0;
  })());
}

/* ---------- 8) cloneCovers: snapshots are really independent ---------- */
{
  const a = [{ type: 'brush', points: [[1, 2]], radius: 5 }];
  const b = RC.cloneCovers(a);
  b[0].points[0][0] = 999;
  check('cloneCovers: deep copy (undo snapshots cannot leak)', a[0].points[0][0] === 1);
}

/* ---------- 9) shipped editor boots in a stub DOM, wired to shipped markup ----------
   The real rapper.js runs top-to-bottom: every id it touches must exist in the
   real rapper.html, every tool button must get a listener, and switching tools
   must work end to end. */
{
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const html = readFileSync(new URL('../rapper.html', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../rapper.js', import.meta.url), 'utf8');
  const coreSrc = readFileSync(new URL('../rapper-core.js', import.meta.url), 'utf8');

  const usedIds = [...new Set([...appSrc.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const missing = usedIds.filter((id) => !html.includes('id="' + id + '"'));
  check('editor wiring: every $("…") id exists in rapper.html', missing.length === 0,
    usedIds.length + ' ids' + (missing.length ? ' · MISSING: ' + missing.join(',') : ''));
  const radioNames = [...new Set([...appSrc.matchAll(/input\[name=([a-z]+)\]/g)].map((m) => m[1]))];
  const missingRadio = radioNames.filter((n) => !html.includes('name="' + n + '"'));
  check('editor wiring: every radio group exists in rapper.html', missingRadio.length === 0, radioNames.join(','));
  /* .reveal blocks are opacity:0 until JS adds .in — missing this = blank page */
  const revealCount = (html.match(/class="[^"]*\breveal\b/g) || []).length;
  check('editor wiring: scroll-reveal present (.reveal would stay invisible otherwise)',
    revealCount > 0 && appSrc.includes("querySelectorAll('.reveal')") && appSrc.includes("classList.add('in')"),
    revealCount + ' .reveal blocks');

  /* minimal stub DOM — just enough for the IIFE top level + one tool switch */
  const mkEl = (tag) => {
    const listeners = {};
    return {
      tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
      hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', width: 300, height: 150,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, f) {
          if (f === undefined) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); }
          else if (f) this._s.add(c); else this._s.delete(c);
        },
        contains(c) { return this._s.has(c); },
      },
      getContext: () => new Proxy({}, { get: () => () => {} }),
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener() {},
      appendChild(c) { this.children.push(c); return c; },
      setAttribute() {}, getAttribute() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      click() { (listeners.click || []).forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); },
      scrollIntoView() {},
      _listeners: listeners,
    };
  };
  const byId = {};
  const toolBtns = ['select', 'rect', 'ellipse', 'brush', 'pixel', 'drop'].map((t) => {
    const b = mkEl('button'); b.dataset.t = t; return b;
  });
  const logs = [];
  const sandbox = {
    console: { log: () => {}, info: (m) => logs.push(String(m)), warn: () => {}, error: () => {} },
    devicePixelRatio: 1, addEventListener() {}, performance,
    PDFLib: { rgb: (r, g, b) => ({ r, g, b }) },   /* core only needs rgb() at factory time */
    document: {
      getElementById: (id) => byId[id] || (byId[id] = mkEl('div')),
      createElement: (tag) => mkEl(tag),
      createDocumentFragment: () => mkEl('fragment'),
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.rp-toolbtn' ? toolBtns : []),
      addEventListener() {},
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  let bootErr = null;
  try {
    vm.runInContext(coreSrc, sandbox, { filename: 'rapper-core.js' });
    vm.runInContext(appSrc, sandbox, { filename: 'rapper.js' });
  } catch (e) { bootErr = e; }
  check('editor boot: rapper.js runs clean in a stub DOM', bootErr === null,
    bootErr ? String(bootErr).slice(0, 120) : logs.join(' '));
  const wired = toolBtns.filter((b) => (b._listeners.click || []).length > 0).length;
  check('editor boot: all 6 tool buttons wired', wired === 6, wired + '/6');
  check('editor boot: 8 colour swatches rendered', (byId['rp-swatches'] ? byId['rp-swatches'].children.length : -1) === 8);
  toolBtns[1].click();   /* rect */
  check('editor boot: tool switch updates the overlay cursor state',
    byId['rp-over'] && byId['rp-over'].dataset.tool === 'rect');
}

console.log('\n' + (fail === 0 ? 'ALL RAPPER CHECKS PASSED' : fail + ' RAPPER CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
