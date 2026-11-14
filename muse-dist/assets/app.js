/* Muse v3 — if Apple made this product.
 * The idea: a monitoring tool that is calm. It tells you "everything is fine"
 * and gets out of the way. One status, one list, one number per server.
 * Color is information only: green = healthy, red = needs attention.
 * Data still comes from the panel over same-origin relative paths:
 *   WS   /api/v1/ws/server            (live server list, ~2s, no auth)
 *   GET  /api/v1/setting              (site name)
 *   GET  /api/v1/server/:id/metrics?metric=&period=1d   (24h history, tsdb only)
 * The v2 API sends no net speeds — they are computed here from transfer
 * deltas. Offline = last_active older than 30s (or the zero time).
 */
"use strict";

const $ = (s) => document.querySelector(s);
const listEl = $("#serverList");
const MAX_POINTS = 300;            // live chart ring buffer (~10 min @ 2s)
const OFFLINE_AFTER_MS = 30_000;

/* ---------- state ---------- */
const servers = new Map();         // id -> { raw, online, inSpeed, outSpeed, prevIn, prevOut, prevAt, hist, shownCpu }
let ws = null, wsTimer = null, reconnectDelay = 1000;
let detailId = null, detailMetric = "cpu";
let lastUpdateAt = 0;

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
  if (d > 0) return d + "天 " + h + "小时";
  if (h > 0) return h + "小时 " + m + "分";
  return m + "分";
}
function fmtTimeAgo(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t) || t <= 0) return "从未上线";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
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

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("muse-theme", t); } catch (e) {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("muse-theme"); } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(t);
})();
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});

/* ---------- site setting ---------- */
fetch("./api/v1/setting").then((r) => r.json()).then((j) => {
  const name = j && j.data && j.data.config && j.data.config.site_name;
  if (name) $("#siteName").textContent = name;
}).catch(() => {});

/* ---------- search ---------- */
$("#searchInput").addEventListener("input", renderList);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#searchInput").focus();
  }
  if (e.key === "Escape") closeDetail();
});

/* ---------- websocket ---------- */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/api/v1/ws/server";
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => { reconnectDelay = 1000; };
  sock.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && Array.isArray(d.servers)) onServers(d.servers, d.now || Date.now());
  };
  sock.onclose = () => { scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
function scheduleReconnect() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

/* ---------- ingest ---------- */
function onServers(list, nowMs) {
  lastUpdateAt = nowMs;
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
  renderHero();
  renderList();
  if (detailId != null) renderDetail();
}
function pushPoint(arr, t, v) {
  arr.push([t, v]);
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

/* ---------- hero : one calm statement ---------- */
function renderHero() {
  const all = [...servers.values()];
  const eyebrow = $("#heroEyebrow"), title = $("#heroTitle"), sub = $("#heroSub");
  if (!all.length) {
    eyebrow.classList.remove("bad");
    eyebrow.innerHTML = "<i></i>正在连接…";
    title.textContent = "正在连接";
    sub.textContent = "正在获取服务器状态";
    return;
  }
  const online = all.filter((s) => s.online);
  const offline = all.filter((s) => !s.online);
  const ago = lastUpdateAt ? Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000)) : 0;
  if (!offline.length) {
    eyebrow.classList.remove("bad");
    eyebrow.innerHTML = "<i></i>一切正常";
    title.textContent = "一切正常";
    sub.textContent = `${all.length} 台服务器 · 全部在线 · ${ago} 秒前更新`;
  } else {
    eyebrow.classList.add("bad");
    eyebrow.innerHTML = "<i></i>需要注意";
    title.textContent = offline.length === 1 ? "1 台服务器离线" : `${offline.length} 台服务器离线`;
    sub.textContent = `${all.length} 台服务器 · ${online.length} 台在线 · ${offline.map((s) => s.raw.name).join("、")} 离线`;
  }
}

/* ---------- list : rows, keyed reconciliation ---------- */
function visibleServers() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  let arr = [...servers.values()];
  if (q) arr = arr.filter((s) => (s.raw.name || "").toLowerCase().includes(q));
  // needs attention first, then by name — the product decides the order
  arr.sort((a, b) => {
    if (a.online !== b.online) return a.online ? 1 : -1;
    return String(a.raw.name).localeCompare(String(b.raw.name));
  });
  return arr;
}
function renderList() {
  const arr = visibleServers();
  $("#emptyHint").hidden = arr.length !== 0;
  const wanted = new Map(arr.map((s) => [s.raw.id, s]));
  // remove rows that are gone
  for (const el of [...listEl.querySelectorAll(".row")]) {
    if (!wanted.has(Number(el.dataset.id))) el.remove();
  }
  // create / update in place (keeps tweens and focus stable)
  arr.forEach((s, i) => {
    let el = listEl.querySelector(`.row[data-id="${s.raw.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "row";
      el.dataset.id = s.raw.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.style.animationDelay = Math.min(i * 40, 320) + "ms";
      el.innerHTML = `<span class="dot"></span>
        <div class="row-main"><div class="row-name"></div><div class="row-sub"></div></div>
        <div class="row-right"><span class="row-cpu"></span><canvas class="row-spark" width="152" height="60"></canvas><span class="row-chev">›</span></div>`;
      el.addEventListener("click", () => openDetail(s.raw.id));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(s.raw.id); });
      listEl.appendChild(el);
    }
    const raw = s.raw, host = raw.host || {}, st = raw.state || {};
    el.classList.toggle("offline", !s.online);
    el.setAttribute("aria-label", raw.name + (s.online ? " 在线" : " 离线"));
    el.querySelector(".dot").classList.toggle("off", !s.online);
    el.querySelector(".row-name").textContent = raw.name;
    const flag = flagEmoji(raw.country_code);
    const sub = [flag, host.platform, host.arch, "运行 " + (s.online ? fmtUptime(st.uptime) : "离线 · 最后活跃 " + fmtTimeAgo(raw.last_active))]
      .filter((x) => x).join(" · ");
    el.querySelector(".row-sub").textContent = sub;
    // tween the big number toward the live value
    const target = s.online ? (st.cpu ?? 0) : 0;
    s.shownCpu += (target - s.shownCpu) * 0.25;
    if (Math.abs(target - s.shownCpu) < 0.05) s.shownCpu = target;
    const cpuEl = el.querySelector(".row-cpu");
    cpuEl.innerHTML = s.shownCpu.toFixed(0) + "<small>%</small>";
    cpuEl.classList.toggle("hot", s.online && target >= 90);
    drawSpark(el.querySelector(".row-spark"), s.hist.cpu, s.online);
  });
}
// keep numbers easing even between messages
setInterval(() => { if (servers.size) renderList(); }, 400);

function drawSpark(canvas, pts, online) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!online || !pts || pts.length < 2) {
    ctx.strokeStyle = cssVar("--text-3", "#86868b");
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  const vals = pts.map((p) => p[1]);
  const max = Math.max(...vals, 5);
  const x = (i) => (i / (pts.length - 1)) * w;
  const y = (v) => h - 4 - (v / max) * (h - 8);
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = cssVar("--ink", "#1d1d1f");
  ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
}

/* ---------- detail sheet ---------- */
function openDetail(id) {
  const s = servers.get(id);
  if (!s) return;
  detailId = id;
  $("#detail").classList.add("open");
  $("#detail").setAttribute("aria-hidden", "false");
  $("#detailBackdrop").hidden = false;
  renderDetail();
  loadHistory(id);
}
function closeDetail() {
  detailId = null;
  $("#detail").classList.remove("open");
  $("#detail").setAttribute("aria-hidden", "true");
  $("#detailBackdrop").hidden = true;
}
$("#detailClose").addEventListener("click", closeDetail);
$("#detailBackdrop").addEventListener("click", closeDetail);
document.querySelectorAll("#metricSeg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#metricSeg button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    detailMetric = btn.dataset.metric;
    renderDetail();
  });
});

function renderDetail() {
  const s = servers.get(detailId);
  if (!s) { closeDetail(); return; }
  const raw = s.raw, host = raw.host || {}, st = raw.state || {};
  $("#dName").textContent = raw.name;
  $("#dSub").textContent = (host.platform || "–") + (host.arch ? " · " + host.arch : "") +
    (host.cpu && host.cpu[0] ? " · " + host.cpu[0] : "") +
    " · " + (s.online ? "在线" : "离线 · 最后活跃 " + fmtTimeAgo(raw.last_active));
  const memP = pct(st.mem_used, host.mem_total);
  const diskP = pct(st.disk_used, host.disk_total);
  const swapP = pct(st.swap_used, host.swap_total);
  // the big number follows the selected metric
  const label = $("#dBigLabel"), value = $("#dBigValue"), unit = $("#dBigUnit");
  if (detailMetric === "cpu") {
    label.textContent = "CPU";
    value.textContent = st.cpu != null ? st.cpu.toFixed(0) : "–";
    unit.textContent = "%";
    drawMainChart(s.hist.cpu, (v) => v.toFixed(0) + "%");
  } else if (detailMetric === "mem") {
    label.textContent = "内存占用";
    value.textContent = memP.toFixed(0);
    unit.textContent = "%";
    drawMainChart(s.hist.mem, (v) => v.toFixed(0) + "%");
  } else {
    label.textContent = "网络 · 上传 / 下载";
    value.textContent = fmtSpeed(s.outSpeed).replace(" B/s", "").replace(" KB/s", "").replace(" MB/s", "");
    unit.textContent = fmtSpeed(s.outSpeed).includes("KB") ? "KB/s" : fmtSpeed(s.outSpeed).includes("MB") ? "MB/s" : "B/s";
    drawMainDualChart(s.hist.netIn, s.hist.netOut);
  }
  $("#chartCap").textContent = s.online ? "实时曲线 · 最近 10 分钟" : "离线 · 曲线已停止";
  const cells = [
    ["内存", fmtBytes(st.mem_used) + " / " + fmtBytes(host.mem_total) + (memP ? "（" + memP.toFixed(1) + "%）" : "")],
    ["交换", fmtBytes(st.swap_used) + " / " + fmtBytes(host.swap_total) + (swapP ? "（" + swapP.toFixed(1) + "%）" : "")],
    ["磁盘", fmtBytes(st.disk_used) + " / " + fmtBytes(host.disk_total) + (diskP ? "（" + diskP.toFixed(1) + "%）" : "")],
    ["上传", fmtSpeed(s.outSpeed) + " · 累计 " + fmtBytes(st.net_out_transfer)],
    ["下载", fmtSpeed(s.inSpeed) + " · 累计 " + fmtBytes(st.net_in_transfer)],
    ["负载 1 / 5 / 15", [st.load_1, st.load_5, st.load_15].map((v) => v ?? "–").join(" / ")],
    ["运行时间", fmtUptime(st.uptime)],
    ["进程", st.process_count ?? "–"],
    ["TCP / UDP 连接", (st.tcp_conn_count ?? "–") + " / " + (st.udp_conn_count ?? "–")],
    ["启动时间", host.boot_time ? new Date(host.boot_time * 1000).toLocaleString("zh-CN") : "–"],
    ["国家", raw.country_code ? raw.country_code.toUpperCase() : "–"],
  ];
  $("#dInfo").innerHTML = cells.map(([k, v]) => `<div class="d-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
}

function loadHistory(id) {
  $("#dHistNote").textContent = "加载中…";
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
      $("#dHistNote").textContent = pts.length + " 个采样点";
      drawMainChartInto($("#chartHist"), pts.map((p) => [p.ts, p.value]), (v) => v.toFixed(0) + "%");
    })
    .catch(() => {
      if (detailId !== id) return;
      $("#dHistNote").textContent = "";
      $("#dHistEmpty").hidden = false;
    });
}

/* ---------- charts : one ink color, no decoration ---------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 640, h = c.clientHeight || 200;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function drawMainChart(pts, fmtVal) { drawMainChartInto($("#chartMain"), pts, fmtVal); }
function drawMainChartInto(c, pts, fmtVal) {
  const { ctx, w, h } = setupCanvas(c);
  const gray = cssVar("--text-3", "#86868b");
  const ink = cssVar("--ink", "#1d1d1f");
  ctx.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) {
    ctx.fillStyle = gray; ctx.font = "13px sans-serif";
    ctx.fillText(pts && pts.length === 1 ? "采集中…" : "暂无数据", 4, 22);
    return;
  }
  const vals = pts.map((p) => p[1]);
  let max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  if (max - min < 1e-9) max = min + 1;
  const pad = (max - min) * 0.15; max += pad; min = Math.max(0, min - pad);
  const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 20 - ((v - min) / (max - min)) * (h - 34);
  ctx.font = "11px sans-serif";
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.2)");
  [0, 1].forEach((f) => {
    const yy = h - 20 - f * (h - 34);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtVal(min + f * (max - min)), 4, yy - 4);
  });
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, ink + "26"); grad.addColorStop(1, ink + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  ctx.lineTo(x(pts.length - 1), h - 20); ctx.lineTo(x(0), h - 20); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.fillStyle = gray;
  ctx.fillText(new Date(pts[0][0]).toLocaleTimeString("zh-CN", { hour12: false }), 2, h - 5);
  ctx.fillText(new Date(pts[pts.length - 1][0]).toLocaleTimeString("zh-CN", { hour12: false }), w - 56, h - 5);
}
function drawMainDualChart(downPts, upPts) {
  const c = $("#chartMain");
  const { ctx, w, h } = setupCanvas(c);
  const gray = cssVar("--text-3", "#86868b");
  const ink = cssVar("--ink", "#1d1d1f");
  ctx.clearRect(0, 0, w, h);
  const all = [...downPts.map((p) => p[1]), ...upPts.map((p) => p[1])];
  if (!all.length || (downPts.length < 2 && upPts.length < 2)) {
    ctx.fillStyle = gray; ctx.font = "13px sans-serif";
    ctx.fillText("采集中…", 4, 22);
    return;
  }
  const max = Math.max(...all, 1);
  const x = (i, n) => (i / (n - 1)) * (w - 4) + 2;
  const y = (v) => h - 20 - (v / max) * (h - 34);
  const line = (pts, alpha) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i, pts.length), y(p[1])) : ctx.lineTo(x(i, pts.length), y(p[1])); });
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
    ctx.globalAlpha = 1;
  };
  ctx.font = "11px sans-serif";
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.2)");
  [0, 1].forEach((f) => {
    const yy = h - 20 - f * (h - 34);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtSpeed(max * f), 4, yy - 4);
  });
  line(downPts, 1);
  line(upPts, 0.45);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = gray;
  ctx.fillText("— 下载", w - 92, 14);
  ctx.globalAlpha = 0.45; ctx.fillText("— 上传", w - 44, 14); ctx.globalAlpha = 1;
}

/* ---------- clock ---------- */
function tickClock() {
  $("#footClock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}
setInterval(tickClock, 1000); tickClock();

/* ---------- boot ---------- */
connectWS();
