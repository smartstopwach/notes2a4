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
  var LineCapStyle = PDFLib.LineCapStyle;

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
      pageNumbers: false, // small "sheet / total" inside the band
      numPos: 'gap',      // gap | tl | tc | tr | bl | bc | br  (top/bottom × left/centre/right)
      numFmt: 'frac',     // frac "3 / 20" | plain "3" | page "Page 3" | dash "– 3 –" | of "3 of 20"
      numStart: 1,        // first sheet gets this number
      numSize: 8,         // pt font size (6–14)
      sepLine: 'off'      // 4-up only: dotted cut-lines between the panels — off | v | h | both
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
    if (['gap', 'tl', 'tc', 'tr', 'bl', 'bc', 'br'].indexOf(o.numPos) < 0) o.numPos = 'gap';
    if (['frac', 'plain', 'page', 'dash', 'of'].indexOf(o.numFmt) < 0) o.numFmt = 'frac';
    o.numStart = Math.max(0, Math.min(99999, Math.round(+o.numStart) || 1));
    o.numSize = Math.max(6, Math.min(14, +o.numSize || 8));
    if (['off', 'v', 'h', 'both'].indexOf(o.sepLine) < 0) o.sepLine = 'off';
    if (o.perSheet !== 4) o.sepLine = 'off';            // 4-up only — 2-up has no panel to separate
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

      decorateSheet(pg, L, opts, font, s, nSheets, page);

      if (onProgress && (s % 4 === 3 || s === nSheets - 1)) {
        await onProgress(s + 1, nSheets);
      }
    }

    var saved = await out.save({ useObjectStreams: true });
    return { bytes: saved, sheets: nSheets, sourcePages: n, pageWH: { w: page.w, h: page.h } };
  }

  /* ================= Print-Saver inversion =================
   * Converts dark "blackboard" notes to printer-friendly high-contrast ink:
   *   near-black pixels  → white (the paper)
   *   white pixels       → black (ink)
   *   any other colour   → black (ink)
   * 'auto' mode first measures the page: light pages are left untouched.
   * Operates on a canvas ImageData-like { data: Uint8ClampedArray RGBA }.
   */
  var PS_DARK_LUM = 90;                       // ≤ this counts as "black-ish"
  var PS_CHROMA = 60;                         // > this counts as a "real colour"
  var PS_MIN_INK_L = 30, PS_MAX_INK_L = 150;  // kept-colour ink stays in this luma band (printable)

  /* Classic-mode ink level for a COLOURED pixel: photometric negative of its
     luma instead of unconditional solid black. Bright colour strokes (yellow /
     orange pen) still land at ~black, but mid-luma colour FILLS (blue quiz
     badges, pills) become grey — so white labels printed on them survive as
     black-on-grey instead of vanishing inside a solid black blob. */
  function psColourInk(L) {
    var v = 255 - L;
    if (v <= 40) v = 0;            // near-black → crisp solid ink
    else if (v >= 215) v = 255;    // (a colour this dark is already board — handled earlier)
    return v | 0;
  }

  /* Hue-preserving colour flip: light colour on a dark board → dark ink of the
     SAME hue on white paper. Returns [r,g,b]. */
  function psKeepColour(r, g, b, L) {
    var target = 255 - L;
    if (target < PS_MIN_INK_L) target = PS_MIN_INK_L;
    else if (target > PS_MAX_INK_L) target = PS_MAX_INK_L;
    var k = target / (L > 1 ? L : 1);
    r *= k; g *= k; b *= k;
    return [r > 255 ? 255 : r, g > 255 ? 255 : g, b > 255 ? 255 : b];
  }

  function psProcess(imageData, auto, keepColour) {
    var d = imageData.data, i, r, g, b, lum, n = 0, dark = 0;
    for (i = 0; i < d.length; i += 4) {
      r = d[i]; g = d[i + 1]; b = d[i + 2];
      lum = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      if (lum <= PS_DARK_LUM) dark++;
      n++;
    }
    var frac = dark / n;
    var invert = auto ? frac >= 0.5 : true;
    if (invert) {
      for (i = 0; i < d.length; i += 4) {
        r = d[i]; g = d[i + 1]; b = d[i + 2];
        lum = (r * 299 + g * 587 + b * 114) / 1000 | 0;
        var chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum <= PS_DARK_LUM) {                    // dark first: saturated dark theme bg is board, not ink
          d[i] = d[i + 1] = d[i + 2] = 255;
        } else if (keepColour && chroma > PS_CHROMA) {
          var kc = psKeepColour(r, g, b, lum);
          d[i] = kc[0]; d[i + 1] = kc[1]; d[i + 2] = kc[2];
        } else if (chroma > PS_CHROMA) {             // colour fill → luma negative (grey), not blind black:
          var ci = psColourInk(lum);                 // white-on-colour labels stay readable
          d[i] = d[i + 1] = d[i + 2] = ci;
        } else {
          d[i] = d[i + 1] = d[i + 2] = 0;
        }
        d[i + 3] = 255;
      }
    }
    return { darkFrac: frac, inverted: invert };
  }

  /**
   * HQ map — supersample anti-aliased binarisation (SSAA).
   * `big` is an ImageData rendered at (outW*ss, outH*ss); each output pixel
   * area-averages its ss×ss block (ink coverage + max chroma), then maps:
   *   dark core  (avg luma ≤ 90−band)  → white paper   [black → white]
   *   any colour (max chroma > 60)      → solid black   [colours → black]
   *   edge band  (between)              → linear grey ramp (kills jaggies;
   *     drivers blue-noise/dither it at print time, viewers show it as AA)
   *   bright     (avg luma ≥ 90+band)   → solid black   [white → black]
   * auto=true: light pages (darkFrac<0.5) are downsampled untouched.
   * keepColour=true: coloured pixels keep their hue — lightness is flipped to
   *   a dark printable ink of the same colour instead of solid black.
   */
  var PS_BAND = 45;
  var PS_GAMMA = 1.7;   // ink-bias exponent of the edge ramp (>1 → fatter darks)
  function hqMap(big, outW, outH, auto, keepColour, pure) {
    var bd = big.data, bw = big.width, bh = big.height;
    var n = outW * outH;
    var sumL = new Uint16Array(n), cnt = new Uint8Array(n);
    var sumR = new Uint16Array(n), sumG = new Uint16Array(n), sumB = new Uint16Array(n);
    var maxC = new Uint8Array(n);
    for (var y = 0; y < bh; y++) {
      var oy = (y * outH / bh) | 0, row = y * bw;
      for (var x = 0; x < bw; x++) {
        var j = row + x, i = j * 4;
        var ox = (x * outW / bw) | 0;
        var k = oy * outW + ox;
        var r = bd[i], g = bd[i + 1], b = bd[i + 2];
        sumL[k] += (r * 299 + g * 587 + b * 114) / 1000 | 0;
        sumR[k] += r; sumG[k] += g; sumB[k] += b;
        var c = Math.max(r, g, b) - Math.min(r, g, b);
        if (c > maxC[k]) maxC[k] = c;
        cnt[k]++;
      }
    }
    var out = new Uint8ClampedArray(n * 4);
    var T = PS_DARK_LUM, B = PS_BAND, lo = T - B, hi = T + B;
    var Ls = new Float32Array(n);
    var dark = 0;
    for (var q = 0; q < n; q++) {
      var cQ = cnt[q] || 1;
      Ls[q] = sumL[q] / cQ;
      if (Ls[q] <= T) dark++;
    }
    var frac = dark / n;
    var invert = auto ? frac >= 0.5 : true;
    for (var p = 0; p < n; p++) {
      var cN = cnt[p] || 1, L = Ls[p];
      var o = p * 4;
      if (!invert) {                  // light page: plain area-average downsample, untouched colours
        out[o] = sumR[p] / cN; out[o + 1] = sumG[p] / cN; out[o + 2] = sumB[p] / cN; out[o + 3] = 255;
        continue;
      }
      var v;
      if (pure) {                                                  // PURE B&W: hard threshold at the ink midpoint —
        v = L <= T ? 255 : 0;                                      // only 0 or 255 ever leaves this branch; no edge
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;    // ramp, no grey fills, no gradients at all
        continue;
      }
      if (L <= lo) v = 255;                                       // dark pixel → white paper FIRST — even a
                                                                   // saturated dark theme bg (navy slide) is board,
                                                                   // not ink; chroma rule only applies to bright pixels
      else if (maxC[p] > PS_CHROMA) {                              // a real colour (bright/mid only)
        if (keepColour) {                                          // keep the hue, flip the lightness →
          var kc = psKeepColour(sumR[p] / cN, sumG[p] / cN, sumB[p] / cN, L);   // dark printable ink of the same colour
          out[o] = kc[0]; out[o + 1] = kc[1]; out[o + 2] = kc[2]; out[o + 3] = 255;
          continue;
        }
        v = psColourInk(L);                                        // bright colour ink → black; mid-luma colour
      }                                                            // FILLS → grey, so white-on-colour labels
                                                                   // (quiz badges, pills) survive as black-on-grey
      else if (L >= hi) v = 0;
      else {                                                       // ink-biased curve (halation compensation):
        var tt = (L - lo) / (hi - lo);                             // mid-coverage pixels skew toward ink so
        v = (Math.pow(1 - tt, PS_GAMMA) * 255) | 0;               // inverted handwriting keeps its visual weight
      }
      out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
    return { imageData: { data: out, width: outW, height: outH }, darkFrac: frac, inverted: invert };
  }

  /**
   * Negative map — true colour negative (255−c) with the same SSAA area-average
   * downsample as hqMap. Colours flip to their complements (blue↔orange…),
   * dark board → light paper, nothing is forced to black.
   * auto=true: light pages (darkFrac<0.5) are downsampled untouched.
   */
  function negMap(big, outW, outH, auto) {
    var bd = big.data, bw = big.width, bh = big.height;
    var n = outW * outH;
    var sumL = new Uint32Array(n), cnt = new Uint16Array(n);
    var sumR = new Uint32Array(n), sumG = new Uint32Array(n), sumB = new Uint32Array(n);
    for (var y = 0; y < bh; y++) {
      var oy = (y * outH / bh) | 0, row = y * bw;
      for (var x = 0; x < bw; x++) {
        var i = (row + x) * 4;
        var k = oy * outW + ((x * outW / bw) | 0);
        var r = bd[i], g = bd[i + 1], b = bd[i + 2];
        sumL[k] += (r * 299 + g * 587 + b * 114) / 1000 | 0;
        sumR[k] += r; sumG[k] += g; sumB[k] += b;
        cnt[k]++;
      }
    }
    var dark = 0;
    for (var q = 0; q < n; q++) if (sumL[q] / (cnt[q] || 1) <= PS_DARK_LUM) dark++;
    var frac = dark / n;
    var invert = auto ? frac >= 0.5 : true;
    var out = new Uint8ClampedArray(n * 4);
    for (var p = 0; p < n; p++) {
      var cN = cnt[p] || 1, o = p * 4;
      var r2 = sumR[p] / cN, g2 = sumG[p] / cN, b2 = sumB[p] / cN;
      if (invert) { r2 = 255 - r2; g2 = 255 - g2; b2 = 255 - b2; }
      out[o] = r2; out[o + 1] = g2; out[o + 2] = b2; out[o + 3] = 255;
    }
    return { imageData: { data: out, width: outW, height: outH }, darkFrac: frac, inverted: invert };
  }

  /** Shared sheet decoration (ruled lines + sheet number) for both build paths. */
  /**
   * Dotted cut-lines for a 2×2 sheet: a vertical one between the two columns and
   * a horizontal one between the two rows (through the row boundary / white band).
   * Returns [] unless perSheet === 4 and sepLine is on. Coordinates are in pt.
   */
  function sepLines(L, opts, page) {
    var out = [];
    if (opts.perSheet !== 4 || !opts.sepLine || opts.sepLine === 'off') return out;
    var inset = Math.max(6, opts.margin || 0);          // stay clear of the paper edge
    if (opts.sepLine === 'v' || opts.sepLine === 'both') {
      out.push({ x1: page.w / 2, y1: inset, x2: page.w / 2, y2: page.h - inset });
    }
    if (opts.sepLine === 'h' || opts.sepLine === 'both') {
      var y = (L && L.gap && L.gap.h > 0) ? L.gap.y + L.gap.h / 2 : ((L && L.gap) ? L.gap.y : page.h / 2);
      out.push({ x1: inset, y1: y, x2: page.w - inset, y2: y });
    }
    return out;
  }

  function decorateSheet(pg, L, opts, font, s, nSheets, page) {
    if (opts.lines) {
      for (var li = 0; li < L.lines.length; li++) {
        var y = L.lines[li];
        pg.drawLine({
          start: { x: L.gap.x + (L.lineInset || 10), y: y },
          end: { x: L.gap.x + L.gap.w - (L.lineInset || 10), y: y },
          thickness: 0.6,
          color: rgb(0.66, 0.7, 0.76)
        });
      }
    }
    var segs = sepLines(L, opts, page);
    for (var gi = 0; gi < segs.length; gi++) {          // black dotted cut-lines
      pg.drawLine({
        start: { x: segs[gi].x1, y: segs[gi].y1 },
        end:   { x: segs[gi].x2, y: segs[gi].y2 },
        thickness: 1.1,
        color: rgb(0, 0, 0),
        dashArray: [0.9, 3.2],
        dashPhase: 0,
        lineCap: LineCapStyle.Round
      });
    }
    if (opts.pageNumbers && (opts.numPos !== 'gap' || L.gap.h >= 12 || opts.perSheet === 2)) {
      var txt = numText(s, nSheets, opts);
      var size = opts.numSize;
      var tw = font.widthOfTextAtSize(txt, size);
      var p = numPlace(opts.numPos, L, page, tw, size, opts);
      pg.drawText(txt, { x: p.x, y: p.y, size: size, font: font, color: rgb(0.45, 0.48, 0.53) });
    }
  }

  /** Number label text for sheet index s (0-based). */
  function numText(s, nSheets, opts) {
    var n = opts.numStart + s;
    var last = opts.numStart + nSheets - 1;
    switch (opts.numFmt) {
      case 'plain': return '' + n;
      case 'page':  return 'Page ' + n;
      case 'dash':  return '\u2013 ' + n + ' \u2013';
      case 'of':    return n + ' of ' + last;
      default:      return n + ' / ' + last;   // frac
    }
  }

  /** Anchor a number label. Returns {x, y} (pdf-lib bottom-left text origin). */
  function numPlace(pos, L, page, tw, size, opts) {
    var M = Math.max(6, opts.margin || 0);        // breathing room from the sheet edge
    var xl = M + 4, xc = (page.w - tw) / 2, xr = page.w - M - 4 - tw;
    var yt = page.h - M - size, yb = M + 3;
    switch (pos) {
      case 'tl': return { x: xl, y: yt };
      case 'tc': return { x: xc, y: yt };
      case 'tr': return { x: xr, y: yt };
      case 'bl': return { x: xl, y: yb };
      case 'bc': return { x: xc, y: yb };
      case 'br': return { x: xr, y: yb };
      default:                                     // 'gap' — the classic middle band spot
        if (opts.lines && L.lines && L.lines.length) return { x: L.gap.x + 10, y: L.gap.y + L.gap.h - 12 };
        return { x: xc, y: L.gap.y + 3.5 };
    }
  }

  /**
   * Pack pre-rendered page images (Print-Saver output) using the SAME layout engine.
   * items: array in page order — { bytes: Uint8Array (PNG), w, h } or null (blank).
   */
  async function buildFromImages(items, options, onProgress) {
    var opts = normalize(options);
    var n = items.length;
    if (!n) throw new Error('Nothing to pack');
    var out = await PDFDocument.create();
    out.setProducer('Notes2A4 · slides-per-sheet packer · print-saver');
    var font = await out.embedFont(StandardFonts.Helvetica);
    var imgs = new Array(n).fill(null);
    for (var e = 0; e < n; e++) {
      if (items[e] && items[e].bytes) {
        try { imgs[e] = await out.embedPng(items[e].bytes); } catch (err) { imgs[e] = null; }
      }
      if (onProgress && e % 8 === 7) await onProgress(e + 1, n, 'encoding');
    }
    var page = sheetSize(opts);
    var per = opts.perSheet;
    var nSheets = Math.ceil(n / per);
    for (var s = 0; s < nSheets; s++) {
      var cellSizes = [];
      for (var c = 0; c < per; c++) {
        var gi = s * per + c;
        cellSizes.push(gi < n && items[gi] ? { w: items[gi].w, h: items[gi].h } : null);
      }
      var L = (per === 4) ? quadLayout(cellSizes, opts, page) : sheetLayout(cellSizes[0], cellSizes[1], opts, page);
      var boxes = (per === 4) ? L.slides : [L.top, L.bottom];
      var pg = out.addPage([page.w, page.h]);
      for (var c2 = 0; c2 < boxes.length; c2++) {
        var idx = s * per + c2;
        if (imgs[idx] && boxes[c2]) {
          pg.drawImage(imgs[idx], { x: boxes[c2].x, y: boxes[c2].y, width: boxes[c2].width, height: boxes[c2].height });
        }
      }
      decorateSheet(pg, L, opts, font, s, nSheets, page);
      if (onProgress && (s % 4 === 3 || s === nSheets - 1)) await onProgress(s + 1, nSheets, 'packing');
    }
    var saved = await out.save({ useObjectStreams: true });
    return { bytes: saved, sheets: nSheets, sourcePages: n, pageWH: { w: page.w, h: page.h }, printSaver: true };
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
    build: build,
    buildFromImages: buildFromImages,
    numText: numText,
    numPlace: numPlace,
    sepLines: sepLines,
    printSaver: { process: psProcess, hqMap: hqMap, negMap: negMap, keepColour: psKeepColour, DARK_LUM: PS_DARK_LUM, BAND: PS_BAND, GAMMA: PS_GAMMA, CHROMA: PS_CHROMA }
  };
});
