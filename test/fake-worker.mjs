/* ============================================================================
   Shared test doubles for the raster worker.

   The real thing runs in a browser: a Worker + OffscreenCanvas. Here we drive the
   SAME code (worker-raster.js's core, raster-client.js's plumbing) against small
   stand-ins, so the protocol, the transferred buffers and the fallback behaviour
   are all exercised without a browser.

     installFakeWorker(target, opts)   → a Worker class that runs worker-raster.js
     installFakeOffscreenCanvas(target) → OffscreenCanvas + convertToBlob (real PNGs)
   ============================================================================ */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const NC = require('../converter.js');
const core = require('../worker-raster.js');
const { encodePNG } = await import('../tools/img-io.mjs');
const jpeg = require('jpeg-js');

/* ------------------------------------------------------------ OffscreenCanvas --- */
export function makeOffscreenCanvas(target = globalThis) {
  class FakeImageData {
    constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
  }
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; this._px = null; }
    _buf() {
      if (!this._px || this._px.length !== this.width * this.height * 4) {
        const old = this._px;
        this._px = new Uint8ClampedArray(this.width * this.height * 4);
        if (old) this._px.set(old.subarray(0, Math.min(old.length, this._px.length)));
      }
      return this._px;
    }
    getContext() {
      const cv = this;
      return {
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        putImageData(id, x = 0, y = 0) {
          const buf = cv._buf();
          for (let r = 0; r < id.height; r++) {
            const dst = ((y + r) * cv.width + x) * 4;
            buf.set(id.data.subarray(r * id.width * 4, (r + 1) * id.width * 4), dst);
          }
        },
        getImageData(x, y, w, h) {
          const buf = cv._buf();
          const out = new Uint8ClampedArray(w * h * 4);
          for (let r = 0; r < h; r++) {
            const src = ((y + r) * cv.width + x) * 4;
            out.set(buf.subarray(src, src + w * 4), r * w * 4);
          }
          return new FakeImageData(out, w, h);
        },
        drawImage(src, sx, sy, sw, sh) {                 // plain box downscale (what matters here is that it runs)
          const buf = cv._buf(), srcBuf = src._buf();
          for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
              const sxx = Math.min(src.width - 1, Math.floor(x * src.width / sw));
              const syy = Math.min(src.height - 1, Math.floor(y * src.height / sh));
              const si = (syy * src.width + sxx) * 4, di = (y * cv.width + x) * 4;
              buf[di] = srcBuf[si]; buf[di + 1] = srcBuf[si + 1]; buf[di + 2] = srcBuf[si + 2]; buf[di + 3] = srcBuf[si + 3];
            }
          }
        }
      };
    }
    async convertToBlob({ type = 'image/png' } = {}) {
      const buf = this._buf();
      if (/jpe?g/i.test(type)) {
        const rgba = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
        const enc = jpeg.encode({ data: rgba, width: this.width, height: this.height }, 90);   // a real JPEG
        const out = new Uint8Array(enc.data);
        return { arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) };
      }
      const png = encodePNG({ data: buf, w: this.width, h: this.height }, 6);   // a REAL png, so pdf-lib can embed it
      return { arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    }
  }
  target.OffscreenCanvas = FakeCanvas;
  target.ImageData = FakeImageData;
  return { FakeCanvas, FakeImageData };
}

/* ------------------------------------------------------------------- Worker --- */
/**
 * A Worker stand-in that really runs worker-raster.js: messages are structured
 * cloned (with transfer lists honoured, so a buffer can only be sent once) and
 * delivered asynchronously, exactly like a browser worker.
 */
export function installFakeWorker(target = globalThis, { failLoad = false, delay = 0 } = {}) {
  const log = { posts: 0, strips: [], encoded: 0, clones: 0 };
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      this.terminated = false;
      const self = {
        NotesConverter: null,
        importScripts() { for (const u of arguments) if (/converter\.js$/.test(String(u))) self.NotesConverter = NC; },
        postMessage: (msg, transfer) => {
          const clone = transfer && transfer.length ? structuredClone(msg, { transfer }) : msg;
          setTimeout(() => { if (!this.terminated && this.onmessage) this.onmessage({ data: clone }); }, delay);
        },
        onmessage: null
      };
      this._self = self;
      setTimeout(() => {
        if (this.terminated) return;
        if (failLoad) { if (this.onerror) this.onerror({ message: 'boom: worker not available' }); return; }
        core.workerMain(self);
      }, delay);
    }
    postMessage(msg, transfer) {
      log.posts++;
      if (msg && msg.cmd === 'strip') log.strips.push({ id: msg.id, y0: msg.y0, rows: msg.rows });
      if (msg && msg.cmd === 'finish') log.encoded++;
      // structured clone (transfer honoured) — a detached buffer would throw here
      const clone = transfer && transfer.length ? structuredClone(msg, { transfer }) : structuredClone(msg);
      log.clones++;
      setTimeout(() => { if (!this.terminated && this._self.onmessage) this._self.onmessage({ data: clone }); }, delay);
    }
    terminate() { this.terminated = true; }
  }
  target.Worker = FakeWorker;
  return log;
}

/** Load raster-client.js into the current realm (it publishes globalThis.NotesRaster). */
export function installRasterClient(target = globalThis) {
  const src = readFileSync(new URL('../raster-client.js', import.meta.url), 'utf8');
  vm.runInThisContext(src, { filename: 'raster-client.js' });
  return target.NotesRaster;
}

/** Wipe a previous install (the tests boot fresh). */
export function resetRaster(target = globalThis) {
  delete target.NotesRaster;
  delete target.Worker;
  delete target.OffscreenCanvas;
  delete target.ImageData;
}
