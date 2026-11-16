/* CTFd Visual — 即時流量圖前端
 *
 * 畫面：外圈 = 隊伍 / 玩家，內圈 = 題目（依分類分組、上色）。
 * 每個請求是一顆從外圈飛向內圈題目的粒子；連線的亮度代表最近的請求量。
 */
(() => {
  'use strict';

  // ---- 色彩（深色主題；分類色固定順序，不循環） ----------------------------
  const CAT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
  const OTHER = '#898781';
  const INK = {
    text: '#f0efec', text2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a',
    axis: '#383835', plane: '#0d0d0d', good: '#0ca30c', critical: '#d03b3b',
  };
  const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif';
  const GROUP = { view: 'platform', download: 'platform', hint: 'platform', traffic: 'traffic', fail: 'submit', solve: 'submit' };
  const LABEL = { view: '瀏覽', download: '下載', hint: '提示', traffic: '連線', fail: '✕ 答錯', solve: '✓ 解出' };
  const TAU = Math.PI * 2;
  const WINDOW = 60;          // 排行用的時間窗（秒）
  const TL_SECONDS = 300;     // 時間軸長度（秒）
  const LINK_DECAY = 14;      // 連線亮度衰減時間常數（秒）

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const KEY = new URLSearchParams(location.search).get('key') || '';

  // ---- 小工具 ---------------------------------------------------------------
  class Rolling {            // 最近 60 秒的滑動計數
    constructor() { this.b = new Float64Array(WINDOW); this.t = new Int32Array(WINDOW); }
    add(sec, v) {
      const i = ((sec % WINDOW) + WINDOW) % WINDOW;
      if (this.t[i] !== sec) { this.t[i] = sec; this.b[i] = 0; }
      this.b[i] += v;
    }
    sum(nowSec) {
      let s = 0;
      for (let i = 0; i < WINDOW; i++) {
        const age = nowSec - this.t[i];
        if (age >= 0 && age < WINDOW) s += this.b[i];
      }
      return s;
    }
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const rgbaCache = new Map();
  function rgba(hex, a) {
    let c = rgbaCache.get(hex);
    if (!c) {
      const n = parseInt(hex.slice(1), 16);
      c = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
      rgbaCache.set(hex, c);
    }
    return `rgba(${c},${a})`;
  }

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toLocaleString('en-US');
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;   // 名稱來自玩家，一律用 textContent
    return node;
  }

  // ---- 狀態 -----------------------------------------------------------------
  const S = {
    offset: 0,                 // 伺服器時間 - 本機時間（秒）
    mode: 'team', hasTeams: false,
    filters: { platform: true, traffic: true, submit: true },
    chals: new Map(), cats: [],
    actors: new Map(), links: new Map(), slots: [],
    particles: [], effects: [],
    buffer: [],                // 最近約 2 分鐘的事件，切換檢視時重算用
    tl: new Map(),             // sec -> [platform, traffic, fail, solve]
    focus: null, pinned: false,
    rps: 0, feedTokens: 5, feedT: 0, tlHover: -1,
    cine: null, cineQueue: [], cineOn: true,     // 首殺特寫
  };
  const cam = { x: 0, y: 0, z: 1 };              // 流量圖鏡頭：看向 (x, y)，放大 z 倍
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const L = { W: 0, H: 0, cx: 0, cy: 0, Ro: 0, Ri: 0, fs: 11, margin: 100, arcs: [], step: 0 };

  const nowS = () => Date.now() / 1000 + S.offset;
  const unitLabel = () => (S.mode === 'team' && S.hasTeams ? '隊伍' : '玩家');

  const flowEl = $('flow'), cv = $('cv'), ctx = cv.getContext('2d');
  const tlCv = $('tl'), tctx = tlCv.getContext('2d');
  let dpr = 1;

  // ---- 題目 / 分類 ------------------------------------------------------------
  function catColor(cat) {
    const i = S.cats.indexOf(cat);
    return i >= 0 && i < CAT_COLORS.length ? CAT_COLORS[i] : OTHER;
  }

  function registerCats() {
    const fresh = [...new Set([...S.chals.values()].map((c) => c.category))]
      .filter((c) => !S.cats.includes(c))
      .sort((a, b) => a.localeCompare(b));
    S.cats.push(...fresh);     // 只往後加，已出現的分類顏色永遠不變
  }

  function setMeta(raw) {
    let c = S.chals.get(raw.id);
    if (!c) {
      c = { id: raw.id, roll: new Rolling(), heat: 0, pulse: 0, angle: 0, x: 0, y: 0, total: 0, solves: 0, fails: 0 };
      S.chals.set(raw.id, c);
    }
    c.name = raw.name; c.category = raw.category; c.value = raw.value;
    return c;
  }

  function setTotals(raw) {
    const c = S.chals.get(raw.id);
    if (!c) return;
    c.total = Math.max(c.total, raw.total || 0);
    c.solves = raw.solves || 0;      // 伺服器的解題數以 CTFd 資料庫為準
    c.fails = Math.max(c.fails, raw.fails || 0);
  }

  function registryChanged() {
    registerCats();
    layoutChals();
    renderLegend();
    $('empty').hidden = S.chals.size > 0;
  }

  // ---- 版面 -----------------------------------------------------------------
  function layout() {
    const r = flowEl.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    L.W = r.width; L.H = r.height;
    cv.width = Math.max(1, Math.round(L.W * dpr));
    cv.height = Math.max(1, Math.round(L.H * dpr));
    const minDim = Math.min(L.W, L.H);
    L.fs = clamp(minDim / 66, 10, 14);
    L.margin = clamp(minDim * 0.16, 60, 150);
    L.cx = L.W / 2; L.cy = L.H / 2;
    L.Ro = Math.max(70, minDim / 2 - L.margin);
    L.Ri = L.Ro * 0.52;
    const n = clamp(Math.floor((TAU * L.Ro) / (L.fs * 1.6)), 12, 110);
    const old = [...S.actors.values()].filter((a) => a.slot >= 0).sort((a, b) => b.last - a.last);
    S.slots = new Array(n).fill(null);
    for (const a of S.actors.values()) a.slot = -1;
    for (const a of old) assignSlot(a);
    fitCache.clear();
    layoutChals();
    layoutTimeline();
  }

  function layoutChals() {
    const groups = S.cats
      .map((cat) => [...S.chals.values()].filter((c) => c.category === cat)
        .sort((a, b) => a.value - b.value || a.name.localeCompare(b.name)))
      .filter((g) => g.length);
    const total = groups.reduce((s, g) => s + g.length, 0);
    const gap = groups.length > 1 ? 1.3 : 0;
    const step = total ? TAU / (total + groups.length * gap) : 0;
    let a = -Math.PI / 2 + (gap * step) / 2;
    L.arcs = [];
    L.step = step;
    for (const g of groups) {
      g.forEach((c, i) => { c.angle = a + step * (i + 0.5); });
      L.arcs.push({ cat: g[0].category, a0: a + step * 0.12, a1: a + step * (g.length - 0.12), color: catColor(g[0].category) });
      a += step * (g.length + gap);
    }
    for (const c of S.chals.values()) {
      c.x = L.cx + L.Ri * Math.cos(c.angle);
      c.y = L.cy + L.Ri * Math.sin(c.angle);
    }
  }

  // ---- 外圈節點（隊伍 / 玩家） ----------------------------------------------
  function getActor(ev) {
    const useTeam = S.mode === 'team' && ev.team && !ev.anon;
    const key = ev.anon ? 'A:' + ev.user : useTeam ? 'T:' + ev.team : 'U:' + ev.user;
    let a = S.actors.get(key);
    if (!a) {
      a = { key, name: useTeam ? ev.team : ev.user, anon: !!ev.anon, roll: new Rolling(),
            last: 0, slot: -1, alpha: 0, flash: 0, rate: 0, x: 0, y: 0, ang: 0 };
      S.actors.set(key, a);
    }
    return a;
  }

  function assignSlot(a) {
    if (a.slot >= 0) return;
    const n = S.slots.length;
    if (!n) return;
    const start = hash(a.key) % n;
    for (let k = 0; k < n; k++) {
      const j = (start + k) % n;
      if (!S.slots[j]) { S.slots[j] = a; a.slot = j; return; }
    }
    let stale = null;           // 滿了：換掉最久沒動的
    for (const o of S.slots) if (!stale || o.last < stale.last) stale = o;
    if (stale && stale.last < a.last - 10) {
      S.slots[stale.slot] = a; a.slot = stale.slot; stale.slot = -1;
    }
  }

  function actorAngle(a) {
    if (a.slot >= 0) return (a.slot / S.slots.length) * TAU - Math.PI / 2;
    return ((hash(a.key) % 3600) / 3600) * TAU;
  }

  function getLink(a, c) {
    const key = a.key + '\n' + c.id;
    let l = S.links.get(key);
    if (!l) { l = { a, c, heat: 0, last: 0, roll: new Rolling() }; S.links.set(key, l); }
    return l;
  }

  // ---- 事件處理 ---------------------------------------------------------------
  function addTimeline(ev) {
    const sec = Math.floor(ev.ts);
    let row = S.tl.get(sec);
    if (!row) { row = [0, 0, 0, 0]; S.tl.set(sec, row); }
    row[ev.type === 'traffic' ? 1 : ev.type === 'fail' ? 2 : ev.type === 'solve' ? 3 : 0] += ev.count;
  }

  function onEvent(ev) {
    const c = S.chals.get(ev.cid);
    if (c) {
      c.total += ev.count;
      if (ev.type === 'fail') c.fails++;
      else if (ev.type === 'solve') c.solves = ev.solves != null ? Math.max(c.solves, ev.solves) : c.solves + 1;
    }
    if (ev.team && !S.hasTeams) { S.hasTeams = true; syncModeUi(); }
    addTimeline(ev);
    S.buffer.push(ev);
    apply(ev, true);
  }

  function apply(ev, live) {
    const c = S.chals.get(ev.cid);
    if (!c || !S.filters[GROUP[ev.type]]) return;
    const sec = Math.floor(ev.ts);
    const a = getActor(ev);
    a.last = Math.max(a.last, ev.ts);
    a.roll.add(sec, ev.count);
    c.roll.add(sec, ev.count);
    assignSlot(a);
    const link = getLink(a, c);
    link.roll.add(sec, ev.count);
    link.last = Math.max(link.last, ev.ts);
    const w = Math.log2(ev.count + 1);
    if (live && !document.hidden) {
      link.heat += w;
      if (!(ev.type === 'solve' && ev.fb && queueCine(ev, a, c))) spawn(ev, a, c, w);
    } else {
      const age = Math.max(0, nowS() - ev.ts);
      link.heat += w * Math.exp(-age / LINK_DECAY);
      c.heat += w * Math.exp(-age / 8);
      if (live && ev.type === 'solve') toast(ev, a, c);
    }
    if (live) pushFeed(ev, a, c, false);
  }

  function spawn(ev, a, c, w) {
    a.flash = 1;
    if (S.particles.length > 2400) { c.heat += w; return; }
    const group = GROUP[ev.type];
    const n = ev.type === 'traffic' ? Math.min(8, 1 + Math.floor(Math.log2(ev.count))) : 1;
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      S.particles.push({
        a, c, ev, lead: i === 0, w: i === 0 ? w : 0,
        t0: t + i * 70 + Math.random() * 120,
        dur: 950 + Math.random() * 450,
        jit: (Math.random() - 0.5) * 0.24,
        size: group === 'submit' ? 2.8 : group === 'traffic' ? 1.5 : 2.1,
      });
    }
  }

  function arrive(p) {
    const c = p.c;
    c.heat += p.w;
    if (!p.lead) return;
    c.pulse = 1;
    const t = performance.now();
    if (p.ev.type === 'fail') {
      S.effects.push({ kind: 'fail', c, t0: t, dur: 800 });
    } else if (p.ev.type === 'solve') {
      S.effects.push({ kind: 'solve', c, t0: t, dur: p.ev.fb ? 1900 : 1400, big: !!p.ev.fb });
      toast(p.ev, p.a, c);
    }
  }

  function rebuild() {          // 切換「隊伍 / 個人」或篩選條件後，用緩衝事件重算
    S.actors.clear(); S.links.clear(); S.particles.length = 0;
    S.slots.fill(null);
    for (const c of S.chals.values()) { c.roll = new Rolling(); c.heat = 0; }
    for (const ev of S.buffer) apply(ev, false);
    if (S.focus && S.focus.kind === 'actor') clearFocus(true);
    refresh();
  }

  // ---- 連線 -----------------------------------------------------------------
  function onSnapshot(snap) {
    S.offset = snap.server_time - Date.now() / 1000;
    S.chals.clear(); S.actors.clear(); S.links.clear();
    S.particles.length = 0; S.effects.length = 0; S.tl.clear();
    S.slots.fill(null);
    S.focus = null; S.pinned = false;
    endCine(true);
    $('title').textContent = snap.title || 'CTFd Visual';
    document.title = (snap.title || 'CTFd Visual') + ' — 即時題目流量';
    $('demo-badge').hidden = !snap.demo;
    for (const raw of snap.challenges) { setMeta(raw); setTotals(raw); }
    for (const row of snap.timeline) S.tl.set(row[0], row.slice(1));
    const cutoff = nowS() - 125;
    S.buffer = snap.recent.filter((ev) => ev.ts >= cutoff);
    S.hasTeams = snap.recent.some((ev) => ev.team);
    registryChanged();
    for (const ev of S.buffer) apply(ev, false);
    $('feed').replaceChildren();
    for (const ev of snap.recent.slice(-18)) {
      const c = S.chals.get(ev.cid);
      if (c && S.filters[GROUP[ev.type]]) pushFeed(ev, getActor(ev), c, true);
    }
    syncModeUi();
    refresh();
  }

  function onMessage(msg) {
    let changed = false;
    if (msg.challenges_full) {
      const ids = new Set(msg.challenges_full.map((c) => c.id));
      for (const id of [...S.chals.keys()]) if (!ids.has(id)) S.chals.delete(id);
      for (const [k, l] of S.links) if (!S.chals.has(l.c.id)) S.links.delete(k);
      S.particles = S.particles.filter((p) => S.chals.has(p.c.id));
      S.effects = S.effects.filter((e) => S.chals.has(e.c.id));
      msg.challenges_full.forEach(setMeta);
      changed = true;
    }
    if (msg.challenges) { msg.challenges.forEach(setMeta); changed = true; }
    if (changed) registryChanged();
    if (msg.events) msg.events.forEach(onEvent);
    (msg.challenges_full || msg.challenges || []).forEach(setTotals);
  }

  function setStatus(cls, text) {
    const s = $('status');
    s.className = 'status ' + cls;
    s.lastElementChild.textContent = text;
  }

  function connect() {
    const es = new EventSource('/api/stream' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''));
    es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onopen = () => setStatus('ok', '已連線');
    es.onerror = () => {
      setStatus('bad', '連線中斷，重試中…');
      if (es.readyState === EventSource.CLOSED) {     // 例如 view key 錯誤，瀏覽器不會自動重連
        es.close();
        setTimeout(connect, 5000);
      }
    };
  }

  // ---- 焦點（hover / 固定） ---------------------------------------------------
  function setFocus(kind, id, pin) {
    if (S.focus && S.focus.kind === kind && S.focus.id === id && S.pinned === pin) return;
    S.focus = { kind, id };
    S.pinned = pin;
    renderCard();
    markFocusRows();
  }

  function clearFocus(force) {
    if (!S.focus || (S.pinned && !force)) return;
    S.focus = null; S.pinned = false;
    renderCard();
    markFocusRows();
  }

  function markFocusRows() {
    for (const li of document.querySelectorAll('.rank li')) {
      li.classList.toggle('focus', !!S.focus && li.dataset.kind === S.focus.kind && li.dataset.id === S.focus.id);
    }
  }

  function inFocus(f, actorKey, chalId) {
    if (f.kind === 'chal') return chalId === f.id;
    if (f.kind === 'actor') return actorKey === f.id;
    return actorKey === f.a && chalId === f.id;      // 首殺特寫：只留這一條線
  }

  function relatedSet(f) {      // 與焦點有連線的節點
    if (f.kind === 'pair') return new Set([f.a, f.id]);
    const set = new Set([f.id]);
    for (const l of S.links.values()) {
      if (l.heat < 0.04 || !inFocus(f, l.a.key, l.c.id)) continue;
      set.add(l.a.key); set.add(l.c.id);
    }
    return set;
  }

  function hitTest(mx, my) {
    if (S.cine) return null;
    const dx = mx - L.cx, dy = my - L.cy;
    const r = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    if (r > L.Ro - 12 && r < L.Ro + L.margin && S.slots.length) {
      const n = S.slots.length;
      const idx = ((Math.round(((ang + Math.PI / 2) / TAU) * n) % n) + n) % n;
      const a = S.slots[idx];
      if (a && a.alpha > 0.3) return { kind: 'actor', id: a.key };
    } else if (r > L.Ri - 14 && r <= L.Ro - 12 && L.step) {
      let best = null, bestD = L.step * 0.5;
      for (const c of S.chals.values()) {
        let d = Math.abs(ang - c.angle) % TAU;
        if (d > Math.PI) d = TAU - d;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) return { kind: 'chal', id: best.id };
    }
    return null;
  }

  // ---- 繪圖：流量圖 ---------------------------------------------------------
  const fitCache = new Map();
  function fit(text, maxW) {
    const key = ctx.font + '|' + maxW + '|' + text;
    let v = fitCache.get(key);
    if (v !== undefined) return v;
    if (ctx.measureText(text).width <= maxW) v = text;
    else {
      const chars = [...text];
      while (chars.length > 1 && ctx.measureText(chars.join('') + '…').width > maxW) chars.pop();
      v = chars.join('') + '…';
    }
    if (fitCache.size > 4000) fitCache.clear();
    fitCache.set(key, v);
    return v;
  }

  function radialText(text, angle, r) {
    ctx.save();
    ctx.translate(L.cx + r * Math.cos(angle), L.cy + r * Math.sin(angle));
    if (Math.cos(angle) < 0) { ctx.rotate(angle + Math.PI); ctx.textAlign = 'right'; }
    else { ctx.rotate(angle); ctx.textAlign = 'left'; }
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function arcText(text, r, mid, maxArc) {
    const chars = [...text];
    const widths = chars.map((ch) => ctx.measureText(ch).width + 1.2);
    const total = widths.reduce((s, w) => s + w, 0);
    if (total > maxArc * r) return;
    const flip = Math.sin(mid) > 0;         // 下半圈反向排，文字才不會上下顛倒
    const dir = flip ? -1 : 1;
    let a = mid - (dir * total) / 2 / r;
    ctx.textAlign = 'center';
    for (let i = 0; i < chars.length; i++) {
      const half = widths[i] / 2 / r;
      a += dir * half;
      ctx.save();
      ctx.translate(L.cx + r * Math.cos(a), L.cy + r * Math.sin(a));
      ctx.rotate(a + (flip ? -Math.PI / 2 : Math.PI / 2));
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
      a += dir * half;
    }
  }

  function curve(a, c, jit) {    // 回傳二次貝茲曲線的控制點
    const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
    let qx = mx + (L.cx - mx) * 0.6, qy = my + (L.cy - my) * 0.6;
    if (jit) { qx += -(c.y - a.y) * jit; qy += (c.x - a.x) * jit; }
    return [qx, qy];
  }

  function chalRadius(c) { return 4 + Math.min(9, Math.sqrt(c.heat) * 1.5); }

  function draw(now, dt) {
    const { cx, cy, Ro, Ri, fs } = L;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    if (!S.chals.size) return;
    const ns = nowS();

    for (const a of S.actors.values()) {
      a.ang = actorAngle(a);
      a.x = cx + Ro * Math.cos(a.ang); a.y = cy + Ro * Math.sin(a.ang);
      const target = a.slot >= 0 && ns - a.last < WINDOW ? 1 : 0;
      a.alpha += (target - a.alpha) * Math.min(1, dt * 3);
      a.flash = Math.max(0, a.flash - dt * 1.4);
    }
    for (const c of S.chals.values()) {
      c.heat *= Math.exp(-dt / 8);
      c.pulse = Math.max(0, c.pulse - dt * 2.2);
    }

    // 鏡頭：平常看全景，首殺特寫時由 stepCine 接管
    const cine = stepCine(now);
    const focus = cine ? { kind: 'pair', a: S.cine.a.key, id: S.cine.c.id } : S.focus;
    const rel = focus ? relatedSet(focus) : null;
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z,
      dpr * (L.W / 2 - cam.x * cam.z), dpr * (L.H / 2 - cam.y * cam.z));

    // 外圈導引線
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath(); ctx.arc(cx, cy, Ro, 0, TAU); ctx.stroke();

    // 連線（最近誰在打哪題）
    ctx.lineCap = 'round';
    for (const l of S.links.values()) {
      l.heat *= Math.exp(-dt / LINK_DECAY);
      if (l.heat < 0.04) continue;
      let alpha = Math.min(0.42, 0.06 + l.heat * 0.035);
      if (focus) alpha = inFocus(focus, l.a.key, l.c.id) ? Math.min(0.9, alpha * 2.2 + 0.2) : alpha * 0.1;
      const [qx, qy] = curve(l.a, l.c, 0);
      ctx.strokeStyle = rgba(catColor(l.c.category), alpha);
      ctx.lineWidth = 1 + Math.min(2.5, l.heat * 0.12);
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.quadraticCurveTo(qx, qy, l.c.x, l.c.y); ctx.stroke();
    }

    // 粒子（每個請求）
    ctx.globalCompositeOperation = 'lighter';
    let keep = 0;
    for (let i = 0; i < S.particles.length; i++) {
      const p = S.particles[i];
      const t = (now - p.t0) / p.dur;
      if (t >= 1) { arrive(p); continue; }
      S.particles[keep++] = p;
      if (t < 0) continue;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const e0 = Math.max(0, e - 0.07);
      const [qx, qy] = curve(p.a, p.c, p.jit);
      const u = 1 - e, u0 = 1 - e0;
      const hx = u * u * p.a.x + 2 * u * e * qx + e * e * p.c.x;
      const hy = u * u * p.a.y + 2 * u * e * qy + e * e * p.c.y;
      const tx = u0 * u0 * p.a.x + 2 * u0 * e0 * qx + e0 * e0 * p.c.x;
      const ty = u0 * u0 * p.a.y + 2 * u0 * e0 * qy + e0 * e0 * p.c.y;
      const dim = focus && !inFocus(focus, p.a.key, p.c.id) ? 0.12 : 1;
      const color = catColor(p.c.category);
      ctx.strokeStyle = rgba(color, 0.55 * dim);
      ctx.lineWidth = p.size * 1.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = rgba(color, dim);
      ctx.beginPath(); ctx.arc(hx, hy, p.size, 0, TAU); ctx.fill();
      if (p.size > 2.5) {       // flag 提交：加一個亮白核心
        ctx.fillStyle = rgba('#ffffff', 0.9 * dim);
        ctx.beginPath(); ctx.arc(hx, hy, 1.3, 0, TAU); ctx.fill();
      }
    }
    S.particles.length = keep;
    ctx.globalCompositeOperation = 'source-over';

    // 分類弧 + 弧上文字
    ctx.font = `600 ${Math.max(9, fs - 1)}px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (const arc of L.arcs) {
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, Ri - 14, arc.a0, arc.a1); ctx.stroke();
      ctx.fillStyle = INK.text2;
      arcText(arc.cat.toUpperCase(), Ri - 28, (arc.a0 + arc.a1) / 2, arc.a1 - arc.a0);
    }

    // 題目節點
    ctx.font = `${fs}px ${FONT}`;
    const chalLabelW = Math.round(Ro - Ri - 30);
    for (const c of S.chals.values()) {
      const color = catColor(c.category);
      const r = chalRadius(c);
      const dim = rel && !rel.has(c.id);
      ctx.globalAlpha = dim ? 0.25 : 1;
      if (c.heat > 0.3 && !dim) {
        const g = ctx.createRadialGradient(c.x, c.y, r * 0.5, c.x, c.y, r * 2.6);
        g.addColorStop(0, rgba(color, Math.min(0.4, c.heat * 0.05)));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.6, 0, TAU); ctx.fill();
      }
      if (c.pulse > 0.02) {
        ctx.strokeStyle = rgba(color, c.pulse * 0.8);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + (1 - c.pulse) * 10, 0, TAU); ctx.stroke();
      }
      if (!(cine && cine.hideNode && c === S.cine.c)) {     // 被擊破的瞬間由特寫動畫自己畫
        ctx.fillStyle = color;
        ctx.strokeStyle = INK.plane;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill(); ctx.stroke();
      }
      const isFocus = focus && focus.kind !== 'actor' && focus.id === c.id;
      ctx.fillStyle = isFocus || c.heat > 1.2 ? INK.text : INK.text2;
      if (chalLabelW > 24) radialText(fit(c.name, chalLabelW), c.angle, Ri + 17);
    }
    ctx.globalAlpha = 1;

    // 外圈節點
    const actorLabelW = Math.round(L.margin - 18);
    for (const a of S.actors.values()) {
      if (a.slot < 0 || a.alpha < 0.02) continue;
      const dim = rel && !rel.has(a.key);
      ctx.globalAlpha = a.alpha * (dim ? 0.25 : 1);
      const r = 3 + Math.min(4, Math.sqrt(a.rate) * 0.3) + a.flash * 1.6;
      ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, TAU);
      if (a.anon) {
        ctx.fillStyle = INK.plane; ctx.fill();
        ctx.strokeStyle = INK.muted; ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.fillStyle = a.flash > 0.05 ? INK.text : INK.text2; ctx.fill();
        ctx.strokeStyle = INK.plane; ctx.lineWidth = 2; ctx.stroke();
      }
      const isFocus = focus && (focus.kind === 'actor' ? focus.id === a.key : focus.a === a.key);
      ctx.fillStyle = a.anon ? INK.muted : isFocus || a.flash > 0.05 ? INK.text : INK.text2;
      radialText(fit(a.name, actorLabelW), a.ang, Ro + 11);
    }
    ctx.globalAlpha = 1;

    // 特效：答錯 = 紅圈 + ✕，解出 = 擴散光環 + ✓
    keep = 0;
    for (let i = 0; i < S.effects.length; i++) {
      const fx = S.effects[i];
      const t = (now - fx.t0) / fx.dur;
      if (t >= 1) continue;
      S.effects[keep++] = fx;
      const c = fx.c, r = chalRadius(c), out = 1 - Math.pow(1 - t, 3);
      ctx.globalAlpha = rel && !rel.has(c.id) ? 0.15 : 1;      // 特寫或鎖定焦點時，別題的特效淡化
      if (fx.kind === 'fail') {
        ctx.strokeStyle = rgba(INK.critical, (1 - t) * 0.95);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + 3 + out * 20, 0, TAU); ctx.stroke();
        ctx.fillStyle = rgba('#f0a3a3', 1 - t);
        ctx.font = `700 ${fs + 3}px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText('✕', c.x, c.y - r - 9 - out * 10);
      } else {
        const reach = fx.big ? 120 : 70;
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(INK.text, (1 - t) * 0.9);
        ctx.beginPath(); ctx.arc(c.x, c.y, r + out * reach, 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgba(INK.text, (1 - t) * 0.45);
        ctx.beginPath(); ctx.arc(c.x, c.y, r + out * reach * 0.6, 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgba(catColor(c.category), 1 - t);
        const rays = fx.big ? 18 : 12;
        for (let k = 0; k < rays; k++) {
          const ang = (k / rays) * TAU + c.angle;
          const r0 = r + 4 + out * reach * 0.45, r1 = r0 + 8 * (1 - t);
          ctx.beginPath();
          ctx.moveTo(c.x + r0 * Math.cos(ang), c.y + r0 * Math.sin(ang));
          ctx.lineTo(c.x + r1 * Math.cos(ang), c.y + r1 * Math.sin(ang));
          ctx.stroke();
        }
        ctx.fillStyle = rgba('#7be07b', 1 - t * t);
        ctx.font = `700 ${fs + 6}px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText('✓', c.x, c.y - r - 12 - out * 12);
      }
    }
    S.effects.length = keep;
    ctx.globalAlpha = 1;

    if (cine) drawCine(cine);
  }

  // ---- 首殺特寫 ---------------------------------------------------------------
  // 流程：鏡頭推近玩家 → 蓄力 → 流量沿著連線衝向題目（鏡頭跟拍）→ 題目被擊破 → 拉回全景
  const CT = { zoomIn: 1100, hold: 1000, travel: 2000, impact: 2900, zoomOut: 1200 };
  const CINE_Z1 = 2.6, CINE_Z2 = 3.1;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeOutBack = (t) => { const p = clamp(t, 0, 1) - 1; return 1 + 2.70158 * p * p * p + 1.70158 * p * p; };
  const noise = (k) => { const v = Math.sin((k + 1) * 12.9898) * 43758.5453; return v - Math.floor(v); };

  function queueCine(ev, a, c) {
    if (!S.cineOn || REDUCED_MOTION) return false;
    if (S.cine) {
      if (S.cineQueue.length >= 2) return false;       // 排太多就退回一般的解題特效
      S.cineQueue.push({ ev, a, c });
    } else {
      startCine({ ev, a, c });
    }
    return true;
  }

  function setCineSub(text, hit) {
    const sub = $('cine-sub');
    sub.textContent = text;
    sub.classList.toggle('hit', hit);
  }

  function startCine(job) {
    S.cine = { ev: job.ev, a: job.a, c: job.c, t0: performance.now(), stage: 0, r0: 8 };
    const who = job.ev.team && job.a.name !== job.ev.user ? `${job.a.name}（${job.ev.user}）` : job.a.name;
    $('cine-main').textContent = who;
    setCineSub('送出 Flag…', false);
    $('cine').classList.add('on');
    flowEl.classList.add('cine-on');
  }

  function endCine(dropQueue) {
    S.cine = null;
    if (dropQueue) S.cineQueue.length = 0;
    while (S.cineQueue.length) {
      const next = S.cineQueue.shift();
      if (S.chals.has(next.c.id)) return startCine(next);
    }
    $('cine').classList.remove('on');
    flowEl.classList.remove('cine-on');
  }

  function bezPoint(a, qx, qy, c, u) {
    const v = 1 - u;
    return [v * v * a.x + 2 * v * u * qx + u * u * c.x, v * v * a.y + 2 * v * u * qy + u * u * c.y];
  }

  function camMove(x0, y0, z0, x1, y1, z1, k) {
    cam.x = x0 + (x1 - x0) * k;
    cam.y = y0 + (y1 - y0) * k;
    cam.z = z0 * Math.pow(z1 / z0, k);
  }

  function stepCine(now) {
    cam.x = L.cx; cam.y = L.cy; cam.z = 1;
    const cn = S.cine;
    if (!cn) return null;
    const { a, c } = cn;
    const e = now - cn.t0;
    const t1 = CT.zoomIn, t2 = t1 + CT.hold, t3 = t2 + CT.travel, t4 = t3 + CT.impact, t5 = t4 + CT.zoomOut;
    const [qx, qy] = curve(a, c, 0);
    const st = { e, phase: 'in', u: 0, ti: -1, qx, qy, fade: 1, hideNode: false };
    if (e < t1) {
      camMove(L.cx, L.cy, 1, a.x, a.y, CINE_Z1, ease(e / t1));
    } else if (e < t2) {
      st.phase = 'hold';
      camMove(a.x, a.y, CINE_Z1, a.x, a.y, CINE_Z1 * 1.08, (e - t1) / CT.hold);
    } else if (e < t3) {
      st.phase = 'travel';
      if (cn.stage < 1) { cn.stage = 1; setCineSub(`→ ${c.name}`, false); }
      const k = (e - t2) / CT.travel;
      st.u = ease(k);
      const [hx, hy] = bezPoint(a, qx, qy, c, st.u);
      camMove(hx, hy, CINE_Z1 * 1.08, hx, hy, CINE_Z2, k);
    } else if (e < t5) {
      st.u = 1;
      st.ti = e - t3;
      if (cn.stage < 2) {          // 命中的瞬間
        cn.stage = 2;
        c.heat += 6; c.pulse = 1;
        cn.r0 = Math.max(7, chalRadius(c));
        setCineSub(`攻破 ${c.name}　+${c.value} 分`, true);
      }
      st.hideNode = st.ti < 1500;
      if (e < t4) {
        st.phase = 'impact';
        camMove(c.x, c.y, CINE_Z2, c.x, c.y, CINE_Z2 * 1.06, st.ti / CT.impact);
        if (st.ti < 520) {         // 畫面震動
          const amp = (6 * (1 - st.ti / 520)) / cam.z;
          cam.x += Math.sin(st.ti * 0.09) * amp;
          cam.y += Math.cos(st.ti * 0.117) * amp;
        }
      } else {
        st.phase = 'out';
        const k = ease((e - t4) / CT.zoomOut);
        camMove(c.x, c.y, CINE_Z2 * 1.06, L.cx, L.cy, 1, k);
        st.fade = 1 - k;
      }
    } else {
      endCine(false);
      return null;
    }
    return st;
  }

  function drawCine(st) {
    const cn = S.cine;
    if (!cn) return;
    const { a, c } = cn;
    const color = catColor(c.category);
    const { qx, qy } = st;
    ctx.lineCap = 'round';

    // 玩家：光暈 + 向內收束的蓄力圈
    const actorGlow = st.phase === 'impact' ? Math.max(0, 1 - st.ti / 800) : st.phase === 'out' ? 0 : 1;
    if (actorGlow > 0) {
      const g = ctx.createRadialGradient(a.x, a.y, 2, a.x, a.y, 20);
      g.addColorStop(0, rgba('#ffffff', 0.55 * actorGlow));
      g.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(a.x, a.y, 20, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba('#ffffff', actorGlow);
      ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, TAU); ctx.fill();
    }
    if (st.phase === 'in' || st.phase === 'hold') {
      const power = st.phase === 'hold' ? 1 : clamp(st.e / CT.zoomIn, 0, 1) * 0.6;
      ctx.lineWidth = 1.2;
      for (let j = 0; j < 3; j++) {
        const p = (st.e / 560 + j / 3) % 1;
        ctx.strokeStyle = rgba(color, p * 0.9 * power);
        ctx.beginPath(); ctx.arc(a.x, a.y, 7 + (1 - p) * 24, 0, TAU); ctx.stroke();
      }
    }

    // 沿著連線的光束、封包與彈頭
    if (st.u > 0) {
      const beam = st.phase === 'impact' ? Math.max(0, 1 - st.ti / 700) : st.phase === 'out' ? 0 : 1;
      if (beam > 0) {
        const n = Math.max(2, Math.ceil(48 * st.u));
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        for (let i = 1; i <= n; i++) {
          const [x, y] = bezPoint(a, qx, qy, c, (st.u * i) / n);
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(color, 0.85 * beam); ctx.lineWidth = 3.2; ctx.stroke();
        ctx.strokeStyle = rgba('#ffffff', 0.9 * beam); ctx.lineWidth = 1; ctx.stroke();
      }
      if (st.phase === 'travel') {
        for (let j = 1; j <= 12; j++) {          // 跟在後面的流量封包
          const u = st.u - j * 0.035 - ((st.e / 900) % 0.035);
          if (u <= 0) break;
          const [x, y] = bezPoint(a, qx, qy, c, u);
          ctx.fillStyle = rgba('#ffffff', 0.9 - j * 0.06);
          ctx.beginPath(); ctx.arc(x, y, 1.7, 0, TAU); ctx.fill();
        }
        const [hx, hy] = bezPoint(a, qx, qy, c, st.u);
        const g = ctx.createRadialGradient(hx, hy, 1, hx, hy, 13);
        g.addColorStop(0, rgba(color, 0.95));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(hx, hy, 13, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(hx, hy, 3.4, 0, TAU); ctx.fill();
      }
    }
    if (st.ti < 0) return;

    // 題目被擊破：閃光 → 碎裂 → 衝擊波 → 重組並插上旗子
    const ti = st.ti, r0 = cn.r0;
    if (ti < 240) {
      ctx.fillStyle = rgba('#ffffff', (1 - ti / 240) * 0.9);
      ctx.beginPath(); ctx.arc(c.x, c.y, r0 + ti * 0.16, 0, TAU); ctx.fill();
    }
    const waves = [[0, 44, '#ffffff'], [140, 66, color], [300, 92, '#ffffff']];
    for (const [delay, reach, tone] of waves) {
      const p = (ti - delay) / 950;
      if (p <= 0 || p >= 1) continue;
      ctx.strokeStyle = rgba(tone, (1 - p) * 0.9);
      ctx.lineWidth = 2.2 * (1 - p) + 0.4;
      ctx.beginPath(); ctx.arc(c.x, c.y, r0 + easeOut(p) * reach, 0, TAU); ctx.stroke();
    }
    const sp = ti / 1200;
    if (sp < 1) {
      const out = easeOut(sp), alpha = 1 - sp * sp;
      for (let k = 0; k < 20; k++) {             // 火花
        const ang = (k / 20) * TAU + noise(k + 40);
        const d0 = r0 + out * (30 + noise(k + 70) * 34), d1 = d0 + 7 * (1 - sp);
        ctx.strokeStyle = rgba(k % 2 ? color : '#ffffff', alpha * 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c.x + d0 * Math.cos(ang), c.y + d0 * Math.sin(ang));
        ctx.lineTo(c.x + d1 * Math.cos(ang), c.y + d1 * Math.sin(ang));
        ctx.stroke();
      }
      for (let k = 0; k < 12; k++) {             // 節點碎片
        const rnd = noise(k);
        const ang = (k / 12) * TAU + rnd * 0.5;
        const d = out * (20 + rnd * 24);
        const size = r0 * (0.5 + rnd * 0.4) * (1 - sp * 0.45);
        ctx.save();
        ctx.translate(c.x + d * Math.cos(ang), c.y + d * Math.sin(ang));
        ctx.rotate(ang + ti * 0.004 * (rnd > 0.5 ? 1 : -1) * (1 + rnd));
        ctx.beginPath();
        ctx.moveTo(size, 0); ctx.lineTo(-size * 0.6, size * 0.6); ctx.lineTo(-size * 0.5, -size * 0.55);
        ctx.closePath();
        ctx.fillStyle = rgba(color, alpha); ctx.fill();
        ctx.strokeStyle = rgba('#ffffff', alpha * 0.6); ctx.lineWidth = 0.6; ctx.stroke();
        ctx.restore();
      }
    }
    if (ti >= 900 && st.hideNode) {              // 節點重組
      const s = easeOutBack((ti - 900) / 600);
      ctx.fillStyle = color; ctx.strokeStyle = INK.plane; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(0.1, r0 * s), 0, TAU); ctx.fill(); ctx.stroke();
    }
    if (ti >= 700) {                             // 插旗
      const s = easeOutBack((ti - 700) / 450);
      const base = c.y - r0 * 0.4, top = base - 24 * s;
      ctx.globalAlpha = st.fade;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(c.x, base); ctx.lineTo(c.x, top); ctx.stroke();
      ctx.fillStyle = INK.good; ctx.strokeStyle = INK.plane; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(c.x, top); ctx.lineTo(c.x + 14 * s, top + 4.5 * s); ctx.lineTo(c.x, top + 9 * s);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ---- 繪圖：時間軸 -----------------------------------------------------------
  const TL = { W: 0, H: 0, padL: 36, padR: 10, padT: 22, padB: 16 };

  function layoutTimeline() {
    const r = tlCv.parentElement.getBoundingClientRect();
    TL.W = r.width; TL.H = r.height;
    tlCv.width = Math.max(1, Math.round(TL.W * dpr));
    tlCv.height = Math.max(1, Math.round(TL.H * dpr));
  }

  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function drawTimeline() {
    const { W, H, padL, padR, padT, padB } = TL;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, W, H);
    const pw = W - padL - padR, ph = H - padT - padB;
    if (pw < 40 || ph < 20) return;
    const nowSec = Math.floor(nowS());
    const first = nowSec - TL_SECONDS + 1;
    let max = 0;
    for (let s = first; s <= nowSec; s++) {
      const row = S.tl.get(s);
      if (row) max = Math.max(max, row[0] + row[1] + row[2] + row[3]);
    }
    const yMax = niceMax(max);
    const bw = pw / TL_SECONDS;
    const y0 = padT + ph;

    tctx.font = `10px ${FONT}`;
    tctx.textBaseline = 'middle';
    tctx.lineWidth = 1;
    for (const f of [0, 0.5, 1]) {
      const y = Math.round(y0 - f * ph) + 0.5;
      tctx.strokeStyle = f === 0 ? INK.axis : INK.grid;
      tctx.beginPath(); tctx.moveTo(padL, y); tctx.lineTo(W - padR, y); tctx.stroke();
      tctx.fillStyle = INK.muted; tctx.textAlign = 'right';
      tctx.fillText(fmt(yMax * f), padL - 6, y);
    }
    tctx.textAlign = 'center';
    for (let m = 0; m <= 5; m++) {
      const x = padL + pw - m * 60 * bw;
      tctx.fillStyle = INK.muted;
      tctx.textAlign = m === 0 ? 'right' : m === 5 ? 'left' : 'center';
      tctx.fillText(m === 0 ? '現在' : `-${m} 分`, x, H - 6);
    }

    const barW = bw >= 3 ? bw - 1 : bw;
    for (let i = 0; i < TL_SECONDS; i++) {
      const row = S.tl.get(first + i);
      if (!row) continue;
      const x = padL + i * bw;
      const total = row[0] + row[1] + row[2] + row[3];
      const h = Math.max(1, (total / yMax) * ph);
      tctx.fillStyle = i === S.tlHover ? INK.text : rgba(INK.text2, 0.78);
      tctx.fillRect(x, y0 - h, barW, h);
      const mx = x + barW / 2;
      if (row[3]) {              // 解出：綠色三角
        tctx.fillStyle = INK.good;
        tctx.beginPath(); tctx.moveTo(mx, 2); tctx.lineTo(mx + 4, 10); tctx.lineTo(mx - 4, 10); tctx.closePath(); tctx.fill();
      }
      if (row[2]) {              // 答錯：紅點
        tctx.fillStyle = INK.critical;
        tctx.beginPath(); tctx.arc(mx, 16, 2.5, 0, TAU); tctx.fill();
      }
    }

    const tip = $('tl-tip');
    if (S.tlHover >= 0) {
      const sec = first + S.tlHover;
      const row = S.tl.get(sec) || [0, 0, 0, 0];
      const x = Math.round(padL + S.tlHover * bw + barW / 2) + 0.5;
      tctx.strokeStyle = INK.muted;
      tctx.beginPath(); tctx.moveTo(x, padT); tctx.lineTo(x, y0); tctx.stroke();
      const time = new Date(sec * 1000).toLocaleTimeString('zh-TW', { hour12: false });
      tip.replaceChildren(
        el('span', 't-m', time + '　'),
        el('b', '', `${fmt(row[0] + row[1] + row[2] + row[3])} 請求`),
        el('span', 't-m', `　平台 ${fmt(row[0])} · 連線 ${fmt(row[1])} · 答錯 ${row[2]} · 解出 ${row[3]}`),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = clamp(x - tw / 2, 0, W - tw) + 'px';
    } else {
      tip.hidden = true;
    }
  }

  // ---- 側欄 -----------------------------------------------------------------
  function syncList(ol, items, kind, update) {
    const existing = new Map();
    for (const li of [...ol.children]) {
      if (li.dataset.id !== undefined) existing.set(li.dataset.id, li); else li.remove();
    }
    for (const item of items) {
      let li = existing.get(item.id);
      if (li) existing.delete(item.id);
      else {
        li = el('li');
        li.dataset.kind = kind; li.dataset.id = item.id;
        const top = el('div', 'r-top');
        top.append(el('span', 'sw'), el('span', 'r-name'), el('span', 'r-val'));
        const bar = el('div', 'r-bar');
        bar.append(el('i'));
        li.append(top, bar, el('div', 'r-meta'));
      }
      update(li, item);
      ol.append(li);              // 依排序重新排入（既有節點會被移動而不是重建）
    }
    for (const li of existing.values()) li.remove();
    if (!items.length) ol.append(el('li', 'none', '目前沒有活動'));
  }

  function fillRow(li, name, value, frac, color, meta, anon) {
    const [sw, nm, val] = li.firstChild.children;
    sw.className = anon ? 'sw anon' : 'sw';
    sw.style.background = anon ? '' : color;
    nm.textContent = name; nm.title = name;
    val.textContent = fmt(value);
    const bar = li.children[1].firstChild;
    bar.style.width = (frac * 100).toFixed(1) + '%';
    bar.style.background = color;
    li.children[2].textContent = meta;
  }

  function renderRanks() {
    const sec = Math.floor(nowS());
    const rowsFor = (ol) => {
      const row = ol.querySelector('li[data-id]');
      return Math.max(3, Math.floor(ol.clientHeight / (row ? row.offsetHeight : 50)));
    };

    const chalOl = $('rank-chals');
    const chals = [...S.chals.values()]
      .map((c) => ({ id: c.id, c, v: c.roll.sum(sec) }))
      .sort((x, y) => y.v - x.v || y.c.total - x.c.total || x.c.name.localeCompare(y.c.name))
      .slice(0, rowsFor(chalOl));
    const cMax = Math.max(1, ...chals.map((x) => x.v));
    syncList(chalOl, chals, 'chal', (li, x) => {
      fillRow(li, x.c.name, x.v, x.v / cMax, catColor(x.c.category),
        `${x.c.category} · ${x.c.value} 分 · ✓ ${x.c.solves} · ✕ ${x.c.fails}`, false);
    });

    const best = new Map();       // 每個外圈節點目前最常打的題目
    for (const l of S.links.values()) {
      const v = l.roll.sum(sec);
      if (v <= 0) continue;
      const b = best.get(l.a);
      if (!b || v > b.v) best.set(l.a, { v, c: l.c });
    }
    let active = 0;
    const all = [];
    for (const a of S.actors.values()) {
      a.rate = a.roll.sum(sec);
      if (a.rate > 0) { active++; all.push({ id: a.key, a, v: a.rate }); }
    }
    const actorOl = $('rank-actors');
    all.sort((x, y) => y.v - x.v || x.a.name.localeCompare(y.a.name));
    const actors = all.slice(0, rowsFor(actorOl));
    const aMax = Math.max(1, ...actors.map((x) => x.v));
    syncList(actorOl, actors, 'actor', (li, x) => {
      const b = best.get(x.a);
      fillRow(li, x.a.name, x.v, x.v / aMax, b ? catColor(b.c.category) : INK.text2,
        b ? `→ ${b.c.name}` : '', x.a.anon);
    });
    markFocusRows();

    let total = 0, solves = 0;
    for (const c of S.chals.values()) { total += c.total; solves += c.solves; }
    $('t-actors').textContent = active;
    $('t-solves').textContent = fmt(solves);
    $('t-total').textContent = fmt(total);
  }

  function renderLegend() {
    const box = $('legend');
    const rows = [];
    const present = S.cats.filter((cat) => [...S.chals.values()].some((c) => c.category === cat));
    present.forEach((cat) => {
      const row = el('div', 'row');
      const sw = el('span', 'sw');
      sw.style.background = catColor(cat);
      row.append(sw, el('span', '', cat));
      rows.push(row);
    });
    if (present.length) rows.push(el('div', 'sep'));
    for (const [glyph, text] of [['●', '一個請求'], ['✓', '解出題目'], ['✕', 'Flag 答錯'], ['○', '未登入的來源 IP']]) {
      const row = el('div', 'row');
      row.append(el('span', 'glyph', glyph), el('span', '', text));
      rows.push(row);
    }
    box.replaceChildren(...rows);
  }

  function renderCard() {
    const card = $('card');
    if (!S.focus) { card.hidden = true; return; }
    const sec = Math.floor(nowS());
    const title = el('div', 'c-title');
    const sw = el('span', 'sw');
    const stats = el('div', 'c-stats');
    const stat = (v, label) => { const d = el('div'); d.append(el('b', '', v), el('span', '', label)); stats.append(d); };
    let sub, head;
    const rows = [];
    if (S.focus.kind === 'chal') {
      const c = S.chals.get(S.focus.id);
      if (!c) { clearFocus(true); return; }
      sw.style.background = catColor(c.category);
      title.append(sw, el('span', '', c.name));
      sub = `${c.category} · ${c.value} 分`;
      stat(fmt(c.roll.sum(sec)), '近 60 秒請求');
      stat('✓ ' + c.solves, '解出');
      stat('✕ ' + c.fails, '答錯');
      head = `正在打這題的${unitLabel()}`;
      for (const l of S.links.values()) if (l.c === c) rows.push([l.a.name, l.roll.sum(sec)]);
    } else {
      const a = S.actors.get(S.focus.id);
      if (!a) { clearFocus(true); return; }
      if (a.anon) sw.className = 'sw anon'; else sw.style.background = INK.text2;
      title.append(sw, el('span', '', a.name));
      sub = a.anon ? '尚未對應到帳號的來源 IP' : unitLabel();
      for (const l of S.links.values()) if (l.a === a) rows.push([l.c.name, l.roll.sum(sec)]);
      stat(fmt(a.roll.sum(sec)), '近 60 秒請求');
      stat(String(rows.filter((r) => r[1] > 0).length), '同時在打的題目');
      head = '正在打的題目';
    }
    const list = rows.filter((r) => r[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 6);
    const body = [title, el('div', 'c-sub', sub), stats, el('div', 'c-head', head)];
    if (!list.length) body.push(el('div', 'c-head', '（近 60 秒沒有活動）'));
    for (const [name, v] of list) {
      const row = el('div', 'c-row');
      row.append(el('span', '', name), el('span', '', fmt(v)));
      body.push(row);
    }
    body.push(el('div', 'c-pin', S.pinned ? '已固定 · 點空白處取消' : '點一下可固定'));
    card.replaceChildren(...body);
    card.hidden = false;
  }

  function pushFeed(ev, a, c, force) {
    if (!force && GROUP[ev.type] !== 'submit') {     // 一般事件限流，提交事件一定顯示
      const t = performance.now();
      S.feedTokens = Math.min(5, S.feedTokens + (t - S.feedT) / 220);
      S.feedT = t;
      if (S.feedTokens < 1) return;
      S.feedTokens -= 1;
    }
    const li = el('li');
    const time = el('time', '', new Date(ev.ts * 1000).toLocaleTimeString('zh-TW', { hour12: false }));
    const sw = el('span', 'sw');
    sw.style.background = catColor(c.category);
    let tagText = LABEL[ev.type];
    if (ev.type === 'traffic' && ev.count > 1) tagText += ' ×' + fmt(ev.count);
    if (ev.type === 'solve' && ev.fb) tagText = '✓ 首殺';
    const tag = el('span', 'tag' + (ev.type === 'fail' ? ' fail' : ev.type === 'solve' ? ' solve' : ''), tagText);
    li.append(time, el('span', 'who' + (a.anon ? ' anon' : ''), a.name), el('span', 'arrow', '→'), sw, el('span', 'what', c.name), tag);
    const feed = $('feed');
    feed.prepend(li);
    while (feed.children.length > 40) feed.lastChild.remove();
  }

  function toast(ev, a, c) {
    const box = $('toasts');
    const t = el('div', 'toast');
    const who = ev.team && a.name !== ev.user ? `${a.name}（${ev.user}）` : a.name;
    t.append(el('span', 'ico', '✓'));
    if (ev.fb) t.append(el('span', 'fb', '首殺'));
    t.append(el('b', '', who), el('span', '', '解出'), el('b', '', c.name), el('span', '', `+${c.value}`));
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 600); }, ev.fb ? 6500 : 4500);
  }

  // ---- 週期更新 -------------------------------------------------------------
  function maintain() {
    const ns = nowS();
    for (const [key, a] of S.actors) {
      const idle = ns - a.last;
      if (a.slot >= 0 && idle > WINDOW + 15) { S.slots[a.slot] = null; a.slot = -1; }
      if (idle > 130) S.actors.delete(key);
    }
    for (const [key, l] of S.links) if (ns - l.last > WINDOW + 10) S.links.delete(key);
    const cut = S.buffer.findIndex((ev) => ev.ts >= ns - 125);
    if (cut > 0) S.buffer.splice(0, cut); else if (cut < 0) S.buffer.length = 0;
    const old = Math.floor(ns) - TL_SECONDS - 10;
    for (const sec of S.tl.keys()) if (sec < old) S.tl.delete(sec);
  }

  function updateRps() {
    const sec = Math.floor(nowS());
    let sum = 0;
    for (let s = sec - 5; s < sec; s++) {
      const row = S.tl.get(s);
      if (row) sum += row[0] + row[1] + row[2] + row[3];
    }
    S.rps = sum / 5;
    $('t-rps').textContent = S.rps >= 10 ? fmt(S.rps) : S.rps.toFixed(1);
  }

  function refresh() {
    updateRps();
    renderRanks();
    renderCard();
    drawTimeline();
  }

  function syncModeUi() {
    const unit = unitLabel();
    $('actors-title').textContent = '活躍' + unit;
    $('t-actors-l').textContent = '活躍' + unit;
    document.querySelector('.seg').hidden = !S.hasTeams;
    for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.mode === S.mode);
  }

  // ---- 互動 -----------------------------------------------------------------
  function bind() {
    for (const b of document.querySelectorAll('.seg button')) {
      b.addEventListener('click', () => {
        if (S.mode === b.dataset.mode) return;
        S.mode = b.dataset.mode;
        syncModeUi();
        rebuild();
      });
    }
    for (const chip of document.querySelectorAll('.chip[data-filter]')) {
      chip.addEventListener('click', () => {
        const f = chip.dataset.filter;
        S.filters[f] = !S.filters[f];
        chip.classList.toggle('on', S.filters[f]);
        chip.setAttribute('aria-pressed', String(S.filters[f]));
        rebuild();
      });
    }
    $('chip-cine').addEventListener('click', (e) => {
      S.cineOn = !S.cineOn;
      e.currentTarget.classList.toggle('on', S.cineOn);
      e.currentTarget.setAttribute('aria-pressed', String(S.cineOn));
      if (!S.cineOn && S.cine) endCine(true);
    });
    $('btn-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });

    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('mousemove', (e) => {
      const hit = hitTest(...pos(e));
      cv.style.cursor = hit ? 'pointer' : 'default';
      if (S.pinned) return;
      if (hit) setFocus(hit.kind, hit.id, false); else clearFocus(false);
    });
    cv.addEventListener('mouseleave', () => clearFocus(false));
    cv.addEventListener('click', (e) => {
      const hit = hitTest(...pos(e));
      if (!hit) return clearFocus(true);
      const same = S.pinned && S.focus && S.focus.kind === hit.kind && S.focus.id === hit.id;
      if (same) clearFocus(true); else setFocus(hit.kind, hit.id, true);
    });

    for (const ol of document.querySelectorAll('.rank')) {
      ol.addEventListener('mouseover', (e) => {
        const li = e.target.closest('li[data-id]');
        if (li && !S.pinned) setFocus(li.dataset.kind, li.dataset.id, false);
      });
      ol.addEventListener('mouseleave', () => clearFocus(false));
      ol.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        const same = S.pinned && S.focus && S.focus.kind === li.dataset.kind && S.focus.id === li.dataset.id;
        if (same) clearFocus(true); else setFocus(li.dataset.kind, li.dataset.id, true);
      });
    }

    tlCv.addEventListener('mousemove', (e) => {
      const r = tlCv.getBoundingClientRect();
      const pw = TL.W - TL.padL - TL.padR;
      const i = Math.floor(((e.clientX - r.left - TL.padL) / pw) * TL_SECONDS);
      S.tlHover = i >= 0 && i < TL_SECONDS ? i : -1;
      drawTimeline();
    });
    tlCv.addEventListener('mouseleave', () => { S.tlHover = -1; drawTimeline(); });

    new ResizeObserver(layout).observe(flowEl);
    new ResizeObserver(() => { layoutTimeline(); drawTimeline(); }).observe(tlCv.parentElement);
  }

  // ---- 啟動 -----------------------------------------------------------------
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    draw(now, dt);
    requestAnimationFrame(frame);
  }

  bind();
  layout();
  renderLegend();
  syncModeUi();
  $('empty').hidden = false;
  setInterval(() => { maintain(); renderRanks(); }, 1000);
  setInterval(() => { updateRps(); renderCard(); drawTimeline(); }, 250);
  connect();
  requestAnimationFrame(frame);
})();
