/* ============ image in/out for the probe tools ============
   Decoders: PNG (written here), JPEG (jpeg-js), and raster images found inside
   a returned PDF (Flate RGB/grey + DCTDecode). Encoder: PNG (no dependencies). */
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('only 8-bit PNGs supported (got ' + bd + ')');
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : 0;
  if (!ch) throw new Error('unsupported PNG colour type ' + ct);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = new Uint8Array(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 3;
      if (ch >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; }
      else out[d] = out[d + 1] = out[d + 2] = line[s];
    }
  }
  return { w, h, data: out };
}

export function decodeJPEG(buf) {
  const jpeg = require('jpeg-js');
  const { width, height, data } = jpeg.decode(buf, { useTArray: true });
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    out[i * 3] = data[j]; out[i * 3 + 1] = data[j + 1]; out[i * 3 + 2] = data[j + 2];
  }
  return { w: width, h: height, data: out };
}

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
export function encodePNG(img, level = 6) {
  const { w, h, data } = img;
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => {
    const line = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      line[1 + x * 3] = data[s]; line[2 + x * 3] = data[s + 1]; line[3 + x * 3] = data[s + 2];
    }
    return line;
  }));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, level)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* raster images inside a PDF the other tool produced */
export function imagesFromPDF(buf) {
  const lat = buf.toString('latin1'), found = [];
  const re = /<<([^]*?)>>\s*stream\r?\n?/g;
  let m;
  while ((m = re.exec(lat))) {
    const dict = m[1];
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const w = +(dict.match(/\/Width\s+(\d+)/) || [])[1];
    const h = +(dict.match(/\/Height\s+(\d+)/) || [])[1];
    if (!w || !h) continue;
    const start = m.index + m[0].length;
    const end = lat.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = buf.subarray(start, end);
    const filt = (dict.match(/\/Filter\s*(\/\w+|\[[^\]]*\])/) || [])[1] || '';
    const isJpg = /DCTDecode/.test(filt), isFlate = /FlateDecode/.test(filt), isGray = /DeviceGray/.test(dict);
    try {
      if (isJpg) found.push({ name: 'pdf-jpeg', img: decodeJPEG(Buffer.from(raw)) });
      else if (isFlate && !/Predictor/.test(dict)) {
        const inf = inflateSync(raw);
        const ch = isGray ? 1 : 3;
        if (inf.length >= w * h * ch) {
          const out = new Uint8Array(w * h * 3);
          for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = inf[i * ch + Math.min(c, ch - 1)];
          found.push({ name: 'pdf-flate', img: { w, h, data: out } });
        }
      }
    } catch (e) { /* skip a broken stream */ }
  }
  return found;
}

export function loadImage(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') {
    const imgs = imagesFromPDF(buf);
    if (!imgs.length) throw new Error('no embedded raster image found in this PDF (a screenshot/PNG works best)');
    imgs.sort((a, b) => b.img.w * b.img.h - a.img.w * a.img.h);
    console.log('· PDF contained ' + imgs.length + ' image(s); using ' + imgs[0].name + ' ' + imgs[0].img.w + 'x' + imgs[0].img.h);
    return imgs[0].img;
  }
  if (buf.readUInt32BE(0) === 0x89504e47) return decodePNG(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJPEG(buf);
  throw new Error('unrecognised file - send a PDF, PNG or JPEG');
}
