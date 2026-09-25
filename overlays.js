/*!
 * Notes2A4 — page overlays for 1:1 tools (Invert Lab).
 * UMD module: runs in the browser (global `InvertOverlays`, uses pdf-lib UMD)
 * and in Node (require('pdf-lib')) for tests.
 *
 * Three vector-sharp finishing touches, drawn on top of each finished page:
 *   · ruled lines — full-page faint ruling (10 styles, same look as the
 *     packer's gap ruling) for writing over the printout
 *   · dotted separator — black dotted cut/fold guide through the page middle
 *   · sheet numbers — "3 / 20" style labels, 6 positions × 5 styles
 *
 * Everything is OFF by default: existing 1:1 outputs are byte-identical
 * unless the user enables an overlay.
 *
 *   drawPage(pg, opts, info) → { lines, seps, nums } (counts drawn)
 *   opts = { lines:false|style, lineStep, sep:'off'|v|h|both,
 *            nums:false|true, numPos, numFmt, numStart, numSize }
 *   info = { i:0-based page idx, n:total pages, w,h:page size pt, font|null }
 * Coordinates are pdf-lib bottom-left points throughout.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pdf-lib'));
  } else {
    root.InvertOverlays = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  var rgb = PDFLib.rgb;
  var Round = PDFLib.LineCapStyle ? PDFLib.LineCapStyle.Round : 1;

  var LINE_STYLES = ['solid', 'dashed', 'dotted', 'grid', 'dots', 'margin', 'graph', 'staff', 'columns', 'cornell'];
  var NUM_POS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
  var NUM_FMT = ['frac', 'plain', 'page', 'dash', 'of'];
  var NUM_SIZES = { s: 6.5, m: 8, l: 11 };   // same three sizes as the packer

  function normOpts(o) {
    o = o || {};
    return {
      lines: (o.lines && LINE_STYLES.indexOf(o.lines) >= 0) ? o.lines : false,
      lineStep: Math.max(8, Math.min(72, +o.lineStep || 25.5)),   // 9 mm school ruling
      lineMargin: Math.max(0, Math.min(140, +o.lineMargin || 36)),
      sep: (o.sep === 'v' || o.sep === 'h' || o.sep === 'both') ? o.sep : 'off',
      nums: !!o.nums,
      numPos: NUM_POS.indexOf(o.numPos) >= 0 ? o.numPos : 'bc',
      numFmt: NUM_FMT.indexOf(o.numFmt) >= 0 ? o.numFmt : 'frac',
      numStart: Math.max(0, Math.min(99999, Math.round(+o.numStart) || 1)),
      numSize: Math.max(6, Math.min(14, +o.numSize || 8))
    };
  }

  /** Number label text for page index s (0-based) of n pages. */
  function numText(s, n, o) {
    var first = o.numStart, last = o.numStart + n - 1, cur = o.numStart + s;
    switch (o.numFmt) {
      case 'plain': return '' + cur;
      case 'page':  return 'Page ' + cur;
      case 'dash':  return '\u2013 ' + cur + ' \u2013';
      case 'of':    return cur + ' of ' + last;
      default:      return cur + ' / ' + last;   // frac
    }
  }

  /** Anchor a number label. Returns {x, y} (pdf-lib bottom-left text origin). */
  function numPlace(pos, w, h, tw, size, M) {
    M = Math.max(6, +M || 24);
    var xl = M + 4, xc = (w - tw) / 2, xr = w - M - 4 - tw;
    var yt = h - M - size, yb = M + 3;
    switch (pos) {
      case 'tl': return { x: xl, y: yt };
      case 'tc': return { x: xc, y: yt };
      case 'tr': return { x: xr, y: yt };
      case 'bl': return { x: xl, y: yb };
      case 'bc': return { x: xc, y: yb };
      default:   return { x: xr, y: yb };   // 'br'
    }
  }

  /** Horizontal rule rows for a full page: {x0, x1, ys, gy0, gy1}. */
  function ruleRows(w, h, step, mg) {
    return ruleRowsBand(w, h, step, mg, null);
  }

  /**
   * Rule rows, optionally confined to a packer white band (pdf-lib
   * bottom-left pt). band = {axis:'h', y0, y1} (packer middle-band rows) or
   * {axis:'v', x0, x1} (vertical band). A band too narrow to hold a
   * single row yields no rows (never a crash, never a stray line).
   */
  function ruleRowsBand(w, h, step, mg, band) {
    var x0 = mg, x1 = w - mg, top = h - mg, bot = mg;
    if (band && band.axis === 'h' && isFinite(band.y0) && isFinite(band.y1)) {
      top = Math.min(band.y1, h - 4);
      bot = Math.max(band.y0, 4);
    } else if (band && band.axis === 'v' && isFinite(band.x0) && isFinite(band.x1)) {
      x0 = Math.max(band.x0 + 10, 4);
      x1 = Math.min(band.x1 - 10, w - 4);
    }
    var ys = [];
    if (x1 - x0 >= 20) {
      for (var y = top; y >= bot - 0.01; y -= step) ys.push(y);
    }
    return { x0: x0, x1: x1, ys: ys, gy0: bot, gy1: top };
  }

  /** Dotted cut/fold guides through the page middle: [{x1,y1,x2,y2}]. */
  function sepLines(w, h, mode) {
    var out = [];
    if (mode !== 'v' && mode !== 'h' && mode !== 'both') return out;
    var inset = 8;
    if (mode === 'v' || mode === 'both') out.push({ x1: w / 2, y1: inset, x2: w / 2, y2: h - inset });
    if (mode === 'h' || mode === 'both') out.push({ x1: inset, y1: h / 2, x2: w - inset, y2: h / 2 });
    return out;
  }

  /**
   * Draw all enabled overlays onto one pdf-lib page. Returns counts drawn.
   * The page keeps its size; overlays sit on top of whatever is there.
   */
  /* ============ packer white-band detection (2-up / 4-up keep) ============
     Both packers leave a wide, near-empty HORIZONTAL white strip in the
     middle of each sheet (2-up: the gap between the slides; 4-up: the band
     between the rows, shared by both columns — see quadLayout). findBand
     locates that strip on a low-res top-left RGBA render so Invert Lab can
     leave it white while the slides around it flip. Safety invariant: only
     ~white rows/cols are ever reported, so keeping a band can never destroy
     real content. Tolerates packer ruling (grey full-span lines), dotted
     separators and gap sheet numbers by merging small non-white gaps. */

  var BAND_WHITE = 240;        // a channel >= this counts as white
  var BAND_FRAC = 0.90;        // a row/col qualifies when >= this fraction is white
  var BAND_AVG = 0.97;         // qualifying rows/cols must average >= this white
  var BAND_NONBAND_MAX = 0.30; // merged non-white gap rows/cols inside the band must stay below this
  var BAND_FLANK_DARK = 0.08;  // a flank line counts as content when >= this fraction is non-white

  /**
   * img: {data: Uint8ClampedArray|Array, w|width, h|height} top-left RGBA.
   * axis: 'h' = full-width white rows (the packer middle band), 'v' =
   * full-height white cols (symmetric support; no current packer emits one).
   * scale: render scale in px per pt (min sizes derive).
   * A run only counts when slide content flanks it on BOTH sides — that is
   * what rejects blank pages and fixed-gap top/bottom padding (white on one
   * side only). Nearest-to-centre wins, so a small centred band beats a long
   * off-centre white stretch. Returns {axis, a0, a1} px, end-exclusive, or null.
   */
  function findBand(img, axis, scale) {
    var W = img.w || img.width, H = img.h || img.height, d = img.data;
    if (!W || !H || !d || !d.length) return null;
    scale = scale || 1;
    var minLen = Math.max(4, Math.round(12 * scale));   // bands under ~12pt are noise
    var mergeGap = Math.max(1, Math.round(4 * scale));  // ruling / dots / numbers bridge
    var n = axis === 'v' ? W : H;                      // scan lines across the strip direction
    var span = axis === 'v' ? H : W;                   // pixels inside one scan line
    if (n < 8 || span < 8) return null;
    var lo = Math.floor(n * 0.2), hi = Math.ceil(n * 0.8);  // bands live in the middle 60%

    function whiteFrac(i) {
      var white = 0;
      if (axis === 'v') {
        for (var y = 0; y < H; y++) {
          var o = (y * W + i) * 4;
          if (d[o] >= BAND_WHITE && d[o + 1] >= BAND_WHITE && d[o + 2] >= BAND_WHITE) white++;
        }
      } else {
        var row = i * W * 4;
        for (var x = 0; x < W; x++) {
          var p = row + x * 4;
          if (d[p] >= BAND_WHITE && d[p + 1] >= BAND_WHITE && d[p + 2] >= BAND_WHITE) white++;
        }
      }
      return white / span;
    }

    // qualifying runs in the middle window, merged across small gaps
    var runs = [], cur = null;
    for (var i = lo; i < hi; i++) {
      var q = whiteFrac(i);
      if (q >= BAND_FRAC) {
        if (!cur) cur = { a0: i, sum: 0, cnt: 0 };
        cur.sum += q; cur.cnt++;
      } else if (cur) {
        cur.a1 = i; runs.push(cur); cur = null;
      }
    }
    if (cur) { cur.a1 = hi; runs.push(cur); }
    if (!runs.length) return null;
    var merged = [];
    runs.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r.a0 - last.a1 <= mergeGap) {
        last.a1 = r.a1; last.sum += r.sum; last.cnt += r.cnt;
      } else merged.push({ a0: r.a0, a1: r.a1, sum: r.sum, cnt: r.cnt });
    });
    // a band sits BETWEEN slides: content must show on both flanks (this is
    // what rejects blank pages and fixed-gap padding, white on one side only)
    var flank = Math.max(8, Math.round(24 * scale));
    function hasFlank(a0, a1, dir) {
      var from = dir < 0 ? Math.max(0, a0 - flank) : a1;
      var to = dir < 0 ? a0 : Math.min(n, a1 + flank);
      for (var j = from; j < to; j++) {
        if (1 - whiteFrac(j) >= BAND_FLANK_DARK) return true;
      }
      return false;
    }
    var best = null, bestDist = Infinity;
    merged.forEach(function (m) {
      var len = m.a1 - m.a0;
      if (len < minLen) return;
      if ((len - m.cnt) / len > BAND_NONBAND_MAX) return;  // gaps would mean crossing a slide
      if (m.sum / m.cnt < BAND_AVG) return;               // sparse text pages are not bands
      if (!hasFlank(m.a0, m.a1, -1) || !hasFlank(m.a0, m.a1, 1)) return;
      var dist = Math.abs((m.a0 + m.a1) / 2 - n / 2);     // nearest-to-centre wins
      if (dist < bestDist) { best = m; bestDist = dist; }
    });
    if (!best) return null;
    return { axis: axis, a0: best.a0, a1: best.a1 };
  }

  /**
   * Restore a band on an exact-vector page: a second white Difference rect
   * over the band un-flips |255-|255-c|| back to c. band uses pdf-lib
   * bottom-left pt ({axis:'h', y0, y1} or {axis:'v', x0, x1}).
   */
  function unflipBand(pg, band, w, h) {
    if (!band) return null;
    var r;
    if (band.axis === 'v') {
      r = { x: band.x0, y: 0, w: band.x1 - band.x0, h: h };
    } else {
      r = { x: 0, y: band.y0, w: w, h: band.y1 - band.y0 };
    }
    pg.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1), blendMode: 'Difference' });
    return r;
  }

  function drawPage(pg, opts, info) {
    var o = normOpts(opts);
    var counts = { lines: 0, seps: 0, nums: 0 };
    var w = info.w, h = info.h;
    if (!(w > 0 && h > 0)) return counts;

    if (o.lines) {
      var sty = o.lines;
      // a layout toggle on + a detected band: rule only inside the white
      // band; the toggle on + NO band: skip ruling entirely (page-level
      // lines would land on slides, so silence beats clutter)
      var band = info.bandOnly ? (info.band || 'skip') : null;
      var R = band === 'skip' ? { x0: 0, x1: 0, ys: [], gy0: 0, gy1: 0 }
        : band ? ruleRowsBand(w, h, o.lineStep, o.lineMargin, band)
               : ruleRows(w, h, o.lineStep, o.lineMargin);
      var col = (sty === 'grid' || sty === 'dots' || sty === 'graph') ? rgb(0.74, 0.78, 0.84) : rgb(0.66, 0.7, 0.76);
      var vcol = rgb(0.74, 0.78, 0.84), vheavy = rgb(0.58, 0.63, 0.71);
      if (sty !== 'columns' && sty !== 'staff') {
        for (var li = 0; li < R.ys.length; li++) {
          var ln = { start: { x: R.x0, y: R.ys[li] }, end: { x: R.x1, y: R.ys[li] }, thickness: 0.6, color: col };
          if (sty === 'dashed') { ln.thickness = 0.7; ln.dashArray = [6, 4]; }
          else if (sty === 'dotted') { ln.thickness = 1.5; ln.lineCap = Round; ln.dashArray = [0.1, 4.5]; }
          else if (sty === 'grid' || sty === 'graph') { ln.thickness = 0.45; }
          else if (sty === 'dots') { ln.thickness = 1.5; ln.lineCap = Round; ln.dashArray = [0.1, o.lineStep]; ln.dashPhase = o.lineStep / 2; }
          if (sty === 'graph' && li % 5 === 0) { ln.thickness = 0.9; ln.color = vheavy; }
          pg.drawLine(ln);
          counts.lines++;
        }
      }
      if ((sty === 'grid' || sty === 'graph' || sty === 'columns') && R.ys.length) {
        var vj = 1;
        for (var vx = R.x0 + o.lineStep; vx < R.x1 - o.lineStep / 2; vx += o.lineStep, vj++) {
          var heavy = (sty === 'graph' && vj % 5 === 0);
          pg.drawLine({ start: { x: vx, y: R.gy0 }, end: { x: vx, y: R.gy1 },
            thickness: (sty === 'columns') ? 0.6 : (heavy ? 0.9 : 0.45),
            color: (sty === 'columns') ? rgb(0.66, 0.7, 0.76) : (heavy ? vheavy : vcol) });
          counts.lines++;
        }
      }
      if (sty === 'margin' && R.ys.length) {
        var mx = R.x0 + 0.16 * (R.x1 - R.x0);
        pg.drawLine({ start: { x: mx, y: R.gy0 }, end: { x: mx, y: R.gy1 }, thickness: 0.9, color: rgb(0.78, 0.42, 0.46) });
        counts.lines++;
      }
      if (sty === 'cornell' && R.ys.length) {
        var cxx = R.x0 + 0.3 * (R.x1 - R.x0), sy = R.gy0 + 0.24 * (R.gy1 - R.gy0);
        pg.drawLine({ start: { x: cxx, y: sy }, end: { x: cxx, y: R.gy1 }, thickness: 0.85, color: vheavy });
        pg.drawLine({ start: { x: R.x0, y: sy }, end: { x: R.x1, y: sy }, thickness: 0.85, color: vheavy });
        counts.lines += 2;
      }
      if (sty === 'staff') {
        var p = o.lineStep / 4.5;
        for (var si = 0; si < R.ys.length; si++) {
          for (var k = 0; k < 5; k++) {
            pg.drawLine({ start: { x: R.x0, y: R.ys[si] - k * p }, end: { x: R.x1, y: R.ys[si] - k * p }, thickness: 0.5, color: rgb(0.62, 0.66, 0.73) });
            counts.lines++;
          }
        }
      }
    }

    var segs = sepLines(w, h, o.sep);
    for (var gi = 0; gi < segs.length; gi++) {
      pg.drawLine({
        start: { x: segs[gi].x1, y: segs[gi].y1 },
        end: { x: segs[gi].x2, y: segs[gi].y2 },
        thickness: 1.1, color: rgb(0, 0, 0),
        dashArray: [0.9, 3.2], dashPhase: 0, lineCap: Round
      });
      counts.seps++;
    }

    if (o.nums && info.font) {
      var txt = numText(info.i || 0, info.n || 1, o);
      var size = o.numSize;
      var tw = info.font.widthOfTextAtSize(txt, size);
      var pl = numPlace(o.numPos, w, h, tw, size, 24);
      pg.drawText(txt, { x: pl.x, y: pl.y, size: size, font: info.font, color: rgb(0.45, 0.48, 0.53) });
      counts.nums++;
    }
    return counts;
  }

  return {
    LINE_STYLES: LINE_STYLES,
    NUM_POS: NUM_POS,
    NUM_FMT: NUM_FMT,
    NUM_SIZES: NUM_SIZES,
    normOpts: normOpts,
    numText: numText,
    numPlace: numPlace,
    ruleRows: ruleRows,
    ruleRowsBand: ruleRowsBand,
    findBand: findBand,
    unflipBand: unflipBand,
    sepLines: sepLines,
    drawPage: drawPage
  };
});
