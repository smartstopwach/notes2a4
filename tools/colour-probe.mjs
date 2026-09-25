/* ============ make the colour-inversion probe (PDF + PNG) ============
   node tools/colour-probe.mjs

   Why: send this file to another colour-inversion tool, get its output back, and
   every swatch tells us exactly how that tool maps colours — per channel, by
   luma, hue-preserving, thresholded… The analyser (tools/analyse-probe.mjs) then
   reads the returned file and reports the mapping, so Notes2A4 can match it 1:1.

   Layout comes from tools/probe-layout.mjs, i.e. the same numbers the analyser
   samples, so the two can never disagree. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  PAGE, FID, allSwatches, gradientRects, GRADIENTS, PENS, BOARDS, hsv
} from './probe-layout.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const c255 = (c) => rgb(clamp01(c[0] / 255), clamp01(c[1] / 255), clamp01(c[2] / 255));
const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
export const OUT_DIR = 'probe';
mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ PDF --- */
const doc = await PDFDocument.create();
/* fixed dates: regenerating the probe must produce byte-identical files */
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
doc.setCreationDate(FIXED_DATE);
doc.setModificationDate(FIXED_DATE);
doc.setTitle('Notes2A4 colour-inversion probe');
doc.setSubject('Send this file to a colour-inversion tool, then send its output back');
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const mono = await doc.embedFont(StandardFonts.Courier);
const monoB = await doc.embedFont(StandardFonts.CourierBold);

function fiducials(pg) {
  const s = FID.size, i = FID.inset;
  [[i, i], [PAGE.w - i - s, i], [i, PAGE.h - i - s], [PAGE.w - i - s, PAGE.h - i - s]].forEach(([x, y]) => {
    pg.drawRectangle({ x, y, width: s, height: s, color: rgb(0, 0, 0) });
  });
}
function header(pg, title, sub) {
  pg.drawText(title, { x: 33, y: PAGE.h - 58, size: 17, font: bold, color: rgb(0.07, 0.09, 0.16) });
  pg.drawText(sub, { x: 33, y: PAGE.h - 76, size: 9, font, color: rgb(0.35, 0.39, 0.47) });
}

/* ---- page 1: ramps + hues + tints + note colours, fully labelled ---- */
const p1 = doc.addPage([PAGE.w, PAGE.h]);
fiducials(p1); header(p1, 'Colour probe - page 1: measurement blocks',
  'Every block is one known RGB value. Send this page through the colour tool you liked, then send its result back - the mappings are read straight from these blocks.');
{
  const rows = [...new Set(allSwatches().map((s) => s.row))];
  for (const row of rows) {
    const cells = allSwatches().filter((s) => s.row === row);
    const top = cells[0].y + cells[0].h;
    p1.drawText(row, { x: 33, y: top + 3.5, size: 7.5, font: bold, color: rgb(0.25, 0.29, 0.36) });
    for (const c of cells) {
      p1.drawRectangle({ x: c.x, y: c.y, width: c.w, height: c.h, color: c255(c.rgb) });
      p1.drawText((c.name ? c.name + ' ' : '') + c.hex, { x: c.x, y: c.y - 8, size: 5.2, font: mono, color: rgb(0.42, 0.46, 0.54) });
    }
  }
}

/* ---- page 2: gradients + real-note panels (visual, not sampled) ---- */
const p2 = doc.addPage([PAGE.w, PAGE.h]);
fiducials(p2); header(p2, 'Colour probe - page 2: gradients and real handwriting',
  'The strips show whether the tool works per pixel or with a curve; the panels show what happens to thin strokes, markers and highlights.');
{
  const gs = gradientRects();
  const stepW = 2;
  for (const g of gs) {
    p2.drawText(g.name, { x: g.x, y: g.y + g.h + 3.5, size: 7.5, font: bold, color: rgb(0.25, 0.29, 0.36) });
    for (let x = 0; x < g.w; x += stepW) {
      const t = x / (g.w - stepW);
      const c = [0, 1, 2].map((k) => g.from[k] + (g.to[k] - g.from[k]) * t);
      p2.drawRectangle({ x: g.x + x, y: g.y, width: Math.min(stepW, g.w - x), height: g.h, color: c255(c) });
    }
  }

  const boardX = 33, boardW = 250, boardH = 150, boardY = 430;
  p2.drawRectangle({ x: boardX, y: boardY, width: boardW, height: boardH, color: c255([18, 23, 43]) });
  p2.drawText('dark board + thin strokes', { x: boardX, y: boardY + boardH + 6, size: 8, font: bold, color: rgb(0.25, 0.29, 0.36) });
  p2.drawText('I = Imax e^(-Rt/L)', { x: boardX + 12, y: boardY + boardH - 26, size: 11, font: bold, color: rgb(1, 1, 1) });
  [0.5, 0.75, 1, 1.5].forEach((th, i) => {
    const y = boardY + boardH - 50 - i * 16;
    for (let x = 0; x < boardW - 40; x += 14) {
      p2.drawLine({ start: { x: boardX + 12 + x, y }, end: { x: boardX + 12 + x + 9, y: y + (i % 2 ? 3 : -3) },
        thickness: th, color: rgb(1, 1, 1) });
    }
    p2.drawText(th + ' pt', { x: boardX + boardW - 26, y: y - 3, size: 5.5, font: mono, color: rgb(0.85, 0.9, 1) });
  });
  p2.drawRectangle({ x: boardX + 12, y: boardY + 14, width: 60, height: 12, color: c255([250, 204, 21]) });
  p2.drawRectangle({ x: boardX + 84, y: boardY + 14, width: 60, height: 12, color: c255([6, 182, 212]) });
  p2.drawText('marker / cyan on board', { x: boardX + 152, y: boardY + 16, size: 6, font, color: rgb(0.8, 0.85, 0.95) });

  const lightX = 308, lightW = 254, lightH = 150, lightY = 430;
  p2.drawRectangle({ x: lightX, y: lightY, width: lightW, height: lightH, color: rgb(1, 1, 1), borderColor: rgb(0.8, 0.83, 0.88), borderWidth: 0.8 });
  p2.drawText('light page + highlighter', { x: lightX, y: lightY + lightH + 6, size: 8, font: bold, color: rgb(0.25, 0.29, 0.36) });
  p2.drawRectangle({ x: lightX + 12, y: lightY + lightH - 34, width: 130, height: 11, color: c255([253, 224, 71]) });
  p2.drawText('highlighted line of notes', { x: lightX + 14, y: lightY + lightH - 32, size: 8, font, color: rgb(0.1, 0.12, 0.2) });
  p2.drawText('plain black text on white paper', { x: lightX + 12, y: lightY + lightH - 56, size: 9, font, color: rgb(0.05, 0.06, 0.1) });
  p2.drawText('blue pen line under the notes', { x: lightX + 12, y: lightY + lightH - 78, size: 8, font, color: c255([29, 78, 216]) });
  p2.drawLine({ start: { x: lightX + 12, y: lightY + lightH - 83 }, end: { x: lightX + 150, y: lightY + lightH - 83 }, thickness: 0.8, color: c255([29, 78, 216]) });
  p2.drawText('red margin mark in the corner', { x: lightX + 12, y: lightY + lightH - 104, size: 8, font, color: c255([220, 38, 38]) });
}

/* ---- page 3: legend + what to do ---- */
const p3 = doc.addPage([PAGE.w, PAGE.h]);
fiducials(p3); header(p3, 'Colour probe — page 3 · how to use it',
  'Send page 1–2 through the tool you liked, then send its output back (PDF, screenshot or photo — all fine).');
{
  const lines = [
    'What happens next',
    '',
    '1.  Open the other colour-inversion tool you liked.',
    '2.  Send this PDF (or take a screenshot of page 1) into it and convert.',
    '3.  Send me back the result — the PDF, a screenshot, or even a photo.',
    '4.  I read every block, work out that exact colour rule of that tool',
    '     (255 - c, or luma-based, or hue-preserving, or thresholded...),',
    '     and make Notes2A4\u2019s True negative match it exactly.',
    '',
    'Tips for a clean result',
    '',
    '- Keep the tiny corner squares visible \u2014 they let me line up the grid.',
    '- A screenshot is perfect; make sure blocks are not cropped.',
    '- JPEG/photo is fine too \u2014 there are pure black and pure white',
    '  reference blocks so I can correct for compression and lighting.',
    '',
    'Legend — page 1 rows (17-step grey is the widest row)',
    ''
  ];
  let y = PAGE.h - 110;
  for (const t of lines) {
    const f = t.startsWith('What happens') || t.startsWith('Tips for') || t.startsWith('Legend') ? bold : font;
    p3.drawText(t, { x: 40, y, size: t.startsWith('What happens') || t.startsWith('Tips for') || t.startsWith('Legend') ? 11 : 9.5, font: f, color: rgb(0.12, 0.15, 0.22) });
    y -= t === '' ? 8 : 15;
  }
  const rows = [
    ['grey 0-255 (step 16)', '17 blocks: 000000, 101010, ... FFFFFF'],
    ['red / green / blue ramp', '9 blocks each: 00, 20, 40, 60, 80, A0, C0, E0, FF on that channel'],
    ['hues 0-320', '9 hues at full brightness, then the same 9 at half brightness'],
    ['pastel tints', 'very light red / green / blue / yellow / cyan / magenta / cream / sky / rose'],
    ['dark shades', 'dark red, green, blue, olive, teal, purple, greys, navy-ish'],
    ['pen colours', 'page 1, last-but-one row: blue, red, green, orange, teal, purple, pink, amber, brown, indigo'],
    ['board colours', 'page 1, last row: navy, slate, black, deep purple, dark green'],
    ['gradients', 'page 2: black-white, white-black, blue-yellow, red-cyan, navy-white'],
    ['panels', 'dark board with 0.5/0.75/1/1.5 pt strokes; white page with a highlighter']
  ];
  y -= 6;
  for (const [a, b] of rows) {
    if (y < 60) break;
    p3.drawText(a, { x: 44, y, size: 8.5, font: bold, color: rgb(0.16, 0.2, 0.28) });
    p3.drawText(b, { x: 190, y, size: 8, font, color: rgb(0.35, 0.39, 0.47) });
    y -= 14;
  }
}

const pdf = await doc.save({ useObjectStreams: true });
writeFileSync(OUT_DIR + '/colour-probe.pdf', Buffer.from(pdf));
console.log('wrote probe/colour-probe.pdf', (pdf.length / 1024).toFixed(1) + ' KB');

/* ------------------------------------------------------------------ PNG ---
   The same page-1 + page-2 swatch grids, rasterised exactly (rects only, no text,
   no antialiasing) so an image-based tool gets perfectly measurable blocks. */
const SC = 2;                                  // px per pt
const W = Math.round(PAGE.w * SC), H = Math.round(PAGE.h * SC);
const px = Buffer.alloc(W * H * 3, 255);
function rect(x, y, w, h, c) {                 // y is PDF-style (bottom-left origin)
  const x0 = Math.max(0, Math.round(x * SC)), x1 = Math.min(W, Math.round((x + w) * SC));
  const y1 = Math.min(H, Math.round((PAGE.h - y) * SC)), y0 = Math.max(0, Math.round((PAGE.h - y - h) * SC));
  for (let yy = y0; yy < y1; yy++) {
    let o = (yy * W + x0) * 3;
    for (let xx = x0; xx < x1; xx++) { px[o++] = c[0]; px[o++] = c[1]; px[o++] = c[2]; }
  }
}
rect(0, 0, PAGE.w, PAGE.h, [255, 255, 255]);
rect(FID.inset, FID.inset, FID.size, FID.size, [0, 0, 0]);
rect(PAGE.w - FID.inset - FID.size, FID.inset, FID.size, FID.size, [0, 0, 0]);
rect(FID.inset, PAGE.h - FID.inset - FID.size, FID.size, FID.size, [0, 0, 0]);
rect(PAGE.w - FID.inset - FID.size, PAGE.h - FID.inset - FID.size, FID.size, FID.size, [0, 0, 0]);
for (const s of allSwatches()) rect(s.x, s.y, s.w, s.h, s.rgb);   // page-1 geometry, same numbers the analyser samples

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.concat(Array.from({ length: H }, (_, y) => Buffer.concat([Buffer.from([0]), px.subarray(y * W * 3, (y + 1) * W * 3)])));
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, 9)), chunk('IEND', Buffer.alloc(0))
]);
writeFileSync(OUT_DIR + '/colour-probe.png', png);
console.log('wrote probe/colour-probe.png', W + 'x' + H, (png.length / 1024).toFixed(1) + ' KB');

/* machine-readable copy of the truth table (used by the analyser + mirrors) */
const truth = allSwatches().map((s) => ({ page: s.page, row: s.row, step: s.step, hex: s.hex, rgb: s.rgb, x: s.x, y: s.y, w: s.w, h: s.h }));
writeFileSync(OUT_DIR + '/colour-probe.truth.json', JSON.stringify(truth, null, 1));
console.log('wrote probe/colour-probe.truth.json', truth.length, 'swatches');
