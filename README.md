# Notes2A4 — pack two note pages onto every A4 sheet

**Your 400-page 16:9 notes PDF becomes exactly 200 print-ready A4 pages — in your browser, with zero uploads.**

> **New: 4-up Studio** (`4up.html`) — a dedicated landing page for the special *four-into-one* mode: four slides on one **landscape A4**, demo-exact (see below). 400 → **100** sheets.

One slide is placed flush on **top** of a white A4 sheet, the next one flush at the **bottom**, both scaled to the full page
width. The leftover height (≈ 6 cm for 16:9 content) stays a clean white **gap in the middle — free space to write your own
notes**. This mirrors the classic "2 slides on 1 page" handout layout (top bbox ≈ 0–334 pt, bottom ≈ 508–842 pt on a
595.28 × 841.89 pt page), but done as true vector embedding: no rasterising, no quality loss, text stays selectable — unless you switch on the opt-in **Print-Saver** inversion mode (see Features).

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  page 1   (16:9, full-  │   │  page 3                 │
│           width)        │   ├─────────────────────────┤
├─────────────────────────┤   │                         │  16:9  →  2-up A4
│      white gap (notes)  │   │        white gap        │  N pages   ⌈N/2⌉ sheets
├─────────────────────────┤   ├─────────────────────────┤
│  page 2                 │   │  page 4                 │
└─────────────────────────┘   └─────────────────────────┘
```

## Features

- **100% client-side** — pdf.js reads, pdf-lib writes; no server, no tracking, works offline after load (all libraries vendored in `vendor/`)
- **Vector-perfect output** — source pages are embedded as PDF Form XObjects, not screenshots
- **Demo-exact default geometry** — margin 0, full-width slides, auto middle gap (matches the standard 2-per-page layout pixel-close)
- Options: A4 / Letter / A5 / Legal, printable margin (mm), auto or fixed middle gap, **ruled lines** in the gap for handwriting, sheet numbers
- **Print-Saver** (both tools): colour inversion for toner-starved printers — black ↔ white swap, every other colour → solid black, so a dark "blackboard" deck prints as white paper with black ink. Scanned pages are auto-detected and rendered at their **exact native pixel size (1:1, never upscaled — zero interpolation blur)**; the dpi slider (96 / 150 / 220) only governs genuine vector/text pages, which gain real sharpness from it. Output is packed through the same layout engine; *Auto* inverts only genuinely dark pages, light notes pass through untouched. In this mode text becomes part of the image (not selectable); turn the checkbox off and the vector path is exactly as before
- Live preview rendered by the **same geometry engine** as the final PDF (`converter.js` is shared with the Node tests)
- Handles odd page counts (last sheet = one slide + clean space) and blank pages without a Contents stream
- Animated hero explainer showing exactly what the tool does, reduced-motion aware

## 4-up Studio — `4up.html` (special landing page)

Geometry measured from the reference demo (`11th (2) (1).pdf`) and reproduced to ≤ 5.1 pt (1.8 mm — the demo's own edge bleed):

| property | value |
|---|---|
| sheet | A4 **landscape** — 841.89 × 595.28 pt |
| order | **pair columns**: page 1 top-left, 2 bottom-left, 3 top-right, 4 bottom-right |
| column width | exactly half the printable width — 420.94 pt (no center gutter, flush edges) |
| rows | flush to top & bottom edges; each slide keeps its own aspect (mixed 715/716/718 heights OK) |
| middle band | leftover horizontal strip ≈ 123 pt ≈ 43 mm, white — optional ruled lines + centered sheet number |
| saving | 400 pages → 100 landscape sheets (**−75 %** paper), vector-perfect like 2-up |

The page ships its own animated hero (4-card deck flying into the 2 × 2 grid, counter flip, glow cues), a full workbench with live preview (paper, margin, auto/custom band, ruled lines, numbers) and one-click download — all in the same shared `converter.js` engine the Node tests run.

## Try it

Open [`index.html`](index.html) — or with a tiny server (recommended so the pdf.js worker loads cleanly):

```bash
python3 -m http.server 8080     # then visit http://localhost:8080
```

GitHub Pages (if enabled for this repo): https://smartstopwach.github.io/notes2a4/

## How it works

1. `pdf.js` parses the file for stats + previews (page count, per-page size, canvas renders).
2. `converter.js` computes, per output sheet: each 16:9 page scaled by `s = (W_page − 2·margin) / W_src`, top slide pinned to the top edge, bottom pinned to the bottom edge, gap = leftover height (auto mode) or your fixed value (stack vertically centered, shrunk to fit if requested gap is too large).
3. `pdf-lib` writes a fresh PDF with `embedPdf()` → `drawPage()` per slide, plus vector ruled lines / page numbers if enabled.
4. With **Print-Saver** on: `nativePP()` reads the page's dominant embedded image from the content stream (`getOperatorList`) to learn its true px-per-point density; pages that are scans render at that exact 1:1 scale (no resample at all), vector pages at the chosen dpi. Each bitmap is then binarised by the colour map `luma ≤ 90 → white, anything else → black` (`NotesConverter.printSaver`), re-encoded as PNG, and packed by the identical layout code (`buildFromImages`) — geometry, gap, lines and numbers all unchanged.

## Tests

The shipped converter core is exercised directly in Node (same file, no re-implementation):

```bash
npm install          # dev-only, provides pdf-lib for the test harness
node test/convert.test.mjs
```

39 assertions: 2-up geometry vs. the reference demo (±3 pt); 4-up pair-column geometry vs. the measured landscape demo cells (±6 pt per corner); band/flush/gutter invariants; shrink-to-fit; partial sheets; blank-page robustness; 400 → 200 and 400 → 100; print-saver pixel map (black→white, white→black, colours→black), auto dark-page detection, and raster-pack layout in both 2-up and 4-up; end-to-end builds on real notes PDFs.

## Layout

```
index.html            the whole app shell
styles.css            theme + hero explainer animation
app.js                file intake, options, live preview, convert, download
4up.html              4-up Studio landing page (special mode)
app4up.js             4-up workbench logic · fourup.css  hero animation + styles
converter.js          shared geometry + PDF packing core (UMD: browser & node)
vendor/               pdf-lib 1.17.1, pdfjs-dist 3.11.174 (local copies — no CDN needed)
test/convert.test.mjs Node test harness
```

## Privacy

Nothing is ever uploaded. There is no backend — your notes PDFs are personal, and the tool is built accordingly.

## Licence

MIT © 2026 smartstopwach
