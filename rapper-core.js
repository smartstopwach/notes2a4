/*!
 * THE RAPPER — core engine (cover-up overlays for stamped PDFs)
 * UMD module: runs in the browser (global `RapperCore`, uses pdf-lib UMD)
 * and in Node (require('pdf-lib')) for tests.
 *
 * THE MODEL — one cover object per drawn shape:
 *   { id, type, x, y, w, h, color, opacity, points, radius, block }
 *   · type: 'rect' | 'ellipse' | 'brush' | 'pixel' (pixelate region)
 *   · x, y, w, h: PDF POINTS, origin at the TOP-LEFT of the page
 *     (this matches pdf.js viewports and mouse coordinates, so the editor
 *     never flips anything; only the pdf-lib writer flips to bottom-left)
 *   · color: '#rrggbb' hex · opacity: 0..1
 *   · brush: points = [[x,y],...] in the same top-left space, radius in pt
 *   · pixel: block = pixelate block size in OUTPUT pixels (at export dpi)
 *
 * Vector covers (rect/ellipse/brush) are drawn onto COPIED original pages —
 * text stays selectable, file stays small. Pages holding a 'pixel' region are
 * re-rendered (rasterized) with every cover burned in, at the chosen dpi.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pdf-lib'));
  } else {
    root.RapperCore = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  var rgb = PDFLib.rgb;

  /** '#rrggbb' (or '#rgb') → [0..1, 0..1, 0..1]. Junk in → white out. */
  function hexToRgb01(hex) {
    var h = String(hex || '').replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255
    ];
  }

  /** '#rrggbb' → [0..255, 0..255, 0..255] for canvas work. */
  function hexToRgb255(hex) {
    var c = hexToRgb01(hex);
    return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
  }

  /** [r,g,b] 0..255 → '#rrggbb' (what the eyedropper hands back). */
  function rgb255ToHex(r, g, b) {
    function h(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + h(r) + h(g) + h(b);
  }

  /**
   * Top-left rect (editor space) → pdf-lib bottom-left {x, y, width, height}.
   * @param {{x:number,y:number,w:number,h:number}} r
   * @param {number} pageH page height in pt
   */
  function flipRect(r, pageH) {
    var w = Math.max(0, +r.w || 0), h = Math.max(0, +r.h || 0);
    return { x: +r.x || 0, y: pageH - (+r.y || 0) - h, width: w, height: h };
  }

  /** Any cover list holding a 'pixel' region forces that page to rasterize. */
  function hasRaster(covers) {
    for (var i = 0; i < (covers || []).length; i++) {
      if (covers[i] && covers[i].type === 'pixel') return true;
    }
    return false;
  }

  /**
   * A brush stroke → the filled circles pdf-lib must draw. Points closer than
   * half the radius apart are filled in by interpolation, so fast mouse moves
   * never leave dotted gaps. Returns [{x, y, r}] in TOP-LEFT pt (flip at draw).
   */
  function brushCircles(points, radius) {
    var out = [];
    var pts = points || [];
    var r = Math.max(0.25, +radius || 1);
    if (!pts.length) return out;
    out.push({ x: pts[0][0], y: pts[0][1], r: r });
    for (var i = 1; i < pts.length; i++) {
      var x0 = pts[i - 1][0], y0 = pts[i - 1][1];
      var dx = pts[i][0] - x0, dy = pts[i][1] - y0;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.ceil(dist / (r / 2)));
      for (var s = 1; s <= steps; s++) {
        out.push({ x: x0 + dx * s / steps, y: y0 + dy * s / steps, r: r });
      }
    }
    return out;
  }

  /**
   * Pixelate one RECTANGULAR region of an RGBA buffer IN PLACE.
   * img = { data: Uint8ClampedArray, w, h } (output-pixel space).
   * rect = { x, y, w, h } in the SAME pixel space (top-left origin).
   * Every block x block square is replaced by its own average colour —
   * text under it becomes unreadable mush, which is the whole point.
   */
  function pixelateRegion(img, rect, block) {
    var d = img.data, W = img.w || img.width, H = img.h || img.height;
    var bs = Math.max(2, Math.round(block) || 8);
    var x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    var x1 = Math.min(W, Math.ceil(rect.x + rect.w)), y1 = Math.min(H, Math.ceil(rect.y + rect.h));
    for (var by = y0; by < y1; by += bs) {
      for (var bx = x0; bx < x1; bx += bs) {
        var ex = Math.min(x1, bx + bs), ey = Math.min(y1, by + bs);
        var sr = 0, sg = 0, sb = 0, n = 0;
        for (var y = by; y < ey; y++) {
          for (var x = bx; x < ex; x++) {
            var o = (y * W + x) * 4;
            sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; n++;
          }
        }
        if (!n) continue;
        var ar = Math.round(sr / n), ag = Math.round(sg / n), ab = Math.round(sb / n);
        for (var y2 = by; y2 < ey; y2++) {
          for (var x2 = bx; x2 < ex; x2++) {
            var o2 = (y2 * W + x2) * 4;
            d[o2] = ar; d[o2 + 1] = ag; d[o2 + 2] = ab;
          }
        }
      }
    }
    return img;
  }

  /**
   * Draw the VECTOR covers of one page onto a pdf-lib page object.
   * The page must already be the right size (copied original); 'pixel'
   * covers are SKIPPED here (their page is rasterized instead).
   * Returns how many covers were drawn.
   */
  function applyVectorCovers(page, covers, pageH) {
    var drawn = 0;
    for (var i = 0; i < (covers || []).length; i++) {
      var c = covers[i];
      if (!c) continue;
      var col = hexToRgb01(c.color);
      var opt = { color: rgb(col[0], col[1], col[2]), opacity: Math.max(0, Math.min(1, c.opacity == null ? 1 : +c.opacity)) };
      if (c.type === 'rect') {
        var r = flipRect(c, pageH);
        if (r.width < 0.5 || r.height < 0.5) continue;
        page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: opt.color, opacity: opt.opacity });
        drawn++;
      } else if (c.type === 'ellipse') {
        var e = flipRect(c, pageH);
        if (e.width < 0.5 || e.height < 0.5) continue;
        page.drawEllipse({
          x: e.x + e.width / 2, y: e.y + e.height / 2,
          xScale: e.width / 2, yScale: e.height / 2,
          color: opt.color, opacity: opt.opacity
        });
        drawn++;
      } else if (c.type === 'brush') {
        var dots = brushCircles(c.points, c.radius);
        for (var k = 0; k < dots.length; k++) {
          page.drawCircle({
            x: dots[k].x, y: pageH - dots[k].y,
            size: dots[k].r, color: opt.color, opacity: opt.opacity
          });
        }
        if (dots.length) drawn++;
      }
      /* 'pixel' is raster-only — deliberately skipped here */
    }
    return drawn;
  }

  /**
   * Hit-test: topmost cover under point (x, y) in top-left pt space.
   * Brushes hit within their radius of any stored point. Returns index or -1.
   * Optional tol (pt) expands every target — fat-finger friendly on touch.
   */
  function hitCover(covers, x, y, tol) {
    var t = Math.max(0, +tol || 0);
    for (var i = (covers || []).length - 1; i >= 0; i--) {
      var c = covers[i];
      if (!c) continue;
      if (c.type === 'brush') {
        var pts = c.points || [], r = (c.radius || 4) + 2 + t;
        for (var k = 0; k < pts.length; k++) {
          var dx = pts[k][0] - x, dy = pts[k][1] - y;
          if (dx * dx + dy * dy <= r * r) return i;
        }
      } else if (x >= c.x - t && x <= c.x + c.w + t && y >= c.y - t && y <= c.y + c.h + t) {
        return i;
      }
    }
    return -1;
  }

  /** Deep-copy a cover list (for apply-to-all / undo snapshots). */
  function cloneCovers(covers) {
    return JSON.parse(JSON.stringify(covers || []));
  }

  /**
   * Pick the template page for "apply to all": the current page when it has
   * covers, otherwise the first page (in order) that does. Returns
   * { page, covers } or null when no page has anything to apply.
   */
  function chooseApplySource(all, cur, pageCount) {
    all = all || {};
    if ((all[cur] || []).length) return { page: cur, covers: all[cur] };
    for (var p = 1; p <= pageCount; p++) {
      if (p !== cur && (all[p] || []).length) return { page: p, covers: all[p] };
    }
    return null;
  }

  return {
    hexToRgb01: hexToRgb01,
    hexToRgb255: hexToRgb255,
    rgb255ToHex: rgb255ToHex,
    flipRect: flipRect,
    hasRaster: hasRaster,
    brushCircles: brushCircles,
    pixelateRegion: pixelateRegion,
    applyVectorCovers: applyVectorCovers,
    hitCover: hitCover,
    cloneCovers: cloneCovers,
    chooseApplySource: chooseApplySource
  };
});
