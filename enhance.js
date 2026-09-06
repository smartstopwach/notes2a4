/* ============ Notes2A4 — premium interaction layer ============
   Topbar state · CSS-3D tilt + cursor light on hero stages ·
   kinetic count-ups · toast system.
   Opt-in via data attributes. Zero cost on touch / reduced-motion
   devices: everything bails to static instantly. */
(function () {
  'use strict';

  var mq = window.matchMedia ? window.matchMedia.bind(window) : null;
  var REDUCE = mq && mq('(prefers-reduced-motion: reduce)').matches;
  var FINE = mq && mq('(hover: hover) and (pointer: fine)').matches;

  /* ---------- topbar: solidifies once the page scrolls ---------- */
  var tb = document.querySelector('.topbar');
  if (tb) {
    var wasScrolled = null;
    var onScroll = function () {
      var s = (window.scrollY || document.documentElement.scrollTop || 0) > 8;
      if (s !== wasScrolled) { wasScrolled = s; tb.classList.toggle('scrolled', s); }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- 3D tilt + cursor light (mouse only, rAF-batched) ---------- */
  if (FINE && !REDUCE) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tilt]'), function (host) {
      var stage = host.querySelector('.anim-stage,.fu-stage');
      var sheet = host.querySelector('.anim-sheet,.fu-sheet');
      if (!stage) return;
      var raf = 0, tx = 0, ty = 0, lx = -1, ly = -1;

      function apply() {
        raf = 0;
        stage.style.setProperty('--ry', (tx * 6.5).toFixed(2) + 'deg');
        stage.style.setProperty('--rx', (-ty * 4.5).toFixed(2) + 'deg');
        if (sheet) {
          if (lx >= 0) {
            sheet.style.setProperty('--mx', (lx * 100).toFixed(1) + '%');
            sheet.style.setProperty('--my', (ly * 100).toFixed(1) + '%');
          } else { sheet.style.removeProperty('--mx'); sheet.style.removeProperty('--my'); }
        }
      }
      host.addEventListener('pointermove', function (e) {
        var r = host.getBoundingClientRect();
        tx = (e.clientX - r.left) / r.width - .5;
        ty = (e.clientY - r.top) / r.height - .5;
        if (sheet) {
          var s = sheet.getBoundingClientRect();
          lx = Math.min(1, Math.max(0, (e.clientX - s.left) / Math.max(1, s.width)));
          ly = Math.min(1, Math.max(0, (e.clientY - s.top) / Math.max(1, s.height)));
        }
        if (!raf) raf = requestAnimationFrame(apply);
      }, { passive: true });
      host.addEventListener('pointerleave', function () {
        tx = ty = 0; lx = ly = -1;
        if (!raf) raf = requestAnimationFrame(apply);
      });
    });
  }

  /* ---------- kinetic numbers: data-count="from:to" [data-delay] ---------- */
  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (el) {
    var parts = String(el.getAttribute('data-count')).split(':');
    var from = parseInt(parts[0], 10), to = parseInt(parts[1], 10);
    var delay = parseInt(el.getAttribute('data-delay') || '300', 10);
    if (REDUCE || isNaN(from) || isNaN(to)) { el.textContent = to; return; }
    el.textContent = from;
    setTimeout(function () {
      var t0 = 0;
      function tick(ts) {
        if (!t0) t0 = ts;
        var p = Math.min(1, (ts - t0) / 900);
        el.textContent = Math.round(from + (to - from) * easeOutExpo(p));
        if (p < 1) requestAnimationFrame(tick);
        else {
          el.textContent = to;
          if (el.id === 'halfs') {           /* the moment the sheet halves — a light pop */
            el.style.transition = 'transform .35s var(--ease-out)';
            el.style.transform = 'scale(1.16)';
            setTimeout(function () { el.style.transform = ''; }, 40);
          }
        }
      }
      requestAnimationFrame(tick);
    }, delay);
  });

  /* ---------- toasts (small confirmations; errors stay inline with role=alert) ---------- */
  window.NotesFX = window.NotesFX || {};
  NotesFX.toast = function (msg, ms) {
    var wrap = document.getElementById('toasts');
    if (!wrap) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span></span>';
    t.querySelector('span').textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 380);
    }, ms || 2600);
  };
})();
