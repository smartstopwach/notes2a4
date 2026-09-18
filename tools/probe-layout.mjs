/* ============ colour-probe layout — shared by the PDF/PNG maker and the analyser ============
   One definition of every test swatch, so the analyser knows exactly which colour
   sits in which cell of the returned file: the mapping can then be read off
   without OCR. Coordinates are in PDF points (A4 portrait, origin bottom-left). */

export const PAGE = { w: 595.28, h: 841.89 };
export const FID = { size: 16, inset: 20 };              // black corner marks = orientation + scale reference
export const GRID = { left: 33, bottom: 70, sw: 30, sh: 26, gap: 3, rowGap: 15 };

export const GRAYS = [...Array.from({ length: 16 }, (_, i) => [i * 16, i * 16, i * 16]), [255, 255, 255]];

export const RGB_RAMP = [0, 32, 64, 96, 128, 160, 192, 224, 255];
export const R_RAMP = RGB_RAMP.map((v) => [v, 0, 0]);
export const G_RAMP = RGB_RAMP.map((v) => [0, v, 0]);
export const B_RAMP = RGB_RAMP.map((v) => [0, 0, v]);

/* HSV → RGB so the hue rows are exact and documented */
export function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return t.map((k) => Math.round((k + m) * 255));
}
export const HUE_STEPS = [0, 40, 80, 120, 160, 200, 240, 280, 320];
export const HUES_FULL = HUE_STEPS.map((h) => hsv(h, 1, 1));
export const HUES_HALF = HUE_STEPS.map((h) => hsv(h, 1, 0.5));

export const PASTELS = [
  [255, 224, 224], [224, 255, 224], [224, 224, 255], [255, 255, 224], [224, 255, 255],
  [255, 224, 255], [245, 245, 220], [230, 240, 250], [250, 235, 245]
];

export const DARKS = [
  [64, 0, 0], [0, 64, 0], [0, 0, 64], [64, 64, 0], [0, 64, 64],
  [64, 0, 64], [32, 32, 32], [48, 48, 64], [16, 24, 48]
];

export const PENS = [
  ['blue', [29, 78, 216]], ['red', [220, 38, 38]], ['green', [22, 163, 74]],
  ['orange', [234, 88, 12]], ['teal', [20, 184, 166]], ['purple', [124, 58, 237]],
  ['pink', [219, 39, 119]], ['amber', [245, 158, 11]], ['brown', [146, 64, 14]],
  ['indigo', [67, 56, 202]]
];

export const BOARDS = [
  ['navy board', [18, 23, 43]], ['slate board', [30, 41, 59]], ['pure black', [0, 0, 0]],
  ['deep purple', [27, 16, 53]], ['dark green', [11, 43, 31]]
];

/* gradient strips: name, from, to (page 2, full width) */
export const GRADIENTS = [
  ['black - white', [0, 0, 0], [255, 255, 255]],
  ['white - black', [255, 255, 255], [0, 0, 0]],
  ['blue - yellow', [26, 58, 143], [250, 204, 21]],
  ['red - cyan', [185, 28, 28], [6, 182, 212]],
  ['navy - white', [18, 23, 43], [255, 255, 255]]
];

/* ---- page 1 (= the machine-readable calibration page) rows, top → bottom ----
   Every row carries its own cell width so wide rows never overflow the sheet. */
export function page1Rows() {
  const penCols = PENS.map((p) => p[1]);
  const names = PENS.map((p) => p[0]);
  const boardCols = BOARDS.map((b) => b[1]);
  const boardNames = BOARDS.map((b) => b[0]);
  return [
    { label: 'grey 0-255 (step 16)', cols: GRAYS, sw: 29, gap: 2.6 },
    { label: 'red ramp 0-255', cols: R_RAMP, sw: 54, gap: 5 },
    { label: 'green ramp 0-255', cols: G_RAMP, sw: 54, gap: 5 },
    { label: 'blue ramp 0-255', cols: B_RAMP, sw: 54, gap: 5 },
    { label: 'hues 0-320 (100% S, 100% V)', cols: HUES_FULL, sw: 54, gap: 5 },
    { label: 'hues 0-320 (100% S, 50% V)', cols: HUES_HALF, sw: 54, gap: 5 },
    { label: 'pastel tints', cols: PASTELS, sw: 54, gap: 5 },
    { label: 'dark shades', cols: DARKS, sw: 54, gap: 5 },
    { label: 'pen colours', cols: penCols, sw: 45, gap: 5, names },
    { label: 'board colours', cols: boardCols, sw: 92, gap: 5, names: boardNames }
  ];
}

const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/* Every swatch the analyser must find, as a rectangle in PDF points + its colour. */
export function allSwatches() {
  const out = [];
  let y = PAGE.h - 136;
  for (const row of page1Rows()) {
    row.cols.forEach((c, i) => {
      out.push({
        page: 1, row: row.label, step: i, rgb: c, hex: hex(c), name: row.names ? row.names[i] : null,
        x: GRID.left + i * (row.sw + row.gap), y: y - GRID.sh, w: row.sw, h: GRID.sh
      });
    });
    y -= GRID.sh + GRID.rowGap + 15;
  }
  return out;
}

export function gradientRects() {
  return GRADIENTS.map((g, i) => ({
    name: g[0], from: g[1], to: g[2],
    x: 33, y: 168 - i * 27, w: PAGE.w - 66, h: 18
  }));
}
