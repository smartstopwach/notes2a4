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
      perSheet: 2,        // 2 = portrait stack (demo look) | 4 = 2×2 grid on landscape
      margin: 0,          // pt, printable margin around the sheet
      gapMode: 'auto',    // 'auto' = leftover white space (demo look) | 'fixed'
      gap: 40 * PT_PER_MM / 2, // pt, used only when gapMode === 'fixed'
      gutter: 16,         // pt, cross-gutter used by 4-up in auto mode
      lines: false,       // ruled lines inside the gap (2-up only — room for handwritten notes)
      lineSpacing: 14,    // pt
      pageNumbers: false  // small "sheet / total" inside the gap
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
    // Ruled lines only make sense in the 2-up middle gap; silently drop them in 4-up.
    if (o.perSheet === 4) o.lines = false;
    return o;
  }

  /** Sheet size for a mode: 2-up is portrait, 4-up turns the same paper sideways. */
  function sheetSize(opts) {
    var p = PAPERS[opts.paper];
    return (opts.perSheet === 4) ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
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
   * 4-up layout: a 2×2 grid of slides on a LANDSCAPE sheet (uniform scale,
   * even cross-gutters, whole block centered — the classic lecture "handout 4").
   * sizes: array of up to 4 {w,h} (indices 0,1 = top row; 2,3 = bottom row).
   */
  function quadLayout(sizes, opts, page) {
    var W = page.w, H = page.h, m = opts.margin;
    var availW = W - 2 * m, availH = H - 2 * m;
    if (availW <= 0 || availH <= 0) throw new Error('Margin too large for this paper size');
    var g = (opts.gapMode === 'fixed') ? opts.gap : opts.gutter;
    var gH = Math.min(g, availW * 0.18);
    var gV = Math.min(g, availH * 0.30);
    var present = [];
    var i;
    for (i = 0; i < 4; i++) present.push(sizes[i] || null);

    var cellW = (availW - gH) / 2;
    // uniform scale so every slide shares the same width
    var s = Infinity;
    for (i = 0; i < 4; i++) if (present[i]) s = Math.min(s, cellW / present[i].w);
    var rowH = [
      Math.max(present[0] ? present[0].h * s : 0, present[1] ? present[1].h * s : 0),
      Math.max(present[2] ? present[2].h * s : 0, present[3] ? present[3].h * s : 0)
    ];
    var has2 = rowH[1] > 0;                      // a partial last sheet → single row, centered
    var block = rowH[0] + (has2 ? gV + rowH[1] : 0);
    if (block > availH) {                        // shrink so everything fits
      var k = availH / block;
      s *= k; rowH[0] *= k; rowH[1] *= k; gV *= k;
      block = availH;
    }
    var pad = (availH - block) / 2;              // equal white space above/below
    var rowTopY = m + pad + rowH[1] + (has2 ? gV : 0); // baseline of upper row
    var rowBotY = m + pad;                       // baseline of lower row

    var slides = [];
    for (i = 0; i < 4; i++) {
      var sz = present[i];
      if (!sz) { slides.push(null); continue; }
      var w = sz.w * s, h = sz.h * s;
      var row = i < 2 ? 0 : 1, col = i % 2;
      var cellX = m + col * (cellW + gH);
      slides.push({
        x: cellX + (cellW - w) / 2,
        y: (row === 0 ? rowTopY : rowBotY) + (rowH[row] - h) / 2,
        width: w, height: h
      });
    }
    return {
      W: W, H: H, margin: m, slides: slides, lines: [],
      gutterCenterY: rowBotY + rowH[1] + (has2 ? gV / 2 : 0),
      gutterH: has2 ? gV : 0, scale: s,
      gap: { x: m, y: rowBotY + rowH[1], w: availW, h: has2 ? gV : 0 }
    };
  }

  /** Unified entry used by the app and by the tests: handles 2-up and 4-up. */
  function layoutForSheet(sizes, options, page) {
    var opts = normalize(options);
    if (opts.perSheet === 4) {
      var L4 = quadLayout(sizes, opts, page);
      L4.top = L4.slides[0]; L4.bottom = L4.slides[2];
      return L4;
    }
    var L = sheetLayout(sizes[0] || null, sizes[1] || null, opts, page);
    L.slides = [L.top, L.bottom];
    return L;
  }

  /**
   * Convert a source PDF into a packed PDF (2-up portrait or 4-up landscape).
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

    var page = sheetSize(opts);            // 2-up → portrait · 4-up → landscape
    var per = opts.perSheet;
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

      if (opts.lines && per === 2) {
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
        var tx = (page.w - tw) / 2, ty;
        if (per === 4) {
          ty = (L.gutterH >= 12 ? L.gutterCenterY - size / 3 : page.h - opts.margin - size - 2.5);
        } else if (opts.lines && L.lines.length) {
          tx = L.gap.x + 10;
          ty = L.gap.y + L.gap.h - 12;
        } else {
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
