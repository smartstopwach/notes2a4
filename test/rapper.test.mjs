/* ============ THE RAPPER core tests — cover maths + vector overlay writer ============
   node test/rapper.test.mjs       (needs pdf-lib in node_modules)
   The editor stores covers in TOP-LEFT pt space; only the pdf-lib writer flips
   to bottom-left. These checks pin that contract, the brush interpolation, the
   pixelate routine and the real overlay output (ops must exist in the PDF). */
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, rgb, degrees } from 'pdf-lib';

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
  check('hitCover: tolerance forgives near-misses (touch)', RC.hitCover(covers, 115, 15, 10) === 0 && RC.hitCover(covers, 115, 15) === -1);
  check('hitCover: default tolerance is 0 (old behaviour kept)', RC.hitCover(covers, 111, 20) === -1);
}

/* ---------- 6b) chooseApplySource: the button never "does nothing" ---------- */
{
  const all = { 1: [{ id: 'a' }], 2: [], 3: [{ id: 'b' }, { id: 'c' }] };
  const a = RC.chooseApplySource(all, 3, 3);
  check('chooseApplySource: current page wins when it has covers', a && a.page === 3 && a.covers.length === 2);
  const b = RC.chooseApplySource(all, 2, 3);
  check('chooseApplySource: empty current page falls back to first non-empty', b && b.page === 1 && b.covers.length === 1);
  check('chooseApplySource: nothing anywhere → null', RC.chooseApplySource({ 1: [], 2: [] }, 1, 2) === null);
}

/* ---------- 6c) pixelate accepts real ImageData shape ({data,width,height}) ---------- */
{
  const W = 20, H = 20;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = i % 256; d[i * 4 + 1] = 9; d[i * 4 + 2] = 9; d[i * 4 + 3] = 255; }
  const before = d.slice();
  let threw = false, changed = false;
  try {
    RC.pixelateRegion({ data: d, width: W, height: H }, { x: 0, y: 0, w: W, h: H }, 10);
    for (let i = 0; i < d.length; i += 4) if (d[i] !== before[i]) { changed = true; break; }
  } catch (e) { threw = true; }
  check('pixelate: ImageData shape works (what canvas hands the app)', threw === false && changed === true);
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
  ], 595.28, 841.89, 0);
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
    const d2 = RC.applyVectorCovers(pg, [{ type: 'rect', x: 1, y: 1, w: 0, h: 0, color: '#fff' }], 595.28, 841.89, 0);
    return d2 === 0;
  })());
}

/* ---------- 7b) rotation mapping: editor display space → MediaBox space ----------
   Viewers rotate the page clockwise by /Rotate, so on a rotated scan the old
   flipRect math put every cover 90° off the stamp (or fully off the page). */
{
  const W = 600, H = 800, r = { x: 10, y: 20, w: 100, h: 50 };
  const m0 = RC.mapRect(r, W, H, 0);
  check('mapRect: 0° == flipRect', m0.x === 10 && m0.y === 730 && m0.width === 100 && m0.height === 50,
    JSON.stringify(m0));
  const m90 = RC.mapRect(r, W, H, 90);
  check('mapRect: 90° swaps axes (x←y, w←h)', m90.x === 20 && m90.y === 10 && m90.width === 50 && m90.height === 100,
    JSON.stringify(m90));
  const m180 = RC.mapRect(r, W, H, 180);
  check('mapRect: 180° mirrors x', m180.x === 490 && m180.y === 20 && m180.width === 100 && m180.height === 50,
    JSON.stringify(m180));
  const m270 = RC.mapRect(r, W, H, 270);
  check('mapRect: 270° swaps + mirrors', m270.x === 530 && m270.y === 690 && m270.width === 50 && m270.height === 100,
    JSON.stringify(m270));
  const f90 = RC.mapRect({ x: 0, y: 0, w: 800, h: 600 }, W, H, 90);
  const f270 = RC.mapRect({ x: 0, y: 0, w: 800, h: 600 }, W, H, 270);
  const f180 = RC.mapRect({ x: 0, y: 0, w: 600, h: 800 }, W, H, 180);
  check('mapRect: full display rect → full MediaBox at every rotation',
    f90.x === 0 && f90.y === 0 && f90.width === 600 && f90.height === 800 &&
    f270.x === 0 && f270.y === 0 && f270.width === 600 && f270.height === 800 &&
    f180.x === 0 && f180.y === 0 && f180.width === 600 && f180.height === 800);
  const c90 = RC.mapPoint(0, 0, W, H, 90), c270 = RC.mapPoint(0, 0, W, H, 270);
  check('mapPoint: display top-left → unrotated corner pins the turn direction',
    c90.x === 0 && c90.y === 0 && c270.x === 600 && c270.y === 800,
    '90°→(' + c90.x + ',' + c90.y + ') 270°→(' + c270.x + ',' + c270.y + ')');
  check('normRot: quarter turns snap, exotic angles fall back to 0',
    RC.normRot(90) === 90 && RC.normRot(-90) === 270 && RC.normRot(360) === 0 &&
    RC.normRot(450) === 90 && RC.normRot(91) === 90 && RC.normRot(45) === 0 && RC.normRot(undefined) === 0);
}

/* ---------- 7c) mixed page sizes: different-sized pages stay untouched ---------- */
{
  check('sameSize: equal + near-equal match, different does not',
    RC.sameSize({ w: 595.28, h: 841.89 }, { w: 595.28, h: 841.89 }, 1) === true &&
    RC.sameSize({ w: 595.28, h: 841.89 }, { w: 595.6, h: 841.5 }, 1) === true &&
    RC.sameSize({ w: 595.28, h: 841.89 }, { w: 400, h: 300 }, 1) === false);
  check('sameSize: unknown size never blocks a cover', RC.sameSize(null, { w: 1, h: 1 }) === true);
  const stamped = { type: 'rect', x: 1, y: 1, w: 9, h: 9, pw: 595.28, ph: 841.89 };
  const drawn = { type: 'rect', x: 1, y: 1, w: 9, h: 9 };
  check('filterLiveCovers: mismatched stamp skipped, matching stamp + drawn kept',
    RC.filterLiveCovers([stamped, drawn], { w: 400, h: 300 }, 1.5).length === 1 &&
    RC.filterLiveCovers([stamped, drawn], { w: 595.28, h: 841.89 }, 1.5).length === 2);
}

/* ---------- 7d) crop-aware mapping + annotation stripping ----------
   pdf.js renders the CropBox, not the MediaBox; and annotations paint ABOVE
   page content. Both made downloads look unmasked while preview wrapped. */
{
  /* MediaBox 600x800, CropBox (100,200)-(500,600) */
  const crop = { x: 100, y: 200, w: 400, h: 400 };
  const c0 = RC.mapRect({ x: 10, y: 20, w: 100, h: 50 }, 600, 800, 0, crop);
  check('mapRect: crop offsets the flip (R0)', c0.x === 110 && c0.y === 530 && c0.width === 100 && c0.height === 50,
    JSON.stringify(c0));
  const c90 = RC.mapRect({ x: 10, y: 20, w: 100, h: 50 }, 600, 800, 90, crop);
  check('mapRect: crop + 90° (swap inside crop, then offset)',
    c90.x === 120 && c90.y === 210 && c90.width === 50 && c90.height === 100, JSON.stringify(c90));
  const full = RC.mapRect({ x: 0, y: 0, w: 400, h: 400 }, 600, 800, 0, crop);
  check('mapRect: full crop rect → the CropBox itself',
    full.x === 100 && full.y === 200 && full.width === 400 && full.height === 400);
  const plain = RC.mapRect({ x: 10, y: 20, w: 100, h: 50 }, 600, 800, 0);
  check('mapRect: no crop → MediaBox flip as before',
    plain.x === 10 && plain.y === 730 && plain.width === 100 && plain.height === 50);

  const mkStamp = (d, rect) => d.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Stamp'),
    Rect: d.context.obj(rect.map((n) => d.context.obj(n))),
  });
  const covers = [{ type: 'rect', x: 40, y: 150, w: 220, h: 120 }];   // → mediabox x40..260 y530..650
  const d = await PDFDocument.create();
  const pg = d.addPage([600, 800]);
  pg.node.set(PDFName.of('Annots'), d.context.obj([
    mkStamp(d, [50, 500, 250, 600]),     // under the cover → gone
    mkStamp(d, [400, 100, 500, 150]),    // far away → kept
  ]));
  const gone = RC.stripCoveredAnnots(d, pg, covers, 600, 800, 0);
  const left = d.context.lookup(pg.node.get(PDFName.of('Annots'))).asArray();
  check('stripCoveredAnnots: overlapping stamp removed, far one kept', gone === 1 && left.length === 1,
    'removed=' + gone + ' left=' + left.length);
  const d2 = await PDFDocument.create();
  check('stripCoveredAnnots: no annots → 0, never throws',
    RC.stripCoveredAnnots(d2, d2.addPage([600, 800]), covers, 600, 800, 0) === 0);
  const d3 = await PDFDocument.create();
  const p3 = d3.addPage([600, 800]);
  p3.node.set(PDFName.of('Annots'), d3.context.obj([d3.context.obj({ Type: PDFName.of('Annot') })]));
  check('stripCoveredAnnots: Rect-less annot kept safely (no crash)',
    RC.stripCoveredAnnots(d3, p3, covers, 600, 800, 0) === 0 &&
    d3.context.lookup(p3.node.get(PDFName.of('Annots'))).asArray().length === 1);
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
  /* app↔core contract: these exact call shapes shipped broken once (silent no-ops) */
  const pixCalls = [...appSrc.matchAll(/RC\.pixelateRegion\(([^,]+),/g)].map((m) => m[1].trim());
  check('app↔core: pixelate gets the ImageData object (not .data, .w, .h)',
    pixCalls.length === 2 && pixCalls.every((a) => a === 'img'), pixCalls.join(' | '));
  check('app↔core: hitCover result used as an index (0 is a valid hit)',
    /RC\.hitCover\([^)]*\)\s*>=\s*0/.test(appSrc) && appSrc.includes('var hit = list[hi]'));
  check('app↔core: apply-to-all uses the smart source picker',
    appSrc.includes('RC.chooseApplySource(covers, cur, pageCount)'));
  /* focus mode wiring: button → body class → CSS takes over */
  const css = readFileSync(new URL('../rapper.css', import.meta.url), 'utf8');
  check('focus mode: button exists, toggles body.rp-focus, CSS hides the chrome',
    html.includes('id="rp-focus"') && appSrc.includes("classList.toggle('rp-focus'") &&
    css.includes('body.rp-focus .topbar') && appSrc.includes("k === 'f'"));
  check('touch ease: double-tap deletes, coarse pointers get bigger targets',
    appSrc.includes("addEventListener('dblclick'") && css.includes('@media (pointer:coarse)'));

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
  check('editor boot: visible build tag shows the running build',
    byId['rp-build'] && byId['rp-build'].textContent === 'rapper/4',
    byId['rp-build'] ? byId['rp-build'].textContent : '(missing)');
}

/* ---------- 10) end-to-end: draw → apply → export lands covers in the PDF ----------
   The real rapper.js + the real pdf-lib run in a stub DOM with a stub pdf.js.
   This is the path that silently shipped unmasked PDFs on rotated pages. */
{
  const vm2 = await import('node:vm');
  const { inflateSync } = await import('node:zlib');
  const { readFileSync } = await import('node:fs');
  const appSrc = readFileSync(new URL('../rapper.js', import.meta.url), 'utf8');
  const coreSrc = readFileSync(new URL('../rapper-core.js', import.meta.url), 'utf8');
  const ONEPX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const mkCtx = () => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, imageSmoothingEnabled: true,
    setTransform() {}, fillRect() {}, clearRect() {}, beginPath() {}, rect() {}, arc() {}, ellipse() {},
    moveTo() {}, lineTo() {}, fill() {}, stroke() {}, save() {}, restore() {}, setLineDash() {},
    drawImage() {}, fillText() {}, strokeRect() {}, strokeText() {}, clip() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, resetTransform() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, measureText: () => ({ width: 10 }),
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h }; },
    putImageData() {},
  });
  function mkEl(tag, id, box) {
    const listeners = {};
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
      hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', width: 300, height: 150,
      clientWidth: id === 'rp-box' ? box.w : 100, clientHeight: id === 'rp-box' ? 600 : 100,
      files: null,
      classList: { _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, f) { if (f === undefined) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); } else if (f) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); } },
      getContext: () => mkCtx(),
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener() {},
      appendChild(c) {
        if (c && c.tagName === 'FRAGMENT') this.children.push(...c.children);
        else this.children.push(c);
        return c;
      },
      setAttribute() {}, getAttribute() { return null; },
      querySelector(sel) {
        const need = String(sel || '').split('.').filter(Boolean);
        const walk = (kids) => {
          for (const k of kids) {
            if (need.every((c) => k.classList && k.classList._s.has(c))) return k;
            const f = walk(k.children || []);
            if (f) return f;
          }
          return null;
        };
        return walk(el.children);
      },
      querySelectorAll() { return []; },
      getBoundingClientRect: () => ({ left: 0, top: 0,
        width: el.style.width ? parseFloat(el.style.width) : 100,
        height: el.style.height ? parseFloat(el.style.height) : 100 }),
      click() { (listeners.click || []).forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); },
      scrollIntoView() {}, focus() {}, remove() {},
      setPointerCapture() {}, releasePointerCapture() {},
      toBlob(cb, type) { cb(new Blob([ONEPX], { type: type || 'image/png' })); },
      _listeners: listeners, _id: id,
    };
    let _cls = '';
    Object.defineProperty(el, 'className', {
      get: () => _cls,
      set: (v) => { _cls = String(v); el.classList._s = new Set(_cls.split(/\s+/).filter(Boolean)); },
    });
    return el;
  }

  /* pages: [{w, h, rotate?}] in UNROTATED MediaBox pt; the stub pdf.js exposes
     the rotated viewport exactly like the real one, rotations included */
  async function bootRapper(pages, realBytes, opts = {}) {
    const box = { w: opts.boxW || 800 };
    const byId = {};
    const toolBtns = ['select', 'rect', 'ellipse', 'brush', 'pixel', 'drop'].map((t) => {
      const b = mkEl('button', null, box); b.dataset.t = t; return b;
    });
    const winL = {};
    const canvases = [];
    let captured = null;
    const fakePdf = {
      numPages: pages.length,
      getPage: async (n) => {
        const pg = pages[n - 1];
        const swap = pg.rotate === 90 || pg.rotate === 270;
        const dw = pg.crop ? pg.crop[2] - pg.crop[0] : pg.w;
        const dh = pg.crop ? pg.crop[3] - pg.crop[1] : pg.h;
        return {
          rotate: pg.rotate || 0,
          getViewport: ({ scale }) => ({
            width: (swap ? dh : dw) * scale, height: (swap ? dw : dh) * scale,
          }),
          getAnnotations: async () => Array(pg.stamps || 0).fill({ subtype: 'Stamp' }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup() {},
        };
      },
    };
    const sandbox = {
      console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      performance, setTimeout, clearTimeout,
      devicePixelRatio: 1, innerHeight: opts.innerH || 900,
      PDFLib: { PDFDocument, PDFName, rgb }, Blob,
      URL: { createObjectURL: (b) => { captured = b; return 'blob:t'; }, revokeObjectURL() {} },
      pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(fakePdf) }), GlobalWorkerOptions: {} },
      document: {
        getElementById: (id) => byId[id] || (byId[id] = mkEl('div', id, box)),
        createElement: (tag) => {
          const e = mkEl(tag, null, box);
          if (String(tag).toLowerCase() === 'canvas') canvases.push(e);
          return e;
        },
        createDocumentFragment: () => mkEl('fragment', null, box),
        querySelector: (sel) => (sel.includes('rpfmt') ? { value: 'png' } : (sel.includes('rpdpi') ? { value: '200' } : null)),
        querySelectorAll: (sel) => (sel === '.rp-toolbtn' ? toolBtns : []),
        addEventListener() {},
        body: mkEl('body', null, box),
      },
      addEventListener(t, f) { (winL[t] = winL[t] || []).push(f); },
    };
    sandbox.window = sandbox;
    vm2.createContext(sandbox);
    vm2.runInContext(coreSrc, sandbox, { filename: 'rapper-core.js' });
    vm2.runInContext(appSrc, sandbox, { filename: 'rapper.js' });
    const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, label) => {
      for (let i = 0; i < 400; i++) { if (fn()) return; await tick(5); }
      throw new Error('e2e timeout: ' + label);
    };
    const u8 = realBytes instanceof Uint8Array ? realBytes : new Uint8Array(realBytes);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    byId['rp-file'].files = [{ name: 't.pdf', type: 'application/pdf', arrayBuffer: async () => ab.slice(0) }];
    byId['rp-file']._listeners.change.forEach((f) => f());
    await waitFor(() => String(byId['rp-pc'].textContent) === String(pages.length), 'load');
    await tick(250);   // thumbnails (page sizes for apply-to-all) settle
    return {
      byId, toolBtns, canvases,
      draw(toolIdx, x1, y1, x2, y2) {
        toolBtns[toolIdx].click();
        const over = byId['rp-over'];
        over._listeners.pointerdown.forEach((f) => f({ clientX: x1, clientY: y1, pointerId: 1, preventDefault() {} }));
        over._listeners.pointermove.forEach((f) => f({ clientX: x2, clientY: y2, pointerId: 1, preventDefault() {} }));
        (winL.pointerup || []).forEach((f) => f({}));
      },
      click: (id) => byId[id].click(),
      export: async () => {
        byId['rp-go'].click();
        await waitFor(() => byId['rp-result'].hidden === false, 'export');
        return Buffer.from(await captured.arrayBuffer());
      },
    };
  }

  async function realDoc(pages) {
    const d = await PDFDocument.create();
    pages.forEach((p) => {
      const pg = d.addPage([p.w, p.h]);
      if (p.rotate) pg.setRotation(degrees(p.rotate));
      if (p.crop) pg.node.set(PDFName.of('CropBox'), d.context.obj(p.crop.map((n) => d.context.obj(n))));
      (p.annots || []).forEach((a) => {
        const dict = d.context.obj({
          Type: PDFName.of('Annot'), Subtype: PDFName.of(a.subtype || 'Stamp'),
          Rect: d.context.obj(a.rect.map((n) => d.context.obj(n))),
        });
        const cur = d.context.lookup(pg.node.get(PDFName.of('Annots')));
        const items = cur && cur.asArray ? cur.asArray().slice() : [];
        items.push(dict);
        pg.node.set(PDFName.of('Annots'), d.context.obj(items));
      });
    });
    return d.save();
  }
  function contentOf(outBytes) {
    const buf = Buffer.from(outBytes);
    const lat = buf.toString('latin1');
    let content = '', i = 0;
    while ((i = lat.indexOf('stream', i)) >= 0) {
      let st = i + 6;
      if (lat[st] === '\r') st++;
      if (lat[st] === '\n') st++;
      const en = lat.indexOf('endstream', st);
      if (en < 0) break;
      try { content += inflateSync(buf.subarray(st, en)).toString('latin1') + '\n'; } catch (e) {}
      i = en + 9;
    }
    return { content, lat };
  }
  function cmOps(content) {
    const out = [];
    const re = /1 0 0 1 ([\d.]+) ([\d.]+) cm/g;
    let m;
    while ((m = re.exec(content))) out.push([+m[1], +m[2]]);
    return out;
  }
  const hasNear = (ops, x, y, tol) => ops.some(([ox, oy]) => Math.abs(ox - x) <= tol && Math.abs(oy - y) <= tol);

  /* A: plain 2-pager — draw on page 1, apply to all, both pages masked */
  {
    const pages = [{ w: 595.28, h: 841.89 }, { w: 595.28, h: 841.89 }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(1, 100, 100, 200, 150);
    r.click('rp-all');
    check('e2e: draw + apply-to-all covers both pages', r.byId['rp-covchip'].textContent === '2 covers',
      r.byId['rp-covchip'].textContent);
    const out = await r.export();
    const sc = parseFloat(r.byId['rp-over'].style.width) / 595.28;
    const ex = 100 / sc, ey = 841.89 - 100 / sc - 50 / sc;
    const ops = cmOps(contentOf(out).content);
    const hits = ops.filter(([ox, oy]) => Math.abs(ox - ex) <= 0.6 && Math.abs(oy - ey) <= 0.6).length;
    check('e2e: exported PDF masks BOTH pages at the drawn spot', hits === 2,
      'expect (' + ex.toFixed(1) + ',' + ey.toFixed(1) + ') ×2 · ops ' + JSON.stringify(ops));
  }
  /* B: rotated scan — the 90° cover must land on the stamp, not off-page */
  {
    const pages = [{ w: 595.28, h: 841.89, rotate: 90 }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(1, 600, 100, 700, 140);
    const out = await r.export();
    const sc = parseFloat(r.byId['rp-over'].style.width) / 841.89;   // display width = H
    const ex = 100 / sc, ey = 600 / sc;   // 90°: X←y, Y←x
    const ops = cmOps(contentOf(out).content);
    check('e2e: rotated page masks the stamp (90°-mapped, not off-page)',
      hasNear(ops, ex, ey, 0.6), 'expect (' + ex.toFixed(1) + ',' + ey.toFixed(1) + ') · ops ' + JSON.stringify(ops));
  }
  /* C: mixed sizes — the small page stays untouched */
  {
    const pages = [{ w: 595.28, h: 841.89 }, { w: 400, h: 300 }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(1, 100, 100, 200, 150);
    r.click('rp-all');
    check('e2e: apply-to-all skips the different-sized page (and says so)',
      r.byId['rp-covchip'].textContent === '1 cover' && r.byId['rp-status'].innerHTML.includes('skipped'),
      r.byId['rp-covchip'].textContent);
    const out = await r.export();
    /* pdf-lib brackets every rect with two 0,0 transforms — count real placements */
    const ops = cmOps(contentOf(out).content).filter(([x, y]) => x !== 0 || y !== 0);
    check('e2e: only the matching page is masked (small page byte-clean)', ops.length === 1,
      'ops ' + JSON.stringify(ops));
  }
  /* D: blur on a rotated page — the embedded bitmap is counter-rotated */
  {
    const pages = [{ w: 595.28, h: 841.89, rotate: 90 }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(4, 100, 100, 200, 150);
    const out = await r.export();
    const dims = r.canvases.map((c) => c.width + 'x' + c.height);
    const expW = Math.round(595.28 * 200 / 72), expH = Math.round(841.89 * 200 / 72);
    check('e2e: blur page embeds counter-rotated (unrotated dims, not display dims)',
      dims.includes(expW + 'x' + expH), dims.join(','));
    const { lat } = contentOf(out);
    check('e2e: blur page really embeds a raster image', /\/XObject/.test(lat) && /\/Image/.test(lat));
  }
  /* E: small screens — the whole page fits the box, no scroll-spill */
  {
    const pages = [{ w: 595.28, h: 841.89 }];
    const r = await bootRapper(pages, await realDoc(pages), { boxW: 800, innerH: 900 });
    const ow = parseFloat(r.byId['rp-over'].style.width), oh = parseFloat(r.byId['rp-over'].style.height);
    check('e2e: tall page fits the box height (whole page visible, no scroll)',
      oh <= 590 && oh > 400, Math.round(ow) + 'x' + Math.round(oh));
  }
  {
    const pages = [{ w: 841.89, h: 595.28 }];
    const r = await bootRapper(pages, await realDoc(pages), { boxW: 800, innerH: 900 });
    const ow = parseFloat(r.byId['rp-over'].style.width);
    check('e2e: wide page still fits the box width', Math.abs(ow - 760) < 2, Math.round(ow) + 'px');
  }
  /* F: cropped page — the mask lands on the CropBox, MediaBox-offset */
  {
    const pages = [{ w: 595.28, h: 841.89, crop: [100, 200, 495, 742] }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(1, 100, 100, 200, 150);
    const out = await r.export();
    const sc = parseFloat(r.byId['rp-over'].style.width) / 395;   // display width = crop w
    const ex = 100 + 100 / sc, ey = 200 + (542 - 100 / sc - 50 / sc);
    const ops = cmOps(contentOf(out).content);
    check('e2e: cropped page masks at the crop-offset spot',
      hasNear(ops, ex, ey, 0.6), 'expect (' + ex.toFixed(1) + ',' + ey.toFixed(1) + ') · ops ' + JSON.stringify(ops));
  }
  /* G: stamp annotations under a cover are deleted, the rest survive */
  {
    const pages = [{ w: 595.28, h: 841.89, annots: [
      { rect: [50, 500, 250, 600] },    // under the cover → gone
      { rect: [400, 100, 500, 150] },   // far away → kept
    ] }];
    const r = await bootRapper(pages, await realDoc(pages));
    r.draw(1, 40, 100, 260, 220);
    const out = await r.export();
    const back = await PDFDocument.load(out);
    const arr = back.context.lookup(back.getPage(0).node.get(PDFName.of('Annots')));
    const left = arr && arr.asArray ? arr.asArray().length : 0;
    check('e2e: covered stamp stripped, far stamp kept', left === 1, left + ' annots left');
    const rsMeta = r.byId['rp-rsMeta'].textContent;
    check('e2e: result reports the cleared stamp', rsMeta.includes('1 stamp'), rsMeta);
  }
  /* H: the file chip reports sizes + rotation + stamps at a glance */
  {
    const pages = [
      { w: 595.28, h: 841.89, stamps: 2 },
      { w: 400, h: 300, rotate: 90, stamps: 1 },
    ];
    const r = await bootRapper(pages, await realDoc(pages));
    const chip = r.byId['rp-pages'].textContent;
    check('e2e: file chip reports sizes + rotation + stamps',
      chip.includes('2 sizes') && chip.includes('rotated') && chip.includes('3 stamps'), chip);
  }
}

console.log('\n' + (fail === 0 ? 'ALL RAPPER CHECKS PASSED' : fail + ' RAPPER CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
