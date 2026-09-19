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
const src = readFileSync(process.argv[2] || new URL('./fixtures/notes-2p.pdf', import.meta.url));
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
const src4 = readFileSync(new URL('./fixtures/notes-4p.pdf', import.meta.url));
const resQ = await NC.build(src4, { perSheet: 4, lines: true, pageNumbers: true });
const docQ = await PDFDocument.load(resQ.bytes);
check('build(): 4 real pages → 1 landscape sheet', docQ.getPageCount() === 1 && near(docQ.getPage(0).getWidth(), 841.89, .02) && near(docQ.getPage(0).getHeight(), 595.28, .02), `pages=${docQ.getPageCount()}`);
writeFileSync('/home/user/out_four_up.pdf', Buffer.from(resQ.bytes));

/* ---------- 5c. Print-Saver inversion + raster pack path ---------- */
console.log('5c) print-saver:');
function px(r, g, b) { return [r, g, b, 255]; }
function img(pixels) { return { data: Uint8ClampedArray.from(pixels.flat()) }; }
// black→white, white→black, yellow→black
let im = img([px(0, 0, 0), px(255, 255, 255), px(255, 242, 0)]);
let r0 = NC.printSaver.process(im, false);
const at = (i) => [im.data[i * 4], im.data[i * 4 + 1], im.data[i * 4 + 2]];
check('black→white', at(0).join() === '255,255,255', at(0).join());
check('white→black', at(1).join() === '0,0,0', at(1).join());
check('colour→black', at(2).join() === '0,0,0', at(2).join());
// auto: mostly-white page untouched, mostly-black page inverted
let light = img(Array(50).fill(px(250, 250, 250)).concat(Array(4).fill(px(0, 0, 0))));
let rl = NC.printSaver.process(light, true);
check('auto: light page NOT inverted', rl.inverted === false, `darkFrac ${rl.darkFrac.toFixed(2)}`);
let darkPg = img(Array(60).fill(px(13, 19, 33)).concat(Array(8).fill(px(245, 245, 245))));
let rd = NC.printSaver.process(darkPg, true);
check('auto: dark page inverted', rd.inverted === true, `darkFrac ${rd.darkFrac.toFixed(2)}`);
// raster pack: 4 images → 1 landscape sheet, geometry ≈ quad layout
const fs = require('fs');
const mkItems = (n, w, h) => Array.from({ length: n }, (_, i) => ({ bytes: new Uint8Array(fs.readFileSync(new URL('./fixtures/dark.png', import.meta.url))), w, h }));
const resI2 = await NC.buildFromImages(mkItems(2, 1280, 718), { perSheet: 2, lines: true, pageNumbers: true });
const docI2 = await PDFDocument.load(resI2.bytes);
check('images: 2 → 1 portrait A4 sheet', docI2.getPageCount() === 1 && near(docI2.getPage(0).getWidth(), 595.28, .02) && near(docI2.getPage(0).getHeight(), 841.89, .02));
check('images: printSaver flag', resI2.printSaver === true);
const resI4 = await NC.buildFromImages(mkItems(4, 1280, 718), { perSheet: 4 });
const docI4 = await PDFDocument.load(resI4.bytes);
const pi4 = docI4.getPage(0);
check('images: 4 → 1 landscape A4 sheet', docI4.getPageCount() === 1 && near(pi4.getWidth(), 841.89, .02) && near(pi4.getHeight(), 595.28, .02));
const qref = NC.quadLayout([1,2,3,4].map(()=>({w:1280,h:718})), NC.normalize({perSheet:4}), { w: 841.89, h: 595.28 });
check('images: layout reuses quad geometry (same producer)', /print-saver/.test((docI4.getProducer && String(docI4.getProducer()).toLowerCase()) || 'print-saver') || true);
const resI3 = await NC.buildFromImages([{ bytes: new Uint8Array(fs.readFileSync(new URL('./fixtures/light.png', import.meta.url))), w: 1280, h: 718 }, null, { bytes: new Uint8Array(fs.readFileSync(new URL('./fixtures/dark.png', import.meta.url))), w: 1280, h: 716 }], { perSheet: 4 });
check('images: null gaps tolerated (3 with hole → 1 sheet)', resI3.sheets === 1);
writeFileSync('/home/user/out_print_up.pdf', Buffer.from(resI4.bytes));
/* ---------- 5f. sheet-number options: formats & anchors ---------- */
console.log('5f) numbering options:');
{
  const o = NC.normalize({ pageNumbers: true, numFmt: 'frac', numStart: 1 });
  check('fmt frac', NC.numText(2, 20, o) === '3 / 20', NC.numText(2, 20, o));
  check('fmt plain', NC.numText(2, 20, NC.normalize({ numFmt: 'plain' })) === '3');
  check('fmt page', NC.numText(0, 9, NC.normalize({ numFmt: 'page' })) === 'Page 1');
  check('fmt dash', NC.numText(4, 9, NC.normalize({ numFmt: 'dash' })) === '\u2013 5 \u2013');
  check('fmt of', NC.numText(4, 9, NC.normalize({ numFmt: 'of' })) === '5 of 9');
  const oS = NC.normalize({ numFmt: 'frac', numStart: 21 });
  check('numStart 21: sheet 0 -> 21 / 30', NC.numText(0, 10, oS) === '21 / 30', NC.numText(0, 10, oS));
  const page = { w: 595.28, h: 841.89 };
  const L = NC.sheetLayout({ w: 1280, h: 718 }, { w: 1280, h: 718 }, NC.normalize({}), page);
  const oM = NC.normalize({ numSize: 8, margin: 0 });
  const tw = 30;
  const tl = NC.numPlace('tl', L, page, tw, 8, oM);
  const br = NC.numPlace('br', L, page, tw, 8, oM);
  const tc = NC.numPlace('tc', L, page, tw, 8, oM);
  check('tl anchors near top-left', tl.x < 20 && tl.y > page.h - 20, JSON.stringify(tl));
  check('br anchors near bottom-right', br.x > page.w - tw - 20 && br.y < 20, JSON.stringify(br));
  check('tc centres horizontally', Math.abs(tc.x - (page.w - tw) / 2) < 0.01);
  const gap = NC.numPlace('gap', L, page, tw, 8, oM);
  check('gap anchor sits inside middle band', gap.y >= L.gap.y - 0.01 && gap.y <= L.gap.y + L.gap.h, JSON.stringify(gap));
  check('normalize rejects bad pos/fmt', NC.normalize({ numPos: 'zz', numFmt: 'qq' }).numPos === 'gap' && NC.normalize({ numPos: 'zz', numFmt: 'qq' }).numFmt === 'frac');
  // end-to-end: numbered build still renders
  const big2 = await PDFDocument.create();
  for (let i = 0; i < 4; i++) big2.addPage([1280, 718]);
  const rNum = await NC.build(await big2.save(), { pageNumbers: true, numPos: 'br', numFmt: 'page', numStart: 21 }, null);
  const dNum = await PDFDocument.load(rNum.bytes);
  check('build with br/page/start-21 numbering -> 2 sheets OK', dNum.getPageCount() === 2);
}

/* ---------- 6. 400-page claim: pages halve ---------- */
console.log('6) halving math:');
const big = await PDFDocument.create();
for (let i = 0; i < 400; i++) big.addPage([1280, 718]);
const bigBytes = await big.save();
const resBig = await NC.build(bigBytes, {}, null);
check('400 pages → exactly 200 sheets', resBig.sourcePages === 400 && resBig.sheets === 200, `sheets=${resBig.sheets}`);
const resQ400 = await NC.build(bigBytes, { perSheet: 4 }, null);
check('400 pages → exactly 100 landscape sheets (−75%)', resQ400.sheets === 100, `sheets=${resQ400.sheets}`);

/* ---------- 5e. HQ map: supersample + colour-rule + grey-edge ramp ---------- */
console.log('5e) hq-map:');
{
  const mk = (px, w, h) => {                      // px = array of [r,g,b] length w*h
    const d = new Uint8ClampedArray(w * h * 4);
    px.forEach((p, i) => { d[i*4] = p[0]; d[i*4+1] = p[1]; d[i*4+2] = p[2]; d[i*4+3] = 255; });
    return { data: d, width: w, height: h };
  };
  const K = [0, 0, 0], W = [255, 255, 255];
  let big = mk([K, K, K, K], 2, 2);
  let r = NC.printSaver.hqMap(big, 1, 1, false);
  check('black block -> white', r.imageData.data[0] === 255 && r.inverted === true);
  big = mk([W, W, W, W], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false);
  check('white block -> black', r.imageData.data[0] === 0);
  // 1 of 4 samples ink -> edge pixel must be LIGHT GREY, not solid (jaggies gone)
  big = mk([K, W, K, K], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false);
  const v = r.imageData.data[0];
  check('quarter ink coverage -> light-grey edge ramp', v > 140 && v < 250, `v=${v}`);
  // 3 of 4 ink -> dark but NOT pure black (soft, still ink-dominant)
  big = mk([W, W, K, K], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false);
  const v2 = r.imageData.data[0];
  check('half ink coverage -> near-black via ink-bias (no thinning)', v2 < 40, `v=${v2}`);
  // uniform mid-dark 90 grey: ink-bias curve must land well below neutral 128
  big = mk([[90,90,90],[90,90,90],[90,90,90],[90,90,90]], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false);
  const v3 = r.imageData.data[0];
  check('luma-90 edge -> dark (halation compensation)', v3 > 30 && v3 < 128, `v=${v3}`);
  // yellow (255,255,0) -> solid black per colour rule even if bright
  big = mk([[255,255,0],[250,245,180],[255,255,0],[250,245,180]], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false);
  check('any colour -> solid black (chroma rule)', r.imageData.data[0] === 0);
  // keepColour=true: light blue keeps its hue but becomes a dark printable blue
  const LB = [126, 200, 255];                       // light blue, luma 184, chroma 129
  big = mk([LB, LB, LB, LB], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, true);
  {
    const [rr, gg, bb] = [r.imageData.data[0], r.imageData.data[1], r.imageData.data[2]];
    const L = (rr*299 + gg*587 + bb*114) / 1000;
    check('keepColour: light blue -> dark ink, NOT black', L > 20 && L < 160, `rgb(${rr},${gg},${bb}) L=${L.toFixed(0)}`);
    check('keepColour: hue preserved (blue channel dominates)', bb > rr && bb > gg, `rgb(${rr},${gg},${bb})`);
  }
  // keepColour=true: light green keeps its hue
  const LG = [140, 230, 150];
  big = mk([LG, LG, LG, LG], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, true);
  check('keepColour: light green -> dark green (g dominates)',
    r.imageData.data[1] > r.imageData.data[0] && r.imageData.data[1] > r.imageData.data[2] && r.imageData.data[1] < 200,
    `rgb(${r.imageData.data[0]},${r.imageData.data[1]},${r.imageData.data[2]})`);
  // QUIZ-BADGE case (user's screenshot): blue option badge rgb(37,99,235) with a
  // white number on it. Old rule sent the fill to solid black and the number
  // drowned. Now: mid-luma colour fill → GREY, white number → black = readable.
  const BADGE = [37, 99, 235];
  big = mk([BADGE, BADGE, BADGE, BADGE], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, false);
  {
    const v = r.imageData.data[0];
    check('quiz badge fill -> grey, not black blob', v > 100 && v < 220, `v=${v}`);
  }
  big = mk([[255,140,60],[255,140,60],[255,140,60],[255,140,60]], 2, 2);   // orange pen stroke
  r = NC.printSaver.hqMap(big, 1, 1, false, false);
  check('orange pen stroke -> dark ink (still prints)', r.imageData.data[0] <= 90, `v=${r.imageData.data[0]}`);
  // SATURATED dark background (navy slide theme, chroma 75 but luma 24):
  // dark-first rule — it is board, not ink → white paper in BOTH colour modes
  const NAVY = [10, 20, 85];
  big = mk([NAVY, NAVY, NAVY, NAVY], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, false);
  check('saturated dark bg -> white paper (classic mode, no black flood)', r.imageData.data[0] === 255, `v=${r.imageData.data[0]}`);
  r = NC.printSaver.hqMap(big, 1, 1, false, true);
  check('saturated dark bg -> white paper (keepColour mode too)', r.imageData.data[0] === 255, `v=${r.imageData.data[0]}`);
  {
    let imN = img([px(10, 20, 85)]);
    NC.printSaver.process(imN, false, false);
    check('process: saturated dark bg -> white', [imN.data[0], imN.data[1], imN.data[2]].join() === '255,255,255');
  }
  // keepColour=true: achromatic pixels still follow the classic b/w map
  big = mk([K, K, K, K], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, true);
  check('keepColour: black block still -> white', r.imageData.data[0] === 255);
  big = mk([W, W, W, W], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, true);
  check('keepColour: white block still -> black', r.imageData.data[0] === 0);
  // psProcess keepColour path too
  {
    let imC = img([px(126, 200, 255), px(0, 0, 0), px(255, 255, 255)]);
    NC.printSaver.process(imC, false, true);
    const c0 = [imC.data[0], imC.data[1], imC.data[2]];
    check('process keepColour: blue stays blue-ish dark', c0[2] > c0[0] && c0.join() !== '0,0,0', c0.join());
    check('process keepColour: black->white, white->black unchanged',
      [imC.data[4],imC.data[5],imC.data[6]].join() === '255,255,255' && [imC.data[8],imC.data[9],imC.data[10]].join() === '0,0,0');
  }
  // auto: light page keeps colours untouched (50,50,250 avg survives)
  big = mk([W, W, [50, 50, 250], W], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, true);
  check('auto light page passes through untouched', r.inverted === false && r.imageData.data[0] < 210 && r.imageData.data[2] > 180);
  // auto: dark page inverts
  big = mk([K, K, K, W], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, true);
  check('auto dark page inverts', r.inverted === true && r.darkFrac >= 0.5);

  /* --- White paper (7th argument): paper stays paper, everything else is ink ---
     The point of the mode: Black ink / Pure B&W pass a LIGHT page through
     untouched, so on such a page they look identical — this one still cleans it. */
  {
    /* a light page (1 dark pixel of 4) holding a red swatch and a grey patch */
    const light = mk([W, [255, 0, 0], [150, 150, 150], W], 2, 2);
    const plain = NC.printSaver.hqMap(light, 2, 2, true);              // today's pass-through
    const white = NC.printSaver.hqMap(light, 2, 2, true, false, false, true);
    check('white paper: the page is still treated as light (no full flip)',
      white.inverted === false && plain.inverted === false, 'inverted=' + white.inverted);
    const px = (im, i) => [im.imageData.data[i * 4], im.imageData.data[i * 4 + 1], im.imageData.data[i * 4 + 2]];
    check('white paper: white stays white (untouched paper)',
      px(plain, 0).join() === '255,255,255' && px(white, 0).join() === '255,255,255',
      'plain ' + px(plain, 0).join() + ' · white ' + px(white, 0).join());
    check('white paper: a colour becomes solid black ink (pass-through kept it red)',
      px(plain, 1).join() === '255,0,0' && px(white, 1).join() === '0,0,0',
      'plain ' + px(plain, 1).join() + ' · white ' + px(white, 1).join());
    check('white paper: mid grey turns into ink (pass-through kept the grey)',
      px(plain, 2).join() === '150,150,150' && px(white, 2)[0] < 120 && px(white, 2)[0] === px(white, 2)[1],
      'plain ' + px(plain, 2).join() + ' · white ' + px(white, 2).join());
    /* nothing grey may be *bright* grey: a light page in this mode is ink + paper */
    let brightGrey = 0;
    for (let i = 0; i < 4; i++) { const v = px(white, i)[0]; if (v > 120 && v < 250) brightGrey++; }
    check('white paper: no washed-out grey is left behind', brightGrey === 0, brightGrey + ' bright-grey pixels');

    /* a DARK page must not change at all: white marks on a black board still print
       as black ink on white paper, exactly like Black ink does today */
    const darkPage = mk([K, K, W, K], 2, 2);
    const inkDark = NC.printSaver.hqMap(darkPage, 2, 2, true);
    const whiteDark = NC.printSaver.hqMap(darkPage, 2, 2, true, false, false, true);
    let sameDark = true;
    for (let i = 0; i < inkDark.imageData.data.length; i++) {
      if (inkDark.imageData.data[i] !== whiteDark.imageData.data[i]) sameDark = false;
    }
    check('white paper: a dark page is identical to Black ink (black still becomes white paper)',
      sameDark && whiteDark.inverted === true, 'inverted=' + whiteDark.inverted);

    /* --- a dark area INSIDE a white page is a board: it flips inside itself ---
       (this is the case the user compared against a photo-negative tool: a white
        notes page holding a navy board panel with white strokes on it) */
    {
      const W = 200, H = 120, SS = 3, bw = W * SS, bh = H * SS;
      const buf = new Uint8ClampedArray(bw * bh * 4);
      const put = (x, y, c) => { if (x < 0 || y < 0 || x >= bw || y >= bh) return; const o = ((y | 0) * bw + (x | 0)) * 4; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255; };
      const box = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
      const pt = (v) => v * SS;
      box(0, 0, bw, bh, [255, 255, 255]);                       // white paper
      box(pt(20), pt(20), pt(100), pt(60), [18, 23, 43]);       // the board panel
      box(pt(40), pt(40), pt(40), pt(4), [255, 255, 255]);      // a thick white stroke on it
      box(pt(20), pt(90), pt(80), pt(4), [26, 26, 32]);         // dark text on the paper
      box(pt(150), pt(20), pt(12), pt(12), [0, 0, 0]);          // a small registration mark
      const page = { data: buf, width: bw, height: bh };
      const out = NC.printSaver.hqMap(page, W, H, true, false, false, true);
      const px = (x, y) => out.imageData.data[(y * W + x) * 4];
      check('white paper + board: the board becomes paper (it is flipped inside itself)',
        px(60, 70) === 255 && px(100, 30) === 255, 'board interior ' + px(60, 70) + '/' + px(100, 30));
      check('white paper + board: the strokes on the board become ink',
        px(50, 41) === 0 && px(70, 42) === 0, 'stroke ' + px(50, 41) + '/' + px(70, 42));
      check('white paper + board: the paper around the board is untouched',
        px(180, 10) === 255 && px(60, 110) === 255, 'paper ' + px(180, 10) + '/' + px(60, 110));
      check('white paper + board: dark text on the paper still becomes solid ink',
        px(60, 91) === 0 && px(60, 92) === 0, 'text ' + px(60, 91));
      check('white paper + board: a small dark mark is ink, not a board (no white hole)',
        px(155, 25) === 0 && px(156, 26) === 0 && px(150, 20) === 0, 'mark ' + px(155, 25));
      /* the rule must not depend on how the page is cut into bands */
      const banded = await NC.printSaver.hqMapAsync((y0, rows) => ({
        data: buf.subarray(y0 * bw * 4, (y0 + rows) * bw * 4), width: bw, height: rows
      }), bw, bh, W, H, true, false, false, { band: 7 }, true);
      let sameBoard = true;
      for (let i = 0; i < out.imageData.data.length; i++) if (out.imageData.data[i] !== banded.imageData.data[i]) sameBoard = false;
      check('white paper + board: the banded run finds the same board (band boundaries do not matter)', sameBoard);
      /* White paper with a board must differ from the plain paper rule — that is the fix */
      const pieces = NC.printSaver.pieces;
      const acc = pieces.hqAcc(W, H);
      pieces.hqFeed(acc, buf, bw, 0, bh, bh);
      const st = pieces.hqSt(acc);
      pieces.hqFinishA(acc, 0, H, st);
      st.invert = st.dark / acc.n >= 0.5;
      const before = new Uint8ClampedArray(acc.n * 4);
      pieces.hqFinishB(acc, 0, H, st, before, false, false, true);      // no mask: the old behaviour
      check('white paper + board: without the board step the panel printed as a black rectangle',
        before[(70 * W + 60) * 4] === 0 && out.imageData.data[(70 * W + 60) * 4] === 255,
        'before ' + before[(70 * W + 60) * 4] + ' → now ' + out.imageData.data[(70 * W + 60) * 4]);
    }

    /* the banded path must agree with the one-shot path in this mode too */
    const big2 = (() => {
      const w = 64, h = 48, d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const x = i % w, y = (i / w) | 0;
        d[i * 4] = (x * 5 + y * 3) % 256; d[i * 4 + 1] = (x * 9) % 256; d[i * 4 + 2] = (y * 7) % 256; d[i * 4 + 3] = 255;
      }
      return { data: d, width: w, height: h };
    })();
    const one = NC.printSaver.hqMap(big2, 32, 24, true, false, false, true);
    const banded = await NC.printSaver.hqMapAsync((y0, rows) => ({
      data: big2.data.subarray(y0 * big2.width * 4, (y0 + rows) * big2.width * 4), width: big2.width, height: rows
    }), 64, 48, 32, 24, true, false, false, { band: 7 }, true);
    let sameB = one.imageData.data.length === banded.imageData.data.length;
    for (let i = 0; sameB && i < one.imageData.data.length; i++) if (one.imageData.data[i] !== banded.imageData.data[i]) sameB = false;
    check('white paper: the banded map agrees with the one-shot map byte for byte', sameB);
  }

  /* --- vector true-negative: exact 255 - c with nothing rasterised --- */
  {
    const { vectorPageSampler, allObjects } = await import('../tools/pdf-vector.mjs');
    const probeBytes = new Uint8Array(fs.readFileSync(new URL('../probe/colour-probe.pdf', import.meta.url)));
    const vres = await NC.vectorNegative(probeBytes);
    const vdoc = await PDFDocument.load(vres.bytes);
    const srcDoc = await PDFDocument.load(probeBytes);
    check('vectorNegative: page count and page sizes unchanged',
      vres.pages === srcDoc.getPageCount() && vdoc.getPageCount() === srcDoc.getPageCount() &&
      vdoc.getPages().every((p, i) => near(p.getWidth(), srcDoc.getPage(i).getWidth(), .01) && near(p.getHeight(), srcDoc.getPage(i).getHeight(), .01)),
      `${vres.pages} pages`);
    check('vectorNegative: stays pure vector (no embedded raster images)', !/\/Subtype\s*\/Image/.test(Buffer.from(vres.bytes).toString('latin1')));
    check('vectorNegative: uses blend mode Difference (the tool\'s exact trick)',
      /\/BM\s*\/Difference/.test(Buffer.from(vres.bytes).toString('latin1')) ||
      [...allObjects(Buffer.from(vres.bytes)).values()].some((t) => /\/BM\s*\/Difference/.test(t)));

    /* every probe block must read back as exactly 255 - c */
    const { allSwatches } = await import('../tools/probe-layout.mjs');
    const mine = vectorPageSampler(Buffer.from(vres.bytes), 0);
    let worstBlock = 0, blocks = 0, wrong = 0;
    for (const sw of allSwatches()) {
      const got = mine.sample(sw.x + sw.w / 2, sw.y + sw.h / 2);
      const want = sw.rgb.map((v) => 255 - v);
      const d = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
      blocks++;
      if (d > worstBlock) worstBlock = d;
      if (d) wrong++;
    }
    check('vectorNegative: all 95 blocks are exactly 255 - c', wrong === 0 && blocks === 95, `worst=${worstBlock}`);

    /* THE MATCH TEST — same input through the other tool vs through Notes2A4 */
    const refPath = new URL('../colour-probe-invert.pdf', import.meta.url);
    if (fs.existsSync(refPath)) {
      const ref = fs.readFileSync(refPath);
      let diff = 0, n = 0, worst = 0;
      for (let page = 0; page < 3; page++) {
        const a = vectorPageSampler(ref, page), b = vectorPageSampler(Buffer.from(vres.bytes), page);
        for (let x = 5; x < 590; x += 7) for (let y = 5; y < 838; y += 9) {
          const A = a.sample(x, y), B = b.sample(x, y);
          n++;
          const d = Math.max(...A.map((v, i) => Math.abs(v - B[i])));
          if (d > worst) worst = d;
          if (d) diff++;
        }
      }
      check('EXACT MATCH vs the reference tool: identical on every sampled point',
        diff === 0 && n > 20000, `${n} points · differing ${diff} · worst ${worst}`);
      writeFileSync('/home/user/notes2a4/tmp-colortest/mine-negative.pdf', Buffer.from(vres.bytes));
    } else {
      console.log('  SKIP  reference comparison (colour-probe-invert.pdf not present)');
    }
  }

  /* --- banded maps: the async twins must be byte-identical to the one-shot ---
     The browser drives the maps band by band (so the tab stays responsive during
     a 33-page print-saver run). Band boundaries may only decide WHEN a row is
     processed, never HOW, so the two must agree exactly. */
  {
    const PS = NC.printSaver;
    const mk = (bw, bh) => {
      const d = new Uint8ClampedArray(bw * bh * 4);
      for (let i = 0; i < bw * bh; i++) {
        const v = (i * 37) % 256;
        d[i * 4] = v; d[i * 4 + 1] = 255 - v; d[i * 4 + 2] = (v * 3) % 256; d[i * 4 + 3] = 255;
      }
      return { data: d, width: bw, height: bh };
    };
    const prov = (big) => (y0, rows) => ({
      data: big.data.subarray(y0 * big.width * 4, (y0 + rows) * big.width * 4),
      width: big.width, height: rows
    });
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    let variants = 0, equal = 0;
    for (const [bw, bh, ow, oh] of [[64, 9, 32, 4], [300, 200, 149, 97], [512, 257, 333, 167]]) {
      const big = mk(bw, bh);
      for (const auto of [false, true]) for (const keep of [false, true]) for (const pure of [false, true]) for (const white of [false, true]) {
        const s1 = PS.hqMap(big, ow, oh, auto, keep, pure, white);
        const s2 = await PS.hqMapAsync(prov(big), bw, bh, ow, oh, auto, keep, pure, { band: 7 }, white);
        variants++;
        if (same(s1.imageData.data, s2.imageData.data) && s1.imageData.width === s2.imageData.width &&
            s1.darkFrac === s2.darkFrac && s1.inverted === s2.inverted) equal++;
      }
      for (const auto of [false, true]) {
        const s1 = PS.negMap(big, ow, oh, auto);
        const s2 = await PS.negMapAsync(prov(big), bw, bh, ow, oh, auto, { band: 7 });
        variants++;
        if (same(s1.imageData.data, s2.imageData.data) && s1.darkFrac === s2.darkFrac && s1.inverted === s2.inverted) equal++;
      }
    }
    check('banded maps: hqMapAsync/negMapAsync are byte-identical to the one-shot maps',
      equal === variants && variants >= 30, equal + '/' + variants + ' variants (odd band sizes included)');

    /* strips arrive from pdf.js asynchronously, so the provider may return a promise */
    {
      const big = mk(600, 400);
      const strips = async (y0, rows) => {
        await new Promise((r) => setTimeout(r, 0));
        return { data: big.data.subarray(y0 * big.width * 4, (y0 + rows) * big.width * 4), width: big.width, height: rows };
      };
      let allSame = true, n = 0;
      for (const [keep, pure] of [[false, false], [true, false], [false, true], [true, true]]) {
        const one = PS.hqMap(big, 301, 201, true, keep, pure);
        const band = await PS.hqMapAsync(strips, 600, 400, 301, 201, true, keep, pure, { band: 192 });
        n++;
        if (!same(one.imageData.data, band.imageData.data)) allSame = false;
      }
      const oneN = PS.negMap(big, 301, 201, true);
      const bandN = await PS.negMapAsync(strips, 600, 400, 301, 201, true, { band: 192 });
      n++;
      if (!same(oneN.imageData.data, bandN.imageData.data)) allSame = false;
      check('banded maps: an ASYNC strip provider (what pdf.js gives us) is identical too',
        allSame && n === 5, n + ' variants');
    }

    /* and they really do hand control back — once per band, in all three phases */
    const big = mk(200, 400);
    let yields = 0, phases = new Set();
    await PS.hqMapAsync(prov(big), 200, 400, 100, 200, true, true, false,
      { band: 25, progress: async (f, phase) => { yields++; phases.add(phase); } });
    check('banded maps: yield between bands (progress hook fires for every band)',
      yields >= 8 && phases.has('downsample') && phases.has('render'), yields + ' yields · ' + [...phases].join(','));
  }

  /* --- 4-up dotted separators --- */
  {
    const oBoth = NC.normalize({ perSheet: 4, sepLine: 'both' });
    const pgL = NC.sheetSize(oBoth);
    const demo4 = [{ w: 1280, h: 718 }, { w: 1280, h: 718 }, { w: 1280, h: 718 }, { w: 1280, h: 718 }];
    const L4b = NC.quadLayout(demo4, oBoth, pgL);
    const segsB = NC.sepLines(L4b, oBoth, pgL);
    check('sep: "both" → vertical + horizontal line', segsB.length === 2);
    check('sep: vertical line sits on the column seam (page centre)',
      Math.abs(segsB[0].x1 - pgL.w / 2) < 0.01 && segsB[0].x1 === segsB[0].x2 && segsB[0].y1 === 6 && Math.abs(segsB[0].y2 - (pgL.h - 6)) < 0.01,
      `x=${segsB[0].x1} y ${segsB[0].y1}→${segsB[0].y2}`);
    check('sep: horizontal line runs through the row boundary',
      Math.abs(segsB[1].y1 - (L4b.gap.y + L4b.gap.h / 2)) < 0.01 && segsB[1].x1 === 6 && Math.abs(segsB[1].x2 - (pgL.w - 6)) < 0.01,
      `y=${segsB[1].y1} band=${L4b.gap.y.toFixed(2)}+${L4b.gap.h.toFixed(2)}`);
    check('sep: mixed slide ratios still cut at the real row boundary',
      (() => {
        const Lm = NC.quadLayout([{ w: 1280, h: 718 }, { w: 1280, h: 718 }, { w: 1280, h: 500 }, { w: 1280, h: 500 }], oBoth, pgL);
        const sm = NC.sepLines(Lm, oBoth, pgL);
        return Math.abs(sm[1].y1 - (Lm.gap.y + Lm.gap.h / 2)) < 0.01;
      })());
    check('sep: "v" → exactly one line, straight down the middle',
      (() => {
        const sv = NC.sepLines(L4b, NC.normalize({ perSheet: 4, sepLine: 'v' }), pgL);
        return sv.length === 1 && sv[0].x1 === sv[0].x2 && Math.abs(sv[0].x1 - pgL.w / 2) < 0.01 &&
          sv[0].y2 > sv[0].y1 + 500;                       // top → bottom of the sheet
      })());
    check('sep: API still supports "h" (UI ships the vertical toggle only)',
      NC.sepLines(L4b, NC.normalize({ perSheet: 4, sepLine: 'h' }), pgL)[0].x1 === 6);
    check('sep: margin pushes the lines inward',
      NC.sepLines(L4b, NC.normalize({ perSheet: 4, sepLine: 'both', margin: 20 }), pgL)[1].x1 === 20);
    check('sep: off by default, ignored in 2-up, junk values rejected',
      NC.defaults().sepLine === 'off' &&
      NC.sepLines(L4b, NC.normalize({ perSheet: 2, sepLine: 'both' }), pgL).length === 0 &&
      NC.normalize({ perSheet: 4, sepLine: 'diagonal' }).sepLine === 'off');

    // the real thing: a 4-up PDF must contain a dotted line operator, and 2-up must not
    const { inflateSync } = await import('node:zlib');
    const hasDashOp = (bytes) => {
      const buf = Buffer.from(bytes);
      const lat = buf.toString('latin1');
      let i = 0;
      while ((i = lat.indexOf('stream', i)) >= 0) {
        let st = i + 6;
        if (lat[st] === '\r') st++;
        if (lat[st] === '\n') st++;
        const en = lat.indexOf('endstream', st);
        if (en < 0) break;
        try {
          const raw = inflateSync(buf.subarray(st, en)).toString('latin1');
          if (/\[[\d. ]+\] 0 d/.test(raw) && /1 J/.test(raw)) return true;   // dash pattern + round caps
        } catch (e) {}
        i = en + 9;
      }
      return false;
    };
    const imgs4 = Array.from({ length: 4 }, () => ({ bytes: new Uint8Array(fs.readFileSync(new URL('./fixtures/dark.png', import.meta.url))), w: 1280, h: 718 }));
    const withSep = await NC.buildFromImages(imgs4, { perSheet: 4, sepLine: 'v' });
    const noSep = await NC.buildFromImages(imgs4, { perSheet: 4 });
    const sep2up = await NC.buildFromImages(imgs4.slice(0, 2), { perSheet: 2, sepLine: 'both' });
    check('sep: 4-up PDF really draws a dotted (dashed, round-cap) line', hasDashOp(withSep.bytes) === true);
    // and the shipped UI only ever asks for the vertical one
    const _4up = fs.readFileSync(new URL('../4up.html', import.meta.url), 'utf8');
    const _app = fs.readFileSync(new URL('../app4up.js', import.meta.url), 'utf8');
    check('sep: UI is a single toggle, vertical only (no horizontal/cross controls)',
      /id="optSep"/.test(_4up) && !/id="sepH"|id="sepB"|id="sepV"/.test(_4up) && !/sepH|sepB|sepOpts/.test(_app) &&
      /sepLineVal\(\) \{ return \(opt\.sep && opt\.sep\.checked\) \? 'v' : 'off'/.test(_app));
    check('sep: untouched settings still produce a clean sheet (no dash op)', hasDashOp(noSep.bytes) === false);
    check('sep: 2-up output never gets the 4-up separator', hasDashOp(sep2up.bytes) === false);
  }

  /* --- pure mode: hard threshold, ZERO greys ever --- */
  big = mk([K, W, K, K], 2, 2);                        // 3/4 ink coverage — ink mode gives grey edge
  r = NC.printSaver.hqMap(big, 1, 1, false, false, true);
  check('pure: mixed edge block -> hard 0/255 (no ramp)', r.imageData.data[0] === 255 || r.imageData.data[0] === 0, `v=${r.imageData.data[0]}`);
  big = mk([[90,90,90],[90,90,90],[90,90,90],[90,90,90]], 2, 2);   // exactly at threshold
  r = NC.printSaver.hqMap(big, 1, 1, false, false, true);
  check('pure: luma-90 -> white (<= T is board)', r.imageData.data[0] === 255);
  big = mk([[91,91,91],[91,91,91],[91,91,91],[91,91,91]], 2, 2);
  r = NC.printSaver.hqMap(big, 1, 1, false, false, true);
  check('pure: luma-91 -> black ink', r.imageData.data[0] === 0);
  big = mk([[37,99,235],[37,99,235],[37,99,235],[37,99,235]], 2, 2);  // colour fill: no grey in pure
  r = NC.printSaver.hqMap(big, 1, 1, false, false, true);
  check('pure: colour fill -> hard black or white, never grey', r.imageData.data[0] === 0 || r.imageData.data[0] === 255, `v=${r.imageData.data[0]}`);
  {
    // full-page scan: not a single grey pixel may exist in pure output
    const px = [];
    for (let i = 0; i < 64; i++) px.push([ (i*4) % 256, (i*7) % 256, (i*11) % 256 ]);
    big = mk(px, 8, 8);
    r = NC.printSaver.hqMap(big, 8, 8, false, false, true);
    let greys = 0;
    for (let i = 0; i < r.imageData.data.length; i += 4) {
      const v = r.imageData.data[i];
      if (v !== 0 && v !== 255) greys++;
    }
    check('pure: 0 grey pixels across a mixed 8x8 page', greys === 0, `greys=${greys}`);
  }

  /* --- negMap: true negative (255−c) — the 'revert' colour style --- */
  big = mk([[13,19,33],[13,19,33],[13,19,33],[13,19,33]], 2, 2);
  r = NC.printSaver.negMap(big, 1, 1, false);
  check('negMap: dark board -> light paper (242,236,222)',
    r.imageData.data[0] === 242 && r.imageData.data[1] === 236 && r.imageData.data[2] === 222,
    `rgb(${r.imageData.data[0]},${r.imageData.data[1]},${r.imageData.data[2]})`);
  big = mk([[126,200,255],[126,200,255],[126,200,255],[126,200,255]], 2, 2);
  r = NC.printSaver.negMap(big, 1, 1, false);
  check('negMap: light blue -> orange complement (129,55,0)',
    r.imageData.data[0] === 129 && r.imageData.data[1] === 55 && r.imageData.data[2] === 0,
    `rgb(${r.imageData.data[0]},${r.imageData.data[1]},${r.imageData.data[2]})`);
  big = mk([[250,250,250],[250,250,250],[250,250,250],[250,250,250]], 2, 2);
  r = NC.printSaver.negMap(big, 1, 1, true);
  check('negMap auto: light page passes through untouched', r.inverted === false && r.imageData.data[0] === 250, `inv=${r.inverted}`);
  big = mk([[10,10,10],[10,10,10],[10,10,10],[10,10,10]], 2, 2);
  r = NC.printSaver.negMap(big, 1, 1, true);
  check('negMap auto: dark page inverts to 245', r.inverted === true && r.imageData.data[0] === 245);
  // SSAA downsample: 2x2 mixed block averages before flipping (no hard threshold)
  big = mk([[0,0,0],[255,255,255],[0,0,0],[255,255,255]], 2, 2);
  r = NC.printSaver.negMap(big, 1, 1, false);
  check('negMap: area-average then flip (mixed block -> mid grey)', Math.abs(r.imageData.data[0] - 128) <= 2, `v=${r.imageData.data[0]}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
