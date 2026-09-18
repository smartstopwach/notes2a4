/* ============ read a probe RESULT and report the other tool's colour rule ============
   node tools/analyse-probe.mjs <result.pdf|result.png|result.jpg> [...more files]

   The probe PDF/PNG has known colour blocks in known places. This script finds
   the corner marks in whatever you send back (screenshot, photo, JPEG, a PDF the
   other tool produced), samples every block, and reports:

     * the exact input → output table for all 95 blocks
     * a per-channel affine fit  out = a·in + b            (checks 255 − c)
     * whether the output depends only on luma             (grey/colour agreement)
     * hue behaviour                                       (kept / complemented / crushed)
     * a plain-English verdict + the JS function Notes2A4 would need

   No image library: PNG is decoded here, JPEG through jpeg-js, and images inside
   a returned PDF are extracted from the content streams.  */
import { writeFileSync } from 'node:fs';
import { PAGE, FID, allSwatches } from './probe-layout.mjs';
import { loadImage } from './img-io.mjs';

const target = process.argv[2];
if (!target) { console.error('usage: node tools/analyse-probe.mjs <result.pdf|png|jpg>'); process.exit(2); }

/* ------------------------------------------------------------- geometry --- */
const fidCentresPDF = [
  [FID.inset + FID.size / 2, FID.inset + FID.size / 2, 'bl'],
  [PAGE.w - FID.inset - FID.size / 2, FID.inset + FID.size / 2, 'br'],
  [FID.inset + FID.size / 2, PAGE.h - FID.inset - FID.size / 2, 'tl'],
  [PAGE.w - FID.inset - FID.size / 2, PAGE.h - FID.inset - FID.size / 2, 'tr']
];

/* find the dark square nearest an expected position (searching a window) */
function findFid(img, ex, ey, win) {
  const { w, h, data } = img;
  let sx = 0, sy = 0, n = 0;
  const x0 = Math.max(0, Math.round(ex - win)), x1 = Math.min(w, Math.round(ex + win));
  const y0 = Math.max(0, Math.round(ey - win)), y1 = Math.min(h, Math.round(ey + win));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 3;
    if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) {
      /* keep only the blob: weight by darkness and closeness to expected */
      const d = Math.hypot(x - ex, y - ey);
      const k = 1 / (1 + d / (win * 0.6));
      sx += x * k; sy += y * k; n += k;
    }
  }
  if (!n) return null;
  return { x: sx / n, y: sy / n, n };
}

function solve(img) {
  const sc = Math.hypot(img.w, img.h) / Math.hypot(PAGE.w, PAGE.h);   // rough image px per pt
  const win = Math.max(12, 26 * sc);
  const pts = [];
  for (const [px, py, tag] of fidCentresPDF) {
    const ex = px * sc * (img.w / (PAGE.w * sc)), ey = (PAGE.h - py) * sc * (img.h / (PAGE.h * sc));
    const f = findFid(img, ex, ey, win);
    if (!f || f.n < 6) continue;
    pts.push({ tag, pdf: [px, py], img: [f.x, f.y] });
  }
  if (pts.length < 3) throw new Error('corner marks not found (' + pts.length + '/4) - keep the four small squares visible');
  const L = pts.filter((p) => p.tag[1] === 'l'), R = pts.filter((p) => p.tag[1] === 'r');
  const B = pts.filter((p) => p.tag[0] === 'b'), T = pts.filter((p) => p.tag[0] === 't');
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const xl = avg(L.map((p) => p.img[0])), xr = avg(R.map((p) => p.img[0]));
  const yb = avg(B.map((p) => p.img[1])), yt = avg(T.map((p) => p.img[1]));
  const px = avg(L.map((p) => p.pdf[0])), pw = avg(R.map((p) => p.pdf[0]));
  const pyB = avg(B.map((p) => p.pdf[1])), pyT = avg(T.map((p) => p.pdf[1]));
  const a = (xr - xl) / (pw - px), b = xl - a * px;
  /* image y grows downward, so map "height above the page bottom": Y = c·(H − y) + d */
  const c = (yb - yt) / (pyT - pyB), d = yt - c * (PAGE.h - pyT);
  return {
    corners: pts.length,
    toImg: (x, y) => [a * x + b, c * (PAGE.h - y) + d],
    scale: a,
    yScale: c
  };
}

function sampleCentre(img, x, y, w, h, geo) {
  /* average the middle ~45% of the block to dodge JPEG ringing at the edges */
  const [x0, y1] = geo.toImg(x, y);
  const [x1, y0] = geo.toImg(x + w, y + h);
  const xa = Math.round(x0 + (x1 - x0) * 0.3), xb = Math.round(x1 - (x1 - x0) * 0.3);
  const ya = Math.round(y0 + (y1 - y0) * 0.3), yb = Math.round(y1 - (y1 - y0) * 0.3);
  const out = [0, 0, 0];
  let n = 0;
  for (let yy = Math.max(0, ya); yy < Math.min(img.h, yb); yy++) {
    for (let xx = Math.max(0, xa); xx < Math.min(img.w, xb); xx++) {
      const i = (yy * img.w + xx) * 3;
      out[0] += img.data[i]; out[1] += img.data[i + 1]; out[2] += img.data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  return out.map((v) => Math.round(v / n));
}

/* -------------------------------------------------------------- analysis --- */
const img = loadImage(target);
console.log('\nprobe result: ' + img.w + 'x' + img.h + ' px');
const geo = solve(img);
console.log('corner marks: ' + geo.corners + '/4 · scale ' + geo.scale.toFixed(3) + ' px/pt\n');

let rows = allSwatches().map((s) => {
  const out = sampleCentre(img, s.x, s.y, s.w, s.h, geo);
  return { ...s, out };
}).filter((r) => r.out);

/* reference correction (helps with photos + JPEG): normalise against the darkest
   and brightest block ACTUALLY MEASURED, so it works whatever the tool did —
   including a tool that flips black and white */
const ref = [0, 1, 2].map((k) => {
  const vals = rows.map((r) => r.out[k]).sort((a, b) => a - b);
  const pick = (q) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * q)))];
  return { lo: pick(0.02), hi: pick(0.98) };
});
console.log('reference: measured range  R ' + ref[0].lo + '-' + ref[0].hi + '  G ' + ref[1].lo + '-' + ref[1].hi + '  B ' + ref[2].lo + '-' + ref[2].hi);
if (ref.some((r) => r.hi - r.lo < 120)) console.log('  ! low contrast - is the result cropped, blurred or heavily compressed?');
const adj = (out, k) => {
  if (!ref) return out[k];
  const span = Math.max(1, ref[k].hi - ref[k].lo);
  return Math.max(0, Math.min(255, Math.round((out[k] - ref[k].lo) * 255 / span)));
};

console.log('\ninput  →  output          (block)');
console.log('-----------------------------------------------');
let lastRow = '';
for (const r of rows) {
  if (r.row !== lastRow) { console.log('\n' + r.row.toUpperCase() + (r.page === 2 ? '  (page 2)' : '')); lastRow = r.row; }
  const o = [adj(r.out, 0), adj(r.out, 1), adj(r.out, 2)];
  const hex = o.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  console.log('  ' + r.hex + '  →  ' + hex + '   ' + (r.hex === hex ? '(same)' : ''));
}

/* ---- fits ---- */
function fitChannel(pairs) {                     // least squares  y = a x + b
  const n = pairs.length;
  const sx = pairs.reduce((s, p) => s + p[0], 0), sy = pairs.reduce((s, p) => s + p[1], 0);
  const sxx = pairs.reduce((s, p) => s + p[0] * p[0], 0), sxy = pairs.reduce((s, p) => s + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  const a = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const b = (sy - a * sx) / n;
  const res = pairs.map(([x, y]) => Math.abs(y - (a * x + b)));
  res.sort((u, v) => u - v);
  return { a, b, max: res[res.length - 1], med: res[res.length >> 1] };
}
const pairs = [0, 1, 2].map((k) => rows.map((r) => [r.rgb[k], adj(r.out, k)]));
const fits = pairs.map(fitChannel);
const luma = (c) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;

console.log('\n---- per-channel fit  out = a·in + b ----');
fits.forEach((f, k) => console.log('  ' + 'RGB'[k] + ': out = ' + f.a.toFixed(4) + '·in + ' + f.b.toFixed(2) +
  '   (median error ' + f.med.toFixed(1) + ', worst ' + f.max.toFixed(1) + ')'));

const isComplement = fits.every((f) => Math.abs(f.a + 1) < 0.03 && Math.abs(f.b - 255) < 6 && f.max < 12);
console.log(isComplement ? '  ⇒ EXACT 255 − c inversion (per channel)' : '  ⇒ not a plain per-channel 255 − c');

/* luma-only? */
const groups = new Map();
for (const r of rows) {
  if (/hues|pastel|dark|pen|board|red ramp|green ramp|blue ramp/.test(r.row) === false && r.row.indexOf('grey') !== 0) continue;
  const key = Math.round(luma(r.rgb) / 6);
  const o = [adj(r.out, 0), adj(r.out, 1), adj(r.out, 2)];
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ spread: Math.max(...o) - Math.min(...o), out: o, hex: r.hex });
}
let lumaGroups = 0, lumaSpread = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;
  lumaGroups++;
  lumaSpread += Math.max(...g.map((x) => x.spread));
}
const lumaOnly = lumaGroups >= 4 && lumaSpread / Math.max(1, lumaGroups) < 14;
console.log('\n---- does the output depend only on luma? ----');
console.log('  same-luma groups tested: ' + lumaGroups + ' · average internal spread: ' +
  (lumaGroups ? (lumaSpread / lumaGroups).toFixed(1) : '-'));
console.log(lumaOnly ? '  ⇒ YES: colour is thrown away (grey/threshold style)' : '  ⇒ NO: channels are treated separately (colour survives)');

/* hue behaviour */
const toHSV = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [((h % 360) + 360) % 360, mx ? d / mx : 0, mx];
};
const hueRows = rows.filter((r) => /hues|pen|board/.test(r.row));
const deltas = [];
for (const r of hueRows) {
  const [, s0] = toHSV(r.rgb);
  const o = [adj(r.out, 0), adj(r.out, 1), adj(r.out, 2)];
  const [h1, s1] = toHSV(o);
  if (s0 > 0.35 && s1 > 0.2) {
    const [h0] = toHSV(r.rgb);
    let d = (h1 - h0 + 540) % 360 - 180;
    deltas.push(d);
  }
}
if (deltas.length) {
  /* hue distance must wrap: a complement measures as -180 as often as +180 */
  const near = (t) => deltas.filter((d) => Math.abs(Math.abs(d) - t) < 30).length / deltas.length;
  console.log('\n---- hue behaviour (' + deltas.length + ' saturated colours) ----');
  console.log('  hues kept: ' + (near(0) * 100).toFixed(0) + '%   ·   complemented (180°): ' + (near(180) * 100).toFixed(0) + '%');
}

/* ---- verdict + the code Notes2A4 would need ---- */
console.log('\n================================================');
if (isComplement) {
  console.log('VERDICT: the other tool does a straight per-channel inversion  (out = 255 - in).');
  console.log('Notes2A4 already has this: Print-Saver → colour style "True negative" (negMap).');
  console.log('If your preview looked different, the cause is the preview, not the math.');
} else if (lumaOnly) {
  console.log('VERDICT: luma-only output - colour is discarded, only brightness flips.');
  console.log('Notes2A4 equivalent: Print-Saver colour style "Black ink" / "Pure B&W".');
} else {
  console.log('VERDICT: a channel-wise curve that is NOT a plain 255 - c.');
  console.log('Fit to use in converter.js (negMap):');
  console.log('  r2 = clamp(' + fits[0].a.toFixed(4) + '·r + ' + fits[0].b.toFixed(2) + ')');
  console.log('  g2 = clamp(' + fits[1].a.toFixed(4) + '·g + ' + fits[1].b.toFixed(2) + ')');
  console.log('  b2 = clamp(' + fits[2].a.toFixed(4) + '·b + ' + fits[2].b.toFixed(2) + ')');
  const worst = rows.map((r) => {
    const o = [adj(r.out, 0), adj(r.out, 1), adj(r.out, 2)];
    const pred = r.rgb.map((v, k) => Math.max(0, Math.min(255, fits[k].a * v + fits[k].b)));
    return Math.max(...o.map((v, k) => Math.abs(v - pred[k])));
  });
  worst.sort((a, b) => b - a);
  console.log('  worst residual over all 95 blocks: ' + worst[0].toFixed(0) +
    '  (below ~12 means the linear model is exact enough to ship)');
}
console.log('================================================\n');

/* keep the raw table for the repo / later comparison */
writeFileSync('tmp-colortest/probe-result-table.json', JSON.stringify(
  rows.map((r) => ({ page: r.page, row: r.row, hex: r.hex, out: [adj(r.out, 0), adj(r.out, 1), adj(r.out, 2)], raw: r.out })), null, 1));
console.log('full table saved to tmp-colortest/probe-result-table.json (' + rows.length + ' blocks)\n');
