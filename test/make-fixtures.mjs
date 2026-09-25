/* Regenerates the sample PDFs the test-suite runs on, so the suite is
   self-contained (no file outside the repo is needed).
   Usage: node test/make-fixtures.mjs                */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';

const W = 960, H = 540;                                  // 16:9 note slide

async function make(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([W, H]);
    p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.07, 0.08, 0.1) });   // dark board
    p.drawText('Notes2A4 sample slide ' + i + ' / ' + pages, { x: 60, y: H - 90, size: 34, font: bold, color: rgb(0.95, 0.96, 1) });
    p.drawText('I = Imax e^(-Rt/L)   at t = 0, I = Imax', { x: 60, y: H - 160, size: 20, font, color: rgb(0.85, 0.9, 1) });
    p.drawText('L dI/dt = -IR    integrate 0 to t', { x: 60, y: H - 200, size: 20, font, color: rgb(0.85, 0.9, 1) });
    p.drawText('current decays exponentially — time constant L/R', { x: 60, y: H - 240, size: 20, font, color: rgb(0.85, 0.9, 1) });
    for (let k = 0; k < 5; k++) {
      p.drawText('- rule ' + (k + 1) + ': v = iR,  p = vi  (page ' + i + ')', { x: 60, y: H - 300 - k * 30, size: 17, font, color: rgb(0.8, 0.87, 1) });
    }
  }
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync(file, Buffer.from(await doc.save({ useObjectStreams: true })));
  console.log('wrote', file, pages, 'pages');
}

await make('test/fixtures/notes-2p.pdf', 2);
await make('test/fixtures/notes-4p.pdf', 4);

/* Two solid PNG "slide" images for the print-saver raster tests — written with
   a tiny inline PNG encoder so no image library is needed. */
import { deflateSync } from 'node:zlib';

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
function solidPng(file, w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]));
  console.log('wrote', file, w + 'x' + h);
}
solidPng('test/fixtures/dark.png', 256, 144, [19, 19, 33]);
solidPng('test/fixtures/light.png', 256, 144, [250, 250, 250]);
