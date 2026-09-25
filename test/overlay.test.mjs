/* ============ Invert Lab overlays — ruled lines + dotted separator + sheet numbers ============
   node test/overlay.test.mjs       (needs pdf-lib in node_modules)
   Vector-sharp finishing touches drawn on top of each finished 1:1 page.
   Everything is OFF by default, so existing outputs stay byte-identical. */
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const require = createRequire(import.meta.url);
const OV = require('../overlays.js');

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

console.log('\n' + (fail === 0 ? 'ALL OVERLAY CHECKS PASSED' : fail + ' OVERLAY CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
