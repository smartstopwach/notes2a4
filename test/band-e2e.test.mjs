/* ============ band-keep TRUE end-to-end proof (real converter bytes) ============
   node test/band-e2e.test.mjs
   Builds a REAL 4-up + 2-up PDF with converter.buildFromImages, extracts the
   embedded slide images back out of the PDF bytes, composites the page at the
   app's 0.35 detection scale, runs the REAL OV.findBand (must cover the REAL
   layout band), then flips with the REAL invertPixels extracted from the
   shipped app-invert.js (band rows must stay pixel-identical white, slide
   rows must flip). Only node builtins + pdf-lib. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const require2 = createRequire(import.meta.url);
const CV = require2('../converter.js');
const OV = require2('../overlays.js');
const { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = require2('pdf-lib');

const DET = 0.35;
let seed = 1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* ---------- minimal PNG encoder (8-bit RGB, filter 0) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const h = Buffer.alloc(8); h.writeUInt32BE(data.length, 0); h.write(type, 4, 'ascii');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([h, data, c]);
}
function pngEncode(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.subarray(y * w * 3, (y + 1) * w * 3)).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- slide painters (RGB) ---------- */
function mkSlide(w, h, paint) {
  const rgb = new Uint8Array(w * h * 3).fill(255);
  const px = (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = v; } };
  paint(px, w, h);
  return { bytes: pngEncode(w, h, rgb), rgb, w, h };
}
const slides4 = [
  mkSlide(480, 270, (px, w, h) => {           // S0 dark blackboard + chalk text
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x, y, 24);
    for (let y = 30; y < h - 20; y += 26) for (let x = 30; x < w - 30 - ((y * 7) % 90); x++) { px(x, y, 235); px(x, y + 1, 235); }
  }),
  mkSlide(480, 300, (px, w, h) => {           // S1 white + title bar + bullets
    for (let y = 18; y < 52; y++) for (let x = 24; x < w - 24; x++) px(x, y, 35);
    for (let y = 90; y < h - 20; y += 30) { for (let k = 0; k < 4; k++) for (let x = 24; x < 40; x++) px(x, y + 4 + k, 40); for (let x = 56; x < w - 40 - ((y * 13) % 120); x++) { px(x, y + 4, 45); px(x, y + 5, 45); } }
  }),
  mkSlide(480, 240, (px, w, h) => {           // S2 white + grey diagram blocks
    for (const [bx, by, bw, bh] of [[40, 40, 120, 80], [200, 40, 120, 80], [40, 160, 280, 120]])
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) px(x, y, (x === bx || y === by) ? 50 : 205);
    for (let y = 300; y < 330; y += 12) for (let x = 40; x < 320 - ((y * 3) % 60); x++) px(x, y, 45);
  }),
  mkSlide(504, 216, (px, w, h) => {           // S3 half dark / half light
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) px(x, y, 28);
    for (let y = 16; y < h / 2 - 10; y += 24) for (let x = 24; x < w - 60; x++) px(x, y, 232);
    for (let y = h / 2 + 14; y < h - 12; y += 24) for (let x = 24; x < w - 100; x++) { px(x, y, 42); px(x, y + 1, 42); }
  }),
];
const aspects4 = [{ w: 1280, h: 720 }, { w: 1280, h: 800 }, { w: 1200, h: 600 }, { w: 1260, h: 540 }];

/* ---------- extract embedded images from built PDF ---------- */
async function extractImages(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPages()[0];
  const resNode = doc.context.lookup(page.node.Resources());
  const xobj = doc.context.lookup(resNode.get(PDFName.of('XObject')));
  const out = [];
  for (const k of xobj.keys()) {
    const ref = xobj.get(k);
    const stm = doc.context.lookup(ref);
    const d = stm.dict;
    if (String(d.lookup(PDFName.of('Subtype'))) !== '/Image') continue;
    const W = Number(d.lookup(PDFName.of('Width'))), H = Number(d.lookup(PDFName.of('Height')));
    let raw = Buffer.from(stm instanceof PDFRawStream ? decodePDFRawStream(stm).decode() : stm.getContents());
    if (raw.length !== W * H * 3) { try { raw = Buffer.from(inflateSync(Buffer.from(stm.getContents()))); } catch (e) {} }
    if (raw.length !== W * H * 3) throw new Error('cannot decode image ' + W + 'x' + H + ' got ' + raw.length);
    out.push({ W, H, rgb: new Uint8Array(raw) });
  }
  return { imgs: out, pageW: page.getWidth(), pageH: page.getHeight() };
}

/* ---------- composite page at detection scale ---------- */
function composite(L, boxes, placed, pageW, pageH) {
  const W = Math.round(pageW * DET), H = Math.round(pageH * DET);
  const d = new Uint8ClampedArray(W * H * 4).fill(255);
  const bil = (img, sx, sy) => {
    const x0 = Math.max(0, Math.min(img.W - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(img.H - 1, Math.floor(sy)));
    const x1 = Math.min(img.W - 1, x0 + 1), y1 = Math.min(img.H - 1, y0 + 1);
    const fx = sx - Math.floor(sx), fy = sy - Math.floor(sy);
    const g = (x, y) => img.rgb[(y * img.W + x) * 3];
    return g(x0, y0) * (1 - fx) * (1 - fy) + g(x1, y0) * fx * (1 - fy) + g(x0, y1) * (1 - fx) * fy + g(x1, y1) * fx * fy;
  };
  boxes.forEach((b, i) => {
    if (!b || !placed[i]) return;
    const x0 = Math.round(b.x * DET), x1 = Math.round((b.x + b.width) * DET);
    const y0 = Math.round((pageH - b.y - b.height) * DET), y1 = Math.round((pageH - b.y) * DET);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = bil(placed[i], ((x + 0.5) / DET - b.x) / b.width * (placed[i].W - 1), ((y + 0.5) / DET - (pageH - b.y - b.height)) / b.height * (placed[i].H - 1));
      const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = v;
    }
  });
  // packer ruling rows (0.6pt solid ≈ 1 antialiased px row at 0.35)
  const gx0 = Math.round((L.gap.x + 10) * DET), gx1 = Math.round((L.gap.x + L.gap.w - 10) * DET);
  (L.lines || []).forEach((ly) => {
    const y = Math.round((pageH - ly) * DET);
    if (y < 0 || y >= H) return;
    for (let x = gx0; x < gx1; x++) { const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = 195; }
  });
  return { data: d, w: W, h: H };
}

/* ---------- the REAL invertPixels, extracted from shipped app-invert.js ---------- */
function realInvertPixels() {
  const src = readFileSync(new URL('../app-invert.js', import.meta.url), 'utf8');
  const at = src.indexOf('function invertPixels(idat, flip, skip)');
  if (at < 0) throw new Error('invertPixels not found in app-invert.js');
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}') { depth--; if (!depth) break; } }
  const fnSrc = src.slice(at, i + 1);
  if (!fnSrc.includes('skip.rows')) throw new Error('extracted stale invertPixels (no skip support)');
  return eval('(' + fnSrc.replace('function invertPixels', 'function') + ')');
}
const invertPixels = realInvertPixels();

function coversBand(det, exp) {
  if (!det) return false;
  const ov = Math.max(0, Math.min(det.a1, exp.a1) - Math.max(det.a0, exp.a0));
  const dc = Math.abs((det.a0 + det.a1) / 2 - (exp.a0 + exp.a1) / 2);
  return ov / Math.max(1, exp.a1 - exp.a0) >= 0.6 && dc <= 12;
}
function regionMean(img, x0, x1, y0, y1) {
  const W = img.w || img.width, H = img.h || img.height;
  let s = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { s += img.data[(y * W + x) * 4]; n++; }
  return s / Math.max(1, n);
}
const rowMean = (img, y0, y1) => regionMean(img, 0, img.w || img.width, y0, y1);

let pass = 0, fail = 0;
const check = (n, ok, ex) => { ok ? pass++ : fail++; console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ex === undefined ? '' : '  [' + ex + ']')); };

async function e2e(perSheet, slideIdx, label) {
  const optsIn = { perSheet, paper: 'a4', margin: 0, gapMode: 'auto', lines: true, lineSpacing: 14, pageNumbers: false, sepLine: 'off' };
  const items = slideIdx.map((si, k) => ({ bytes: new Uint8Array(slides4[si].bytes), w: aspects4[si].w, h: aspects4[si].h }));
  const built = await CV.buildFromImages(items, optsIn, null);
  check(label + ': real PDF built (' + built.bytes.length + ' bytes, ' + built.sheets + ' sheet)', built.sheets === 1);
  const { imgs, pageW, pageH } = await extractImages(built.bytes);
  check(label + ': all slide images extracted from PDF bytes', imgs.length === slideIdx.length, imgs.length + ' images');
  // identify each embedded image by dimensions → correct slide placement
  const placed = slideIdx.map((si) => imgs.find((g) => g.W === slides4[si].w && g.H === slides4[si].h));
  check(label + ': embedded images identified by size', placed.every(Boolean));
  const opts = CV.normalize(optsIn);
  const page = { w: pageW, h: pageH };
  const cellSizes = slideIdx.map((si) => ({ w: aspects4[si].w, h: aspects4[si].h }));
  while (cellSizes.length < perSheet) cellSizes.push(null);
  const L = perSheet === 4 ? CV.quadLayout(cellSizes, opts, page) : CV.sheetLayout(cellSizes[0], cellSizes[1], opts, page);
  const boxes = perSheet === 4 ? L.slides : [L.top, L.bottom];
  const exp = { a0: Math.round((pageH - L.gap.y - L.gap.h) * DET), a1: Math.round((pageH - L.gap.y) * DET) };
  const img = composite(L, boxes, placed, pageW, pageH);
  const b = OV.findBand(img, 'h', DET);
  check(label + ': findBand covers the real layout band', coversBand(b, exp),
    (b ? b.a0 + '..' + b.a1 : 'null') + ' vs layout ' + exp.a0 + '..' + exp.a1 + ' (band ' + L.gap.h.toFixed(0) + 'pt, page ' + pageW.toFixed(0) + 'x' + pageH.toFixed(0) + ')');
  if (!b) return;
  // app-identical masking math at 150dpi: band pt → bh px → strip skip → REAL invertPixels
  const outSc = 150 / 72, ss = 2, k = outSc * ss;
  const bh = { rows: true, a0: Math.round((b.a0 / DET) * k), a1: Math.round((b.a1 / DET) * k) };
  // emulate flip at detection scale instead (same rows proportionally): skip in img coords
  const id = { data: img.data.slice(), width: img.w, height: img.h };
  const preBand = rowMean(id, b.a0, b.a1);
  invertPixels(id, true, { rows: true, a0: b.a0, a1: b.a1 });
  const postBand = rowMean(id, b.a0, b.a1);
  check(label + ': kept band rows stay white after REAL flip', Math.abs(postBand - preBand) < 0.01 && postBand > 240, 'mean ' + preBand.toFixed(1) + ' → ' + postBand.toFixed(1) + ' (pixel-identical = skipped)');
  // dark S0 pixels (left column, above the band) must have flipped dark → light
  const preDark = regionMean(img, 0, img.w / 2, exp.a0 - 26, exp.a0 - 16);
  const postDark = regionMean(id, 0, img.w / 2, exp.a0 - 26, exp.a0 - 16);
  check(label + ': slide rows actually flipped', preDark < 140 && postDark > preDark + 80,
    'mean ' + preDark.toFixed(1) + ' → ' + postDark.toFixed(1));
}

console.log('\n=== BAND-KEEP TRUE E2E (real converter bytes + real shipped functions) ===\n');
await e2e(4, [0, 1, 2, 3], '4up');
await e2e(2, [0, 1], '2up');
console.log('\n' + (fail ? fail + ' E2E CHECK(S) FAILED' : 'ALL E2E CHECKS PASSED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
