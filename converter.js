/*!
 * Notes2A4 — converter core (2 slides → 1 white A4 sheet, top + bottom, gap in middle)
 * UMD module: runs in the browser (global `NotesConverter`, uses pdf-lib UMD)
 * and in Node (require('pdf-lib')) for tests.
 *
 * Geometry follows the "11th (2).pdf" demo: each 16:9 slide is scaled to the full
 * printable width of the sheet and stacked — one flush to the top, one flush to the
 * bottom — leaving the remaining height as a white gap in the middle.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pdf-lib'));
  } else {
    root.NotesConverter = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  var PDFDocument = PDFLib.PDFDocument;
  var StandardFonts = PDFLib.StandardFonts;
  var rgb = PDFLib.rgb;

  var PT_PER_MM = 72 / 25.4;

  var PAPERS = {
    a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
    letter: { label: 'Letter (216 × 279 mm)', w: 612, h: 792 },
    a5: { label: 'A5 (148 × 210 mm)', w: 419.53, h: 595.28 },
    legal: { label: 'Legal (216 × 356 mm)', w: 612, h: 1008 }
  };

  function defaults() {
    return {
      paper: 'a4',
      margin: 0,          // pt, printable margin around the sheet
      gapMode: 'auto',    // 'auto' = leftover white space (demo look) | 'fixed'
      gap: 40 * PT_PER_MM / 2, // pt, used only when gapMode === 'fixed'
      lines: false,       // ruled lines inside the gap (room for handwritten notes)
      lineSpacing: 14,    // pt
      pageNumbers: false  // small "sheet / total" inside the gap
    };
  }

  function normalize(opts) {
    var o = defaults();
    if (opts) for (var k in o) if (opts[k] !== undefined) o[k] = opts[k];
    if (!PAPERS[o.paper]) o.paper = 'a4';
    o.margin = Math.max(0, Math.min(36, +o.margin || 0));
    o.gap = Math.max(0, Math.min(300, +o.gap || 0));
    if (o.gapMode !== 'fixed') o.gapMode = 'auto';
    o.lines = !!o.lines;
    o.pageNumbers = !!o.pageNumbers;
    o.lineSpacing = Math.max(6, Math.min(36, +o.lineSpacing || 14));
    return o;
  }

  /**
   * Pure geometry: where do the two slides sit on one sheet?
   * Coordinates are PDF points with origin at the BOTTOM-LEFT of the page.
   *
   * @param {{w:number,h:number}|null} topSize    size of the source page that goes on top
   * @param {{w:number,h:number}|null} bottomSize size of the source page that goes at the bottom
   * @param {object} opts normalized options
   * @param {{w:number,h:number}} page sheet size (PAPERS entry)
   */
  function sheetLayout(topSize, bottomSize, opts, page) {
    var W = page.w, H = page.h, m = opts.margin;
    var maxW = W - 2 * m;
    if (maxW <= 0) throw new Error('Margin too large for this paper size');

    function fit(sz) {
      if (!sz) return null;
      var s = maxW / sz.w;
      return { s: s, w: sz.w * s, h: sz.h * s };
    }

    var t = fit(topSize);
    var b = fit(bottomSize);
    var hT = t ? t.h : 0;
    var hB = b ? b.h : 0;

    var gap;
    if (opts.gapMode === 'auto') {
      gap = Math.max(0, H - 2 * m - hT - hB); // demo behaviour: leftover fills the middle
    } else {
      gap = Math.max(0, opts.gap);
    }

    var block = hT + gap + hB;
    var avail = H - 2 * m;
    if (block > avail && block > 0) {         // shrink uniformly so everything fits
      var k = avail / block;
      if (t) t = { s: t.s * k, w: t.w * k, h: t.h * k };
      if (b) b = { s: b.s * k, w: b.w * k, h: b.h * k };
      gap = gap * k;
      hT = t ? t.h : 0;
      hB = b ? b.h : 0;
      block = hT + gap + hB;
    }

    var blockBottom = m + (avail - block) / 2; // vertically center the stack
    var topY = blockBottom + gap + hB;
    var botY = blockBottom;

    var L = {
      W: W, H: H, margin: m,
      top: t ? { x: (W - t.w) / 2, y: topY, width: t.w, height: t.h } : null,
      bottom: b ? { x: (W - b.w) / 2, y: botY, width: b.w, height: b.h } : null,
      gap: { x: m, y: botY + hB, w: maxW, h: gap },
      lines: [],
      scale: t ? t.s : (b ? b.s : 1)
    };

    if (L.lines && opts.lines && gap >= opts.lineSpacing + 8) {
      var pad = 7;
      var area0 = L.gap.y + pad;
      var area1 = L.gap.y + L.gap.h - pad;
      var n = Math.max(1, Math.floor((area1 - area0) / opts.lineSpacing));
      var step = (area1 - area0) / n;
      for (var i = 0; i < n; i++) L.lines.push(area1 - (i + 1) * step + step * 0.0);
      // keep lines within the printable width, small inset so they look like a ruled band
      L.lineInset = 10;
    }
    return L;
  }

  /**
   * Convert a source PDF into a packed 2-up PDF.
   *
   * @param {Uint8Array|ArrayBuffer} srcBytes
   * @param {object} [options] see defaults()
   * @param {(done:number,total:number)=>void} [onProgress] called per sheet (awaits it → UI can breathe)
   * @returns {Promise<{bytes:Uint8Array, sheets:number, sourcePages:number, pageWH:{w:number,h:number}}>}
   */
  async function build(srcBytes, options, onProgress) {
    var opts = normalize(options);
    var bytes = srcBytes instanceof Uint8Array ? srcBytes : new Uint8Array(srcBytes);

    var src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    var srcPages = src.getPages();
    var n = srcPages.length;
    if (!n) throw new Error('The PDF has no pages');

    var sizes = [];
    var embedIdx = []; // pages with a Contents stream (pdf-lib can't embed empty ones)
    for (var i = 0; i < n; i++) {
      sizes.push({ w: srcPages[i].getWidth(), h: srcPages[i].getHeight() });
      var hasContents = true;
      try { hasContents = !!(srcPages[i].node.Contents && srcPages[i].node.Contents()); } catch (e) {}
      if (hasContents) embedIdx.push(i);
    }

    var out = await PDFDocument.create();
    out.setProducer('Notes2A4 · two slides per sheet');
    var font = await out.embedFont(StandardFonts.Helvetica);

    // Embed every source page once (vector Form XObjects — text stays crisp).
    // Some exports contain blank pages with no Contents stream, which pdf-lib
    // refuses to embed; they are skipped and leave clean white space instead.
    var embedded = new Array(n).fill(null);
    try {
      var batch = await out.embedPdf(bytes, embedIdx);
      for (var bi = 0; bi < embedIdx.length; bi++) embedded[embedIdx[bi]] = batch[bi];
    } catch (eBatch) {
      for (var e1 = 0; e1 < embedIdx.length; e1++) {
        var idx = embedIdx[e1];
        try { embedded[idx] = (await out.embedPdf(bytes, [idx]))[0]; }
        catch (eOne) { embedded[idx] = null; }
      }
    }

    var page = PAPERS[opts.paper];
    var nSheets = Math.ceil(n / 2);
    var lineColor = rgb(0.66, 0.7, 0.76);
    var numColor = rgb(0.45, 0.48, 0.53);

    for (var s = 0; s < nSheets; s++) {
      var aIdx = 2 * s, bIdx = 2 * s + 1;
      var a = embedded[aIdx];
      var b = bIdx < n ? embedded[bIdx] : null;
      var L = sheetLayout(sizes[aIdx], b ? sizes[bIdx] : null, opts, page);

      var pg = out.addPage([page.w, page.h]);
      if (a && L.top) pg.drawPage(a, { x: L.top.x, y: L.top.y, width: L.top.width, height: L.top.height });
      if (b && L.bottom) pg.drawPage(b, { x: L.bottom.x, y: L.bottom.y, width: L.bottom.width, height: L.bottom.height });

      if (opts.lines) {
        for (var li = 0; li < L.lines.length; li++) {
          var y = L.lines[li];
          pg.drawLine({
            start: { x: L.gap.x + (L.lineInset || 10), y: y },
            end: { x: L.gap.x + L.gap.w - (L.lineInset || 10), y: y },
            thickness: 0.6,
            color: lineColor
          });
        }
      }

      if (opts.pageNumbers) {
        var txt = (s + 1) + ' / ' + nSheets;
        var size = 8;
        var tw = font.widthOfTextAtSize(txt, size);
        var tx, ty;
        if (opts.lines && L.lines.length) {
          tx = L.gap.x + 10;
          ty = L.gap.y + L.gap.h - 12;
        } else {
          tx = (page.w - tw) / 2;
          ty = L.gap.y + 3.5;
        }
        pg.drawText(txt, { x: tx, y: ty, size: size, font: font, color: numColor });
      }

      if (onProgress && (s % 4 === 3 || s === nSheets - 1)) {
        await onProgress(s + 1, nSheets);
      }
    }

    var saved = await out.save({ useObjectStreams: true });
    return { bytes: saved, sheets: nSheets, sourcePages: n, pageWH: { w: page.w, h: page.h } };
  }

  return {
    PAPERS: PAPERS,
    PT_PER_MM: PT_PER_MM,
    defaults: defaults,
    normalize: normalize,
    sheetLayout: sheetLayout,
    build: build
  };
});
