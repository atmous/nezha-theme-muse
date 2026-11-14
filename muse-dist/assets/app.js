/* Muse v4 — sci-fi HUD. Dark, glowing, data-dense.
 * Same data layer as before: WS /api/v1/ws/server (live, no auth),
 * GET /api/v1/setting, GET /api/v1/server/:id/metrics (24h, tsdb only).
 * Net speeds are computed here from transfer deltas (v2 API has no speed
 * fields). Offline = last_active older than 30s (or the zero time).
 */
"use strict";

const $ = (s) => document.querySelector(s);
const gridEl = $("#serverGrid");
const MAX_POINTS = 300;            // live ring buffer (~10 min @ 2s)
const OFFLINE_AFTER_MS = 30_000;

/* ---------- state ---------- */
const servers = new Map();         // id -> { raw, online, inSpeed, outSpeed, prevIn, prevOut, prevAt, hist, shownCpu }
let ws = null, wsTimer = null, reconnectDelay = 1000;
let detailId = null;
let lastUpdateAt = 0, lastWsAt = 0;

/* ---------- helpers ---------- */
function fmtBytes(b) {
  if (!isFinite(b) || b == null) return "–";
  if (b < 0) b = 0;
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b >= 100 ? Math.round(b) : b.toFixed(1)) + " " + u[i];
}
function fmtSpeed(bps) {
  if (!isFinite(bps) || bps == null) return "–";
  return fmtBytes(bps) + "/s";
}
function fmtUptime(sec) {
  if (!isFinite(sec) || sec == null) return "–";
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400); sec %= 86400;
  const h = Math.floor(sec / 3600); sec %= 3600;
  const m = Math.floor(sec / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}
function fmtTimeAgo(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t) || t <= 0) return "NEVER";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + "s AGO";
  if (s < 3600) return Math.floor(s / 60) + "m AGO";
  if (s < 86400) return Math.floor(s / 3600) + "h AGO";
  return Math.floor(s / 86400) + "d AGO";
}
function flagEmoji(cc) {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return "";
  const up = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return "";
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pct(used, total) {
  if (!total || total <= 0 || used == null) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}
function barClass(p) { return p >= 90 ? "hot" : p >= 75 ? "warn" : ""; }

/* ---------- theme : HUD is dark by nature ---------- */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("muse-theme", t); } catch (e) {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("muse-theme"); } catch (e) {}
  // v4 is a dark HUD; force dark unless the user explicitly picked light
  if (t !== "light") t = "dark";
  applyTheme(t);
})();
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});

/* ---------- site setting ---------- */
fetch("./api/v1/setting").then((r) => r.json()).then((j) => {
  const name = j && j.data && j.data.config && j.data.config.site_name;
  if (name) document.querySelector(".brand-tag").textContent = "// " + name.toUpperCase() + " HUD";
}).catch(() => {});

/* ---------- search ---------- */
$("#searchInput").addEventListener("input", renderAll);

/* ---------- websocket ---------- */
function connectWS() {
  setLink("CONNECTING", "");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/api/v1/ws/server";
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => { reconnectDelay = 1000; setLink("LIVE", "ok"); };
  sock.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && Array.isArray(d.servers)) onServers(d.servers, d.now || Date.now());
  };
  sock.onclose = () => { setLink("LOST", "bad"); scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
function scheduleReconnect() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}
function setLink(text, cls) {
  $("#linkText").textContent = "LINK···" + text;
  $("#linkBox").className = "link" + (cls ? " " + cls : "");
}

/* ---------- ingest ---------- */
function onServers(list, nowMs) {
  lastUpdateAt = nowMs; lastWsAt = Date.now();
  const seen = new Set();
  for (const raw of list) {
    if (!raw || raw.id == null) continue;
    seen.add(raw.id);
    let s = servers.get(raw.id);
    if (!s) {
      s = { raw, online: false, inSpeed: 0, outSpeed: 0, prevIn: null, prevOut: null, prevAt: null,
            hist: { cpu: [], mem: [], netIn: [], netOut: [] }, shownCpu: 0 };
      servers.set(raw.id, s);
    }
    const st = raw.state || {};
    if (s.prevIn != null && s.prevAt != null && nowMs > s.prevAt) {
      const dt = (nowMs - s.prevAt) / 1000;
      const dIn = (st.net_in_transfer ?? 0) - s.prevIn;
      const dOut = (st.net_out_transfer ?? 0) - s.prevOut;
      s.inSpeed = dIn >= 0 ? dIn / dt : 0;
      s.outSpeed = dOut >= 0 ? dOut / dt : 0;
    }
    s.prevIn = st.net_in_transfer ?? 0;
    s.prevOut = st.net_out_transfer ?? 0;
    s.prevAt = nowMs;
    s.raw = raw;
    const la = Date.parse(raw.last_active);
    const hasState = raw.state && Object.keys(raw.state).length > 0;
    s.online = hasState && isFinite(la) && la > 0 && (nowMs - la) < OFFLINE_AFTER_MS;
    if (s.online) {
      const h = s.hist, t = nowMs;
      const memPct = pct(st.mem_used, raw.host && raw.host.mem_total);
      pushPoint(h.cpu, t, st.cpu ?? 0);
      pushPoint(h.mem, t, memPct);
      pushPoint(h.netIn, t, s.inSpeed);
      pushPoint(h.netOut, t, s.outSpeed);
    }
  }
  for (const id of [...servers.keys()]) if (!seen.has(id)) servers.delete(id);
  renderAll();
  if (detailId != null) renderDetail();
}
function pushPoint(arr, t, v) {
  arr.push([t, v]);
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

/* ---------- render : status strip + panels ---------- */
function visibleServers() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  let arr = [...servers.values()];
  if (q) arr = arr.filter((s) => (s.raw.name || "").toLowerCase().includes(q));
  arr.sort((a, b) => {
    if (a.online !== b.online) return a.online ? 1 : -1;
    return String(a.raw.name).localeCompare(String(b.raw.name));
  });
  return arr;
}
function renderAll() {
  const arr = visibleServers();
  $("#emptyHint").hidden = arr.length !== 0;
  // status strip
  const all = [...servers.values()];
  const online = all.filter((s) => s.online);
  const offline = all.filter((s) => !s.online);
  const statusEl = $("#statStatus");
  if (!all.length) {
    statusEl.textContent = "···"; statusEl.className = "";
  } else if (!offline.length) {
    statusEl.textContent = "NOMINAL"; statusEl.className = "gd";
  } else {
    statusEl.textContent = "ALERT"; statusEl.className = "bd";
  }
  $("#statOnline").textContent = all.length ? online.length + " / " + all.length : "–";
  $("#statOnline").className = offline.length ? "bd" : "gd";
  const avgCpu = online.length ? online.reduce((a, s) => a + (s.raw.state?.cpu ?? 0), 0) / online.length : null;
  const avgMem = online.length ? online.reduce((a, s) => a + pct(s.raw.state?.mem_used, s.raw.host?.mem_total), 0) / online.length : null;
  $("#statCpu").textContent = avgCpu != null ? avgCpu.toFixed(1) + "%" : "–";
  $("#statCpu").className = avgCpu != null && avgCpu >= 90 ? "bd" : "cy";
  $("#statMem").textContent = avgMem != null ? avgMem.toFixed(1) + "%" : "–";
  $("#statMem").className = avgMem != null && avgMem >= 90 ? "bd" : "cy";
  const totNet = online.reduce((a, s) => a + s.inSpeed + s.outSpeed, 0);
  $("#statNet").textContent = all.length ? fmtSpeed(totNet) : "–";
  $("#statNet").className = "cy";
  $("#statAlerts").textContent = String(offline.length);
  $("#statAlerts").className = offline.length ? "bd" : "gd";
  $("#statUpdated").textContent = lastUpdateAt ? Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000)) + "s AGO" : "–";
  // panels, keyed reconciliation
  const wanted = new Map(arr.map((s) => [s.raw.id, s]));
  for (const el of [...gridEl.querySelectorAll(".panel")]) {
    if (!wanted.has(Number(el.dataset.id))) el.remove();
  }
  arr.forEach((s, i) => {
    let el = gridEl.querySelector(`.panel[data-id="${s.raw.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "panel";
      el.dataset.id = s.raw.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.style.animationDelay = Math.min(i * 50, 350) + "ms";
      el.innerHTML = `<div class="panel-head">
          <span class="flag"></span>
          <div style="min-width:0"><div class="p-name"></div><div class="p-sub"></div></div>
          <span class="pill"></span>
        </div>
        <div class="p-main">
          <div class="p-cpu"></div>
          <div class="p-chart"><label>CPU // LIVE</label><canvas width="480" height="104"></canvas></div>
        </div>
        <div class="bars">
          <div class="bar-row"><label>CPU</label><div class="bar"><i class="b-cpu"></i></div><output class="o-cpu"></output></div>
          <div class="bar-row"><label>MEM</label><div class="bar"><i class="b-mem"></i></div><output class="o-mem"></output></div>
          <div class="bar-row"><label>DISK</label><div class="bar"><i class="b-disk"></i></div><output class="o-disk"></output></div>
        </div>
        <div class="readouts"></div>
        <div class="offline-note" hidden></div>`;
      el.addEventListener("click", () => openDetail(s.raw.id));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(s.raw.id); });
      gridEl.appendChild(el);
    }
    updatePanel(el, s);
  });
}
function updatePanel(el, s) {
  const raw = s.raw, host = raw.host || {}, st = raw.state || {};
  el.classList.toggle("offline", !s.online);
  el.querySelector(".flag").textContent = flagEmoji(raw.country_code) || "◆";
  el.querySelector(".p-name").textContent = raw.name.toUpperCase();
  const cpuModel = host.cpu && host.cpu[0] ? host.cpu[0].replace(/\(R\)|\(TM\)| Processor/g, "").trim() : "";
  el.querySelector(".p-sub").textContent = [host.platform, host.arch, cpuModel].filter(Boolean).join(" · ").toUpperCase() || "–";
  const pill = el.querySelector(".pill");
  pill.textContent = s.online ? "● ONLINE" : "● OFFLINE";
  pill.classList.toggle("off", !s.online);
  // tween the big CPU number
  const target = s.online ? (st.cpu ?? 0) : 0;
  s.shownCpu += (target - s.shownCpu) * 0.25;
  if (Math.abs(target - s.shownCpu) < 0.05) s.shownCpu = target;
  const cpuEl = el.querySelector(".p-cpu");
  cpuEl.innerHTML = s.shownCpu.toFixed(0) + "<small>%</small>";
  cpuEl.className = "p-cpu" + (s.online && target >= 90 ? " hot" : s.online && target >= 75 ? " warm" : "");
  drawStrip(el.querySelector(".p-chart canvas"), s.hist.cpu, s.online);
  const memP = pct(st.mem_used, host.mem_total);
  const diskP = pct(st.disk_used, host.disk_total);
  const setBar = (cls, out, v) => {
    el.querySelector(cls).style.width = v.toFixed(1) + "%";
    el.querySelector(cls).className = "b-" + cls.slice(3) + " " + barClass(v);
    el.querySelector(out).textContent = v.toFixed(1) + "%";
  };
  setBar(".b-cpu", ".o-cpu", s.online ? target : 0);
  setBar(".b-mem", ".o-mem", s.online ? memP : 0);
  setBar(".b-disk", ".o-disk", s.online ? diskP : 0);
  const ro = [
    ["MEM", s.online ? fmtBytes(st.mem_used) + " / " + fmtBytes(host.mem_total) : "–", ""],
    ["NET ↑", s.online ? fmtSpeed(s.outSpeed) : "–", "up"],
    ["NET ↓", s.online ? fmtSpeed(s.inSpeed) : "–", "dn"],
    ["LOAD 1m", s.online ? (st.load_1 ?? "–") : "–", ""],
    ["UPTIME", s.online ? fmtUptime(st.uptime) : "–", ""],
    ["PROCS", s.online ? (st.process_count ?? "–") : "–", ""],
    ["TCP/UDP", s.online ? (st.tcp_conn_count ?? "–") + "/" + (st.udp_conn_count ?? "–") : "–", ""],
    ["SWAP", s.online ? pct(st.swap_used, host.swap_total).toFixed(0) + "%" : "–", ""],
  ];
  el.querySelector(".readouts").innerHTML = ro.map(([k, v, c]) =>
    `<div class="ro"><label>${k}</label><b class="${c}">${esc(v)}</b></div>`).join("");
  const note = el.querySelector(".offline-note");
  note.hidden = s.online;
  note.textContent = s.online ? "" : "⚠ SIGNAL LOST · LAST SEEN " + fmtTimeAgo(raw.last_active);
}
// keep numbers easing between messages
setInterval(() => { if (servers.size) renderAll(); }, 400);

function drawStrip(canvas, pts, online) {
  const { ctx, w, h } = setupCanvas(canvas);
  const cyan = cssVar("--cyan", "#00e5ff");
  ctx.clearRect(0, 0, w, h);
  // baseline grid
  ctx.strokeStyle = cssVar("--line-soft", "rgba(0,229,255,.12)");
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
  if (!online || !pts || pts.length < 2) {
    ctx.strokeStyle = cssVar("--text-3", "#4a5878");
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const vals = pts.map((p) => p[1]);
  const max = Math.max(...vals, 5);
  const x = (i) => (i / (pts.length - 1)) * w;
  const y = (v) => h - 2 - (v / max) * (h - 6);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, cyan + "44"); grad.addColorStop(1, cyan + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = cyan; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.shadowColor = cyan; ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(x(pts.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
}

/* ---------- detail overlay ---------- */
function openDetail(id) {
  const s = servers.get(id);
  if (!s) return;
  detailId = id;
  const ov = $("#detailOverlay");
  ov.hidden = false;
  ov.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderDetail();
  loadHistory(id);
}
function closeDetail() {
  detailId = null;
  const ov = $("#detailOverlay");
  ov.hidden = true;
  ov.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
$("#detailClose").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

function renderDetail() {
  const s = servers.get(detailId);
  if (!s) { closeDetail(); return; }
  const raw = s.raw, host = raw.host || {}, st = raw.state || {};
  $("#dEyebrow").textContent = "SERVER // DETAIL · ID " + raw.id + (s.online ? " · ONLINE" : " · OFFLINE");
  $("#dName").textContent = raw.name.toUpperCase();
  $("#dSub").textContent = [host.platform, host.arch, host.cpu && host.cpu[0], raw.country_code ? raw.country_code.toUpperCase() : ""]
    .filter(Boolean).join(" · ").toUpperCase();
  const memP = pct(st.mem_used, host.mem_total);
  $("#dCpuBig").textContent = s.online && st.cpu != null ? st.cpu.toFixed(1) + "%" : "–";
  $("#dMemBig").textContent = s.online ? memP.toFixed(1) + "%" : "–";
  $("#dNetUp").textContent = s.online ? "↑ " + fmtSpeed(s.outSpeed) : "–";
  $("#dNetDown").textContent = s.online ? "↓ " + fmtSpeed(s.inSpeed) : "–";
  $("#dUpBig").textContent = s.online ? fmtUptime(st.uptime) : "–";
  $("#dCpuNow").textContent = s.online && st.cpu != null ? st.cpu.toFixed(1) + "%" : "–";
  $("#dMemNow").textContent = s.online ? memP.toFixed(1) + "%" : "–";
  $("#dNetNow").textContent = s.online ? "↑ " + fmtSpeed(s.outSpeed) + " ↓ " + fmtSpeed(s.inSpeed) : "–";
  drawChart($("#chartCpu"), s.hist.cpu, (v) => v.toFixed(0) + "%");
  drawChart($("#chartMem"), s.hist.mem, (v) => v.toFixed(0) + "%");
  drawDualChart($("#chartNet"), s.hist.netIn, s.hist.netOut);
  const cells = [
    ["MEMORY", fmtBytes(st.mem_used) + " / " + fmtBytes(host.mem_total) + " (" + memP.toFixed(1) + "%)"],
    ["SWAP", fmtBytes(st.swap_used) + " / " + fmtBytes(host.swap_total) + " (" + pct(st.swap_used, host.swap_total).toFixed(1) + "%)"],
    ["DISK", fmtBytes(st.disk_used) + " / " + fmtBytes(host.disk_total) + " (" + pct(st.disk_used, host.disk_total).toFixed(1) + "%)"],
    ["NET OUT", fmtSpeed(s.outSpeed) + " · TOTAL " + fmtBytes(st.net_out_transfer)],
    ["NET IN", fmtSpeed(s.inSpeed) + " · TOTAL " + fmtBytes(st.net_in_transfer)],
    ["LOAD 1/5/15", [st.load_1, st.load_5, st.load_15].map((v) => v ?? "–").join(" / ")],
    ["UPTIME", fmtUptime(st.uptime)],
    ["PROCESSES", st.process_count ?? "–"],
    ["TCP / UDP", (st.tcp_conn_count ?? "–") + " / " + (st.udp_conn_count ?? "–")],
    ["BOOT TIME", host.boot_time ? new Date(host.boot_time * 1000).toLocaleString("zh-CN") : "–"],
    ["COUNTRY", raw.country_code ? raw.country_code.toUpperCase() : "–"],
    ["LAST ACTIVE", fmtTimeAgo(raw.last_active)],
  ];
  $("#dInfo").innerHTML = cells.map(([k, v]) => `<div class="ro"><label>${esc(k)}</label><b>${esc(v)}</b></div>`).join("");
}

function loadHistory(id) {
  $("#dHistNote").textContent = "LOADING…";
  $("#dHistEmpty").hidden = true;
  fetch("./api/v1/server/" + id + "/metrics?metric=cpu&period=1d")
    .then((r) => r.json())
    .then((j) => {
      if (detailId !== id) return;
      const pts = (j && j.data && j.data.data_points) || [];
      if (!pts.length) {
        $("#dHistNote").textContent = "";
        $("#dHistEmpty").hidden = false;
        const c = $("#chartHist"), ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
        return;
      }
      $("#dHistNote").textContent = pts.length + " SAMPLES";
      drawChart($("#chartHist"), pts.map((p) => [p.ts, p.value]), (v) => v.toFixed(0) + "%");
    })
    .catch(() => {
      if (detailId !== id) return;
      $("#dHistNote").textContent = "";
      $("#dHistEmpty").hidden = false;
    });
}

/* ---------- charts ---------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 480, h = c.clientHeight || 150;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function drawChart(c, pts, fmtVal) {
  const { ctx, w, h } = setupCanvas(c);
  const cyan = cssVar("--cyan", "#00e5ff");
  const gray = cssVar("--text-3", "#4a5878");
  ctx.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) {
    ctx.fillStyle = gray; ctx.font = "12px monospace";
    ctx.fillText(pts && pts.length === 1 ? "COLLECTING…" : "NO DATA", 6, 20);
    return;
  }
  const vals = pts.map((p) => p[1]);
  let max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  if (max - min < 1e-9) max = min + 1;
  const pad = (max - min) * 0.15; max += pad; min = Math.max(0, min - pad);
  const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 18 - ((v - min) / (max - min)) * (h - 30);
  ctx.font = "10px monospace";
  ctx.strokeStyle = cssVar("--line-soft", "rgba(0,229,255,.12)");
  [0, 1].forEach((f) => {
    const yy = h - 18 - f * (h - 30);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtVal(min + f * (max - min)), 4, yy - 3);
  });
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, cyan + "33"); grad.addColorStop(1, cyan + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = cyan; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.shadowColor = cyan; ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(x(pts.length - 1), h - 18); ctx.lineTo(x(0), h - 18); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.fillStyle = gray;
  ctx.fillText(new Date(pts[0][0]).toLocaleTimeString("zh-CN", { hour12: false }), 2, h - 4);
  ctx.fillText(new Date(pts[pts.length - 1][0]).toLocaleTimeString("zh-CN", { hour12: false }), w - 52, h - 4);
}
function drawDualChart(c, downPts, upPts) {
  const { ctx, w, h } = setupCanvas(c);
  const cyan = cssVar("--cyan", "#00e5ff");
  const blue = cssVar("--blue", "#38bdf8");
  const gray = cssVar("--text-3", "#4a5878");
  ctx.clearRect(0, 0, w, h);
  const all = [...downPts.map((p) => p[1]), ...upPts.map((p) => p[1])];
  if (!all.length || (downPts.length < 2 && upPts.length < 2)) {
    ctx.fillStyle = gray; ctx.font = "12px monospace";
    ctx.fillText("COLLECTING…", 6, 20);
    return;
  }
  const max = Math.max(...all, 1);
  const x = (i, n) => (i / (n - 1)) * (w - 4) + 2;
  const y = (v) => h - 18 - (v / max) * (h - 30);
  const line = (pts, color, alpha) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i, pts.length), y(p[1])) : ctx.lineTo(x(i, pts.length), y(p[1])); });
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.shadowColor = color; ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };
  ctx.font = "10px monospace";
  ctx.strokeStyle = cssVar("--line-soft", "rgba(0,229,255,.12)");
  [0, 1].forEach((f) => {
    const yy = h - 18 - f * (h - 30);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtSpeed(max * f), 4, yy - 3);
  });
  line(downPts, cyan, 1);
  line(upPts, blue, 0.7);
  ctx.font = "10px monospace";
  ctx.fillStyle = cyan; ctx.fillText("— DOWN", w - 96, 12);
  ctx.fillStyle = blue; ctx.fillText("— UP", w - 44, 12);
}

/* ---------- clocks ---------- */
function tickClock() {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  $("#clock").textContent = t;
  $("#footClock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}
setInterval(tickClock, 1000); tickClock();

/* ---------- boot ---------- */
connectWS();
