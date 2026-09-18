/* ============ the worker file, run like a real Worker ============
   node test/worker-realm.test.mjs

   The other worker tests call workerMain() by hand. This one runs worker-raster.js
   the way a browser does: a realm where `self` IS the global object, where
   `importScripts()` pulls in vendor/pdf-lib.min.js and converter.js, and where the
   only way in and out is onmessage/postMessage. That is what catches the things a
   hand-made stub would hide — a module that cannot load in a worker, a global that
   is missing, a message that never comes back.

   The page that comes back is decoded and compared with the main-thread hqMap
   output pixel for pixel, so "the worker renders the same page" is verified, not
   assumed.
*/
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { decodePNG } from '../tools/img-io.mjs';
import { makeOffscreenCanvas } from './fake-worker.mjs';

const require = createRequire(import.meta.url);
const NC = require('../converter.js');
const PS = NC.printSaver;
const ROOT = new URL('..', import.meta.url);

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']')); }
};

/* ---- a realm that behaves like a classic Web Worker ------------------------ */
function makeWorkerRealm() {
  const inbox = [];                                  // what the worker posts to us
  const realm = {};
  realm.self = realm;                                // in a worker, `self` is the global object
  realm.postMessage = (msg) => { inbox.push(msg); };
  realm.importScripts = function () {
    for (const url of arguments) {
      const file = String(url).replace(/^\/*/, '');
      vm.runInContext(readFileSync(new URL(file, ROOT), 'utf8'), ctx, { filename: file });
    }
  };
  realm.console = console;
  realm.setTimeout = setTimeout; realm.clearTimeout = clearTimeout;
  realm.Uint8Array = Uint8Array; realm.Uint8ClampedArray = Uint8ClampedArray;
  realm.Uint16Array = Uint16Array; realm.Uint32Array = Uint32Array; realm.Float32Array = Float32Array;
  realm.Math = Math; realm.JSON = JSON; realm.Promise = Promise; realm.Error = Error;
  const fake = makeOffscreenCanvas(realm);
  const ctx = vm.createContext(realm);
  vm.runInContext(readFileSync(new URL('worker-raster.js', ROOT), 'utf8'), ctx, { filename: 'worker-raster.js' });
  return {
    inbox, realm, ctx, fake,
    send(data) { realm.onmessage({ data }); },
    wait(cmd, id, ms = 20000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = inbox.findIndex((m) => m.cmd === cmd && (id === undefined || m.id === id));
          if (hit >= 0) return resolve(inbox[hit]);
          if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for ' + cmd));
          setTimeout(tick, 5);
        };
        tick();
      });
    }
  };
}

console.log('\n=== raster worker, run like a real Worker ===\n');

{
  const R = makeWorkerRealm();
  await new Promise((r) => setTimeout(r, 30));
  check('worker realm: the worker announces itself with { cmd:"ready" }',
    R.inbox.some((m) => m.cmd === 'ready'));

  /* a page: 240×180 supersampled, mapped with the ink rule, encoded to PNG */
  const bw = 240, bh = 180, W = 120, H = 90;
  const data = new Uint8ClampedArray(bw * bh * 4);
  for (let i = 0; i < bw * bh; i++) {
    const v = (i * 53) % 256;
    data[i * 4] = v; data[i * 4 + 1] = (v * 7) % 256; data[i * 4 + 2] = 255 - v; data[i * 4 + 3] = 255;
  }
  const big = { data, width: bw, height: bh };
  R.send({ cmd: 'begin', id: 7, kind: 'hq', bw, bh, W, H, auto: true, keepColour: false, pure: false, trackBlank: true });
  for (let y = 0; y < bh; y += 45) {
    const rows = Math.min(45, bh - y);
    R.send({ cmd: 'strip', id: 7, y0: y, rows, data: data.slice(y * bw * 4, (y + rows) * bw * 4).buffer });
  }
  R.send({ cmd: 'finish', id: 7, encode: { mime: 'image/png', previewMax: 64 } });
  const done = await R.wait('done', 7);

  check('worker realm: the worker loaded converter.js through importScripts (pdf-lib first)',
    !!R.realm.NotesConverter && !!R.realm.PDFLib, 'PDFLib ' + (R.realm.PDFLib && typeof R.realm.PDFLib) + ' · converter ' + typeof R.realm.NotesConverter);
  check('worker realm: strips are reported back as progress',
    R.inbox.filter((m) => m.cmd === 'progress' && m.id === 7).length >= 4,
    R.inbox.filter((m) => m.cmd === 'progress' && m.id === 7).length + ' progress messages');
  check('worker realm: a finished job comes back as real PNG bytes + a preview',
    done.bytes && new Uint8Array(done.bytes)[0] === 0x89 && done.preview && done.preview.w <= 64,
    (done.bytes ? done.bytes.byteLength : 0) + ' bytes · preview ' + (done.preview ? done.preview.w + '×' + done.preview.h : 'none'));

  const img = decodePNG(Buffer.from(new Uint8Array(done.bytes)));
  const mine = PS.hqMap(big, W, H, true, false, false);
  let worst = 0, differing = 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(img.data[i * 4 + c] - mine.imageData.data[i * 4 + c]);
      if (d) differing++;
      if (d > worst) worst = d;
    }
  }
  check('worker realm: the decoded page equals the main-thread hqMap page, pixel for pixel',
    differing === 0, differing + ' differing channels · worst ' + worst);

  /* the flip path encodes an RGBA buffer that was produced on the main thread */
  R.send({ cmd: 'encode', id: 8, data: new Uint8ClampedArray(W * H * 4).fill(200).buffer, W, H, encode: { mime: 'image/jpeg', quality: 0.94 } });
  const enc = await R.wait('done', 8);
  check('worker realm: encode() of a main-thread RGBA buffer works (the 255−c path)',
    enc.bytes && enc.bytes.byteLength > 100, (enc.bytes ? enc.bytes.byteLength : 0) + ' bytes');

  /* a broken job must answer with { cmd:"error" }, never silence */
  R.send({ cmd: 'finish', id: 999, encode: {} });
  const err = await R.wait('error', 999);
  check('worker realm: a job that cannot run answers with an error message',
    /no such job/.test(err.message), err.message);
}

console.log('\n' + (fail === 0 ? 'ALL WORKER REALM CHECKS PASSED' : fail + ' WORKER REALM CHECK(S) FAILED') + '  (' + pass + ' passed)\n');
process.exit(fail ? 1 : 0);
