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
- **Progress you can trust from anywhere** — the tab title counts up *and* shows the estimate while the tab is hidden (`⏳ 41% · ~40 s · page 20 of 34 · Notes2A4`), the status line reads `page 20 of 34 · binarising 62%` with the time left in its own chip next to the bar (a smoothed estimate that refreshes once a second), and every phase goes through one code path so the bar, the status, the chip and the title can never disagree
- **A background tab costs less, never more** — switching tabs skips the frame waits (the message-channel yield takes over), the live preview copy and the cosmetic thumbnails, and parses/paints nothing; the strip of previews parks itself with a note and finishes the moment the tab is back. The work that *must* happen keeps happening: **pdf.js renders a page chunk per animation frame and a hidden tab fires none**, so the page loop used to freeze at whatever percentage it had reached ("19%") while the estimate grew and grew — while a run is active, a frame asked for in a hidden tab is now answered from the message channel, which is not clamped like `setTimeout` (1 s hidden, 1 per minute after 5 minutes), paced to ~250 wake-ups/s, and unhooked the moment the run ends. Measured in the smoke suite: a hidden 220 dpi run with every render driven by animation frames still finishes in the same time as a visible one
- **The wait says what it is** — the status line reads "page 12 of 34 · binarising 62%" and a **"~40 s left" chip** sits right next to the bar (an estimate extrapolated from the work already done; it says "estimating time left…" until there is enough to go on, "still working…" if the percentage has not moved for 15 s — a growing number next to a frozen bar is a lie — and it disappears the moment the run is done), the live panel notes that the small tiles are quick thumbnails while it shows the full-resolution page, and the preview strip pauses while a run is going (no CPU fight) and finishes itself once the result is on screen
- **The preview column shows everything** — the live preview sticks below the topbar and, under the two large sheets, lists *every* sheet (4-up/2-up) or every page of the result (Invert Lab) as a small, captioned tile, drawn one at a time so the column is never a tall empty card
- **The heavy pixels run in a worker** — `worker-raster.js` runs the print-saver map over the supersampled page and the PNG/JPEG encode off the main thread; strips are transferred (never copied) and the finished page comes back as encoded bytes. The maths is not re-implemented: the worker imports `converter.js` and uses the very same `printSaver.pieces`, so a worker-built page is byte-identical (verified by decoding the returned PNG and comparing it with the main-thread map). If a browser cannot start a worker, the apps fall back to the main-thread banded pipeline without breaking a single conversion
- **Pages are rendered in strips** — a 220 dpi A4 page is ~32 Mpx of supersampled canvas; instead of asking pdf.js for that in one call (which blocks for seconds and triggers Chrome's "Page Unresponsive" dialog), each page is drawn as ~96-row strips with whole-pixel `offsetY` offsets, fed straight into the banded maps. Same pixels, no 128 MB canvas, no long block
- **The tab stays alive on long runs** — the print-saver pipeline walks each page band by band (`hqMapAsync` / `negMapAsync` in `converter.js`) and hands control back to the browser between bands, so a 33-page 220 dpi flip shows a moving progress bar instead of Chrome's "Page Unresponsive" dialog. Band boundaries never change a pixel — the tests compare the banded maps with the one-shot maps byte for byte
- **Exact vector true negative** (Invert Lab) — the `255 − c` flip applied to the PDF itself with blend mode `/Difference` (the same trick dedicated inversion tools use): every sampled pixel matches a reference tool's output **exactly** (500,990-point comparison, zero differences, verified in the test suite), while text stays text (sharp + selectable), the file stays small and the run is instant — no rasterising, so Sharpness / Encoding do not apply
- **Demo-exact default geometry** — margin 0, full-width slides, auto middle gap (matches the standard 2-per-page layout pixel-close)
- Options: A4 / Letter / A5 / Legal, printable margin (mm), auto or fixed middle gap, **ruled lines** in the gap for handwriting, sheet numbers
- **Print-Saver** (both tools): colour inversion for toner-starved printers — black ↔ white swap, every other colour → solid black, so a dark "blackboard" deck prints as white paper with black ink. Scanned pages are auto-detected (content-stream probe) and re-rendered by the **HQ engine**: at up to **3× their native density, computed with 2× supersampling + area-averaging (SSAA)** — subpixel-smooth curves, no staircase jaggies, no interpolation mush. An **ink-bias response curve** (γ=1.7 toward the dark side of the 45–135 ramp) compensates halation: white-on-black strokes visually lose ~1 px of glow-edges on inversion, and the bias gives that weight back so thin handwriting never breaks. The dpi radio picks the tier (96 → 1×, 150 → 2×, 220 → 3×) and also governs genuine vector/text pages. A **Keep colours** toggle switches the colour rule: instead of crushing every colour to solid black, coloured strokes (blue/green/yellow highlights, chroma > 60) keep their hue and get their lightness flipped into a dark printable ink of the same colour — light blue on the board becomes dark blue on paper. Output is packed through the same layout engine; *Auto* inverts only genuinely dark pages, light notes pass through untouched. In this mode text becomes part of the image (not selectable); turn the checkbox off and the vector path is exactly as before
- **White paper** (both tools + Invert Lab): the style for a page that is *already white*. Paper is handed back exactly as it came in (everything from ~200 luma up — paper, a light grey box — stays untouched), while everything else becomes solid black ink: colour, grey and dark marks alike. A **dark area inside the page** (a blackboard panel, a dark slide, a photo) is found in blocks (≈4 mm, eroded then grown back so small marks, thick strokes and the registration squares stay under the paper rule) and flipped *inside itself*: the board prints as white paper with black ink on it, exactly what a photo-negative tool does to that panel — a white-marker sketch on a dark board survives instead of printing as a black rectangle. On a genuinely **dark page** it behaves exactly like *Black ink*. It exists because *Black ink* and *Pure B&W* deliberately pass a light page through untouched (that is what keeps notes clean), which made those two styles look identical on such a page — one style now covers a white notes page, a board panel and a blackboard deck
- **Pure B&W** (both tools + Invert Lab):- **Pure B&W** (both tools + Invert Lab): a second black-and-white style next to *Black ink*, using one hard threshold instead of the grey edge ramp — every output pixel is exactly `0` or `255`, so thin handwriting prints as **full black on full white** with zero grey pixels (verified: 0.00% grey on a thin-stroke test page)
- **Readable option explanations** — every dense hint in the workbench is a bullet list instead of a paragraph: colour styles, **Auto**, edge margin, start-at numbering, what Print-Saver does, the HQ engine, JPEG vs PNG, and Sharpness. Each bullet opens with a bold key word, and every switch carries its own one-line caption
- **Dotted separator** (4-up Studio): one small toggle draws a black dotted line **straight down the middle of the sheet** (top → bottom, on the column seam) so the left and right panels read as separate notes on one printed page. Drawn as a real dashed PDF line with round caps (`[0.9 3.2] 0 d`, 1.1 pt) inset to your margin; the live preview and the shipped PDF use the one shared helper (`sepLines`), the default is off, and 2-up output is never touched (the core still supports a horizontal/both line for other callers)
- **Reload-proof session** — a reload, crash or accidental close no longer loses anything (see *Session* below)
- **HD live preview** — every preview canvas renders at its real device-pixel density (`cssW × devicePixelRatio`, high-quality smoothing), so nothing is upscaled and soft; and a click on any sheet opens an **HD view** (up to 3600 px wide, fitted to your screen, Esc / backdrop closes) drawn by the same engine as the PDF — readable handwriting before you commit to a conversion
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
4. With **Print-Saver** on: `nativePP()` reads the page's dominant embedded image from the content stream (`getOperatorList`) to learn its true px-per-point density and picks the quality tier from it (×1/×2/×3 of native). The page is rendered at 2× the *target* resolution and `printSaver.hqMap()` area-averages every output block, then maps it: `mean luma ≤ 45 → white paper · saturated colour (chroma > 60) → solid black · bright → black ink`, with a **linear grey ramp between 45 and 135** so stroke edges land as smooth subpixel coverage instead of staircases (print drivers re-halftone these at 600–1200 dpi; viewers read them as antialiasing). Vector pages simply render at the chosen dpi through the same map. Re-encoded as PNG, and packed by the identical layout code (`buildFromImages`) — geometry, gap, lines and numbers all unchanged.

## Session — nothing is lost on reload

`session.js` keeps the working state inside your own browser (origin-private storage, still zero uploads):

| what | where | why it matters |
|---|---|---|
| source PDF(s) | **OPFS** file, IndexedDB Blob as fallback | a reload, a crash or a killed tab comes back with your file already loaded |
| every setting | one small IndexedDB record | positions, styles, dpi, print-saver choices are all exactly as you left them |
| finished result | stored once | the result card, the thumbnails and the download link reappear **without re-converting** |
| interrupted run | per-page checkpoint cache | Print-Saver renders page by page; each finished page is saved, so *Continue* resumes at the page it stopped at instead of starting over |

- A bar above the workbench always shows what is stored; **Continue** appears after an interrupted run, **Forget** wipes everything in one click.
- Restoring is silent: the file is re-parsed locally, the options are re-applied, and the interrupted run resumes from its checkpoint (same settings) — changing any image setting correctly invalidates the stale checkpoints.
- Storage failures (private mode, full disk) never break the tools: every call is guarded and simply degrades to no persistence.

## Colour probe — matching another tool exactly

When another colour-inversion tool gets a result you like, use the probe to make Notes2A4 match it **exactly**:

1. **Send the probe** — [`probe/colour-probe.pdf`](probe/colour-probe.pdf) (or `probe/colour-probe.png` for screenshot-based tools). It is a calibration target: 95 known colour blocks (grey ramp + pure white, R/G/B ramps, nine hues at full and half brightness, pastels, dark shades, ten pen colours, five board colours) plus four corner marks, gradient strips and two real-note panels with 0.5–1.5 pt strokes, markers and a highlighter.
2. **Run it through the other tool** and send the result back — the PDF it produced, a screenshot, a JPEG or even a photo all work.
3. **Read the answer**:

   ```bash
   node tools/analyse-probe.mjs <the-file-that-came-back>
   ```

   The analyser finds the corner marks, corrects for exposure/compression against the measured black/white range, samples all 95 blocks and prints:
   * the full input → output table
   * the per-channel fit `out = a·in + b` with its residual
   * whether the tool is per-channel or luma-only, and whether hues are kept or complemented
   * a verdict — and, when the fit is not a plain `255 − c`, the exact `clamp()` lines to drop into `converter.js`

   ```bash
   npm run probe        # regenerate the probe PDF/PNG/truth table
   npm test             # includes 15 round-trip checks (identity, 255 − c, luma, JPEG)
   ```

`tools/probe-layout.mjs` holds the single geometry definition shared by the generator and the analyser, so a block can never be read from the wrong place.

## Matching another tool exactly

`probe/match-proof.png` is the visual receipt: the same probe page through a reference inversion tool and through Notes2A4's **True negative · exact vector**, side by side, with a difference map — the third panel is pure black, i.e. no pixel differs. The check runs in `npm test` (23,436 sampled points across all three probe pages, plus all 95 blocks against `255 − c`); `colour-probe-invert.pdf` in the repo root is the reference output it compares against, and it was produced by the tool whose colour inversion you liked.

## Tests

The shipped converter core is exercised directly in Node (same file, no re-implementation):

```bash
npm install          # dev-only, provides pdf-lib for the test harness
npm test             # converter suite + session suite
node test/make-fixtures.mjs   # regenerate the in-repo sample PDFs/PNGs
```

**`test/convert.test.mjs` — 92 assertions** on the shipped converter: 2-up geometry vs. the reference demo (±3 pt); 4-up pair-column geometry vs. the measured landscape demo cells (±6 pt per corner); band/flush/gutter invariants; shrink-to-fit; partial sheets; blank-page robustness; 400 → 200 and 400 → 100; sheet-numbering (7 positions × 5 styles × start-at × 3 sizes); print-saver pixel map (black→white, white→black, colours→black), auto dark-page detection, HQ coverage map (quarter/half-ink blocks → grey ramp, chroma rule, light-page passthrough), pure B&W hard threshold (0 grey pixels on a mixed page), 4-up dotted separator (vertical seam geometry, margin inset, dash op present in the PDF and absent when off or in 2-up, shipped UI is the vertical toggle only), and raster-pack layout in both 2-up and 4-up; end-to-end builds on the in-repo sample notes PDFs (`test/fixtures/`, so the suite needs no files outside the repo).

**`test/app-smoke.test.mjs` — 27 checks**: the real `app.js` / `app4up.js` / `app-invert.js` are loaded into a stubbed DOM and actually run — a fixture PDF is dropped in, Start is clicked and every mode is exercised (vector pack, Print-Saver in all colour styles, 4-up with the dotted separator, Invert Lab in black-ink, raster-negative and exact-vector modes). Shipped builds have twice failed at run time in exactly this place (a missing helper name), which grep-based checks cannot see.

**`test/session.test.mjs` — 112 assertions**: the real `session.js` running against in-memory IndexedDB + OPFS stand-ins — byte-identical file round-trips in both engines, half-written-file recovery, options snapshot/apply (idempotent), result storage + cached object URL + replacement, run checkpoints (reuse on identical settings, invalidation on changed settings, clear), `clearAll`, plus wiring checks that all three apps call every session API, that every setting really sits inside `#workbench`, that `session.js` is cache-busted with the apps, and that all three previews render at device-pixel density and wire the HD click-to-enlarge view (so the old downscaled-render blur cannot come back).

**`test/overlay.test.mjs` — 53 checks**: the standalone `overlays.js` engine — option normalisation (junk → safe defaults), all five number styles with start-at totals, six in-bounds number positions, ruling/separator geometry, a real pdf-lib draw (line ops, dash op, round caps, decoded number label in the content stream), all 10 line styles, packer white-band detection (clean/noisy gaps, vertical-axis symmetry, dotted-separator merge, blank/dark/text-page rejection, sub-12pt rejection, flank-content + nearest-centre selection), real-geometry regression proofs (the actual `quadLayout`/`sheetLayout` bands are covered in auto and fixed-8mm gap modes, partial sheets rejected, fixed-gap padding never wins), the Difference unflip restore (geometry + real-page stream), band-confined ruling, `bandOnly` composition, and degenerate-input safety.

**`test/rapper.test.mjs` — 47 checks**: the real `rapper-core.js` cover engine — colour helpers, Y-flip math, gap-free brush dots, mosaic pixelate (region mushed, outside untouched, OOB clipped), vector-vs-raster routing, hit-testing, a real pdf-lib overlay build (filled-path ops + exact flipped position + opacity state in the saved bytes), undo-safe deep clones, plus a stub-DOM boot of the shipped `rapper.js` editor (every `rp-*` id it touches exists in `rapper.html`, tools/colour sliders wire up).

## Layout

```
index.html            the whole app shell
styles.css            theme + hero explainer animation
app.js                file intake, options, live preview, convert, download
4up.html              4-up Studio landing page (special mode)
app4up.js             4-up workbench logic · fourup.css  hero animation + styles
converter.js          shared geometry + PDF packing core (UMD: browser & node)
session.js            reload-proof local storage (OPFS + IndexedDB): files, options, result, checkpoints
vendor/               pdf-lib 1.17.1, pdfjs-dist 3.11.174 (local copies — no CDN needed)
test/convert.test.mjs Node harness — converter core
test/session.test.mjs Node harness — storage engine + app wiring
test/app-smoke.test.mjs headless run of the real app files (stubbed DOM) — Start is
                        actually clicked for every mode; catches missing helpers.
                        Also watches the main thread: a 2 ms heartbeat runs during a
                        220 dpi print-saver run and the longest silence must stay
                        under 250 ms, while the blocking one-shot maps are stubbed
                        to throw so they can never come back
test/fixtures/        sample notes PDFs + PNGs the suites run on
test/make-fixtures.mjs regenerates those fixtures
test/raster-worker.test.mjs worker maths + protocol + failure paths (fake Worker)
test/worker-realm.test.mjs  runs worker-raster.js inside a realm that behaves like a
                        real Web Worker (importScripts + self + postMessage)
test/fake-worker.mjs   the shared Worker / OffscreenCanvas stand-ins
raster-client.js       main-thread side of the client (mapPage / encode / fallback)
worker-raster.js       the worker: map + encode, using converter.js's pieces
probe/                colour-probe.pdf / .png — the calibration target you send elsewhere
tools/colour-probe.mjs  draws the probe · tools/analyse-probe.mjs reads a returned file
tools/probe-layout.mjs  the shared swatch geometry · tools/img-io.mjs  PNG/JPEG in + out
tools/probe-selftest.mjs round-trip checks (identity · 255 − c · luma · JPEG)
```

## Privacy

Nothing is ever uploaded. There is no backend — your notes PDFs are personal, and the tool is built accordingly.

## Licence

MIT © 2026 smartstopwach

## Design system

- Tokens centralised in `styles.css` `:root` — type (`Manrope` UI/display, `Instrument Serif` italic accents, both self-hosted woff2), spacing scale 4→96px, three radii, three elevation levels, one accent + one emphasis hue.
- Hero stages are real CSS-3D (`perspective` + `preserve-3d` + per-layer `translateZ`), reacting to pointer proximity with a subtle tilt and a cursor light — see `enhance.js` (opt-in via `data-tilt`/`data-count`, fully disabled on touch and `prefers-reduced-motion`).
- Motion language: enter = ease-out, exit = ease-in-out, progress = linear; UI ≤300 ms, complex reveals 400–700 ms. Icons are a single inline SVG set (no emoji).
- `enhance.js` also owns the topbar scroll state, kinetic count-ups (400 → 200 / −75 %) and the toast layer; errors stay inline (`role="alert"`), skeletons shimmer while the engine paints.

## The Rapper (`rapper.html`)

Fourth standalone tool: the **TG-ID cover-up studio**. Coaching PDFs arrive with a stamped TG ID watermark on every page — The Rapper lets you **draw covers** over them (rectangle, ellipse, brush, mosaic-blur region), sample the exact paper colour with an **eyedropper**, **apply covers to all pages** in one click (smart source: current page, else the first page that has covers — the button never silently does nothing), then export a clean `*-rapper.pdf`. A **Focus mode** (⛶ button or `F`) turns the whole viewport into left-toolbox + big-page editing; double-click/double-tap deletes a cover for touch users. Shape covers are baked as vector fills, so text underneath stays **selectable**; only pages with blur regions are re-rendered (150/200/300 dpi, JPEG/PNG). Select/move/resize, undo/redo, zoom, per-cover opacity, keyboard shortcuts (`V R E B M I`, arrows turn pages). No server, ever. `rapper.js` + `rapper-core.js` are standalone — they never touch `converter.js`. Covered by `test/rapper.test.mjs`.

## Invert Lab (`invert.html`)

Third standalone tool: **1:1 colour inversion** — every page keeps its exact size and the document keeps its exact page count; each pixel becomes 255−value on R/G/B (true photographic negative). Optional vector-sharp **overlays** drawn on top of each finished page: **ruled lines** (10 styles, same look as the packer's ruling), **dotted separator** (cut/fold guide, vertical/horizontal/both), and **sheet numbers** (6 positions × 5 styles × start-at × 3 sizes) — all off by default, covered by `test/overlay.test.mjs`. For packer-made PDFs, **2-up to invert** / **4-up to invert** toggles detect each page's white middle band and keep it white while the slides flip (raster-negative and exact-vector modes; ruled lines then draw only inside the band). Rendered in-browser with pdf.js at 96/150/220 dpi (2× SSAA guard like the print engine), re-embedded full-bleed into a fresh pdf-lib document with the original MediaBoxes. Options: **flip style** — *True negative* (every channel 255−c, colours kept) or *Black ink* (dark board → white paper, every colour printed as solid black using NotesConverter.printSaver.hqMap — the same engine-verified mapping the Print-Saver uses; already-bright pages pass through); JPEG (lighter) vs PNG (lossless) and “skip blank pages” so empty sheets never flip to solid black. No server, ever. `app-invert.js` is standalone — it never touches `converter.js`.
