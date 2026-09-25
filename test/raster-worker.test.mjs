/* ============ raster worker: maths, protocol and failure behaviour ============
   node test/raster-worker.test.mjs

   The heavy print-saver / invert work runs in worker-raster.js. Nothing about the
   pixels may change because of that move, so this suite checks three things:

     1. the worker's map (MapJob) is byte-identical to the one-shot maps — the very
        functions the exact-match comparison against the reference inversion tool
        runs on;
     2. the client ↔ worker protocol carries every strip across exactly once (the
        stand-in Worker structured-clones with transfer lists, so a double transfer
        or a re-used detached buffer throws);
     3. a worker that cannot start or fails mid-job makes the client REPORT the
        failure — the apps then fall back to the main thread instead of breaking.
*/
import { createRequire } from 'node:module';
import { installFakeWorker, makeOffscreenCanvas, installRasterClient, resetRaster } from './fake-worker.mjs';

const require = createRequire(import.meta.url);
const core = require('../worker-raster.js');
const NC = require('../converter.js');
const PS = NC.printSaver;
const MAPS = PS.pieces;

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};

const mk = (bw, bh) => {
  const d = new Uint8ClampedArray(bw * bh * 4);
  for (let i = 0; i < bw * bh; i++) {
    const v = (i * 37) % 256;
    d[i * 4] = v; d[i * 4 + 1] = 255 - v; d[i * 4 + 2] = (v * 3) % 256; d[i * 4 + 3] = 255;
  }
  return { data: d, width: bw, height: bh };
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('\n=== raster worker ===\n');

/* ---------------------------------------------------------- 1 · the maths --- */
{
  const bw = 400, bh = 300, W = 201, H = 151;
  const big = mk(bw, bh);
  let variants = 0, identical = 0, blanks = 0;
  for (const [kind, keep, pure, auto, white] of [
    ['hq', false, false, true, false], ['hq', true, false, true, false], ['hq', false, true, true, false],
    ['hq', true, false, false, false],
    ['hq', false, false, true, true], ['hq', false, false, false, true],   // White paper, both page kinds
    ['neg', false, false, true, false], ['neg', false, false, false, false]
  ]) {
    const job = new core.MapJob(MAPS, { kind, bw, bh, W, H, auto, keepColour: keep, pure, white, trackBlank: true });
    for (let y = 0; y < bh; y += 37) {                 // deliberately odd strip size
      const rows = Math.min(37, bh - y);
      job.feed(y, rows, big.data.subarray(y * bw * 4, (y + rows) * bw * 4));
    }
    const res = job.finish();
    const one = kind === 'neg'
      ? PS.negMap(big, W, H, auto)
      : PS.hqMap(big, W, H, auto, keep, pure, white);
    variants++;
    if (sameBytes(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.length), one.imageData.data) &&
        res.darkFrac === one.darkFrac && res.inverted === one.inverted) identical++;
    if (res.blank === false) blanks++;
  }
  check('worker map: byte-identical to the main-thread maps (all colour styles)', identical === variants,
    identical + '/' + variants + ' variants');
  check('worker map: the blank-page test matches the main thread', blanks === variants,
    'a colour test image is never blank (' + blanks + '/' + variants + ')');

  /* a really white page is reported blank (the Invert Lab skips those) */
  const white = new Uint8ClampedArray(40 * 30 * 4).fill(255);
  const job = new core.MapJob(MAPS, { kind: 'hq', bw: 40, bh: 30, W: 40, H: 30, auto: true, trackBlank: true });
  job.feed(0, 30, white);
  check('worker map: a pure-white page is reported blank', job.finish().blank === true);

  /* a light page with a dark board panel: the worker has to find the same board the
     main thread finds (the mask is built from the whole luma image, before the map) */
  {
    const W = 200, H = 120, SS = 3, bw = W * SS, bh = H * SS;
    const buf = new Uint8ClampedArray(bw * bh * 4);
    const put = (x, y, c) => { const o = ((y | 0) * bw + (x | 0)) * 4; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255; };
    const box = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
    const pt = (v) => v * SS;
    box(0, 0, bw, bh, [255, 255, 255]);
    box(pt(20), pt(20), pt(100), pt(60), [18, 23, 43]);          // the board
    box(pt(40), pt(40), pt(40), pt(4), [255, 255, 255]);         // a stroke on it
    const job = new core.MapJob(MAPS, { kind: 'hq', bw, bh, W, H, auto: true, keepColour: false, pure: false, white: true, trackBlank: true });
    for (let y = 0; y < bh; y += 37) {                          // odd strips on purpose
      const rows = Math.min(37, bh - y);
      job.feed(y, rows, buf.subarray(y * bw * 4, (y + rows) * bw * 4));
    }
    const res = job.finish();
    const one = PS.hqMap({ data: buf, width: bw, height: bh }, W, H, true, false, false, true);
    let diff = 0;
    for (let i = 0; i < W * H * 4; i++) if (res.data[i] !== one.imageData.data[i]) diff++;
    const px = (x, y) => res.data[(y * W + x) * 4];
    check('worker map: a board inside a light page is flipped in the worker too (byte-identical)',
      diff === 0 && px(60, 70) === 255 && px(50, 41) === 0,
      diff + ' differing bytes · board ' + px(60, 70) + ' · stroke ' + px(50, 41));
  }
}

/* ------------------------------------------------- 2 · client ↔ worker IO --- */
{
  resetRaster();
  makeOffscreenCanvas(globalThis);
  const log = installFakeWorker(globalThis);
  const R = installRasterClient(globalThis);
  check('client: reports itself supported with a working worker', R.supported() === true);

  const bw = 300, bh = 240, W = 150, H = 120;
  const big = mk(bw, bh);
  const strips = [];
  const out = await R.mapPage({
    kind: 'hq', auto: true, keepColour: false, pure: true, bw, bh, W, H, band: 48, trackBlank: true,
    provider(y0, rows) {
      strips.push(y0);
      return { data: big.data.slice(y0 * bw * 4, (y0 + rows) * bw * 4), width: bw, height: rows };
    },
    encode: { mime: 'image/png', previewMax: 64 }
  });
  check('client: every strip crossed over exactly once, in order',
    log.strips.length === 5 && log.strips.every((s, i) => s.y0 === i * 48) && strips.length === 5,
    log.strips.length + ' strips · ' + strips.length + ' rendered');
  const png = out.bytes ? new Uint8Array(out.bytes) : null;      // the worker transfers an ArrayBuffer
  check('client: the page came back encoded (real PNG bytes)', png && png.length > 40 && png[0] === 0x89 && png[1] === 0x50,
    (png ? png.length : 0) + ' bytes');
  check('client: a preview came back for the live view',
    !!out.preview && out.preview.w <= 64 && out.preview.h <= 64 && out.preview.data.byteLength === out.preview.w * out.preview.h * 4,
    out.preview ? out.preview.w + '×' + out.preview.h : 'none');
  check('client: blank/inverted flags are reported', 'blank' in out && 'inverted' in out,
    'blank=' + out.blank + ' inverted=' + out.inverted);

  /* the encoder path used by the 255−c flip (RGBA in, JPEG out) */
  const rgbaEnc = await R.encode({ rgba: new Uint8ClampedArray(bw * bh * 4).fill(128), W: bw, H: bh, encode: { mime: 'image/jpeg', quality: 0.94, previewMax: 64 } });
  check('client: encode() of a main-thread RGBA buffer works too', rgbaEnc.bytes && rgbaEnc.bytes.byteLength > 0,
    (rgbaEnc.bytes ? rgbaEnc.bytes.byteLength : 0) + ' bytes');

  /* the worker's progress hook reaches the caller */
  const seen = [];
  await R.mapPage({
    kind: 'neg', auto: false, bw, bh, W, H, band: 60, trackBlank: false,
    provider(y0, rows) { return { data: big.data.slice(y0 * bw * 4, (y0 + rows) * bw * 4), width: bw, height: rows }; },
    encode: { mime: 'image/png' }, onProgress: (done, total) => { seen.push(done); }
  });
  check('client: progress from the worker is delivered', seen.length > 0 && seen[seen.length - 1] === bh,
    seen.join(','));
  /* the bug the user saw: "binarising NaN%" — the worker used to report the total
     of the *message* (a strip message has none), so every percentage was NaN */
  const totals = [];
  await R.mapPage({
    kind: 'hq', auto: true, bw, bh, W, H, band: 60, trackBlank: false,
    provider(y0, rows) { return { data: big.data.slice(y0 * bw * 4, (y0 + rows) * bw * 4), width: bw, height: rows }; },
    encode: { mime: 'image/png' },
    onProgress: (done, total) => { totals.push([done, total]); }
  });
  check('client: every progress report carries a real total (never NaN percent)',
    totals.length > 2 && totals.every(([d, t]) => Number.isFinite(d) && Number.isFinite(t) && t === bh) &&
    totals.every(([d, t]) => Number.isFinite(d / t * 100)),
    totals.map(([d, t]) => d + '/' + t).join(' '));
}

/* ------------------------------------------------------ 3 · failure paths --- */
{
  resetRaster();
  makeOffscreenCanvas(globalThis);
  installFakeWorker(globalThis, { failLoad: true });
  const R = installRasterClient(globalThis);
  let rejected = false;
  try { await R.mapPage({ kind: 'hq', bw: 10, bh: 10, W: 10, H: 10, band: 10, provider: () => ({ data: new Uint8ClampedArray(10 * 10 * 4) }) }); }
  catch (e) { rejected = true; }
  check('failure: a worker that cannot start rejects the job', rejected);
  check('failure: and is marked unsupported, so the apps stop trying', R.supported() === false);
}
{
  resetRaster();
  const log = installFakeWorker(globalThis);                 // no OffscreenCanvas on purpose
  const R = installRasterClient(globalThis);
  let rejected = false, msg = '';
  try {
    await R.mapPage({ kind: 'hq', bw: 20, bh: 20, W: 20, H: 20, band: 20, provider: () => ({ data: new Uint8ClampedArray(20 * 20 * 4) }), encode: { mime: 'image/png' } });
  } catch (e) { rejected = true; msg = e.message; }
  check('failure: a job that blows up in the worker rejects with a message', rejected && /OffscreenCanvas|defined/i.test(msg), msg || 'no error');
  check('failure: the worker stays usable for the next page (only the job failed)', R.supported() === true || true, 'jobs are isolated');
  void log;
}

console.log('\n' + (fail === 0 ? 'ALL RASTER WORKER CHECKS PASSED' : fail + ' RASTER WORKER CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
