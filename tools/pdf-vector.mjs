/* ============ minimal vector-PDF sampler for the probe ============
   The colour probe is made of filled rectangles, so instead of rasterising we can
   interpret the content streams exactly: walk every drawing op in order, keep the
   graphics state (fill colour, blend mode, CTM), and composite each op that covers
   the point we ask about. That gives the true rendered colour without any image
   library — including for other tools' output, which often overlay a full-page
   white rectangle with /BM /Difference (a per-channel 255 − c inversion).

   Supported: gs (BM + CA/ca), rg/g/k fill colours, re + f/f*, q/Q, cm, w/m/l/S
   strokes (approximated as thin rectangles), Do (ignored), text (ignored — the
   probe's blocks are rectangles, labels are not sampled). */
import { inflateSync } from 'node:zlib';

/* ------------------------------------------------------------ tokenizer --- */
function tokens(str) {
  const out = [];
  let i = 0;
  const isWS = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  while (i < str.length) {
    const c = str[i];
    if (isWS(c)) { i++; continue; }
    if (c === '%') { while (i < str.length && str[i] !== '\n') i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < str.length && !isWS(str[j]) && !'()<>[]{}/%'.includes(str[j])) j++;
      out.push({ t: 'name', v: str.slice(i + 1, j) }); i = j; continue;
    }
    if (c === '(') {
      let depth = 1, j = i + 1, buf = '';
      while (j < str.length && depth) {
        const ch = str[j];
        if (ch === '\\') { buf += str[j + 1]; j += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) { j++; break; } }
        buf += ch; j++;
      }
      out.push({ t: 'str', v: buf }); i = j; continue;
    }
    if (c === '[') { out.push({ t: 'arr', v: [] }); i++; continue; }
    if (c === ']') { out.push({ t: 'op', v: ']' }); i++; continue; }
    if (c === '<' && str[i + 1] === '<') { out.push({ t: 'dict', v: {} }); i += 2; continue; }
    if (c === '>' && str[i + 1] === '>') { out.push({ t: 'op', v: '>>' }); i += 2; continue; }
    if (c === '<') {
      let j = str.indexOf('>', i);
      out.push({ t: 'hex', v: str.slice(i + 1, j) }); i = j + 1; continue;
    }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(str.slice(i));
    if (num) { out.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const op = /^[A-Za-z'"*]+/.exec(str.slice(i));
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    i++;
  }
  return out;
}

/* ------------------------------------------------------- object lookup --- */
/* Plain objects AND objects packed inside /Type /ObjStm containers (pdf-lib wraps
   dictionaries in object streams when saving with useObjectStreams). */
export function allObjects(buf) {
  const lat = buf.toString('latin1'), map = new Map();
  /* take the WHOLE object body (page dicts contain nested << >> dictionaries, and
     /Contents usually sits after them) */
  const re = /(?:^|[^0-9])(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m;
  const streams = [];
  while ((m = re.exec(lat))) {
    const body = m[2];
    const sIdx = body.indexOf('stream');
    const dict = sIdx < 0 ? body : body.slice(0, sIdx);
    map.set(+m[1], dict);
    if (sIdx >= 0) {
      let st = m.index + m[0].indexOf('stream') + 6;
      if (lat[st] === '\r') st++;
      if (lat[st] === '\n') st++;
      const end = lat.indexOf('endstream', st);
      streams.push({ num: +m[1], dict, start: st, end: end < 0 ? lat.length : end });
    }
  }
  for (const s of streams) {
    if (!/\/Type\s*\/ObjStm/.test(s.dict)) continue;
    const n = +(s.dict.match(/\/N\s+(\d+)/) || [])[1];
    const first = +(s.dict.match(/\/First\s+(\d+)/) || [])[1];
    if (!n || !first) continue;
    let data;
    try { data = inflateSync(buf.subarray(s.start, s.end)).toString('latin1'); } catch (e) { continue; }
    const pairs = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = pairs[i * 2], off = pairs[i * 2 + 1];
      const from = first + off;
      const to = i + 1 < n ? first + pairs[(i + 1) * 2 + 1] : data.length;
      map.set(num, data.slice(from, to));
    }
  }
  return map;
}
function objectDicts(buf) { return allObjects(buf); }
function streamText(buf, dict, start, end) {
  const raw = buf.subarray(start, end);
  if (/FlateDecode/.test(dict)) { try { return inflateSync(raw).toString('latin1'); } catch (err) { return null; } }
  return raw.toString('latin1');
}
export function objectStreams(buf, num) {
  const lat = buf.toString('latin1'), out = [];
  const re = new RegExp('(?:^|[^0-9])' + num + '\\s+0\\s+obj([\\s\\S]*?)endobj', 'g');
  let m;
  while ((m = re.exec(lat))) {
    const body = m[1];
    const sIdx = body.indexOf('stream');
    if (sIdx < 0) continue;
    const dict = body.slice(0, sIdx);
    let st = m.index + m[0].indexOf('stream') + 6;
    if (lat[st] === '\r') st++;
    if (lat[st] === '\n') st++;
    const end = lat.indexOf('endstream', st);
    out.push({ dict, text: streamText(buf, dict, st, end < 0 ? lat.length : end) });
  }
  return out;
}
function streamOf(buf, num) {
  const s = objectStreams(buf, num)[0];
  return s ? s.text : null;
}
function pagesOf(buf) {
  const pages = [];
  for (const [num, dict] of allObjects(buf)) {
    if (!/\/Type\s*\/Page[^s]/.test(dict)) continue;
    const cont = dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/);
    const refs = cont ? [...cont[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => +x[1]) : [];
    const gsNames = {};              // name → object number (reference form)
    const gsInline = {};             // name → BM value (dictionary written inline)
    let resMatch = dict.match(/\/ExtGState\s*<<([\s\S]*?)>>\s*(?=\/|$)/);
    if (!resMatch) resMatch = dict.match(/\/ExtGState\s*<<([\s\S]*)/);
    if (resMatch) {
      const body = resMatch[1];
      for (const g of body.matchAll(/\/([A-Za-z0-9_.\-]+)\s+(\d+)\s+0\s+R/g)) gsNames[g[1]] = +g[2];
      for (const g of body.matchAll(/\/([A-Za-z0-9_.\-]+)\s*<<([^>]*)>>/g)) {
        const bm = g[2].match(/\/BM\s*\/(\w+)/);
        if (bm) gsInline[g[1]] = bm[1];
      }
    }
    pages.push({ refs, gsNames, gsInline, dict, num });
  }
  pages.sort((a, b) => a.num - b.num);            // page order = object order (no /Pages tree walk needed here)
  return pages;
}

/* ------------------------------------------------------------- sampling --- */
const mul = (a, b) => [ // 2x3 matrices [a b c d e f]
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const white = [255, 255, 255];

function blendDst(mode, dst, src) {
  const S = src, D = dst;
  switch ((mode || 'Normal')) {
    case 'Difference': return [Math.abs(D[0] - S[0]), Math.abs(D[1] - S[1]), Math.abs(D[2] - S[2])];
    case 'Multiply': return [D[0] * S[0] / 255, D[1] * S[1] / 255, D[2] * S[2] / 255];
    case 'Screen': return [255 - (255 - D[0]) * (255 - S[0]) / 255, 255 - (255 - D[1]) * (255 - S[1]) / 255, 255 - (255 - D[2]) * (255 - S[2]) / 255];
    case 'Exclusion': return [D[0] + S[0] - 2 * D[0] * S[0] / 255, D[1] + S[1] - 2 * D[1] * S[1] / 255, D[2] + S[2] - 2 * D[2] * S[2] / 255];
    default: return S.slice();                      // Normal (and anything unsupported)
  }
}

/**
 * Build a sampler for one page of a vector PDF.
 * Returns { sample(x, y) → [r,g,b] | null, page, ops }.
 */
export function vectorPageSampler(buf, pageIndex = 0) {
  const pages = pagesOf(buf);
  if (!pages[pageIndex]) throw new Error('page ' + (pageIndex + 1) + ' not found');
  const dicts = objectDicts(buf);
  const page = pages[pageIndex];

  /* drawing ops in order: {kind:'rect', x,y,w,h, colour, bm} | {kind:'stroke', pts, width, colour, bm} */
  const ops = [];
  const gsBM = new Map();
  for (const [name, num] of Object.entries(page.gsNames)) {
    const d = dicts.get(num) || '';
    const bm = d.match(/\/BM\s*\/(\w+)/);
    gsBM.set(name, bm ? bm[1] : 'Normal');
  }
  for (const [name, bm] of Object.entries(page.gsInline || {})) gsBM.set(name, bm);
  /* a page can inherit /Resources from its /Pages parent — pull those in too */
  if (!Object.keys(page.gsNames).length && !Object.keys(page.gsInline || {}).length) {
    for (const [, parentDict] of dicts) {
      const rm = parentDict.match(/\/ExtGState\s*<<([\s\S]*)/);
      if (!rm) continue;
      for (const g of rm[1].matchAll(/\/([A-Za-z0-9_.\-]+)\s+(\d+)\s+0\s+R/g)) {
        const d2 = dicts.get(+g[2]) || '';
        const bm2 = d2.match(/\/BM\s*\/(\w+)/);
        if (bm2) gsBM.set(g[1], bm2[1]);
      }
      break;
    }
  }
  for (const num of page.refs) {
    const content = streamOf(buf, num);
    if (content) parseContent(content, ops, gsBM);
  }

  function sample(x, y) {
    let dst = white.slice();
    let hit = false;
    for (const op of ops) {
      if (op.kind === 'rect') {
        if (x >= op.x && x <= op.x + op.w && y >= op.y && y <= op.y + op.h) {
          dst = blendDst(op.bm, dst, op.colour); hit = true;
        }
      } else if (op.kind === 'stroke') {
        /* distance from the point to the polyline, against half the line width */
        let best = Infinity;
        for (let i = 0; i + 1 < op.pts.length; i += 2) {
          const [x1, y1] = [op.pts[i], op.pts[i + 1]], [x2, y2] = [op.pts[i + 2], op.pts[i + 3]];
          const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
          best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
        }
        if (best <= Math.max(0.4, op.width / 2)) { dst = blendDst(op.bm, dst, op.colour); hit = true; }
      }
    }
    return dst.map((v) => Math.round(Math.max(0, Math.min(255, v))));
  }
  return { sample, page, ops };
}

function parseContent(content, ops, gsBM) {
  const tk = tokens(content);
  let stack = [];
  const state = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0], stroke: [0, 0, 0], bm: 'Normal', width: 1 };
  let path = [];                                    // {x,y} in device space
  let cur = null, startPt = null, pending = [];
  let lastRect = null;

  const toDevice = (x, y) => apply(state.ctm, x, y);

  for (const t of tk) {
    if (t.t === 'num' || t.t === 'name' || t.t === 'str' || t.t === 'arr' || t.t === 'dict' || t.t === 'hex') { pending.push(t); continue; }
    const op = t.v;
    const nums = pending.filter((p) => p.t === 'num').map((p) => p.v);
    switch (op) {
      case 'q': stack.push({ ...state, ctm: state.ctm.slice(), fill: state.fill.slice(), stroke: state.stroke.slice() }); break;
      case 'Q': if (stack.length) { const s = stack.pop(); Object.assign(state, s); } break;
      case 'cm': if (nums.length >= 6) state.ctm = mul(state.ctm, nums.slice(-6)); break;
      case 'rg': state.fill = nums.slice(-3).map((v) => v * 255); break;
      case 'RG': state.stroke = nums.slice(-3).map((v) => v * 255); break;
      case 'g': state.fill = [nums[nums.length - 1] * 255, nums[nums.length - 1] * 255, nums[nums.length - 1] * 255]; break;
      case 'G': state.stroke = [nums[nums.length - 1] * 255, nums[nums.length - 1] * 255, nums[nums.length - 1] * 255]; break;
      case 'k': { const [c, m2, y2, k2] = nums.slice(-4); const f = (v) => 255 * (1 - Math.min(1, v + k2)); state.fill = [f(c), f(m2), f(y2)]; break; }
      case 'K': { const [c, m2, y2, k2] = nums.slice(-4); const f = (v) => 255 * (1 - Math.min(1, v + k2)); state.stroke = [f(c), f(m2), f(y2)]; break; }
      case 'gs': {
        const n = pending.filter((p) => p.t === 'name').pop();
        if (n) state.bm = gsBM.get(n.v) || 'Normal';
        break;
      }
      case 'w': state.width = nums[nums.length - 1] || 1; break;
      case 're': {
        const [x, y, w, h] = nums.slice(-4);
        const [x0, y0] = toDevice(x, y), [x1, y1] = toDevice(x + w, y + h);
        lastRect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        break;
      }
      case 'm': {
        const [x, y] = nums.slice(-2); const p = toDevice(x, y); cur = p; startPt = p; path = [p[0], p[1]];
        break;
      }
      case 'l': { const [x, y] = nums.slice(-2); cur = toDevice(x, y); path.push(cur[0], cur[1]); break; }
      case 'c': case 'v': case 'y': { const [x, y] = nums.slice(-2); cur = toDevice(x, y); path.push(cur[0], cur[1]); break; }
      case 'h': if (startPt) { cur = startPt; path.push(cur[0], cur[1]); } break;
      case 'f': case 'f*': case 'F': {
        if (lastRect) ops.push({ kind: 'rect', ...lastRect, colour: state.fill.slice(), bm: state.bm });
        else if (path.length >= 4) {
          /* a filled free path: approximate with its bounding box */
          const xs = path.filter((_, i) => i % 2 === 0), ys = path.filter((_, i) => i % 2 === 1);
          ops.push({ kind: 'rect', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), colour: state.fill.slice(), bm: state.bm });
        }
        lastRect = null; path = []; cur = startPt = null;
        break;
      }
      case 'S': case 's': {
        if (path.length >= 4) ops.push({ kind: 'stroke', pts: path.slice(), width: state.width, colour: state.stroke.slice(), bm: state.bm });
        path = []; cur = startPt = null;
        break;
      }
      case 'b': case 'b*': case 'B': case 'B*': {
        if (lastRect) ops.push({ kind: 'rect', ...lastRect, colour: state.fill.slice(), bm: state.bm });
        if (path.length >= 4) ops.push({ kind: 'stroke', pts: path.slice(), width: state.width, colour: state.stroke.slice(), bm: state.bm });
        lastRect = null; path = []; cur = startPt = null;
        break;
      }
      case 'n': lastRect = null; path = []; cur = startPt = null; break;
      default: break;                               // text, images (Do), colour spaces… not needed for the probe
    }
    pending = [];
  }
}
