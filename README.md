# Notes2A4 — pack two note pages onto every A4 sheet

**Your 400-page 16:9 notes PDF becomes exactly 200 print-ready A4 pages — in your browser, with zero uploads.**

One slide is placed flush on **top** of a white A4 sheet, the next one flush at the **bottom**, both scaled to the full page
width. The leftover height (≈ 6 cm for 16:9 content) stays a clean white **gap in the middle — free space to write your own
notes**. This mirrors the classic "2 slides on 1 page" handout layout (top bbox ≈ 0–334 pt, bottom ≈ 508–842 pt on a
595.28 × 841.89 pt page), but done as true vector embedding: no rasterising, no quality loss, text stays selectable.

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
- Live preview rendered by the **same geometry engine** as the final PDF (`converter.js` is shared with the Node tests)
- Handles odd page counts (last sheet = one slide + clean space) and blank pages without a Contents stream
- Animated hero explainer showing exactly what the tool does, reduced-motion aware

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

## Tests

The shipped converter core is exercised directly in Node (same file, no re-implementation):

```bash
npm install          # dev-only, provides pdf-lib for the test harness
node test/convert.test.mjs
```

17 assertions: geometry vs. the reference 2-up demo (±3 pt), gap/margin invariants, shrink-to-fit, odd count, blank-page robustness, 400 → 200 halving, and an end-to-end build on a real notes PDF.

## Layout

```
index.html            the whole app shell
styles.css            theme + hero explainer animation
app.js                file intake, options, live preview, convert, download
converter.js          shared geometry + PDF packing core (UMD: browser & node)
vendor/               pdf-lib 1.17.1, pdfjs-dist 3.11.174 (local copies — no CDN needed)
test/convert.test.mjs Node test harness
```

## Privacy

Nothing is ever uploaded. There is no backend — your notes PDFs are personal, and the tool is built accordingly.

## Licence

MIT © 2026 smartstopwach
