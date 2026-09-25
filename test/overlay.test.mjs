/* ============ Invert Lab overlays — ruled lines + dotted separator + sheet numbers ============
   node test/overlay.test.mjs       (needs pdf-lib in node_modules)
   Vector-sharp finishing touches drawn on top of each finished 1:1 page.
   Everything is OFF by default, so existing outputs stay byte-identical. */
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const require = createRequire(import.meta.url);
const OV = require('../overlays.js');
const CV = require('../converter.js');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};

/* pdf-lib Flate-compresses content streams — inflate before grepping ops */
async function streamText(doc) {
  const bytes = await doc.save({ useObjectStreams: false });
  const buf = Buffer.from(bytes);
  const lat = buf.toString('latin1');
  let out = '';
  let i = 0;
  while ((i = lat.indexOf('stream', i)) >= 0) {
    let st = i + 6;
    if (lat[st] === '\r') st++;
    if (lat[st] === '\n') st++;
    const en = lat.indexOf('endstream', st);
    if (en < 0) break;
    try { out += inflateSync(buf.subarray(st, en)).toString('latin1') + '\n'; } catch (e) {}
    i = en + 9;
  }
  return out;
}

console.log('\n=== INVERT OVERLAYS ===\n');

/* ---------- 1) option normalisation: junk in, safe defaults out ---------- */
{
  const d = OV.normOpts();
  check('normOpts: everything off by default', d.lines === false && d.sep === 'off' && d.nums === false);
  const j = OV.normOpts({ lines: 'crayon', sep: 'diagonal', numPos: 'middle', numFmt: 'roman', numStart: -5, numSize: 99 });
  check('normOpts: junk style/sep/pos/fmt fall back safely',
    j.lines === false && j.sep === 'off' && j.numPos === 'bc' && j.numFmt === 'frac');
  check('normOpts: numbers clamp to sane ranges', j.numStart === 0 && j.numSize === 14);
  check('normOpts: good values pass through',
    OV.normOpts({ lines: 'grid', sep: 'both', nums: true, numPos: 'tr', numFmt: 'of', numStart: 21, numSize: 11 }).numStart === 21);
}

/* ---------- 2) number text: all five styles + start-at totals ---------- */
{
  const o = (f, s) => OV.normOpts({ nums: true, numFmt: f, numStart: s || 1 });
  check('numText: frac shows current / last', OV.numText(2, 20, o('frac')) === '3 / 20');
  check('numText: plain', OV.numText(2, 20, o('plain')) === '3');
  check('numText: Page N', OV.numText(2, 20, o('page')) === 'Page 3');
  check('numText: dash', OV.numText(2, 20, o('dash')) === '\u2013 3 \u2013');
  check('numText: N of last', OV.numText(2, 20, o('of')) === '3 of 20');
  check('numText: start-at shifts current AND last (21 / 30)', OV.numText(0, 10, o('frac', 21)) === '21 / 30');
}

/* ---------- 3) number placement: six corners, inside the page ---------- */
{
  const W = 595.28, H = 841.89, tw = 30, size = 8;
  const pts = OV.NUM_POS.map((p) => OV.numPlace(p, W, H, tw, size, 24));
  const inside = pts.every((p) => p.x >= 0 && p.x + tw <= W && p.y >= 0 && p.y + size <= H);
  check('numPlace: all six positions sit inside the page', inside && pts.length === 6);
  const distinct = new Set(pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1))).size;
  check('numPlace: all six positions are distinct', distinct === 6);
  const bc = OV.numPlace('bc', W, H, tw, size, 24);
  check('numPlace: bottom-centre is centred', Math.abs(bc.x + tw / 2 - W / 2) < 0.01);
}

/* ---------- 4) ruling + separator geometry ---------- */
{
  const R = OV.ruleRows(595.28, 841.89, 25.5, 36);
  check('ruleRows: rows span the page inside 36pt margins',
    R.x0 === 36 && R.x1 === 595.28 - 36 && R.ys[0] === 841.89 - 36 && R.ys[R.ys.length - 1] >= 36);
  check('ruleRows: A4 at 9mm gives ~30 rows', R.ys.length >= 28 && R.ys.length <= 32, R.ys.length + ' rows');
  const v = OV.sepLines(595.28, 841.89, 'v');
  check('sepLines: vertical runs down the middle', v.length === 1 && v[0].x1 === v[0].x2 && Math.abs(v[0].x1 - 595.28 / 2) < 0.01);
  const h = OV.sepLines(595.28, 841.89, 'h');
  check('sepLines: horizontal runs across the middle', h.length === 1 && h[0].y1 === h[0].y2 && Math.abs(h[0].y1 - 841.89 / 2) < 0.01);
  check('sepLines: both draws two, off draws none',
    OV.sepLines(100, 100, 'both').length === 2 && OV.sepLines(100, 100, 'off').length === 0 && OV.sepLines(100, 100, 'x').length === 0);
}

/* ---------- 5) drawPage on a real pdf-lib page ---------- */
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595.28, 841.89]);
  const off = OV.drawPage(pg, {}, { i: 0, n: 1, w: 595.28, h: 841.89, font: null });
  check('drawPage: all-off draws nothing', off.lines === 0 && off.seps === 0 && off.nums === 0);

  const pg2 = doc.addPage([595.28, 841.89]);
  const on = OV.drawPage(pg2,
    { lines: 'solid', sep: 'v', nums: true, numPos: 'bc', numFmt: 'frac', numStart: 1, numSize: 8 },
    { i: 2, n: 20, w: 595.28, h: 841.89, font });
  check('drawPage: counts what it drew', on.lines >= 28 && on.seps === 1 && on.nums === 1,
    on.lines + ' lines, ' + on.seps + ' sep, ' + on.nums + ' num');

  const st = await streamText(doc);
  check('drawPage: line ops present (m … l … S)', /\bm\b/.test(st) && /\bl\b/.test(st) && /\bS\b/.test(st));
  check('drawPage: dotted separator dash op present', /\[0\.9 3\.2\]/.test(st));
  check('drawPage: round caps for dots', /1 J/.test(st));
  /* pdf-lib hex-encodes text (<33202F203230> = "3 / 20") — decode, then look */
  const decoded = st.replace(/<([0-9A-Fa-f]+)>/g, (m, h) => {
    let s = '';
    for (let k = 0; k + 1 < h.length; k += 2) s += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
    return s;
  });
  check('drawPage: number text block present with the label', /\bBT\b/.test(st) && decoded.includes('3 / 20'));
}

/* ---------- 6) every line style draws without throwing ---------- */
{
  const doc = await PDFDocument.create();
  let ok = true, total = 0;
  for (const s of OV.LINE_STYLES) {
    try {
      const pg = doc.addPage([400, 400]);
      const c = OV.drawPage(pg, { lines: s }, { i: 0, n: 1, w: 400, h: 400, font: null });
      total += c.lines;
      if (c.lines < 1) ok = false;
    } catch (e) { ok = false; }
  }
  check('drawPage: all 10 line styles draw rows', ok, OV.LINE_STYLES.length + ' styles, ' + total + ' ops');
}

/* ---------- 7) degenerate input never throws ---------- */
{
  const doc = await PDFDocument.create();
  const pg = doc.addPage([100, 100]);
  let threw = false, z;
  try {
    z = OV.drawPage(pg, { lines: 'grid', sep: 'both', nums: true }, { i: 0, n: 0, w: 0, h: 0, font: null });
  } catch (e) { threw = true; }
  check('drawPage: zero-size page draws nothing, throws nothing',
    threw === false && z && z.lines === 0 && z.seps === 0 && z.nums === 0);
  let threw2 = false;
  try {
    const c2 = OV.drawPage(pg, { nums: true }, { i: 0, n: 5, w: 100, h: 100, font: null });
    if (c2.nums !== 0) threw2 = true;   // no font → number skipped, not crashed
  } catch (e) { threw2 = true; }
  check('drawPage: numbers without a font are skipped safely', threw2 === false);
}

/* ---------- 8) findBand: packer 2-up gap + 4-up band detection ---------- */
function synthBand(W, H, paint) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = paint(x, y), o = (y * W + x) * 4;
    d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
  }
  return { data: d, w: W, h: H };
}
{
  // clean 2-up gap: dark slides top/bottom, white middle rows 60..140
  const img = synthBand(100, 200, (x, y) => (y >= 60 && y < 140 ? 255 : 20));
  const b = OV.findBand(img, 'h', 1);
  check('findBand: clean 2-up gap rows detected', !!b && b.axis === 'h' && b.a0 === 60 && b.a1 === 140,
    b ? b.a0 + '..' + b.a1 : 'null');
}
{
  // noisy band: grey ruling rows every 10px + a dark number blob inside
  const img = synthBand(100, 200, (x, y) => {
    if (y < 60 || y >= 140) return 20;
    if ((y - 60) % 10 === 0) return 150;                       // ruling row
    if (x >= 5 && x < 13 && y >= 98 && y < 106) return 30;     // gap sheet number
    return 255;
  });
  const b = OV.findBand(img, 'h', 1);
  check('findBand: ruling + gap number tolerated, band still found',
    !!b && b.a0 <= 62 && b.a1 >= 138, b ? b.a0 + '..' + b.a1 : 'null');
}
{
  // vertical band (symmetric v-axis support): dark left/right, white cols 40..62
  const img = synthBand(100, 200, (x, y) => (x >= 40 && x < 62 ? 255 : 20));
  const b = OV.findBand(img, 'v', 1);
  check('findBand: vertical band columns detected', !!b && b.axis === 'v' && b.a0 === 40 && b.a1 === 62,
    b ? b.a0 + '..' + b.a1 : 'null');
}
{
  // dotted separator column through a 4-up band merges back together
  const img = synthBand(100, 200, (x, y) => {
    if (x < 40 || x >= 62) return 20;
    if (x === 50 && y % 4 === 0) return 30;                    // vertical dots
    return 255;
  });
  const b = OV.findBand(img, 'v', 1);
  check('findBand: v-axis dotted column merged, band whole',
    !!b && b.a0 <= 42 && b.a1 >= 60, b ? b.a0 + '..' + b.a1 : 'null');
}
{
  const white = synthBand(60, 60, () => 255);
  check('findBand: blank page has no band', OV.findBand(white, 'h', 0.5) === null);
  const dark = synthBand(60, 60, () => 15);
  check('findBand: all-dark page has no band', OV.findBand(dark, 'h', 0.5) === null);
  const tiny = synthBand(60, 60, () => 255);
  check('findBand: degenerate tiny image is safe', OV.findBand({ data: [], w: 0, h: 0 }, 'h', 1) === null && tiny !== null);
}
{
  // sparse text page: middle rows 95% white qualify row-wise but fail the
  // 97% band average — text must never be mistaken for a keep-band
  const img = synthBand(100, 200, (x, y) => {
    if (y < 60 || y >= 140) return 20;
    return (x % 20 === 0) ? 30 : 255;
  });
  check('findBand: sparse text rows rejected (not a band)', OV.findBand(img, 'h', 1) === null);
  // narrow white run under the ~12pt minimum is noise
  const img2 = synthBand(100, 200, (x, y) => (y >= 96 && y < 104 ? 255 : 20));
  check('findBand: sub-12pt run rejected', OV.findBand(img2, 'h', 1) === null);
}

/* ---------- 9) unflipBand: second Difference rect restores the band ---------- */
{
  const calls = [];
  const fake = { drawRectangle: (o) => calls.push(o) };
  const r = OV.unflipBand(fake, { axis: 'h', y0: 100, y1: 200 }, 595, 842);
  check('unflipBand: 2-up rect spans full width over band rows',
    r && r.x === 0 && r.y === 100 && r.w === 595 && r.h === 100 &&
    calls.length === 1 && calls[0].blendMode === 'Difference', JSON.stringify(r));
  const calls2 = [];
  const fake2 = { drawRectangle: (o) => calls2.push(o) };
  const r2 = OV.unflipBand(fake2, { axis: 'v', x0: 200, x1: 300 }, 595, 842);
  check('unflipBand: vertical rect spans full height over band cols',
    r2 && r2.x === 200 && r2.y === 0 && r2.w === 100 && r2.h === 842, JSON.stringify(r2));
  const calls3 = [];
  check('unflipBand: null band draws nothing', OV.unflipBand({ drawRectangle: (o) => calls3.push(o) }, null, 595, 842) === null && calls3.length === 0);
  const doc = await PDFDocument.create();
  const pg = doc.addPage([595, 842]);
  OV.unflipBand(pg, { axis: 'h', y0: 335, y1: 507 }, 595, 842);
  const raw = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
  check('unflipBand: real page carries the Difference restore', raw.indexOf('Difference') >= 0);
}

/* ---------- 10) ruleRowsBand: ruling confined to the band ---------- */
{
  const R = OV.ruleRowsBand(595, 842, 25.5, 36, { axis: 'h', y0: 335, y1: 507 });
  const inside = R.ys.length > 0 && R.ys.every((y) => y >= 335 - 0.01 && y <= 507 + 0.01);
  check('ruleRowsBand: 2-up rows stay inside band rows', inside && R.x0 === 36 && R.x1 === 595 - 36, R.ys.length + ' rows');
  const Rv = OV.ruleRowsBand(595, 842, 25.5, 36, { axis: 'v', x0: 236, x1: 358 });
  check('ruleRowsBand: vertical band narrows rows into band cols', Rv.x0 === 246 && Rv.x1 === 348 && Rv.ys.length > 0);
  const Rn = OV.ruleRowsBand(595, 842, 25.5, 36, { axis: 'v', x0: 290, x1: 305 });
  check('ruleRowsBand: too-narrow band yields no rows', Rn.ys.length === 0);
}

/* ---------- 11) drawPage honours bandOnly ---------- */
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595, 842]);
  const c = OV.drawPage(pg, { lines: 'solid', lineStep: 25.5, lineMargin: 36 },
    { i: 0, n: 3, w: 595, h: 842, font: font, bandOnly: true, band: { axis: 'h', y0: 335, y1: 507 } });
  check('drawPage: bandOnly + band rules only the band', c.lines > 0 && c.lines < 12, c.lines + ' lines');
  const pg2 = doc.addPage([595, 842]);
  const c2 = OV.drawPage(pg2, { lines: 'solid', sep: 'both', nums: true, numPos: 'bc', numFmt: 'plain', numSize: 'm', numStart: 1 },
    { i: 0, n: 3, w: 595, h: 842, font: font, bandOnly: true, band: null });
  check('drawPage: bandOnly + no band skips lines but keeps seps/nums',
    c2.lines === 0 && c2.seps === 2 && c2.nums === 1, JSON.stringify(c2));
  const pg3 = doc.addPage([595, 842]);
  const c3 = OV.drawPage(pg3, { lines: 'solid', lineStep: 25.5, lineMargin: 36 },
    { i: 2, n: 3, w: 595, h: 842, font: font });
  check('drawPage: without bandOnly the band is ignored (full page)', c3.lines > 20, c3.lines + ' lines');
}

/* ---------- 12) real packer geometry: the layout's own band must be found ----------
   Regression net for the "4-up toggle does nothing" bug: the 4-up middle band
   is a HORIZONTAL strip (quadLayout), so row detection must cover it on real
   layouts — auto and fixed gap, 2-up and 4-up. Synthetic renders at the same
   0.35 detection scale the app uses, with text-like slide content. */
const MM = 72 / 25.4, DET = 0.35, A4P = { w: 595.28, h: 841.89 }, S169 = { w: 1280, h: 720 };
let tseed = 0;
function trnd() { tseed = (tseed * 1103515245 + 12345) & 0x7fffffff; return tseed / 0x7fffffff; }
function synthLayout(L, slides) {
  const W = Math.round(L.W * DET), H = Math.round(L.H * DET);
  const d = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, v) => { const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = v; };
  slides.forEach((s) => {
    if (!s) return;
    const x0 = Math.max(0, Math.round(s.x * DET)), x1 = Math.min(W, Math.round((s.x + s.width) * DET));
    const y0 = Math.max(0, Math.round((L.H - s.y - s.height) * DET)), y1 = Math.min(H, Math.round((L.H - s.y) * DET));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (y % 7 < 2 && trnd() < 0.28) px(x, y, 40);       // text-line stripes
      else if (trnd() < 0.004) px(x, y, 60);
    }
  });
  return { data: d, w: W, h: H };
}
function layoutBandRows(L) {
  const g = L.gap;
  return { a0: Math.round((L.H - g.y - g.h) * DET), a1: Math.round((L.H - g.y) * DET) };
}
function coversBand(det, exp) {   // detected run must cover the layout band (edge slop allowed)
  if (!det) return false;
  const ov = Math.max(0, Math.min(det.a1, exp.a1) - Math.max(det.a0, exp.a0));
  const dc = Math.abs((det.a0 + det.a1) / 2 - (exp.a0 + exp.a1) / 2);
  return ov / Math.max(1, exp.a1 - exp.a0) >= 0.6 && dc <= 12;
}
{
  tseed = 42;
  const L = CV.quadLayout([S169, S169, S169, S169], { margin: 0, gapMode: 'auto', gap: 0 }, A4P);
  const b = OV.findBand(synthLayout(L, L.slides), 'h', DET);
  check('findBand: real 4-up auto band covered', coversBand(b, layoutBandRows(L)),
    b ? b.a0 + '..' + b.a1 + ' vs ' + layoutBandRows(L).a0 + '..' + layoutBandRows(L).a1 : 'null');
}
{
  tseed = 42;   // fixed gap centres the block: top/bottom padding must NOT win over the 8mm band
  const L = CV.quadLayout([S169, S169, S169, S169], { margin: 0, gapMode: 'fixed', gap: 8 * MM }, A4P);
  const b = OV.findBand(synthLayout(L, L.slides), 'h', DET);
  check('findBand: real 4-up fixed 8mm band found, padding ignored', coversBand(b, layoutBandRows(L)),
    b ? b.a0 + '..' + b.a1 + ' vs ' + layoutBandRows(L).a0 + '..' + layoutBandRows(L).a1 : 'null');
}
{
  tseed = 42;
  const L = CV.sheetLayout(S169, S169, { margin: 12 * MM, gapMode: 'auto', gap: 0 }, A4P);
  const b = OV.findBand(synthLayout(L, [L.top, L.bottom]), 'h', DET);
  check('findBand: real 2-up auto gap covered', coversBand(b, layoutBandRows(L)),
    b ? b.a0 + '..' + b.a1 + ' vs ' + layoutBandRows(L).a0 + '..' + layoutBandRows(L).a1 : 'null');
}
{
  tseed = 42;
  const L = CV.sheetLayout(S169, S169, { margin: 36, gapMode: 'fixed', gap: 8 * MM }, A4P);
  const b = OV.findBand(synthLayout(L, [L.top, L.bottom]), 'h', DET);
  check('findBand: real 2-up fixed 8mm gap covered', coversBand(b, layoutBandRows(L)),
    b ? b.a0 + '..' + b.a1 + ' vs ' + layoutBandRows(L).a0 + '..' + layoutBandRows(L).a1 : 'null');
}
{
  tseed = 42;   // partial sheet: one slide on top, unbounded white below — not a band
  const L = CV.quadLayout([S169, null, null, null], { margin: 0, gapMode: 'auto', gap: 0 }, A4P);
  check('findBand: partial sheet unbounded white is not a band',
    OV.findBand(synthLayout(L, L.slides), 'h', DET) === null);
}
{
  // nearest-to-centre wins: long off-centre run must lose to the short centred band
  const img = synthBand(100, 200, (x, y) => ((y >= 40 && y < 90) || (y >= 95 && y < 110) ? 255 : 20));
  const b = OV.findBand(img, 'h', 1);
  check('findBand: centred short band beats long off-centre run', !!b && b.a0 === 95 && b.a1 === 110,
    b ? b.a0 + '..' + b.a1 : 'null');
}
{
  // padding trap, synthetic: white to both page edges, small centred band between slides
  const img = synthBand(100, 200, (x, y) => {
    if (y < 76 || y >= 131) return 255;                    // padding past the window edges
    if (y >= 95 && y < 110) return 255;                    // the real band
    return 20;                                             // slide content flanks
  });
  const b = OV.findBand(img, 'h', 1);
  check('findBand: edge padding rejected, centred band found', !!b && b.a0 === 95 && b.a1 === 110,
    b ? b.a0 + '..' + b.a1 : 'null');
}

/* ---------- 13) unflipBands: 4-up union restore (horizontal AND vertical) ----------
   Outside 2x2 tools may leave a vertical band or a full white cross; the app
   keeps the union. Two overlapping Difference rects would flip their crossing
   twice (back to black), so the vertical band splits around the horizontal. */
{
  const calls = [];
  const fake = { drawRectangle: (o) => calls.push(o) };
  const r = OV.unflipBands(fake, { y0: 100, y1: 200 }, null, 595, 842);
  check('unflipBands: horizontal-only draws one full-width rect',
    r.length === 1 && r[0].x === 0 && r[0].w === 595 && r[0].y === 100 && r[0].h === 100 &&
    calls.length === 1 && calls[0].blendMode === 'Difference', JSON.stringify(r));
}
{
  const fake = { drawRectangle: () => {} };
  const r = OV.unflipBands(fake, null, { x0: 200, x1: 300 }, 595, 842);
  check('unflipBands: vertical-only draws one full-height rect',
    r.length === 1 && r[0].x === 200 && r[0].w === 100 && r[0].y === 0 && r[0].h === 842, JSON.stringify(r));
}
{
  const fake = { drawRectangle: () => {} };
  const r = OV.unflipBands(fake, { y0: 100, y1: 200 }, { x0: 200, x1: 300 }, 595, 842);
  const disjoint = r.length === 3 &&
    r[1].y >= 200 && r[1].y + r[1].h === 842 &&   // top stub sits above the middle rect
    r[2].y === 0 && r[2].y + r[2].h <= 100 &&     // bottom stub sits below it
    r.every((q) => q.w > 0 && q.h > 0);
  check('unflipBands: cross splits into 3 disjoint rects (no double-flip)', disjoint, JSON.stringify(r));
  const r2 = OV.unflipBands(fake, null, null, 595, 842);
  check('unflipBands: no bands draws nothing', Array.isArray(r2) && r2.length === 0);
}
{
  // outside-tool 2x2: dark quadrants with a white cross (rows + cols 90..110)
  const img = synthBand(200, 200, (x, y) => ((y >= 90 && y < 110) || (x >= 90 && x < 110) ? 255 : 25));
  const bh = OV.findBand(img, 'h', 1), bv = OV.findBand(img, 'v', 1);
  check('findBand: white cross detected on BOTH axes',
    !!bh && bh.a0 === 90 && bh.a1 === 110 && !!bv && bv.a0 === 90 && bv.a1 === 110,
    'h→' + (bh ? bh.a0 + '..' + bh.a1 : 'null') + ' v→' + (bv ? bv.a0 + '..' + bv.a1 : 'null'));
}

/* ---------- 14) whitenBand: ink-mode band restore to paper white ---------- */
function mkBuf(w, h, v) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  return d;
}
function atW(d, w, x, y) { return d[(y * w + x) * 4]; }
{
  const d = mkBuf(10, 10, 20);
  const n = OV.whitenBand(d, 10, 10, { r0: 3, r1: 5, c0: 0, c1: 0 });
  check('whitenBand: rows-only whitens the rows, leaves the rest',
    n === 20 && atW(d, 10, 0, 3) === 255 && atW(d, 10, 9, 4) === 255 &&
    atW(d, 10, 5, 2) === 20 && atW(d, 10, 5, 5) === 20, n + ' px');
}
{
  const d = mkBuf(10, 10, 20);
  const n = OV.whitenBand(d, 10, 10, { r0: 0, r1: 0, c0: 2, c1: 4 });
  check('whitenBand: cols-only whitens the cols, leaves the rest',
    n === 20 && atW(d, 10, 2, 0) === 255 && atW(d, 10, 3, 9) === 255 &&
    atW(d, 10, 1, 5) === 20 && atW(d, 10, 4, 5) === 20, n + ' px');
}
{
  const d = mkBuf(10, 10, 20);
  const n = OV.whitenBand(d, 10, 10, { r0: 4, r1: 6, c0: 4, c1: 6 });
  check('whitenBand: rows+cols whiten the full cross, corners stay',
    n === 40 && atW(d, 10, 0, 5) === 255 && atW(d, 10, 5, 0) === 255 &&
    atW(d, 10, 5, 5) === 255 && atW(d, 10, 0, 0) === 20 && atW(d, 10, 9, 9) === 20, n + ' px');
}
{
  const d = mkBuf(6, 6, 20);
  const n = OV.whitenBand(d, 6, 6, null);
  const n2 = OV.whitenBand(d, 6, 6, { r0: 2, r1: 2, c0: 1, c1: 1 });
  check('whitenBand: null/empty skip is a no-op', n === 0 && n2 === 0 && atW(d, 6, 3, 3) === 20);
}

console.log('\n' + (fail === 0 ? 'ALL OVERLAY CHECKS PASSED' : fail + ' OVERLAY CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
