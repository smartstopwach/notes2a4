/* ============ Notes2A4 · session.js — reload-proof in-tab memory ============
   Why: reloading (or a phone killing the tab, or an accidental close) used to
   throw away the picked PDF, every option choice and the finished result.

   What this does instead — everything stays on your device:
     • source PDF(s)  → OPFS file when the browser has it, else IndexedDB
     • every option   → one small IndexedDB record (restored on page load)
     • printed pages  → per-page checkpoint cache, so a run that was
                        interrupted resumes from the page it stopped at
     • finished PDF   → stored once, so the result card + download link come
                        back instantly after a reload (no re-conversion)

   Nothing is ever sent anywhere: this is the same origin-private storage the
   browser gives every site. "Forget" wipes it in one click. */
(function (global) {
  'use strict';

  var DB_NAME = 'notes2a4', DB_VER = 1, STORE = 'kv';
  var K_FILES = 'files.meta', K_OPTS = 'opts', K_RESULT = 'result.meta', K_RUN = 'run';
  var FILES_LIMIT = 380 * 1048576;      // matches the 400 MB intake ceiling
  var IDB_LIMIT = 64 * 1048576;         // fallback engine: stay gentle on quota
  var THUMB_LIMIT = 96 * 1048576;       // above this we skip auto thumbnails

  var READY = false, OPFS_OK = false;
  var dbP = null, opfsP = null, urlCache = null;
  var queue = Promise.resolve();

  /* ---------- tiny helpers ---------- */
  function chan(p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); }
  function seq(fn) {                       // serialize writes so two saves never interleave
    var r = queue.then(function () { return chan(fn()); });
    queue = r;
    return r.then(function (x) { if (x.ok) return x.v; throw x.e; });
  }
  function supported() { return READY; }
  function opfsAvailable() { return OPFS_OK; }

  /* ---------- IndexedDB (metadata + fallback blobs) ---------- */
  function idbOpen() {
    if (dbP) return dbP;
    dbP = new Promise(function (res) {
      if (!global.indexedDB) return res(null);
      var rq;
      try { rq = global.indexedDB.open(DB_NAME, DB_VER); } catch (e) { return res(null); }
      rq.onupgradeneeded = function () {
        try { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); } catch (e) {}
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = rq.onblocked = function () { res(null); };
    });
    return dbP;
  }
  async function kv(kind, key, val) {
    var db = await idbOpen();
    if (!db) return null;
    return new Promise(function (res) {
      var t;
      try { t = db.transaction(STORE, kind === 'get' ? 'readonly' : 'readwrite').objectStore(STORE); }
      catch (e) { return res(null); }
      var rq = kind === 'get' ? t.get(key) : (kind === 'del' ? t.delete(key) : t.put(val, key));
      rq.onsuccess = function () { res(kind === 'get' ? (rq.result === undefined ? null : rq.result) : true); };
      rq.onerror = function () { res(null); };
    });
  }
  var kvGet = function (k) { return kv('get', k); };
  var kvPut = function (k, v) { return kv('put', k, v); };
  var kvDel = function (k) { return kv('del', k); };

  /* ---------- OPFS (big binaries, no quota drama) ---------- */
  function opfsDir() {
    if (opfsP) return opfsP;
    opfsP = (async function () {
      try {
        if (!global.navigator || !navigator.storage || !navigator.storage.getDirectory) return null;
        var root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle('notes2a4', { create: true });
      } catch (e) { return null; }
    })();
    return opfsP;
  }
  async function opfsWrite(name, bytes) {
    if (!OPFS_OK) return false;
    var dir = await opfsDir();
    if (!dir) return false;
    try {
      var fh = await dir.getFileHandle(name, { create: true });
      var w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      return true;
    } catch (e) {
      try { await dir.removeEntry(name); } catch (e2) {}
      return false;
    }
  }
  async function opfsRead(name) {
    var dir = await opfsDir();
    if (!dir) return null;
    try {
      var fh = await dir.getFileHandle(name);
      var f = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch (e) { return null; }
  }
  async function opfsDel(names) {
    var dir = await opfsDir();
    if (!dir) return;
    for (var i = 0; i < names.length; i++) { try { await dir.removeEntry(names[i]); } catch (e) {} }
  }
  async function opfsList() {
    var dir = await opfsDir();
    if (!dir || !dir.keys) return [];
    var out = [];
    try { for await (var k of dir.keys()) out.push(k); } catch (e) {}
    return out;
  }

  /* ---------- init ---------- */
  async function init() {
    var d = await idbOpen();
    if (!d) { READY = false; return false; }
    READY = true;
    OPFS_OK = !!(await opfsDir());
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return true;
  }

  async function usage() {
    try {
      if (global.navigator && navigator.storage && navigator.storage.estimate) {
        var e = await navigator.storage.estimate();
        return { used: e.usage || 0, quota: e.quota || 0 };
      }
    } catch (err) {}
    return { used: 0, quota: 0 };
  }

  /* ---------- source files ---------- */
  async function saveFiles(list) {
    if (!READY || !list || !list.length) return false;
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].bytes ? list[i].bytes.length : 0;
    if (total > FILES_LIMIT) return false;
    return seq(async function () {
      var prev = await kvGet(K_FILES);
      var gen = Date.now().toString(36);
      var entries = [], engine = 'opfs';
      if (OPFS_OK) {
        for (i = 0; i < list.length; i++) {
          var key = 'src-' + gen + '-' + i + '.pdf';
          var ok = await opfsWrite(key, list[i].bytes);
          if (!ok) { engine = 'idb'; break; }
          entries.push({ name: list[i].name, key: key, size: list[i].bytes.length });
        }
      } else engine = 'idb';
      if (engine === 'idb') {
        if (entries.length) await opfsDel(entries.map(function (x) { return x.key; }));   // no half-OPFS leftovers
        if (total > IDB_LIMIT) return false;
        entries = list.map(function (f, j) { return { name: f.name, key: 'idb-' + j, size: f.bytes.length }; });
        await kvPut('files.blobs', list.map(function (f) { return new Blob([f.bytes], { type: 'application/pdf' }); }));
      } else {
        await kvDel('files.blobs');
      }
      if (prev && prev.engine === 'opfs' && prev.entries) {
        var dead = prev.entries.map(function (x) { return x.key; })
          .filter(function (k) { return entries.every(function (n) { return n.key !== k; }); });
        if (dead.length) await opfsDel(dead);
      }
      return await kvPut(K_FILES, { engine: engine, entries: entries, total: total, at: Date.now() });
    });
  }

  async function loadFiles() {
    if (!READY) return [];
    var meta = await kvGet(K_FILES);
    if (!meta || !meta.entries || !meta.entries.length) return [];
    var out = [], i;
    if (meta.engine === 'opfs') {
      for (i = 0; i < meta.entries.length; i++) {
        var b = await opfsRead(meta.entries[i].key);
        if (!b || !b.length) return [];                      // half-written → treat as absent
        out.push({ name: meta.entries[i].name, bytes: b });
      }
    } else {
      var blobs = await kvGet('files.blobs');
      if (!blobs || blobs.length !== meta.entries.length) return [];
      for (i = 0; i < meta.entries.length; i++) {
        out.push({ name: meta.entries[i].name, bytes: new Uint8Array(await blobs[i].arrayBuffer()) });
      }
    }
    return out;
  }

  async function filesClearRaw() {
    var meta = await kvGet(K_FILES);
    if (meta && meta.engine === 'opfs' && meta.entries) await opfsDel(meta.entries.map(function (x) { return x.key; }));
    await kvDel('files.blobs'); await kvDel(K_FILES);
    return true;
  }
  function clearFiles() { if (!READY) return Promise.resolve(false); return seq(filesClearRaw); }

  /* File-like object so restored bytes can walk the same code path a drop does */
  function toFile(f) {
    var bytes = f.bytes;
    try { return new File([bytes], f.name, { type: 'application/pdf' }); } catch (e) {}
    return {
      name: f.name, size: bytes.length, type: 'application/pdf',
      arrayBuffer: function () {
        return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
    };
  }

  /* ---------- options ---------- */
  function optsSave(map) { if (!READY) return Promise.resolve(false); return seq(function () { return kvPut(K_OPTS, { map: map, at: Date.now() }); }); }
  async function optsLoad() { if (!READY) return null; var r = await kvGet(K_OPTS); return r && r.map ? r.map : null; }
  function optsClear() { if (!READY) return Promise.resolve(false); return seq(function () { return kvDel(K_OPTS); }); }

  /* ---------- finished result (reload → result card comes straight back) ---------- */
  async function saveResult(r) {
    if (!READY || !r || !r.bytes) return false;
    if (r.bytes.length > FILES_LIMIT) return false;
    return seq(async function () {
      var prev = await kvGet(K_RESULT);
      var key = 'out-' + Date.now().toString(36) + '.pdf', engine = 'opfs';
      var ok = OPFS_OK ? await opfsWrite(key, r.bytes) : false;
      if (!ok) {
        engine = 'idb'; key = 'result.blob';
        if (r.bytes.length > IDB_LIMIT) return false;
        await kvPut('result.blob', new Blob([r.bytes], { type: 'application/pdf' }));
      } else {
        await kvDel('result.blob');
      }
      if (prev && prev.engine === 'opfs' && prev.key && prev.key !== key) await opfsDel([prev.key]);
      urlCache = null;
      return await kvPut(K_RESULT, {
        engine: engine, key: key, name: r.name || 'notes2a4.pdf', kind: r.kind || '',
        size: r.bytes.length, info: r.info || null, at: Date.now()
      });
    });
  }
  async function loadResultMeta() {
    if (!READY) return null;
    var m = await kvGet(K_RESULT);
    return m && m.key ? m : null;
  }
  async function resultBytes() {
    var m = await loadResultMeta();
    if (!m) return null;
    if (m.engine === 'opfs') return await opfsRead(m.key);
    var b = await kvGet('result.blob');
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  }
  async function resultUrl() {
    if (urlCache) return urlCache;
    if (!READY) return null;
    var m = await loadResultMeta();
    if (!m) return null;
    var bytes = await resultBytes();
    if (!bytes) return null;
    urlCache = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    return urlCache;
  }
  async function resultClearRaw() {
    var m = await kvGet(K_RESULT);
    if (m && m.engine === 'opfs' && m.key) await opfsDel([m.key]);
    if (urlCache) { try { URL.revokeObjectURL(urlCache); } catch (e) {} urlCache = null; }
    await kvDel('result.blob'); await kvDel(K_RESULT);
    return true;
  }
  function clearResult() { if (!READY) return Promise.resolve(false); return seq(resultClearRaw); }

  /* ---------- interrupted run: settings + page-by-page checkpoint ----------
     Print-Saver renders every page at 150–220 dpi before packing, which is the
     long, reload-prone part. Each finished page is written to the checkpoint
     cache; a later run with the SAME image settings reuses those pages and
     starts rendering from the first missing one. */
  function runSave(meta) {
    if (!READY) return Promise.resolve(false);
    return seq(async function () {
      var prev = (await kvGet(K_RUN)) || {};                 // merge: sig/pages from runBegin must survive
      return kvPut(K_RUN, Object.assign({}, prev, meta, { at: Date.now() }));
    });
  }
  async function runLoad() { if (!READY) return null; var r = await kvGet(K_RUN); return r && r.at ? r : null; }
  async function runClearRaw() {
    await kvDel(K_RUN);
    await kvDel('run.pages');
    var names = (await opfsList()).filter(function (n) { return n.indexOf('run-') === 0; });
    if (names.length) await opfsDel(names);
    return true;
  }
  function runClear() { if (!READY) return Promise.resolve(false); return seq(runClearRaw); }
  /* Start (or adopt) a run. Returns {reused:true} when the same settings are
     already checkpointed, so leftover page files stay valid. */
  async function runBegin(sig, pages, kind) {
    var prev = await runLoad();
    if (prev && prev.sig && prev.sig === sig && prev.pages === pages) {
      var meta = await kvGet('run.pages');
      return { reused: !!(meta && meta.entries && meta.entries.length), have: meta && meta.entries ? meta.entries.length : 0 };
    }
    await runClear();
    await runSave({ sig: sig, pages: pages, phase: 'start', at: Date.now(), kind: kind || '' });
    return { reused: false, have: 0 };
  }
  async function pagePut(i, bytes) {
    if (!READY || !OPFS_OK || !bytes || !bytes.length) return false;
    return seq(async function () {
      var key = 'run-p' + i + '.png';
      if (!(await opfsWrite(key, bytes))) return false;
      var meta = (await kvGet('run.pages')) || { entries: [] };
      meta.entries = meta.entries.filter(function (e) { return e.i !== i; });
      meta.entries.push({ i: i, key: key, size: bytes.length });
      return await kvPut('run.pages', meta);
    });
  }
  async function pageGet(i) {
    if (!READY || !OPFS_OK) return null;
    var meta = await kvGet('run.pages');
    if (!meta || !meta.entries) return null;
    for (var k = 0; k < meta.entries.length; k++) {
      if (meta.entries[k].i === i) {
        var b = await opfsRead(meta.entries[k].key);
        return b && b.length ? b : null;
      }
    }
    return null;
  }
  async function pageStats() {
    if (!READY) return { count: 0, bytes: 0 };
    var meta = await kvGet('run.pages');
    if (!meta || !meta.entries) return { count: 0, bytes: 0 };
    var b = 0;
    meta.entries.forEach(function (e) { b += e.size || 0; });
    return { count: meta.entries.length, bytes: b };
  }

  /* ---------- option snapshots (any element-like list works: Node-testable) ---------- */
  function collect(selector) {
    if (!global.document) return [];
    var out = [];
    try { document.querySelectorAll(selector).forEach(function (el) { out.push(el); }); } catch (e) {}
    return out;
  }
  function snapshot(list) {
    var m = {};
    list.forEach(function (el) {
      if (!el || !el.id || el.type === 'file') return;
      var t = el.type || el.tagName;
      m[el.id] = { t: t, v: (t === 'checkbox' || t === 'radio') ? !!el.checked : String(el.value) };
    });
    return m;
  }
  function apply(map, list) {
    if (!map) return 0;
    var n = 0;
    list.forEach(function (el) {
      if (!el || !el.id || !map[el.id]) return;
      var rec = map[el.id];
      if (rec.t === 'checkbox' || rec.t === 'radio') { if (!!el.checked !== !!rec.v) { el.checked = !!rec.v; n++; } }
      else if (String(el.value) !== String(rec.v)) { el.value = rec.v; n++; }
    });
    return n;
  }
  /* One debounced saver per app: any change/input inside the options area is
     folded into a single small record ~400 ms later.
     optsRoot = container to listen on, selector = what belongs in the snapshot */
  function autoSaveOpts(optsRoot, selector, delay) {
    if (!READY) return null;
    var timer = null;
    var fire = function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { optsSave(snapshot(collect(selector))); }, delay == null ? 400 : delay);
    };
    if (optsRoot && optsRoot.addEventListener) {
      ['change', 'input'].forEach(function (ev) { optsRoot.addEventListener(ev, fire); });
    }
    return fire;
  }

  /* ---------- wipe ---------- */
  function clearAll() {
    if (!READY) return Promise.resolve(false);
    return seq(async function () {                       // one queued job, raw pieces (no nested queue = no deadlock)
      await filesClearRaw();
      await resultClearRaw();
      await runClearRaw();
      await kvDel(K_OPTS);
      var names = (await opfsList()).filter(function (n) {
        return n.indexOf('src-') === 0 || n.indexOf('out-') === 0 || n.indexOf('run-') === 0;
      });
      if (names.length) await opfsDel(names);
      return true;
    });
  }

  /* Every public call is guarded: a full disk, a private-mode browser or a
     blocked storage backend must never break a conversion — the app just sees
     the fallback value and carries on without persistence. */
  function guard(fn, fallback) {
    return function () {
      try {
        return Promise.resolve(fn.apply(null, arguments)).catch(function () { return fallback; });
      } catch (e) { return Promise.resolve(fallback); }
    };
  }

  var api = {
    init: init, supported: supported, opfs: opfsAvailable, usage: guard(usage, { used: 0, quota: 0 }),
    flush: function () { return queue; },
    saveFiles: guard(saveFiles, false), loadFiles: guard(loadFiles, []), clearFiles: guard(clearFiles, false), toFile: toFile,
    saveOpts: guard(optsSave, false), loadOpts: guard(optsLoad, null), clearOpts: guard(optsClear, false),
    saveResult: guard(saveResult, false), loadResultMeta: guard(loadResultMeta, null),
    resultBytes: guard(resultBytes, null), resultUrl: guard(resultUrl, null), clearResult: guard(clearResult, false),
    runBegin: guard(runBegin, { reused: false, have: 0 }), runSave: guard(runSave, false),
    runLoad: guard(runLoad, null), runClear: guard(runClear, false),
    pagePut: guard(pagePut, false), pageGet: guard(pageGet, null), pageStats: guard(pageStats, { count: 0, bytes: 0 }),
    snapshot: snapshot, apply: apply, collect: collect, autoSaveOpts: autoSaveOpts,
    THUMB_LIMIT: THUMB_LIMIT,
    clearAll: guard(clearAll, false)
  };

  global.NotesSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
