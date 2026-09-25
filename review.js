/* ============ Notes2A4 · Page Review — big per-page preview + delete unwanted pages ============
 * Shared by all three tools (2-up, 4-up, Invert Lab). Fully standalone:
 *   - injects a "Review pages" button into the .filebar (next to ✕ remove)
 *   - fullscreen overlay: ONE page at a time, rendered large
 *   - keyboard: ← / → move · Delete / Backspace toggle-remove · Enter keep + next · A apply · Esc close
 *   - Apply rebuilds the PDF (pdf-lib copyPages, vector 1:1 — no re-render) and feeds it
 *     back through the tool's own #fileInput, so every badge/preview refreshes naturally.
 * API used by the apps:  PageReview.setSource(bytes /*Uint8Array*\/, name)
 */
(function () {
  'use strict';
  var BUILD = 2;
  console.info('[Notes2A4] review.js build', BUILD, '· page review + delete');

  var $ = function (id) { return document.getElementById(id); };

  var src = { bytes: null, name: '', doc: null, pages: 0 };
  var ui = null;                 // overlay DOM refs, created lazily
  var cur = 0;                   // 0-based current page
  var removed = null;            // Uint8Array flags per page
  var renderGen = 0;
  var cache = {};                // pageIndex -> canvas (small LRU)
  var cacheOrder = [];

  /* ---------- styles ---------- */
  function injectCSS() {
    if ($('pr-style')) return;
    var css = [
      '.pr-overlay{position:fixed;inset:0;z-index:1000;background:rgba(8,10,18,.92);backdrop-filter:blur(6px);display:flex;flex-direction:column;font-family:inherit}',
      '.pr-top{display:flex;align-items:center;gap:.8rem;padding:.7rem 1.1rem;flex-wrap:wrap}',
      '.pr-name{font-weight:700;color:#e8ecf5;font-size:.95rem;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pr-count{color:#9aa7bd;font-size:.9rem}',
      '.pr-count b{color:#e8ecf5}',
      '.pr-chip-del{background:#7f1d1d;color:#fecaca;padding:.15rem .6rem;border-radius:999px;font-size:.8rem;font-weight:700}',
      '.pr-top .sp{flex:1}',
      '.pr-btn{cursor:pointer;border:1px solid #3a4356;background:#1b2130;color:#dbe3f0;border-radius:10px;padding:.5rem .95rem;font:600 .88rem/1 system-ui;display:inline-flex;align-items:center;gap:.4rem}',
      '.pr-btn:hover{background:#242c3f}',
      '.pr-btn:disabled{opacity:.45;cursor:default}',
      '.pr-btn.pr-danger{border-color:#b91c1c;background:#3d1113;color:#fda4a4}',
      '.pr-btn.pr-danger:hover{background:#541618}',
      '.pr-btn.pr-apply{border-color:#15803d;background:#0f2e1c;color:#86efac}',
      '.pr-btn.pr-apply:hover{background:#154227}',
      '.pr-stage{flex:1;display:flex;align-items:center;justify-content:center;gap:1rem;min-height:0;padding:0 1rem}',
      '.pr-nav{width:52px;height:92px;border-radius:14px;border:1px solid #3a4356;background:#161c2a;color:#cbd5e6;font-size:1.6rem;cursor:pointer;flex:none}',
      '.pr-nav:hover{background:#212a3d}.pr-nav:disabled{opacity:.25;cursor:default}',
      '.pr-frame{position:relative;max-height:100%;display:flex;align-items:center;justify-content:center}',
      '.pr-frame canvas{max-width:100%;max-height:76vh;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.6);background:#fff}',
      '.pr-frame.pr-removed canvas{opacity:.32;filter:grayscale(.9)}',
      '.pr-x{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none}',
      '.pr-frame.pr-removed .pr-x{display:flex}',
      '.pr-x span{background:#b91c1c;color:#fff;font:800 1rem/1 system-ui;padding:.7rem 1.2rem;border-radius:12px;letter-spacing:.04em;box-shadow:0 8px 30px rgba(0,0,0,.5)}',
      '.pr-bottom{display:flex;align-items:center;justify-content:center;gap:.9rem;padding:.75rem 1rem 1rem;flex-wrap:wrap}',
      '.pr-jump{width:70px;background:#141a28;border:1px solid #3a4356;color:#e8ecf5;border-radius:8px;padding:.45rem .5rem;font:600 .9rem system-ui;text-align:center}',
      '.pr-keys{color:#6c7891;font-size:.78rem}',
      '.pr-keys kbd{background:#1d2434;border:1px solid #39445c;border-bottom-width:2px;border-radius:5px;padding:.1rem .4rem;color:#aeb9cf;font:600 .74rem system-ui}',
      '.pr-peek{animation:prpeek .6s ease 2}@keyframes prpeek{50%{box-shadow:0 0 0 3px rgba(74,222,128,.45);transform:translateY(-2px)}}.pr-loading::after{content:"";position:absolute;width:38px;height:38px;border-radius:50%;border:3px solid #3a4356;border-top-color:#8ab4ff;animation:prspin .8s linear infinite}',
      '@keyframes prspin{to{transform:rotate(360deg)}}',
      '@media (max-width:700px){.pr-nav{width:40px;height:64px}.pr-frame canvas{max-height:62vh}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'pr-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- overlay DOM ---------- */
  function buildUI() {
    if (ui) return;
    injectCSS();
    var ov = document.createElement('div');
    ov.className = 'pr-overlay'; ov.hidden = true;
    ov.innerHTML =
      '<div class="pr-top">' +
        '<span class="pr-name" id="prName"></span>' +
        '<span class="pr-count">page <b id="prCur">1</b> / <b id="prTotal">1</b></span>' +
        '<span class="pr-chip-del" id="prDelCount" hidden>0 removed</span>' +
        '<span class="sp"></span>' +
        '<button class="pr-btn pr-danger" id="prRemove" type="button">🗑 Remove page <kbd style="opacity:.7">Del</kbd></button>' +
        '<button class="pr-btn pr-apply" id="prApply" type="button">✓ Apply — keep <span id="prKeep">all</span> <kbd style="opacity:.7">A</kbd></button>' +
        '<button class="pr-btn" id="prClose" type="button">✕ Close</button>' +
      '</div>' +
      '<div class="pr-stage">' +
        '<button class="pr-nav" id="prPrev" type="button" aria-label="Previous page">‹</button>' +
        '<div class="pr-frame" id="prFrame"><canvas id="prCanvas"></canvas>' +
          '<div class="pr-x"><span>REMOVED — Del restores · Enter keeps</span></div></div>' +
        '<button class="pr-nav" id="prNext" type="button" aria-label="Next page">›</button>' +
      '</div>' +
      '<div class="pr-bottom">' +
        '<label class="pr-count">go to <input class="pr-jump" id="prJump" type="number" min="1" step="1"></label>' +
        '<span class="pr-keys"><kbd>←</kbd><kbd>→</kbd> move &nbsp; <kbd>Del</kbd>/<kbd>⌫</kbd> remove/restore &nbsp; <kbd>Enter</kbd> keep → next &nbsp; <kbd>A</kbd> apply &nbsp; <kbd>Esc</kbd> close</span>' +
      '</div>';
    document.body.appendChild(ov);
    ui = {
      ov: ov, name: $('prName'), cur: $('prCur'), total: $('prTotal'),
      delCount: $('prDelCount'), keep: $('prKeep'),
      remove: $('prRemove'), apply: $('prApply'), close: $('prClose'),
      prev: $('prPrev'), next: $('prNext'), frame: $('prFrame'),
      canvas: $('prCanvas'), jump: $('prJump')
    };
    ui.prev.addEventListener('click', function () { go(cur - 1); });
    ui.next.addEventListener('click', function () { go(cur + 1); });
    ui.remove.addEventListener('click', toggleRemove);
    ui.close.addEventListener('click', close);
    ui.apply.addEventListener('click', apply);
    ui.jump.addEventListener('change', function () {
      var v = parseInt(ui.jump.value, 10);
      if (v >= 1 && v <= src.pages) go(v - 1);
    });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!ui || ui.ov.hidden) return;
    if (e.target === ui.jump) { if (e.key === 'Escape') { ui.jump.blur(); e.preventDefault(); } return; }
    var k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') { go(cur + 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { go(cur - 1); }
    else if (k === 'Delete' || k === 'Backspace') { toggleRemove(); }
    else if (k === 'Home') { go(0); }
    else if (k === 'End') { go(src.pages - 1); }
    else if (k === 'Enter') { keepNext(); }
    else if (k === 'a' || k === 'A') { apply(); }
    else if (k === 'Escape') { close(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }

  /* ---------- rendering ---------- */
  function evictCache() {
    while (cacheOrder.length > 6) { var k = cacheOrder.shift(); delete cache[k]; }
  }

  async function renderInto(idx) {
    var gen = ++renderGen;
    ui.frame.classList.add('pr-loading');
    try {
      var c = cache[idx];
      if (!c) {
        var pg = await src.doc.getPage(idx + 1);
        var v1 = pg.getViewport({ scale: 1 });
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var scale = Math.min((window.innerWidth * 0.7) / v1.width, (window.innerHeight * 0.76) / v1.height) * dpr;
        scale = Math.max(scale, 0.4);
        var vp = pg.getViewport({ scale: scale });
        c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        var cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: cx, viewport: vp }).promise;
        pg.cleanup();
        cache[idx] = c; cacheOrder.push(idx); evictCache();
      }
      if (gen !== renderGen) return;
      ui.canvas.width = c.width; ui.canvas.height = c.height;
      ui.canvas.getContext('2d').drawImage(c, 0, 0);
    } finally {
      if (gen === renderGen) ui.frame.classList.remove('pr-loading');
    }
    // preload neighbours quietly
    [idx + 1, idx - 1].forEach(function (n) {
      if (n < 0 || n >= src.pages || cache[n]) return;
      src.doc.getPage(n + 1).then(function (pg) {
        var v1 = pg.getViewport({ scale: 1 });
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var scale = Math.max(Math.min((window.innerWidth * 0.7) / v1.width, (window.innerHeight * 0.76) / v1.height) * dpr, 0.4);
        var vp = pg.getViewport({ scale: scale });
        var c2 = document.createElement('canvas');
        c2.width = Math.round(vp.width); c2.height = Math.round(vp.height);
        var cx2 = c2.getContext('2d');
        cx2.fillStyle = '#fff'; cx2.fillRect(0, 0, c2.width, c2.height);
        return pg.render({ canvasContext: cx2, viewport: vp }).promise.then(function () {
          pg.cleanup(); cache[n] = c2; cacheOrder.push(n); evictCache();
        });
      }).catch(function () {});
    });
  }

  function refreshHUD() {
    ui.cur.textContent = cur + 1;
    ui.total.textContent = src.pages;
    var del = 0;
    for (var i = 0; i < src.pages; i++) if (removed[i]) del++;
    ui.delCount.hidden = del === 0;
    ui.delCount.textContent = del + ' removed';
    var keep = src.pages - del;
    ui.keep.textContent = del === 0 ? 'all ' + src.pages : keep + ' of ' + src.pages;
    ui.apply.disabled = keep === 0 || del === 0;
    ui.remove.innerHTML = removed[cur]
      ? '↩ Restore page <kbd style="opacity:.7">Del</kbd>'
      : '🗑 Remove page <kbd style="opacity:.7">Del</kbd>';
    ui.frame.classList.toggle('pr-removed', !!removed[cur]);
    ui.prev.disabled = cur === 0;
    ui.next.disabled = cur === src.pages - 1;
    ui.jump.value = cur + 1;
    ui.jump.max = src.pages;
  }

  function go(idx) {
    if (idx < 0 || idx >= src.pages) return;
    cur = idx;
    refreshHUD();
    renderInto(idx);
  }

  function toggleRemove() {
    removed[cur] = removed[cur] ? 0 : 1;
    refreshHUD();
    // convenience: after removing, hop to the next page (like photo apps)
    if (removed[cur] && cur < src.pages - 1) go(cur + 1);
  }

  /* Enter = "keep this page in the PDF" then hop to the next one. If the page was
     marked removed (e.g. by mistake) Enter un-marks it — the flow never blocks:
     you can mash Enter through the whole deck and only Del takes pages out. */
  function keepNext() {
    removed[cur] = 0;
    if (cur < src.pages - 1) { go(cur + 1); return; }
    refreshHUD();
    // last page kept — nudge towards Apply so the decision actually lands
    if (!ui.apply.disabled) {
      ui.apply.classList.add('pr-peek');
      setTimeout(function () { ui.apply.classList.remove('pr-peek'); }, 1400);
    }
  }

  /* ---------- open / close / apply ---------- */
  async function open() {
    if (!src.bytes) return;
    buildUI();
    if (!src.doc) {
      try {
        src.doc = await window.pdfjsLib.getDocument({ data: src.bytes.slice(0) }).promise;
        src.pages = src.doc.numPages;
      } catch (e) {
        if (window.NotesFX) NotesFX.toast('Could not open PDF for review');
        return;
      }
    }
    if (!removed || removed.length !== src.pages) removed = new Uint8Array(src.pages);
    cache = {}; cacheOrder = [];
    ui.name.textContent = src.name;
    ui.ov.hidden = false;
    document.body.style.overflow = 'hidden';
    go(Math.min(cur, src.pages - 1));
  }

  function close() {
    if (!ui) return;
    ui.ov.hidden = true;
    document.body.style.overflow = '';
  }

  async function apply() {
    if (ui.apply.disabled) return;
    var kept = [];
    for (var i = 0; i < src.pages; i++) if (!removed[i]) kept.push(i);
    ui.apply.disabled = true;
    ui.apply.textContent = 'rebuilding…';
    try {
      var srcDoc = await window.PDFLib.PDFDocument.load(src.bytes, { ignoreEncryption: true });
      var out = await window.PDFLib.PDFDocument.create();
      var pages = await out.copyPages(srcDoc, kept);
      pages.forEach(function (p) { out.addPage(p); });
      var newBytes = await out.save({ useObjectStreams: true });
      var delN = src.pages - kept.length;
      // feed the trimmed PDF back through the tool's own file input →
      // the whole app reloads it exactly like a fresh drop
      var file = new File([newBytes], src.name, { type: 'application/pdf' });
      var dt = new DataTransfer();
      dt.items.add(file);
      var inp = $('fileInput');
      inp.files = dt.files;
      close();
      cur = 0; removed = null;
      if (src.doc) { try { src.doc.destroy(); } catch (e) {} }
      src.doc = null;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.NotesFX) NotesFX.toast(delN + (delN === 1 ? ' page' : ' pages') + ' removed · ' + kept.length + ' kept');
    } catch (err) {
      console.error(err);
      if (window.NotesFX) NotesFX.toast('Rebuild failed: ' + (err && err.message || err));
      ui.apply.disabled = false;
      refreshHUD();
    }
  }

  /* ---------- filebar button ---------- */
  function injectButton() {
    var bar = document.querySelector('.filebar');
    if (!bar || $('reviewBtn')) return;
    injectCSS();
    var b = document.createElement('button');
    b.id = 'reviewBtn'; b.type = 'button';
    b.className = 'btn btn-tiny';
    b.innerHTML = '🔍 Review pages';
    b.title = 'Big per-page preview — remove unwanted pages (← → · Del remove · Enter keep → next)';
    var reset = $('resetBtn');
    bar.insertBefore(b, reset || null);
    b.addEventListener('click', open);
    if (reset) reset.addEventListener('click', function () {
      if (src.doc) { try { src.doc.destroy(); } catch (e) {} }
      src = { bytes: null, name: '', doc: null, pages: 0 };
      cur = 0; removed = null; cache = {}; cacheOrder = [];
    });
  }

  /* ---------- public API ---------- */
  window.PageReview = {
    setSource: function (bytes, name) {
      if (src.doc) { try { src.doc.destroy(); } catch (e) {} }
      src = { bytes: bytes, name: name || 'file.pdf', doc: null, pages: 0 };
      cur = 0; removed = null; cache = {}; cacheOrder = [];
      injectButton();
    },
    open: open
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
  else injectButton();
})();
