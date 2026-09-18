/* ============ self-test for the colour-probe round trip ============
   node tools/probe-selftest.mjs

   Proves, on the machine, that the analyser reads a returned file correctly:
     * identity      (the probe unchanged)        → "not a plain inversion", channels separate
     * negative tool (out = 255 − in)             → "EXACT 255 − c", complements hues
     * luma tool     (grey-out by luma)           → "luma-only"
     * a JPEG copy   (compression + no PNG)       → still detected through the reference blocks

   The images are produced by mutating the probe PNG pixel by pixel, so the test
   exercises the real sampling, the real geometry fit and the real verdicts. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { decodePNG, encodePNG } from './img-io.mjs';

const require = createRequire(import.meta.url);
mkdirSync('tmp-colortest', { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};

const probe = decodePNG(readFileSync('probe/colour-probe.png'));
const mapPixels = (fn) => {
  const out = { w: probe.w, h: probe.h, data: new Uint8Array(probe.data.length) };
  for (let i = 0; i < probe.data.length; i += 3) {
    const [r, g, b] = fn(probe.data[i], probe.data[i + 1], probe.data[i + 2]);
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b;
  }
  return out;
};
const run = (file) => {
  const txt = execFileSync(process.execPath, ['tools/analyse-probe.mjs', file], { encoding: 'utf8' });
  return txt;
};

console.log('\n=== colour-probe round trip ===\n');

/* 1) identity */
writeFileSync('tmp-colortest/probe-identity.png', encodePNG(probe, 9));
let out = run('tmp-colortest/probe-identity.png');
check('identity: corner marks found', /corner marks: 4\/4/.test(out));
check('identity: not reported as a plain inversion', /not a plain per-channel 255/.test(out));
check('identity: reported as channel-wise (colour survives)', /NO: channels are treated separately/.test(out));
check('identity: every block reads back unchanged', /000000  →  000000\s+\(same\)/.test(out) && /FFFFFF  →  FFFFFF\s+\(same\)/.test(out));
check('identity: hues reported as kept', /hues kept: 100%/.test(out), (out.match(/hues kept: \d+%/) || [])[0]);

/* 2) the "negative" colour tool */
writeFileSync('tmp-colortest/probe-negative.png', encodePNG(mapPixels((r, g, b) => [255 - r, 255 - g, 255 - b]), 9));
out = run('tmp-colortest/probe-negative.png');
check('negative: detected as EXACT 255 - c', /EXACT 255 − c inversion|EXACT 255 - c inversion|EXACT 255 . c inversion/.test(out));
check('negative: per-channel fit is a = -1, b = 255', /out = -1\.0000·in \+ 255\.0/.test(out));
check('negative: verdict points at True negative in Notes2A4', /True negative/.test(out));
check('negative: reported as complementing hues', /complemented \(180°\): 100%/.test(out));
check('negative: black ↔ white swap visible in the table', /000000  →  FFFFFF/.test(out) && /FFFFFF  →  000000/.test(out));

/* 3) a luma/threshold style tool (colour thrown away) */
writeFileSync('tmp-colortest/probe-luma.png', encodePNG(mapPixels((r, g, b) => {
  const l = 255 - Math.round((r * 299 + g * 587 + b * 114) / 1000);
  return [l, l, l];
}), 9));
out = run('tmp-colortest/probe-luma.png');
check('luma: detected as colour-destroying', /YES: colour is thrown away/.test(out));
check('luma: verdict offers Black ink / Pure B&W as the match', /Black ink" \/ "Pure B&W/.test(out));

/* 4) a real JPEG copy (worst case: lossy, no PNG headers) */
try {
  const jpeg = require('jpeg-js');
  const rgba = Buffer.alloc(probe.w * probe.h * 4, 255);
  for (let i = 0, j = 0; i < probe.w * probe.h; i++, j += 4) {
    rgba[j] = probe.data[i * 3]; rgba[j + 1] = probe.data[i * 3 + 1]; rgba[j + 2] = probe.data[i * 3 + 2];
  }
  writeFileSync('tmp-colortest/probe.jpg', jpeg.encode({ data: rgba, width: probe.w, height: probe.h }, 88).data);
  out = run('tmp-colortest/probe.jpg');
  check('jpeg: still found the grid through compression', /corner marks: 4\/4/.test(out));
  check('jpeg: measured range used for correction', /reference: measured range\s+R/.test(out));
  check('jpeg: verdict still reproducible', /VERDICT:/.test(out));
} catch (e) {
  check('jpeg: jpeg-js available for the JPEG path', false, e.message);
}

console.log('\n' + (fail === 0 ? 'ALL PROBE CHECKS PASSED' : fail + ' PROBE CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
