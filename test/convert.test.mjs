/* Node test for the shipped converter module (same code the browser runs).
 * Run:  node test/convert.test.mjs       (needs pdf-lib in node_modules)   */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const NC = require('../converter.js');

const DEMO = { // measured from user's "11th (2).pdf" (top-left origin, pt)
  page: { w: 595.276, h: 841.89 },
  top:    { x: 0.45,  y: -0.07, w: 595.99, h: 334.02 },  // PDF top-origin
  bottom: { x: 1.52,  y: 511.73, w: 593.04, h: 332.36 },
};
const SRC_PAGE = { w: 1280, h: 718 }; // measured from user's notes PDF

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   [' + extra + ']' : ''));
  if (!cond) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------- 1. geometry matches the demo layout ---------- */
console.log('1) layout vs demo (auto gap, margin 0):');
const opts = NC.normalize({ margin: 0, gapMode: 'auto' });
const L = NC.sheetLayout(SRC_PAGE, SRC_PAGE, opts, { w: 595.28, h: 841.89 });
// convert to top-origin for comparison
const topTopOrigin = { x: L.top.x, y: L.H - (L.top.y + L.top.height), w: L.top.width, h: L.top.height };
const botTopOrigin = { x: L.bottom.x, y: L.H - (L.bottom.y + L.bottom.height), w: L.bottom.width, h: L.bottom.height };
const gapSize = L.gap.h;
check('sheet is A4 portrait', near(L.W, 595.28, .01) && near(L.H, 841.89, .01), `${L.W.toFixed(2)}x${L.H.toFixed(2)}`);
check('top slide flush at page top, full width', near(topTopOrigin.y, 0, 0.5) && near(topTopOrigin.x, 0, 1) && near(topTopOrigin.w, 595.28, 1),
  `x=${topTopOrigin.x.toFixed(1)} y=${topTopOrigin.y.toFixed(1)} w=${topTopOrigin.w.toFixed(1)} h=${topTopOrigin.h.toFixed(1)}`);
check('bottom slide flush at page bottom', near(botTopOrigin.y + botTopOrigin.h, L.H, 0.5) && near(botTopOrigin.w, 595.28, 1),
  `bottom ends at ${(botTopOrigin.y + botTopOrigin.h).toFixed(1)} (page ${L.H.toFixed(1)})`);
check('top slide height ≈ demo (334.0 pt)', near(topTopOrigin.h, 334.0, 1.5), `got ${topTopOrigin.h.toFixed(1)}`);
check('middle gap ≈ demo (177.8 pt white space)', near(gapSize, 177.8, 6), `got ${gapSize.toFixed(1)} pt = ${(gapSize * 25.4 / 72).toFixed(1)} mm`);
check('slides keep 16:9 aspect', near(topTopOrigin.w / topTopOrigin.h, 1280 / 718, 0.01), (topTopOrigin.w / topTopOrigin.h).toFixed(3));

/* ---------- 2. fixed gap centers the stack & everything stays on-sheet ---------- */
console.log('2) fixed gap + margins + lines + page numbers (invariants):');
const o2 = NC.normalize({ margin: 14, gapMode: 'fixed', gap: 120, lines: true, pageNumbers: true });
const L2 = NC.sheetLayout(SRC_PAGE, SRC_PAGE, o2, { w: 595.28, h: 841.89 });
check('both slides fit inside margins',
  L2.top.y >= 14 - 0.01 && L2.top.y + L2.top.height <= 841.89 - 14 + 0.01 &&
  L2.bottom.y >= 14 - 0.01 && L2.bottom.y + L2.bottom.height <= 841.89 - 14 + 0.01);
check('gap between slides ≈ requested 120pt (or shrunk if needed)',
  near(L2.top.y - (L2.bottom.y + L2.bottom.height), Math.min(120, 841.89 - 28 - 2 * L2.top.height), 0.6),
  `got ${(L2.top.y - (L2.bottom.y + L2.bottom.height)).toFixed(1)}`);
check('ruled lines all inside gap band', L2.lines.length > 0 && L2.lines.every(y => y >= L2.bottom.y + L2.bottom.height && y <= L2.top.y), `${L2.lines.length} lines`);
const L3 = NC.sheetLayout(SRC_PAGE, SRC_PAGE, NC.normalize({ gapMode: 'fixed', gap: 300 }), { w: 595.28, h: 841.89 });
check('oversized gap shrinks slides to fit (never overflows)', L3.top.y + L3.top.height <= 841.89 + 0.01 && L3.top.height < 334, `slide h=${L3.top.height.toFixed(1)}`);

/* ---------- 3. odd page count: lone slide on the last sheet ---------- */
console.log('3) odd count:');
const L4 = NC.sheetLayout(SRC_PAGE, null, opts, { w: 595.28, h: 841.89 });
check('single-page sheet: top only, bottom null', L4.top !== null && L4.bottom === null);

/* ---------- 4. REAL build on the user's notes PDF (2 pages → 1 sheet) ---------- */
console.log('4) build() on real notes PDF:');
const src = readFileSync(process.argv[2] || '/home/user/uploads/6120851524276654305.pdf');
let progressSeen = 0;
const t0 = Date.now();
const res = await NC.build(src, { margin: 0, gapMode: 'auto' }, () => { progressSeen++; });
const outDoc = await PDFDocument.load(res.bytes);
const p0 = outDoc.getPages()[0];
check('2 source pages → 1 sheet', res.sheets === 1 && outDoc.getPageCount() === 1, `sheets=${res.sheets}`);
check('output page is A4', near(p0.getWidth(), 595.28, 0.01) && near(p0.getHeight(), 841.89, 0.01), `${p0.getWidth().toFixed(2)}x${p0.getHeight().toFixed(2)}`);
check('progress callback fired', progressSeen === 1);
writeFileSync('/home/user/out_two_up.pdf', Buffer.from(res.bytes));
console.log(`  build time: ${Date.now() - t0} ms, output bytes: ${res.bytes.length}, progress ticks: ${progressSeen}`);

/* ---------- 5. odd + options run end-to-end ---------- */
console.log('5) build() with 3 pages, fixed gap, lines, numbers:');
const pad = await PDFDocument.create();
const [e0] = await pad.embedPdf(src, [0]);
for (let i = 0; i < 3; i++) {
  const pg = pad.addPage([1280, 718]);
  pg.drawPage(e0, { x: 0, y: 0, width: 1280, height: 718 });
}
const threeBytes = await pad.save();
const res3 = await NC.build(threeBytes, { gapMode: 'fixed', gap: 90, lines: true, pageNumbers: true, margin: 10 });
const doc3 = await PDFDocument.load(res3.bytes);
check('3 pages → 2 sheets', res3.sheets === 2 && doc3.getPageCount() === 2, `sheets=${res3.sheets}`);
writeFileSync('/home/user/out_three_up.pdf', Buffer.from(res3.bytes));

/* ---------- 5b. 4-up LANDSCAPE pair-column geometry vs measured demo ---------- */
console.log('5b) 4-up landscape vs demo bbox (measured from "11th (2) (1).pdf"):');
const QPAGE = NC.sheetSize(NC.normalize({ perSheet: 4 }));
check('sheet is landscape A4', near(QPAGE.w, 841.89, .01) && near(QPAGE.h, 595.28, .01), `${QPAGE.w.toFixed(2)}x${QPAGE.h.toFixed(2)}`);
const demoSizes = [{ w: 1280, h: 718 }, { w: 1280, h: 718 }, { w: 1280, h: 715 }, { w: 1280, h: 716 }];
const qo = NC.normalize({ perSheet: 4 });
const Q = NC.quadLayout(demoSizes, qo, QPAGE);
// user's demo image boxes, top-left origin [x0,y0,x1,y1]: TL=p1, BL=p2, TR=p3, BR=p4
const DEMO_CELLS = [
  [-0.99, -1.33, 420.10, 234.89],
  [-0.99, 363.07, 420.10, 599.25],
  [424.16, 1.96, 845.25, 237.05],
  [421.86, 364.69, 842.95, 600.33],
];
Q.slides.forEach(function (b, i) {
  const topY = QPAGE.h - (b.y + b.height);
  const dev = Math.max(Math.abs(b.x - DEMO_CELLS[i][0]), Math.abs(topY - DEMO_CELLS[i][1]),
    Math.abs(b.x + b.width - DEMO_CELLS[i][2]), Math.abs(topY + b.height - DEMO_CELLS[i][3]));
  check('cell ' + ['TL', 'BL', 'TR', 'BR'][i] + ' within 6pt of demo', dev <= 6, 'max dev ' + dev.toFixed(2) + 'pt');
});
check('pair-column order: pages 1·2 left, 3·4 right', near(Q.slides[1].x, Q.slides[0].x, .01) && Q.slides[2].x > QPAGE.w / 2 - .01);
check('middle band ≈ demo 126pt', near(Q.gap.h, 126.0, 6), `${Q.gap.h.toFixed(1)}pt = ${(Q.gap.h * 25.4 / 72).toFixed(1)}mm`);
check('columns flush, no center gutter', Math.abs(Q.slides[2].x - (Q.slides[0].x + Q.slides[0].width)) <= 4.2);
const qp = NC.quadLayout([demoSizes[0], demoSizes[1]], qo, QPAGE);
check('partial sheet (2 of 4) → right column empty, no crash', !!(qp.slides[0] && qp.slides[1]) && qp.slides[2] === null && qp.slides[3] === null);
const qf = NC.quadLayout(demoSizes, NC.normalize({ perSheet: 4, gapMode: 'fixed', gap: 200 }), QPAGE);
check('huge fixed gap shrinks to fit, never overflows', qf.slides.every(b => b.y >= -.01 && b.y + b.height <= 595.281));
const src4 = readFileSync('/home/user/uploads/6120851524276654305 (1).pdf');
const resQ = await NC.build(src4, { perSheet: 4, lines: true, pageNumbers: true });
const docQ = await PDFDocument.load(resQ.bytes);
check('build(): 4 real pages → 1 landscape sheet', docQ.getPageCount() === 1 && near(docQ.getPage(0).getWidth(), 841.89, .02) && near(docQ.getPage(0).getHeight(), 595.28, .02), `pages=${docQ.getPageCount()}`);
writeFileSync('/home/user/out_four_up.pdf', Buffer.from(resQ.bytes));

/* ---------- 6. 400-page claim: pages halve ---------- */
console.log('6) halving math:');
const big = await PDFDocument.create();
for (let i = 0; i < 400; i++) big.addPage([1280, 718]);
const bigBytes = await big.save();
const resBig = await NC.build(bigBytes, {}, null);
check('400 pages → exactly 200 sheets', resBig.sourcePages === 400 && resBig.sheets === 200, `sheets=${resBig.sheets}`);
const resQ400 = await NC.build(bigBytes, { perSheet: 4 }, null);
check('400 pages → exactly 100 landscape sheets (−75%)', resQ400.sheets === 100, `sheets=${resQ400.sheets}`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
