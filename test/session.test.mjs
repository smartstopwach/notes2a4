/* ============ session.js tests — reload-proof storage, verified in Node ============
   session.js talks to the browser through three small surfaces only:
     indexedDB · navigator.storage.getDirectory() (OPFS) · Blob/URL
   Here all three are replaced with in-memory stand-ins, so the real module runs
   unmodified and every promise path (OPFS, IndexedDB fallback, half-written
   file recovery, checkpoint reuse) is exercised for real. */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS ', name, extra === undefined ? '' : '  [' + extra + ']'); }
  else { fail++; console.log('  FAIL ', name, extra === undefined ? '' : '  [' + extra + ']'); }
}
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + n) & 255);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/* ---------- in-memory IndexedDB ---------- */
function makeIDB(store) {
  const later = (fn) => setTimeout(fn, 0);
  const req = (run) => { const r = {}; later(() => run(r)); return r; };
  return {
    open() {
      const rq = {};
      later(() => {
        rq.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: (k) => req((r) => { r.result = store.has(k) ? store.get(k) : undefined; r.onsuccess && r.onsuccess(); }),
              put: (v, k) => req((r) => { store.set(k, v); r.onsuccess && r.onsuccess(); }),
              delete: (k) => req((r) => { store.delete(k); r.onsuccess && r.onsuccess(); })
            })
          })
        };
        rq.onsuccess && rq.onsuccess();
      });
      return rq;
    }
  };
}

/* ---------- in-memory OPFS ---------- */
function makeOPFS(files) {
  return {
    files,
    async getDirectoryHandle() { return makeDir(files); }
  };
}
function makeDir(files) {
  return {
    async getFileHandle(name, opts) {
      if (!files.has(name) && !(opts && opts.create)) throw new Error('NotFound');
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      return {
        async getFile() { return new Blob([files.get(name)]); },
        async createWritable() {
          const parts = [];
          return {
            async write(chunk) { parts.push(chunk); },
            async close() {
              const total = parts.reduce((n, p) => n + p.length, 0);
              const out = new Uint8Array(total);
              let o = 0;
              parts.forEach((p) => { out.set(p, o); o += p.length; });
              files.set(name, out);
            }
          };
        }
      };
    },
    async removeEntry(name) { files.delete(name); },
    async *keys() { for (const k of files.keys()) yield k; }
  };
}

/* ---------- fresh module instance with a chosen environment ---------- */
async function loadSession({ opfsFiles = null, store = new Map() } = {}) {
  Object.defineProperty(globalThis, 'indexedDB', { value: makeIDB(store), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: opfsFiles ? { storage: { getDirectory: () => makeOPFS(opfsFiles), persist: () => Promise.resolve(true) } }
                     : { storage: { persist: () => Promise.resolve(true) } },
    configurable: true, writable: true
  });
  const path = new URL('../session.js', import.meta.url).href;
  delete require.cache[path];
  delete require.cache[require.resolve('../session.js')];
  const mod = require('../session.js');
  await mod.init();
  return { NS: mod, store, opfsFiles };
}

console.log('\n=== session.js: reload-proof storage ===\n');

/* ---------- 1) OPFS engine: files round-trip ---------- */
{
  const opfs = new Map();
  const { NS } = await loadSession({ opfsFiles: opfs });
  check('init: supported + OPFS detected', NS.supported() === true && NS.opfs() === true);

  const f1 = { name: 'lecture.pdf', bytes: bytes(4096, 3) };
  const f2 = { name: 'notes-2.pdf', bytes: bytes(999, 7) };
  check('saveFiles writes both files', (await NS.saveFiles([f1, f2])) === true);
  const back = await NS.loadFiles();
  check('loadFiles returns same count/names', back.length === 2 && back[0].name === 'lecture.pdf' && back[1].name === 'notes-2.pdf',
    back.map((b) => b.name).join(','));
  check('loadFiles bytes are byte-identical', same(back[0].bytes, f1.bytes) && same(back[1].bytes, f2.bytes));
  check('source lives in OPFS (not IDB)', [...opfs.keys()].filter((k) => k.startsWith('src-')).length === 2, [...opfs.keys()].join(','));

  // rewrite with a different file → old generation is cleaned up
  await NS.saveFiles([{ name: 'one.pdf', bytes: bytes(512, 5) }]);
  const back2 = await NS.loadFiles();
  check('re-save replaces the set and drops old blobs', back2.length === 1 && back2[0].name === 'one.pdf' &&
    [...opfs.keys()].filter((k) => k.startsWith('src-')).length === 1);

  check('clearFiles empties the store', (await NS.clearFiles()) === true && (await NS.loadFiles()).length === 0);
}

/* ---------- 2) half-written file → treated as absent (no corrupt PDF) ---------- */
{
  const opfs = new Map();
  const { NS } = await loadSession({ opfsFiles: opfs });
  await NS.saveFiles([{ name: 'a.pdf', bytes: bytes(2048, 11) }]);
  const key = [...opfs.keys()].find((k) => k.startsWith('src-'));
  opfs.delete(key);                                        // simulate power-loss mid-write
  check('missing part ⇒ loadFiles returns nothing instead of a broken PDF', (await NS.loadFiles()).length === 0);
}

/* ---------- 3) IndexedDB fallback (browser without OPFS) ---------- */
{
  const { NS } = await loadSession({ opfsFiles: null });
  check('no OPFS ⇒ still supported', NS.supported() === true && NS.opfs() === false);
  const b = bytes(3000, 13);
  check('saveFiles falls back to IndexedDB', (await NS.saveFiles([{ name: 'fallback.pdf', bytes: b }])) === true);
  const back = await NS.loadFiles();
  check('IDB fallback round-trips the bytes', back.length === 1 && same(back[0].bytes, b));

  const saved = bytes(1500, 17);
  await NS.saveResult({ bytes: saved, name: 'out.pdf', kind: '2up', info: { in: 4, out: 2, meta: 'meta text' } });
  const meta = await NS.loadResultMeta();
  check('IDB fallback keeps the result too', same(await NS.resultBytes(), saved) && meta.name === 'out.pdf' && meta.info.out === 2);
}

/* ---------- 4) options snapshot / restore ---------- */
{
  const { NS } = await loadSession({ opfsFiles: new Map() });
  const mkEl = (id, type, value, checked) => ({ id, type, value: String(value), checked: !!checked });
  const form = [
    mkEl('optPaper', 'select-one', 'a4', false),
    mkEl('optMargin', 'number', '8', false),
    mkEl('gapAuto', 'radio', 'on', true),
    mkEl('gapFixed', 'radio', 'on', false),
    mkEl('optLines', 'checkbox', 'on', true),
    mkEl('numStart', 'number', '21', false),
    mkEl('fileInput', 'file', '', false)
  ];
  const snap = NS.snapshot(form);
  check('snapshot skips file inputs', snap.fileInput === undefined && snap.optPaper.v === 'a4');
  check('snapshot keeps radio/checkbox as booleans', snap.optLines.v === true && snap.gapAuto.v === true);
  await NS.saveOpts(snap);

  const fresh = [
    mkEl('optPaper', 'select-one', 'letter', false),
    mkEl('optMargin', 'number', '12', false),
    mkEl('gapAuto', 'radio', 'on', false),
    mkEl('gapFixed', 'radio', 'on', true),
    mkEl('optLines', 'checkbox', 'on', false),
    mkEl('numStart', 'number', '1', false)
  ];
  const loaded = await NS.loadOpts();
  const n = NS.apply(loaded, fresh);
  check('apply restores every control (6 changed)', n === 6, 'applied=' + n);
  check('values + toggles land correctly',
    fresh[0].value === 'a4' && fresh[1].value === '8' && fresh[2].checked === true &&
    fresh[3].checked === false && fresh[4].checked === true && fresh[5].value === '21');
  check('apply is idempotent (second call changes nothing)', NS.apply(loaded, fresh) === 0);
}

/* ---------- 5) finished result: reload → instant card ---------- */
{
  const opfs = new Map();
  const { NS } = await loadSession({ opfsFiles: opfs });
  const out = bytes(5000, 19);
  await NS.saveResult({ bytes: out, name: 'notes-2up-A4.pdf', kind: 'print', info: { in: 40, out: 20, meta: 'rs-meta' } });
  const meta = await NS.loadResultMeta();
  check('result meta keeps name/kind/size/info', meta.name === 'notes-2up-A4.pdf' && meta.kind === 'print' &&
    meta.size === out.length && meta.info.meta === 'rs-meta');
  check('result bytes come back identical', same(await NS.resultBytes(), out));
  const u1 = await NS.resultUrl(), u2 = await NS.resultUrl();
  check('resultUrl is a stable object URL (cached)', typeof u1 === 'string' && u1 === u2, u1 && u1.slice(0, 12));
  await NS.saveResult({ bytes: bytes(700, 23), name: 'newest.pdf', kind: 'vector' });
  check('saving a newer result replaces the old one', (await NS.loadResultMeta()).name === 'newest.pdf' &&
    [...opfs.keys()].filter((k) => k.startsWith('out-')).length === 1);
  await NS.clearResult();
  check('clearResult wipes meta + bytes + URL cache', (await NS.loadResultMeta()) === null && (await NS.resultBytes()) === null);
}

/* ---------- 6) interrupted run: checkpoints ---------- */
{
  const { NS } = await loadSession({ opfsFiles: new Map() });
  const sig = '150|ink|1|0';
  let begun = await NS.runBegin(sig, 5, 'print');
  check('runBegin on a fresh run: nothing to reuse', begun.reused === false && begun.have === 0);
  await NS.pagePut(0, bytes(1200, 29));
  await NS.pagePut(1, bytes(1300, 31));
  await NS.pagePut(2, bytes(1400, 37));
  await NS.runSave({ phase: 'render', page: 3, pages: 5, kind: 'print' });
  const st = await NS.pageStats();
  check('pageStats counts checkpoints + bytes', st.count === 3 && st.bytes === 3900, JSON.stringify(st));
  check('the checkpoint survives as a real page read', same(await NS.pageGet(1), bytes(1300, 31)));
  const run = await NS.runLoad();
  check('run meta remembers where it stopped', run.page === 3 && run.pages === 5 && run.sig === sig && run.kind === 'print');
  begun = await NS.runBegin(sig, 5, 'print');
  check('same settings ⇒ pages are reused (this is the "continue" path)', begun.reused === true && begun.have === 3);
  check('runSave merges instead of dropping the signature', (await NS.runLoad()).sig === sig);
  begun = await NS.runBegin('220|pure|0|0', 5, 'print');
  check('changed settings ⇒ stale checkpoints are dropped', begun.reused === false && (await NS.pageStats()).count === 0 &&
    (await NS.pageGet(0)) === null);
  await NS.runClear();
  check('runClear removes meta + every page file', (await NS.runLoad()) === null && (await NS.pageStats()).count === 0);
}

/* ---------- 7) clearAll + toFile ---------- */
{
  const opfs = new Map();
  const { NS } = await loadSession({ opfsFiles: opfs });
  await NS.saveFiles([{ name: 'x.pdf', bytes: bytes(800, 41) }]);
  await NS.saveOpts({ optPaper: { t: 'select-one', v: 'a4' } });
  await NS.saveResult({ bytes: bytes(600, 43), name: 'o.pdf' });
  await NS.pagePut(0, bytes(300, 47));
  await NS.runSave({ phase: 'render', page: 1, pages: 2 });
  await NS.clearAll();
  const left = [...opfs.keys()].filter((k) => /^(src|out|run)-/.test(k));
  check('clearAll wipes files, result, checkpoints, options and every blob',
    (await NS.loadFiles()).length === 0 && (await NS.loadResultMeta()) === null &&
    (await NS.loadOpts()) === null && (await NS.runLoad()) === null && left.length === 0, 'left=' + left.join(','));

  const f = NS.toFile({ name: 'again.pdf', bytes: bytes(1200, 53) });
  const buf = await f.arrayBuffer();
  check('toFile brings bytes back onto the normal intake path',
    f.name === 'again.pdf' && f.size === 1200 && same(new Uint8Array(buf), bytes(1200, 53)));
}

/* ---------- 8) wiring: the three apps really use the engine ---------- */
{
  const { readFileSync } = await import('node:fs');
  const apps = [
    { name: 'app.js', tag: 'app.js?v=' },
    { name: 'app4up.js', tag: 'app4up.js?v=' },
    { name: 'app-invert.js', tag: 'app-invert.js?v=' }
  ];
  const htmls = ['index.html', '4up.html', 'invert.html'];
  const need = ['NotesSession.init()', 'NotesSession.loadFiles()', 'NotesSession.saveFiles(',
    'NotesSession.loadOpts()', 'NotesSession.apply(', 'NotesSession.autoSaveOpts(',
    'NotesSession.saveResult(', 'NotesSession.runBegin(', 'NotesSession.pageGet(',
    'NotesSession.pagePut(', 'NotesSession.runSave(', 'NotesSession.runClear()',
    'NotesSession.pageStats()', 'NotesSession.resultUrl()', 'NotesSession.toFile('];
  for (const a of apps) {
    const src = readFileSync(new URL('../' + a.name, import.meta.url), 'utf8');
    const missing = need.filter((n) => src.indexOf(n) < 0);
    check('wiring: ' + a.name + ' calls every session API', missing.length === 0, missing.join(' '));
    check('wiring: ' + a.name + ' resumes a run from the checkpoint (Continue button)',
      src.indexOf("sessGo.addEventListener('click'") > 0 && src.indexOf('run.phase') > 0);
    check('wiring: ' + a.name + ' knows when it is restoring (no re-save loop)',
      /var restoring = false/.test(src) && /!restoring/.test(src));
  }
  for (const h of htmls) {
    const src = readFileSync(new URL('../' + h, import.meta.url), 'utf8');
    check('markup: ' + h + ' has the session bar with Continue + Forget',
      /id="sessBar"/.test(src) && /id="sessGo"/.test(src) && /id="sessForget"/.test(src) && /id="sessMsg"/.test(src));
    const si = src.indexOf('session.js?v='), ci = src.indexOf('converter.js?v=');
    check('markup: ' + h + ' loads session.js before the app', si > 0 && ci > 0 && si < ci);
    const appTag = src.match(/<script src="app[^"]*"/);
    const v = appTag && appTag[0].match(/v=(\d+)/);
    const sv = src.match(/session\.js\?v=(\d+)/);
    check('markup: ' + h + ' cache-busts app + session together', !!v && !!sv && v[1] === sv[1], 'app v' + (v && v[1]));
  }
  // the colour-style / flip-style explanations must be scannable bullets, not a wall of text
  {
    // every dense explanation is a bullet list; count them per page
    const expect = {
      'index.html': { lists: 6, bullets: 18 },   // + White paper
      '4up.html': { lists: 6, bullets: 18 },
      'invert.html': { lists: 5, bullets: 20 }   // + Overlays (ruled lines · separator · numbers) + band-keep + pure-b&w vector
    };
    for (const h of htmls) {
      const src = readFileSync(new URL('../' + h, import.meta.url), 'utf8');
      const lists = [...src.matchAll(/<ul class="note-list">([\s\S]*?)<\/ul>/g)];
      const items = lists.reduce((n, m) => n + (m[1].match(/<li>/g) || []).length, 0);
      check('markup: ' + h + ' explains the settings as bullet points (' + lists.length + ' lists / ' + items + ' bullets)',
        lists.length === expect[h].lists && items === expect[h].bullets, lists.length + '/' + items);
      check('markup: ' + h + ' every bullet opens with a bold key word', lists.length > 0 &&
        lists.every((m) => (m[1].match(/<li><b>/g) || []).length === (m[1].match(/<li>/g) || []).length));
      check('markup: ' + h + ' dropped the old wall-of-text hints', !/K-cartridge output/.test(src) &&
        !/<small>Black ink flips/.test(src) && !/<small>Pages become full-page images/.test(src) &&
        !/<small><b>HQ engine v2:<\/b>/.test(src) && !/<small>0 = slides touch/.test(src) &&
        !/<small>0 = the demo look/.test(src));
      const switchCount = { 'index.html': 4, '4up.html': 5, 'invert.html': 7 }[h];   // + 3 overlay toggles + 2 band toggles
      check('markup: ' + h + ' every switch (toggle) has its own explanation', (() => {
        const rows = [...src.matchAll(/<label class="sw[^"]*"[^>]*>[\s\S]*?<\/label>/g)].map((m) => m[0]);
        return rows.length === switchCount && rows.every((r) => /<em>/.test(r));
      })(), 'switches');
    }
    const css2 = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    check('css: bullet list is styled (dot markers + muted text)', /\.note-list li::before/.test(css2) && /\.note-list li b\{/.test(css2));
  }

  // live-preview sharpness: renderers must target real device pixels (dpr), and
  // every preview sheet must offer the HD click-to-enlarge view
  {
    const fx = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
    check('preview: NotesFX exposes zoomSheet + closeZoom', /NotesFX\.zoomSheet = function/.test(fx) && /NotesFX\.closeZoom = zoomClose/.test(fx));
    check('preview: zoom overlay sizes itself to the viewport and caps the buffer',
      /Math\.min\(2, window\.devicePixelRatio/.test(fx) && /cssW \* dpr > 3600/.test(fx) && /maxW/.test(fx) && /maxH/.test(fx));
    check('preview: zoom cleans up (Esc / backdrop / ×) and releases the canvas',
      /e\.key === 'Escape'/.test(fx) && /zoomClose\(\)/.test(fx) && /cv\.width = cv\.height = 1/.test(fx));

    const shapes = [
      { f: 'app.js', dprMath: /box\.width \* pxPerPt \* dpr/, stale: /pxPerPt \* 1\.5\b|\* quality\)/ },
      { f: 'app4up.js', dprMath: /box\.width \* pxPerPt \* dpr/, stale: /pxPerPt \* 1\.25\b/ },
      { f: 'app-invert.js', dprMath: /Math\.round\(cssW \* dpr\)/, stale: /var sc = 320 \/ Math\.max\(1, vp\.width\)/ }
    ];
    for (const sh of shapes) {
      const src = readFileSync(new URL('../' + sh.f, import.meta.url), 'utf8');
      check('preview: ' + sh.f + ' renders at device-pixel density (dpr-aware)', sh.dprMath.test(src));
      check('preview: ' + sh.f + ' no longer uses the blurry fixed scale', !sh.stale.test(src));
      check('preview: ' + sh.f + ' wires click-to-enlarge on the sheets',
        /NotesFX\.zoomSheet\(/.test(src) && /wireZoom\(\)/.test(src) && /zoom-hint/.test(src));
      check('preview: ' + sh.f + ' draws with high-quality smoothing',
        /imageSmoothingQuality = 'high'/.test(src));
      if (sh.f === 'app-invert.js') {
        check('preview: Invert Lab zoom shows the right half (original vs flipped)',
          /which === 'flipped'/.test(src) && /paintInvertPreview\(scratch, cv, 1, cssW\)/.test(src));
      }
    }
    const css3 = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    check('preview: zoom overlay is styled + hidden when printing',
      /\.zoom-box\{/.test(css3) && /\.zoom-hint\{/.test(css3) && /@media print\{\.zoom-box/.test(css3));
  }

  // every option control must sit inside #workbench, otherwise it is never snapshotted
  for (const h of htmls) {
    const src = readFileSync(new URL('../' + h, import.meta.url), 'utf8');
    const start = src.indexOf('<div id="workbench"');
    let depth = 0, end = start;
    const re = /<\/?div\b[^>]*>/gi;
    re.lastIndex = start;
    let m;
    while ((m = re.exec(src))) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    const inside = src.slice(start, end);
    const ids = [...src.matchAll(/id="((?:opt|dpi|gap|np|nf|ns|ps|style|fmt|num)[A-Za-z0-9]+)"/g)].map((x) => x[1]);
    const outside = ids.filter((id) => inside.indexOf('id="' + id + '"') < 0);
    check('markup: ' + h + ' keeps all ' + ids.length + ' settings inside #workbench (they get restored)',
      ids.length > 8 && outside.length === 0, 'outside=' + outside.join(','));
  }

  // pipeline order: the result card (and its Download button) must be revealed as
  // soon as the bytes exist — previews and the reload-proof save come after it.
  // Rendering previews of a 100 MB print-saver output takes tens of seconds, and
  // users were left staring at "done" until it finished. See test/app-smoke.test.mjs
  // for the behavioural version of this check.
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const iReveal = src.indexOf('result.hidden = false;');
    const iSave = src.indexOf('NotesSession.saveResult(');
    const iThumbs = src.indexOf('renderThumbsSoon(');
    check('order: ' + f + ' starts previews only after the download link is set',
      iThumbs > 0, 'renderThumbsSoon at ' + iThumbs);
    check('order: ' + f + ' reveals the result before the session save',
      iReveal > 0 && iSave > 0 && iReveal < iSave, 'reveal ' + iReveal + ' < save ' + iSave);
    check('order: ' + f + ' never awaits previews on the critical path',
      !/await makeThumbs\((res\.bytes|saved|vres\.bytes)/.test(src) &&
      !/await makeThumbs\(/.test(src.slice(iThumbs)) );
    check('order: ' + f + ' the save is queued, not awaited',
      /\.then\(function \(\) \{[\s\S]{0,220}NotesSession\.runClear\(\)/.test(src) || f === 'app-invert.js');
  }

  // responsiveness: the long pixel work must be driven in bands, never as one
  // synchronous block — a frozen tab ("Page Unresponsive") is a bug report.
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('responsive: ' + f + ' drives the maps in bands (async twin)',
      /hqMapAsync\(|negMapAsync\(/.test(src), f);
    check('responsive: ' + f + ' never reads the whole supersampled canvas at once',
      !/getImageData\(0, 0, cv\.width, cv\.height\)/.test(src));
    check('responsive: ' + f + ' reads it band by band',
      /getImageData\(0, y0,/.test(src));
    check('responsive: ' + f + ' lets the browser paint between bands',
      /await NotesFX\.uiPaint\(\)/.test(src));
  }
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('strips: ' + f + ' renders the page in whole-pixel strips (offsetY), not one 32 Mpx draw',
      /offsetY: -y0/.test(src) && /stripRows/.test(src));
    check('strips: ' + f + ' keeps a full-page fallback if a strip render fails',
      /falling back to a full-page render|strip rendering unavailable/.test(src) || f === 'app-invert.js');
  }
  // heavy pixel work runs in a worker; the main thread must only orchestrate
  for (const f of ['index.html', '4up.html', 'invert.html']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const ci = src.indexOf('converter.js?v=');
    const ri = src.indexOf('raster-client.js?v=');
    check('worker: ' + f + ' loads the raster client after the converter core',
      ci > 0 && ri > ci && /app.*\.js\?v=\d+/.test(src), 'client @' + ri);
  }
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('worker: ' + f + ' tries the worker before its own main-thread pipeline',
      /NotesRaster\.supported\(\)/.test(src) && /NotesRaster\.mapPage\(/.test(src));
    check('worker: ' + f + ' falls back to the main thread when the worker cannot help',
      /catch \(err\) \{[\s\S]{0,220}raster worker could not do this page/.test(src));
  }
  const cli = readFileSync(new URL('../raster-client.js', import.meta.url), 'utf8');
  const wrk = readFileSync(new URL('../worker-raster.js', import.meta.url), 'utf8');
  check('worker: the worker reuses the converter map pieces (no second implementation)',
    /printSaver\.pieces/.test(wrk) && /importScripts\('converter\.js'\)/.test(wrk));
  check('worker: the client never lets a dead worker break a conversion',
    /dead = true/.test(cli) && /dropPending/.test(cli) && /raster worker unavailable/.test(cli));
  check('worker: buffers are transferred, not copied',
    /\[buf\]/.test(cli) && /\[cfg\.rgba\.buffer\]/.test(cli));

  // the preview column must not be one tall empty card next to the long options
  // column: it sticks to the viewport and lists every sheet/page underneath
  for (const h of ['index.html', '4up.html', 'invert.html']) {
    const src = readFileSync(new URL('../' + h, import.meta.url), 'utf8');
    const prevCard = src.slice(src.indexOf('<div class="card prev">'));
    check('preview column: ' + h + ' has the strip of every sheet/page inside the preview card',
      /<div class="prev-strip" id="prevStrip"/.test(prevCard.slice(0, 1200)), h);
  }
  const cssPrev = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  check('preview column: the options column no longer stretches the preview card',
    /\.cols\{[^}]*align-items:start/.test(cssPrev));
  check('preview column: the preview card sticks below the topbar (and stops on small screens)',
    /\.card\.prev\{position:sticky;top:calc\(var\(--topbar/.test(cssPrev) &&
    /@media \(max-width:920px\)\{\.card\.prev\{position:static\}\}/.test(cssPrev));
  check('preview column: the strip has its own tile grid, skeletons and note styling',
    /\.prev-strip\{display:grid/.test(cssPrev) && /\.prev-strip \.thumb-sk/.test(cssPrev) && /\.prev-strip \.thumb-note/.test(cssPrev));
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('preview column: ' + f + ' fills the strip one tile at a time, cancellable',
      /renderSheetStrip\(gen\)|renderPageStrip\(gen\)/.test(src) &&
      /my !== stripToken \|\| gen !== state\.gen/.test(src) &&
      /strip\.place\(fig, /.test(src));
    check('preview column: ' + f + ' pauses the strip while a conversion is running',
      /goBtn\.disabled\) return;/.test(src));
  }

  // the wait must be legible, and the preview strip must not fight a running job
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('wait: ' + f + ' shows a time-left estimate, in its own chip',
      /var etaText = function/.test(src) && /NotesFX\.eta/.test(src) && /etaText\(/.test(src) &&
      /setEta\(eta\);/.test(src) && !/etaOf/.test(src));
    check('wait: ' + f + ' marks a running conversion and pauses the strip for it',
      /state\.running = true/.test(src) && /state\.running\) \{[\s\S]{0,160}strip\.prune\(/.test(src));
    check('wait: ' + f + ' finishes the paused strip once the result is on screen',
      /resumePreviewStrip\(\);/.test(src) && /state\.stripPaused = false/.test(src));
    check('wait: ' + f + ' clears the running flag on every exit (success and failure)',
      (src.match(/goBtn\.disabled = false;/g) || []).length >= 1 &&
      (src.match(/state\.running = false;/g) || []).length >= 1);
  }
  // a hidden tab must cost less: no frames, no live preview, no cosmetic thumbnails
  const fxBg = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  check('background: uiPaint short-circuits when the tab is hidden',
    /typeof requestAnimationFrame !== 'function' \|\| document\.hidden\) return NotesFX\.uiYield\(\)/.test(fxBg));
  check('background: helpers exist to park cosmetic work until the tab returns',
    /NotesFX\.whenVisible = function/.test(fxBg) && /NotesFX\.parkWhileHidden = function/.test(fxBg) &&
    /visibilitychange/.test(fxBg));
  check('background: the live preview is skipped while hidden (nothing to show)',
    /if \(document\.hidden\) return;\s+\/\/ hidden tab/.test(fxBg));
  check('background: the tab title is NOT skipped (it is the only progress a hidden tab shows)',
    !/nobody can see the title now/.test(fxBg) && /_titleAt/.test(fxBg));
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('background: ' + f + ' parks the sheet/page strip while the tab is hidden',
      /if \(document\.hidden\) \{[\s\S]{0,180}strip\.prune\(/.test(src) &&
      /NotesFX\.whenVisible\(\)\.then/.test(src));
    check('background: ' + f + ' parks the result thumbnails too',
      /await NotesFX\.parkWhileHidden\(\)/.test(src));
  }

  // the tab title is the only progress a background tab can show: it must keep
  // updating while hidden (it used to bail out, which looked like a frozen run)
  const fxT = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  check('wait: the tab title is not gated on visibility (it is the cross-tab dial)',
    /NotesFX\.titleProgress = function \(done, total, label, eta\)/.test(fxT) &&
    !/titleProgress = function[\s\S]{0,220}if \(document\.hidden\) return;/.test(fxT) &&
    /_titleAt/.test(fxT) && /if \(now - _titleAt < 250\) return;/.test(fxT));
  check('wait: the title never prints NaN when a total is missing',
    /total > 0 \? Math\.round\(done \/ total \* 100\) : 0/.test(fxT));
  check('wait: the tab title carries the estimate too, so a hidden tab sees both numbers',
    /replace\(\/\\s\*left\$\/, ''\)/.test(fxT) && /short \? ' \\u00b7 ' \+ short : ''/.test(fxT));
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check('wait: ' + f + ' reports every phase through one setStep (bar + status + chip + title agree)',
      (src.match(/setStep\(/g) || []).length >= 4 && (src.match(/etaText\(/g) || []).length === 1 &&
      /pStatus\.textContent = text;/.test(src));
    check('wait: ' + f + ' refreshes the estimate once a second',
      /ticker = setInterval\(function \(\) \{[\s\S]{0,160}setStep\(lastStep\.frac/.test(src));
    const exits = (src.match(/goBtn\.disabled = false;/g) || []).length;
    check('wait: ' + f + ' stops the ticker on every exit (' + exits + ' exits)',
      (src.match(/stopTicker\(\);/g) || []).length >= exits - 1);
    check('wait: ' + f + ' never appends an estimate to "done"',
      /if \(frac >= 0\.999\) return '';/.test(src));
  }
  // the estimate must be readable at a glance, not buried in a long sentence:
  // its own chip next to the bar, styled, and hidden while it has nothing to say
  {
    const chips = ['index.html', '4up.html', 'invert.html'].every((h) =>
      /<span class="p-eta" id="pEta"><\/span>/.test(readFileSync(new URL('../' + h, import.meta.url), 'utf8')));
    const cssEta = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    check('wait: every page has a dedicated estimate chip next to the progress bar',
      chips && /\.p-eta\{/.test(cssEta) && /\.p-eta:empty\{display:none\}/.test(cssEta));
    check('wait: the chip is dimmed while it still says "estimating"',
      /\.p-eta\.est\{/.test(cssEta) && /'p-eta' \+ \(eta && !etaReady \? ' est' : ''\)/.test(
        readFileSync(new URL('../app4up.js', import.meta.url), 'utf8')));
  }
  // a hidden tab fires no frames, and pdf.js drives every render chunk with
  // requestAnimationFrame — the run used to freeze at "19%" until the tab was
  // looked at again, while the ticker kept growing the estimate
  for (const f of ['app.js', 'app4up.js', 'app-invert.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const on = (src.match(/NotesFX\.keepRendering\(true\);/g) || []).length;
    const off = (src.match(/NotesFX\.keepRendering\(false\);/g) || []).length;
    check('hidden frames: ' + f + ' hooks the frame fallback for exactly the length of a run',
      on >= 1 && off >= 1 &&
      on === (src.match(/state\.running = true;/g) || []).length &&
      off === (src.match(/state\.running = false;/g) || []).length);
    check('hidden frames: ' + f + ' says "still working" instead of growing a number that cannot be true',
      /etaMoveFrac/.test(src) && /etaMoveAt/.test(src) && /STUCK_MS/.test(src) &&
      /if \(now - etaMoveAt > STUCK_MS\) return 'still working…';/.test(src));
    check('wait: ' + f + ' never leaves a stale estimate behind on failure',
      (src.match(/setEta\(''\);/g) || []).length >= (src.match(/failed: /g) || []).length);
  }
  // White paper: paper stays paper, everything else becomes ink — a style that
  // must exist on all three pages and survive the whole trip to the worker
  {
    for (const [h, id] of [['index.html', 'psWhite'], ['4up.html', 'psWhite'], ['invert.html', 'styleWhite']]) {
      const src = readFileSync(new URL('../' + h, import.meta.url), 'utf8');
      check('white paper: ' + h + ' offers the style and explains it',
        new RegExp('id="' + id + '"').test(src) && /<b>White paper/.test(src) &&
        /paper is left exactly as it is/.test(src) &&
        /dark area[\s\S]{0,220}blackboard panel/.test(src));   // the board rule must be promised too
    }
    const cv = readFileSync(new URL('../converter.js', import.meta.url), 'utf8');
    check('white paper: the core has the rule and its own paper/content band',
      /var PS_WHITE_HI = 200;/.test(cv) && /var PS_WHITE_LO = 90;/.test(cv) &&
      /function hqFinishB\(acc, r0, r1, st, out, keepColour, pure, white\)/.test(cv) &&
      /if \(maxC\[p\] > PS_CHROMA\) v = 0;[\s\S]{0,220}else if \(L >= PS_WHITE_HI\) v = 255;/.test(cv));
    for (const f of ['app.js', 'app4up.js']) {
      const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
      check('white paper: ' + f + ' passes the style to the map and to the worker',
        /sWhite: \$\('psWhite'\)/.test(src) && /st === 'white'/.test(src) &&
        /pure: st === 'pure', white: st === 'white'/.test(src) &&
        /hqMapAsync\(provider, bw, bh, W, H, printAuto\(\), st === 'keep', st === 'pure', hooks, st === 'white'\)/.test(src));
    }
    const inv = readFileSync(new URL('../app-invert.js', import.meta.url), 'utf8');
    check('white paper: app-invert.js resolves the style and carries the flag everywhere',
      /function whiteMode\(\)/.test(inv) && /white: whiteMode\(\)/.test(inv) &&
      /pureMode\(\), hook, whiteMode\(\)\)/.test(inv) && /pureMode\(\),\n        \{ band: 192/.test(inv));
    const wrk = readFileSync(new URL('../worker-raster.js', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../raster-client.js', import.meta.url), 'utf8');
    check('white paper: the worker and its client carry the flag (a dropped flag looks like "the mode does nothing")',
      /\!\!o\.keepColour, \!\!o\.pure, \!\!o\.white/.test(wrk) && /white: \!\!cfg\.white/.test(cli) &&
      /white, trackBlank/.test(wrk));
  }

  const wrkSrc = readFileSync(new URL('../worker-raster.js', import.meta.url), 'utf8');
  check('wait: worker progress reports the page height, not the message (the NaN bug)',
    /total: job\.o\.bh/.test(wrkSrc) && !/progress', id: m\.id, done: job\.fed, total: m\.bh/.test(wrkSrc));

  const fxFrames = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  check('hidden frames: enhance.js explains and fixes the pdf.js stall (rAF never fires when hidden)',
    /InternalRenderTask/.test(fxFrames) && /NotesFX\.keepRendering = function/.test(fxFrames) &&
    /function _rafShim/.test(fxFrames) && /if \(!document\.hidden && _raf0\) return _raf0\(cb\)/.test(fxFrames));
  check('hidden frames: the fallback is a message-channel macrotask, paced so it cannot spin the CPU',
    /_frameChan = typeof MessageChannel !== 'undefined'/.test(fxFrames) &&
    /if \(_frameChan\) _frameChan\.port2\.postMessage\(0\);/.test(fxFrames) &&
    /else setTimeout\(_frameRun, 16\);/.test(fxFrames) &&          // the timer only as a last resort
    /if \(document\.hidden && now - _frameAt < 4\) \{ _frameArm\(\); return; \}/.test(fxFrames) &&
    /var _rafOrig = \(typeof requestAnimationFrame === 'function'\) \? requestAnimationFrame : null;/.test(fxFrames));

  const fx2 = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  check('wait: NotesFX.eta formats seconds and minutes, and never prints NaN',
    /NotesFX\.eta = function/.test(fx2) && /almost done/.test(fx2) && /s left/.test(fx2) && /min/.test(fx2));
  check('wait: the live panel explains that the tiles are thumbnails',
    /nfx-live-sub/.test(fx2) && /quick thumbnails/.test(fx2));
  check('wait: thumbStrip can prune the slots it did not fill',
    /prune: function/.test(fx2) && /drop the still-empty slots/.test(fx2));

  const fxPaint = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  check('responsive: enhance.js exposes uiPaint (a yield that really paints)',
    /NotesFX\.uiPaint = function/.test(fxPaint) && /requestAnimationFrame/.test(fxPaint) && /setTimeout\(fin, 120\)/.test(fxPaint));
  const conv = readFileSync(new URL('../converter.js', import.meta.url), 'utf8');
  check('responsive: converter.js exports the banded map twins',
    /hqMapAsync: hqMapAsync/.test(conv) && /negMapAsync: negMapAsync/.test(conv));
  check('responsive: the maps share one maths body with the one-shot versions',
    /function hqFeed\(/.test(conv) && /function hqFinishA\(/.test(conv) && /function hqFinishB\(/.test(conv) &&
    /function negFeed\(/.test(conv) && /function negFinishB\(/.test(conv));

  // previews leave a placeholder grid behind while they render
  const fx = readFileSync(new URL('../enhance.js', import.meta.url), 'utf8');
  const css2 = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  check('previews: NotesFX.thumbStrip builds placeholders + a hint line',
    /NotesFX\.thumbStrip = function/.test(fx) && /thumb-sk/.test(fx) && /thumb-note/.test(fx));
  check('previews: skeletons are styled (and animation respects reduced motion)',
    /\.thumbs \.thumb-sk,?\.prev-strip \.thumb-sk\{|\.thumbs \.thumb-sk,\.prev-strip \.thumb-sk\{/.test(css2) &&
    /@keyframes thumbshine/.test(css2) && /prefers-reduced-motion[\s\S]{0,120}\.thumb-sk/.test(css2));
}

console.log('\n' + (fail === 0 ? 'ALL SESSION CHECKS PASSED' : fail + ' SESSION CHECK(S) FAILED') +
  '  (' + pass + ' passed)\n');
process.exit(fail === 0 ? 0 : 1);
