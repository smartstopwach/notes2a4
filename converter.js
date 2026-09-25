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
      lineStyle: 'solid',   // line styles: solid|dashed|dotted|grid|dots — page types: margin|graph|staff|columns|cornell
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
    if (['solid','dashed','dotted','grid','dots','margin','graph','staff','columns','cornell'].indexOf(o.lineStyle) < 0) o.lineStyle = 'solid';
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
    lines.step = step;   // realised step — grid & dot styles square off from it
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
   * auto=true: light pages (darkFrac<0.5) are downsampled untouched — unless
   *   white=true, see below.
   * keepColour=true: coloured pixels keep their hue — lightness is flipped to
   *   a dark printable ink of the same colour instead of solid black.
   * white=true ("White paper"): paper must stay paper. On a light page white is
   *   left white and everything that is not white becomes solid black ink (colour
   *   or grey — the ink ramp only softens the edges). A dark page is untouched by
   *   this flag: white marks on a dark board are flipped exactly like Black ink,
   *   so a dark board still prints as black-on-white. This is the mode for pages
   *   that are already white: Black ink / Pure B&W pass those through untouched,
   *   so choosing them changes nothing on such a page.
   */
  var PS_BAND = 45;
  /* White-paper mode: the paper/content split of a page that is already white
     (its paper is bright, unlike a blackboard's) */
  var PS_WHITE_HI = 200;   // ≥ this is paper: handed back exactly as it came in
  var PS_WHITE_LO = 90;    // ≤ this is solid content: solid ink
  /* A dark *area* inside a light page is a board (a blackboard panel, a dark
     slide): it must print as ink on paper, exactly like Black ink does for a dark
     page. The area is found in blocks (darkFrac ≥ PS_BOARD_FRAC), then eroded
     (a block survives only if it is dark all around) and grown back one block —
     that keeps small dark marks, thick strokes, headings and the corner
     registration squares under the ordinary White-paper rule. */
  var PS_BOARD_FINE = 8;    // fine blocks: where the board's own edge is (≈1.4 mm at 150 dpi)
  var PS_BOARD_COARSE = 24; // coarse cells: how big a dark area must be to count as a board
  var PS_BOARD_SEED = 0.7;  // a cell this dark, surrounded by dark cells, is a board seed
  var PS_BOARD_GROW = 0.5;  // a cell this dark joins the board next to it
  var PS_BOARD_EDGE = 0.3;  // …and this dark may JOIN a board next to it (its own edge)
  var PS_GAMMA = 1.7;   // ink-bias exponent of the edge ramp (>1 → fatter darks)
  /* ------------------------------------------------------------------------
     The two maps below are long-running pixel work. They are built out of three
     pieces so that a browser can drive them a band at a time and hand control
     back to the UI between bands: hqAcc (buffers) → hqFeed (accumulate one set
     of input rows) → hqFinishA/hqFinishB (measure, then write output rows).
     The one-shot hqMap() is the very same code with everything in one go, and
     the tests compare the two byte for byte.

     Nothing about the maths may change here: band boundaries only decide WHEN a
     row is processed, never HOW — oy/ox are pure functions of the row/column
     index, so an output pixel accumulates the same samples in the same order.
     ------------------------------------------------------------------------ */
  function hqAcc(outW, outH) {
    var n = outW * outH;
    return {
      outW: outW, outH: outH, n: n,
      sumL: new Uint16Array(n), cnt: new Uint8Array(n),
      sumR: new Uint16Array(n), sumG: new Uint16Array(n), sumB: new Uint16Array(n),
      maxC: new Uint8Array(n)
    };
  }
  /* rows y0 … y1 of the supersampled image (row stride bw, total height bh) */
  function hqFeed(acc, px, bw, y0, y1, bh) {
    var bd = px, outW = acc.outW, outH = acc.outH;
    var sumL = acc.sumL, sumR = acc.sumR, sumG = acc.sumG, sumB = acc.sumB, maxC = acc.maxC, cnt = acc.cnt;
    for (var y = y0; y < y1; y++) {
      var oy = (y * outH / bh) | 0, row = (y - y0) * bw;
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
  }
  /* pass 1 of the finish: per-pixel luma + the count of dark pixels */
  function hqFinishA(acc, r0, r1, st) {
    var outW = acc.outW, cnt = acc.cnt, sumL = acc.sumL, Ls = st.Ls, T = PS_DARK_LUM;
    for (var r = r0; r < r1; r++) {
      var base = r * outW;
      for (var x = 0; x < outW; x++) {
        var q = base + x;
        Ls[q] = sumL[q] / (cnt[q] || 1);
        if (Ls[q] <= T) st.dark++;
      }
    }
  }
  /* One pass over the finished luma image, after hqFinishA and before hqFinishB:
     which blocks of a light page are a dark area (a board) and must be flipped?
     It reads only st.Ls, so the answer never depends on band boundaries. */
  function hqBoardMask(acc, st) {
    var outW = acc.outW, outH = acc.outH, Ls = st.Ls, T = PS_DARK_LUM;
    var F = PS_BOARD_FINE, C = PS_BOARD_COARSE, i, j;
    var fw = Math.ceil(outW / F), fh = Math.ceil(outH / F);
    var cw = Math.ceil(outW / C), ch = Math.ceil(outH / C);
    /* fine blocks: is this little square mostly ink? */
    var fine = new Float32Array(fw * fh);
    for (var fy = 0; fy < fh; fy++) {
      for (var fx = 0; fx < fw; fx++) {
        var dark = 0, n = 0, y1 = Math.min(outH, fy * F + F), x1 = Math.min(outW, fx * F + F);
        for (var y = fy * F; y < y1; y++) {
          var base = y * outW;
          for (var x = fx * F; x < x1; x++) { n++; if (Ls[base + x] <= T) dark++; }
        }
        fine[fy * fw + fx] = n ? dark / n : 0;
      }
    }
    /* coarse cells: the same question, asked big enough to separate "a panel" from
       "a heading": a dark area has to be ~3 cells thick in every direction before
       it is called a board, so a filled bar or a bold heading is never one */
    var coarse = new Float32Array(cw * ch);
    for (var cy = 0; cy < ch; cy++) {
      for (var cx = 0; cx < cw; cx++) {
        var d2 = 0, n2 = 0, y2 = Math.min(outH, cy * C + C), x2 = Math.min(outW, cx * C + C);
        for (var yy = cy * C; yy < y2; yy++) {
          var b2 = yy * outW;
          for (var xx = cx * C; xx < x2; xx++) { n2++; if (Ls[b2 + xx] <= T) d2++; }
        }
        coarse[cy * cw + cx] = n2 ? d2 / n2 : 0;
      }
    }
    var on = new Uint8Array(cw * ch), queue = [];
    for (var sy = 0; sy < ch; sy++) {
      for (var sx = 0; sx < cw; sx++) {
        if (coarse[sy * cw + sx] < PS_BOARD_SEED) continue;
        var nb = 0;
        for (j = -1; j <= 1; j++) {
          for (i = -1; i <= 1; i++) {
            if (!i && !j) continue;
            var ny = sy + j, nx = sx + i;
            if (ny < 0 || nx < 0 || ny >= ch || nx >= cw) continue;
            if (coarse[ny * cw + nx] >= PS_BOARD_SEED) nb++;
          }
        }
        if (nb >= 5) { on[sy * cw + sx] = 1; queue.push(sy * cw + sx); }
      }
    }
    /* Back to the fine grid. The coarse cells only decided WHERE a board can be;
       the shape itself is then filled at the fine level, walking through blocks
       that are at least partly ink and stopping the moment paper is reached. A dark
       bar a few millimetres below the board is NOT reached by this walk (there is
       paper in between), while the board's own edge — cut through by a white stroke
       or fading out at the panel boundary — is. */
    st.boardW = fw;
    st.board = new Uint8Array(fw * fh);
    var queue2 = [];
    for (var b0 = 0; b0 < fw * fh; b0++) {
      var cx0 = ((b0 % fw) * F / C) | 0, cy0 = (((b0 / fw) | 0) * F / C) | 0;
      if (on[cy0 * cw + cx0] && fine[b0] >= PS_BOARD_EDGE) { st.board[b0] = 1; queue2.push(b0); }
    }
    while (queue2.length) {
      var b1 = queue2.pop(), bx1 = b1 % fw, by1 = (b1 / fw) | 0;
      for (j = -1; j <= 1; j++) {
        for (i = -1; i <= 1; i++) {
          if (!i && !j) continue;
          var nx1 = bx1 + i, ny1 = by1 + j;
          if (nx1 < 0 || ny1 < 0 || nx1 >= fw || ny1 >= fh) continue;
          var b2 = ny1 * fw + nx1;
          if (st.board[b2] || fine[b2] < PS_BOARD_EDGE) continue;
          st.board[b2] = 1; queue2.push(b2);
        }
      }
    }
    /* close single-block gaps, so no paper pixel is left inside the board */
    var grown = st.board.slice();
    for (var dy = 0; dy < fh; dy++) {
      for (var dx = 0; dx < fw; dx++) {
        if (st.board[dy * fw + dx] || fine[dy * fw + dx] < PS_BOARD_EDGE) continue;
        if ((dy > 0 && st.board[(dy - 1) * fw + dx]) || (dy < fh - 1 && st.board[(dy + 1) * fw + dx]) ||
            (dx > 0 && st.board[dy * fw + dx - 1]) || (dx < fw - 1 && st.board[dy * fw + dx + 1])) {
          grown[dy * fw + dx] = 1;
        }
      }
    }
    st.board = grown;
  }

  /* is this pixel inside a board block? */
  function hqBoardAt(st, p, outW) {
    if (!st.board) return 0;
    var BLK = PS_BOARD_FINE;
    var gx = ((p % outW) / BLK) | 0, gy = ((p / outW) | 0) / BLK | 0;
    return st.board[gy * st.boardW + gx];
  }

  /* pass 2 of the finish: write the output pixels for rows r0 … r1 */
  function hqFinishB(acc, r0, r1, st, out, keepColour, pure, white) {
    var outW = acc.outW, cnt = acc.cnt, Ls = st.Ls, maxC = acc.maxC;
    var sumR = acc.sumR, sumG = acc.sumG, sumB = acc.sumB;
    var T = PS_DARK_LUM, B = PS_BAND, lo = T - B, hi = T + B, invert = st.invert;
    for (var p = r0 * outW, e = r1 * outW; p < e; p++) {
      var cN = cnt[p] || 1, L = Ls[p];
      var o = p * 4;
      if (!invert) {                  // light page
        if (white && hqBoardAt(st, p, outW)) {
          /* A BOARD inside the page (a blackboard panel, a dark slide): flip it the
             way Black ink flips a whole dark page — the board becomes paper and the
             marks on it become black ink. That is what the tool the user compared
             against does, and it is the only way a white-marker sketch survives:
             paper stays white, but ink still has to come out as ink. */
          if (L <= lo) v = 255;
          else if (maxC[p] > PS_CHROMA) v = 0;
          else if (L >= hi) v = 0;
          else { var tb = (L - lo) / (hi - lo); v = (Math.pow(1 - tb, PS_GAMMA) * 255) | 0; }
          out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
          continue;
        }
        if (white) {                  // WHITE PAPER: paper stays paper, everything else is ink
          /* The band is measured for a WHITE page, not a black board: paper on a
             scan or a JPEG sits around 230–255, so everything from ~200 up is
             left exactly as it came in (a light grey shaded box counts as paper),
             while anything clearly darker is content and becomes ink. The ramp in
             between keeps the edge ink-biased (fatter darks), so handwriting and
             thin strokes never thin out. */
          if (maxC[p] > PS_CHROMA) v = 0;                    // a colour is content → solid black
          else if (L >= PS_WHITE_HI) v = 255;                // paper stays paper — untouched
          else if (L <= PS_WHITE_LO) v = 0;                  // solid content → solid ink
          else {
            var aw = (L - PS_WHITE_LO) / (PS_WHITE_HI - PS_WHITE_LO);
            v = (Math.pow(aw, PS_GAMMA) * 255) | 0;          // paper-ness of an edge pixel
          }
          out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
          continue;
        }
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
  }
  function hqSt(acc) { return { Ls: new Float32Array(acc.n), dark: 0, invert: true }; }
  function hqResult(acc, st) {
    return { imageData: { data: acc.out, width: acc.outW, height: acc.outH }, darkFrac: st.dark / acc.n, inverted: st.invert };
  }
  function hqMap(big, outW, outH, auto, keepColour, pure, white) {
    var bd = big.data, bw = big.width, bh = big.height;
    var acc = hqAcc(outW, outH);
    hqFeed(acc, bd, bw, 0, bh, bh);
    var st = hqSt(acc);
    hqFinishA(acc, 0, acc.outH, st);
    st.invert = auto ? st.dark / acc.n >= 0.5 : true;
    if (white && !st.invert) hqBoardMask(acc, st);       // dark areas of a light page
    hqFinishB(acc, 0, acc.outH, st, acc.out = new Uint8ClampedArray(acc.n * 4), keepColour, pure, white);
    return hqResult(acc, st);
  }
  /**
   * Same map, driven in bands: `provider(y0, rows)` returns the pixels of those
   * rows (a canvas getImageData() slice in the browser, a subarray in tests),
   * and `hooks.progress(fraction, phase)` is awaited between bands — that await
   * is what keeps the tab interactive during a 33-page print-saver run.
   */
  async function hqMapAsync(provider, bw, bh, outW, outH, auto, keepColour, pure, hooks, white) {
    var acc = hqAcc(outW, outH);
    var band = (hooks && hooks.band) || 256;
    var step = hooks && hooks.progress ? hooks.progress : null;
    for (var y = 0; y < bh; y += band) {
      var y1 = Math.min(bh, y + band);
      var px = provider(y, y1 - y);
      if (px && typeof px.then === 'function') px = await px;      // a strip renderer is async
      hqFeed(acc, px.data, bw, y, y1, bh);
      if (step) await step((y1 / bh) * 0.55, 'downsample');
    }
    var st = hqSt(acc);
    for (var r = 0; r < outH; r += band) {
      var r1 = Math.min(outH, r + band);
      hqFinishA(acc, r, r1, st);
      if (step) await step(0.55 + (r1 / outH) * 0.15, 'measure');
    }
    st.invert = auto ? st.dark / acc.n >= 0.5 : true;
    if (white && !st.invert) hqBoardMask(acc, st);       // dark areas of a light page
    acc.out = new Uint8ClampedArray(acc.n * 4);
    for (var r2 = 0; r2 < outH; r2 += band) {
      var r3 = Math.min(outH, r2 + band);
      hqFinishB(acc, r2, r3, st, acc.out, keepColour, pure, white);
      if (step) await step(0.7 + (r3 / outH) * 0.3, 'render');
    }
    return hqResult(acc, st);
  }

  /**
   * Negative map — true colour negative (255−c) with the same SSAA area-average
   * downsample as hqMap. Colours flip to their complements (blue↔orange…),
   * dark board → light paper, nothing is forced to black.
   * auto=true: light pages (darkFrac<0.5) are downsampled untouched.
   */
  function negAcc(outW, outH) {
    var n = outW * outH;
    return {
      outW: outW, outH: outH, n: n,
      sumL: new Uint32Array(n), cnt: new Uint16Array(n),
      sumR: new Uint32Array(n), sumG: new Uint32Array(n), sumB: new Uint32Array(n)
    };
  }
  function negFeed(acc, px, bw, y0, y1, bh) {
    var bd = px, outW = acc.outW, outH = acc.outH;
    var sumL = acc.sumL, sumR = acc.sumR, sumG = acc.sumG, sumB = acc.sumB, cnt = acc.cnt;
    for (var y = y0; y < y1; y++) {
      var oy = (y * outH / bh) | 0, row = (y - y0) * bw;
      for (var x = 0; x < bw; x++) {
        var i = (row + x) * 4;
        var k = oy * outW + ((x * outW / bw) | 0);
        var r = bd[i], g = bd[i + 1], b = bd[i + 2];
        sumL[k] += (r * 299 + g * 587 + b * 114) / 1000 | 0;
        sumR[k] += r; sumG[k] += g; sumB[k] += b;
        cnt[k]++;
      }
    }
  }
  function negFinishA(acc, r0, r1, st) {
    var outW = acc.outW, cnt = acc.cnt, sumL = acc.sumL, T = PS_DARK_LUM;
    for (var p = r0 * outW, e = r1 * outW; p < e; p++) if (sumL[p] / (cnt[p] || 1) <= T) st.dark++;
  }
  function negFinishB(acc, r0, r1, st, out) {
    var outW = acc.outW, cnt = acc.cnt, sumR = acc.sumR, sumG = acc.sumG, sumB = acc.sumB;
    for (var p = r0 * outW, e = r1 * outW; p < e; p++) {
      var cN = cnt[p] || 1, o = p * 4;
      var r2 = sumR[p] / cN, g2 = sumG[p] / cN, b2 = sumB[p] / cN;
      if (st.invert) { r2 = 255 - r2; g2 = 255 - g2; b2 = 255 - b2; }
      out[o] = r2; out[o + 1] = g2; out[o + 2] = b2; out[o + 3] = 255;
    }
  }
  function negMap(big, outW, outH, auto) {
    var acc = negAcc(outW, outH);
    negFeed(acc, big.data, big.width, 0, big.height, big.height);
    var st = { dark: 0, invert: true };
    negFinishA(acc, 0, acc.outH, st);
    st.invert = auto ? st.dark / acc.n >= 0.5 : true;
    negFinishB(acc, 0, acc.outH, st, acc.out = new Uint8ClampedArray(acc.n * 4));
    return { imageData: { data: acc.out, width: outW, height: outH }, darkFrac: st.dark / acc.n, inverted: st.invert };
  }
  /** Banded twin of negMap — same pixels, but the tab stays alive. */
  async function negMapAsync(provider, bw, bh, outW, outH, auto, hooks) {
    var acc = negAcc(outW, outH);
    var band = (hooks && hooks.band) || 256;
    var step = hooks && hooks.progress ? hooks.progress : null;
    for (var y = 0; y < bh; y += band) {
      var y1 = Math.min(bh, y + band);
      var px = provider(y, y1 - y);
      if (px && typeof px.then === 'function') px = await px;      // a strip renderer is async
      negFeed(acc, px.data, bw, y, y1, bh);
      if (step) await step((y1 / bh) * 0.55, 'downsample');
    }
    var st = { dark: 0, invert: true };
    for (var r = 0; r < outH; r += band) {
      var r1 = Math.min(outH, r + band);
      negFinishA(acc, r, r1, st);
      if (step) await step(0.55 + (r1 / outH) * 0.15, 'measure');
    }
    st.invert = auto ? st.dark / acc.n >= 0.5 : true;
    acc.out = new Uint8ClampedArray(acc.n * 4);
    for (var r2 = 0; r2 < outH; r2 += band) {
      var r3 = Math.min(outH, r2 + band);
      negFinishB(acc, r2, r3, st, acc.out);
      if (step) await step(0.7 + (r3 / outH) * 0.3, 'render');
    }
    return { imageData: { data: acc.out, width: outW, height: outH }, darkFrac: st.dark / acc.n, inverted: st.invert };
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
      var sty = opts.lineStyle || 'solid';
      var x0 = L.gap.x + (L.lineInset || 10), x1 = L.gap.x + L.gap.w - (L.lineInset || 10);
      var step = L.lines.step || opts.lineSpacing;
      var gy0 = L.gap.y + 7, gy1 = L.gap.y + L.gap.h - 7;
      var col = (sty === 'grid' || sty === 'dots' || sty === 'graph') ? rgb(0.74, 0.78, 0.84) : rgb(0.66, 0.7, 0.76);
      var vcol = rgb(0.74, 0.78, 0.84), vheavy = rgb(0.58, 0.63, 0.71);
      if (sty !== 'columns' && sty !== 'staff') {
        for (var li = 0; li < L.lines.length; li++) {
          var y = L.lines[li];
          var ln = { start: { x: x0, y: y }, end: { x: x1, y: y }, thickness: 0.6, color: col };
          if (sty === 'dashed') { ln.thickness = 0.7; ln.dashArray = [6, 4]; }
          else if (sty === 'dotted') { ln.thickness = 1.5; ln.lineCapStyle = 1; ln.dashArray = [0.1, 4.5]; }
          else if (sty === 'grid' || sty === 'graph') { ln.thickness = 0.45; }
          else if (sty === 'dots') { ln.thickness = 1.5; ln.lineCapStyle = 1; ln.dashArray = [0.1, step]; ln.dashPhase = step / 2; }
          if (sty === 'graph' && li % 5 === 0) { ln.thickness = 0.9; ln.color = vheavy; }
          pg.drawLine(ln);
        }
      }
      if ((sty === 'grid' || sty === 'graph' || sty === 'columns') && L.lines.length) {  // verticals at the realised step
        var vj = 1;
        for (var vx = x0 + step; vx < x1 - step / 2; vx += step, vj++) {
          var heavy = (sty === 'graph' && vj % 5 === 0);
          pg.drawLine({ start: { x: vx, y: gy0 }, end: { x: vx, y: gy1 },
            thickness: (sty === 'columns') ? 0.6 : (heavy ? 0.9 : 0.45),
            color: (sty === 'columns') ? rgb(0.66, 0.7, 0.76) : (heavy ? vheavy : vcol) });
        }
      }
      if (sty === 'margin' && L.lines.length) {                       // school-pad margin rule
        var mx = x0 + 0.16 * (x1 - x0);
        pg.drawLine({ start: { x: mx, y: L.gap.y + 4 }, end: { x: mx, y: L.gap.y + L.gap.h - 4 }, thickness: 0.9, color: rgb(0.78, 0.42, 0.46) });
      }
      if (sty === 'cornell' && L.lines.length) {                      // cue column + summary rule
        var cxx = x0 + 0.3 * (x1 - x0), sy = L.gap.y + 0.24 * L.gap.h;
        pg.drawLine({ start: { x: cxx, y: sy }, end: { x: cxx, y: gy1 }, thickness: 0.85, color: vheavy });
        pg.drawLine({ start: { x: x0, y: sy }, end: { x: x1, y: sy }, thickness: 0.85, color: vheavy });
      }
      if (sty === 'staff') {                                          // five-line music staves
        var p = step / 4.5;
        for (var si = 0; si < L.lines.length; si++) {
          for (var k = 0; k < 5; k++) {
            pg.drawLine({ start: { x: x0, y: L.lines[si] - k * p }, end: { x: x1, y: L.lines[si] - k * p }, thickness: 0.5, color: rgb(0.62, 0.66, 0.73) });
          }
        }
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
   * Vector true-negative — a per-channel 255 − c inversion that never rasterises.
   * Each page keeps its original content (text stays text, selectable, sharp) and
   * gets one full-page white rectangle drawn on top with blend mode /Difference,
   * which renders as |white − backdrop| = 255 − c for every pixel. That is exactly
   * what the dedicated colour-inversion tools do, so the output matches them
   * pixel for pixel while the file stays small and instant.
   *
   * Returns { bytes, pages, size } — the first page's MediaBox is reported so the
   * caller can show what was processed.
   */
  async function vectorNegative(bytes) {
    var doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    var pages = doc.getPages();
    if (!pages.length) throw new Error('This PDF has no pages');
    var BlendMode = PDFLib.BlendMode;
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      var box = pg.getMediaBox ? pg.getMediaBox() : { x: 0, y: 0, width: pg.getWidth(), height: pg.getHeight() };
      pg.drawRectangle({
        x: box.x, y: box.y, width: box.width, height: box.height,
        color: rgb(1, 1, 1),
        blendMode: BlendMode ? BlendMode.Difference : undefined
      });
    }
    var saved = await doc.save({ useObjectStreams: true });
    var first = pages[0].getMediaBox ? pages[0].getMediaBox() : { width: pages[0].getWidth(), height: pages[0].getHeight() };
    return { bytes: saved, pages: pages.length, size: { w: first.width, h: first.height } };
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
        items[e].bytes = null;                 // the page image is inside the PDF now — let it go
      }
      if (onProgress && (e % 4 === 3 || e === n - 1)) await onProgress(e + 1, n, 'encoding');
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
    /* pdf-lib writes the whole file in one synchronous pass, so give the UI one
       last frame before it starts — the bar can then say "writing the file…". */
    if (onProgress) await onProgress(nSheets, nSheets, 'writing');
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
    vectorNegative: vectorNegative,
    sepLines: sepLines,
    /* `pieces` is the raw map machinery, so worker-raster.js can run the
       identically-mathed map off-thread (and the tests can prove the two agree) */
    printSaver: {
      process: psProcess, hqMap: hqMap, hqMapAsync: hqMapAsync, negMap: negMap, negMapAsync: negMapAsync,
      keepColour: psKeepColour, DARK_LUM: PS_DARK_LUM, BAND: PS_BAND, GAMMA: PS_GAMMA, CHROMA: PS_CHROMA,
      WHITE_HI: PS_WHITE_HI, WHITE_LO: PS_WHITE_LO,
      BOARD_FINE: PS_BOARD_FINE, BOARD_COARSE: PS_BOARD_COARSE, BOARD_SEED: PS_BOARD_SEED, BOARD_GROW: PS_BOARD_GROW,
      pieces: {
        hqAcc: hqAcc, hqFeed: hqFeed, hqFinishA: hqFinishA, hqFinishB: hqFinishB, hqSt: hqSt,
        hqBoardMask: hqBoardMask,
        negAcc: negAcc, negFeed: negFeed, negFinishA: negFinishA, negFinishB: negFinishB
      }
    }
  };
});
