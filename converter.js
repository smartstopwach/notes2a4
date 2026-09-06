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
      perSheet: 2,        // 2 = portrait stack (demo look) | 4 = pair-columns on LANDSCAPE (demo 4-up look)
      margin: 0,          // pt, printable margin around the sheet
      gapMode: 'auto',    // 'auto' = leftover white space in the middle | 'fixed' = given gap, centered
      gap: 40 * PT_PER_MM / 2, // pt, used only when gapMode === 'fixed'
      lines: false,       // ruled lines inside the middle band (room for handwritten notes)
      lineSpacing: 14,    // pt
      pageNumbers: false  // small "sheet / total" inside the band
    };
  }

  function normalize(opts) {
    var o = defaults();
    if (opts) for (var k in o) if (opts[k] !== undefined) o[k] = opts[k];
    if (!PAPERS[o.paper]) o.paper = 'a4';
    o.perSheet = (+o.perSheet === 4) ? 4 : 2;
    o.margin = Math.max(0, Math.min(36, +o.margin || 0));
    o.gap = Math.max(0, Math.min(300, +o.gap || 0));
    if (o.gapMode !== 'fixed') o.gapMode = 'auto';
    o.lines = !!o.lines;
    o.pageNumbers = !!o.pageNumbers;
    o.lineSpacing = Math.max(6, Math.min(36, +o.lineSpacing || 14));
    return o;
  }

  /** Sheet size for a mode: 2-up is portrait, 4-up turns the same paper sideways (841.89×595.28 for A4). */
  function sheetSize(opts) {
    var p = PAPERS[opts.paper];
    return (opts.perSheet === 4) ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
  }

  function makeRuledLines(band, opts) {
    var lines = [];
    if (!opts.lines || band.h < opts.lineSpacing + 12) return lines;
    var pad = 7;
    var area0 = band.y + pad, area1 = band.y + band.h - pad;
    var n = Math.max(1, Math.floor((area1 - area0) / opts.lineSpacing));
    var step = (area1 - area0) / n;
    for (var i = 0; i < n; i++) lines.push(area1 - (i + 1) * step);
    return lines;
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
      lines: makeRuledLines({ y: botY + hB, h: gap }, opts),
      scale: t ? t.s : (b ? b.s : 1)
    };
    L.lineInset = 10;
    return L;
  }

  /**
   * 4-up layout — reproduces the measured demo geometry ("4 16:9 → landscape A4"):
   * two half-width columns; the LEFT column holds sheet-slides 1 (top) and 2 (bottom),
   * the RIGHT column holds 3 and 4. Each slide is scaled to half the printable width,
   * rows sit flush against the top and bottom edges; the leftover horizontal band in
   * the middle (~44 mm at 16:9, margin 0) stays white — shared by both columns, ideal
   * for handwritten notes (ruled lines optional). 'fixed' gap centers the block instead.
   * sizes[i] = page-order size: 0=TL, 1=BL, 2=TR, 3=BR; nulls allowed (partial sheet).
   */
  function quadLayout(sizes, opts, page) {
    var W = page.w, H = page.h, m = opts.margin;
    var availW = W - 2 * m, availH = H - 2 * m;
    if (availW <= 0 || availH <= 0) throw new Error('Margin too large for this paper size');
    var colW = availW / 2;
    var fixed = opts.gapMode === 'fixed';
    var g = fixed ? Math.max(0, opts.gap) : 0;
    var slides = [null, null, null, null];

    for (var ci = 0; ci < 2; ci++) {
      var ti = 2 * ci, bi = 2 * ci + 1;      // top & bottom slide index of this column
      var tsz = sizes[ti] || null, bsz = sizes[bi] || null;
      if (!tsz && !bsz) continue;
      var sTop = tsz ? colW / tsz.w : 0, sBot = bsz ? colW / bsz.w : 0;
      var hT = tsz ? tsz.h * sTop : 0, hB = bsz ? bsz.h * sBot : 0;
      var block = hT + hB + (fixed ? g : 0);
      if (block > availH) {                   // shrink uniformly so both rows + band fit
        var k = availH / block;
        sTop *= k; sBot *= k; hT *= k; hB *= k;
        block = availH; if (fixed) g *= k;
      }
      var padTop = fixed ? (availH - block) / 2 : 0;
      if (tsz) {
        var wT = tsz.w * sTop;
        slides[ti] = { x: m + ci * colW + (colW - wT) / 2, y: m + availH - padTop - hT, width: wT, height: hT };
      }
      if (bsz) {
        var wB = bsz.w * sBot;
        slides[bi] = { x: m + ci * colW + (colW - wB) / 2, y: m + padTop, width: wB, height: hB };
      }
    }

    // Shared white band = overlap of the two columns' row gaps.
    var tops = [slides[0], slides[2]].filter(Boolean);
    var bots = [slides[1], slides[3]].filter(Boolean);
    var bandTop = tops.length ? Math.min.apply(null, tops.map(function (b) { return b.y; })) : m + availH;
    var bandBot = bots.length ? Math.max.apply(null, bots.map(function (b) { return b.y + b.height; })) : m;
    var band = { x: m, y: bandBot, w: availW, h: Math.max(0, bandTop - bandBot) };

    return {
      W: W, H: H, margin: m, slides: slides, lineInset: 10,
      gap: band, lines: makeRuledLines(band, opts), scale: colW / 1280
    };
  }

  /** Unified entry: handles both modes; returns { slides, gap, lines, ... } in page order. */
  function layoutForSheet(sizes, options, page) {
    var opts = normalize(options);
    if (opts.perSheet === 4) return quadLayout(sizes, opts, page);
    var L = sheetLayout(sizes[0] || null, sizes[1] || null, opts, page);
    L.slides = [L.top, L.bottom];
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
    out.setProducer('Notes2A4 · slides-per-sheet packer');
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

    var per = opts.perSheet;
    var page = sheetSize(opts);
    var nSheets = Math.ceil(n / per);
    var lineColor = rgb(0.66, 0.7, 0.76);
    var numColor = rgb(0.45, 0.48, 0.53);

    for (var s = 0; s < nSheets; s++) {
      var base = s * per;
      var cellSizes = [], cellPages = [];
      for (var c = 0; c < per; c++) {
        var gi = base + c;
        cellSizes.push(gi < n ? sizes[gi] : null);
        cellPages.push(gi < n ? embedded[gi] : null);
      }
      var L = (per === 4)
        ? quadLayout(cellSizes, opts, page)
        : sheetLayout(cellSizes[0], cellSizes[1], opts, page);
      var boxes = (per === 4) ? L.slides : [L.top, L.bottom];

      var pg = out.addPage([page.w, page.h]);
      for (var c2 = 0; c2 < boxes.length; c2++) {
        if (cellPages[c2] && boxes[c2]) pg.drawPage(cellPages[c2], boxes[c2]);
      }

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

      if (opts.pageNumbers && (L.gap.h >= 12 || per === 2)) {
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
    sheetSize: sheetSize,
    sheetLayout: sheetLayout,
    quadLayout: quadLayout,
    layoutForSheet: layoutForSheet,
    build: build
  };
});
