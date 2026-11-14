/* Muse v5 — restraint, after Linear / Stripe / Vercel.
 * Patterns stolen from the references (not pixels):
 *  - Linear: near-monochrome, one accent, low-contrast borders, crisp type;
 *    everything non-essential absent; one level of detail at a time.
 *  - Stripe: tables are the product — right-aligned tabular numerals,
 *    muted gridlines, inline sparklines; one hero metric visualized,
 *    everything else numeric; chart is a summary, table is the truth.
 *  - Vercel: hierarchy from spacing and type weight; color = meaning only.
 * Data layer (unchanged): WS /api/v1/ws/server (live, no auth),
 * GET /api/v1/setting, GET /api/v1/server/:id/metrics (24h, tsdb only).
 * Net speeds are computed here from transfer deltas. Offline =
 * last_active older than 30s (or the zero time).
 */
"use strict";

const $ = (s) => document.querySelector(s);
const tbody = $("#serverTbody");
const MAX_POINTS = 300;            // live ring buffer (~10 min @ 2s)
const OFFLINE_AFTER_MS = 30_000;

/* ---------- state ---------- */
const servers = new Map();         // id -> { raw, online, inSpeed, outSpeed, prevIn, prevOut, prevAt, hist, shownCpu }
const fleetHist = [];              // [ts, avg cpu across online servers]
let ws = null, wsTimer = null, reconnectDelay = 1000;
let detailId = null, detailMetric = "cpu";
let lastUpdateAt = 0;
let sortKey = "status", sortDir = 1;   // default: offline first

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
function barClass(p) { return p >= 90 ? "hot" : p >= 75 ? "warn" : ""; }

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
$("#searchInput").addEventListener("input", renderAll);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#searchInput").focus();
  }
  if (e.key === "Escape") closeDetail();
});

/* ---------- sortable headers (Stripe tables) ---------- */
document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
    document.querySelectorAll("th.sortable").forEach((t) => {
      t.classList.remove("sorted");
      const a = t.querySelector(".arrow");
      if (a) a.remove();
    });
    th.classList.add("sorted");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = sortDir === 1 ? "↑" : "↓";
    th.appendChild(arrow);
    renderAll();
  });
});

/* ---------- websocket ---------- */
function connectWS() {
  setConn("连接中…", "");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/api/v1/ws/server";
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => { reconnectDelay = 1000; setConn("实时连接", "ok"); };
  sock.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && Array.isArray(d.servers)) onServers(d.servers, d.now || Date.now());
  };
  sock.onclose = () => { setConn("连接断开", "bad"); scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
function scheduleReconnect() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}
function setConn(text, cls) {
  $("#connText").textContent = text;
  $("#connDot").className = "conn" + (cls ? " " + cls : "");
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
  // fleet-average CPU for the one hero chart
  const online = [...servers.values()].filter((s) => s.online);
  if (online.length) {
    const avg = online.reduce((a, s) => a + (s.raw.state?.cpu ?? 0), 0) / online.length;
    fleetHist.push([nowMs, avg]);
    if (fleetHist.length > MAX_POINTS) fleetHist.splice(0, fleetHist.length - MAX_POINTS);
  }
  renderAll();
  if (detailId != null) renderDetail();
}
function pushPoint(arr, t, v) {
  arr.push([t, v]);
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

/* ---------- render : KPIs + hero chart + table ---------- */
function visibleServers() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  let arr = [...servers.values()];
  if (q) arr = arr.filter((s) => (s.raw.name || "").toLowerCase().includes(q));
  const key = sortKey, dir = sortDir;
  const val = (s) => {
    const st = s.raw.state || {}, host = s.raw.host || {};
    switch (key) {
      case "name": return String(s.raw.name || "");
      case "status": return s.online ? 1 : 0;
      case "cpu": return s.online ? (st.cpu ?? 0) : -1;
      case "mem": return s.online ? pct(st.mem_used, host.mem_total) : -1;
      case "disk": return s.online ? pct(st.disk_used, host.disk_total) : -1;
      case "net": return s.online ? s.outSpeed + s.inSpeed : -1;
      case "uptime": return s.online ? (st.uptime ?? 0) : -1;
      default: return 0;
    }
  };
  arr.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === "string") return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  return arr;
}
function renderAll() {
  const all = [...servers.values()];
  const online = all.filter((s) => s.online);
  const offline = all.filter((s) => !s.online);
  // page head
  $("#pageSub").textContent = !all.length ? "正在连接…" :
    offline.length ? `${all.length} 台服务器 · ${online.length} 台在线 · ${offline.length} 台离线` :
    `${all.length} 台服务器 · 全部在线 · ${lastUpdateAt ? Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000)) + " 秒前更新" : ""}`;
  // KPIs — one primary (online), rest quiet
  const kOnline = $("#kpiOnline");
  kOnline.textContent = all.length ? online.length + " / " + all.length : "–";
  kOnline.className = offline.length ? "bd" : "gd";
  $("#kpiOnlineSub").textContent = offline.length ? offline.map((s) => s.raw.name).join("、") + " 离线" : "全部在线";
  const avgCpu = online.length ? online.reduce((a, s) => a + (s.raw.state?.cpu ?? 0), 0) / online.length : null;
  const avgMem = online.length ? online.reduce((a, s) => a + pct(s.raw.state?.mem_used, s.raw.host?.mem_total), 0) / online.length : null;
  const kCpu = $("#kpiCpu");
  kCpu.textContent = avgCpu != null ? avgCpu.toFixed(1) + "%" : "–";
  kCpu.className = avgCpu != null && avgCpu >= 90 ? "bd" : "";
  const kMem = $("#kpiMem");
  kMem.textContent = avgMem != null ? avgMem.toFixed(1) + "%" : "–";
  kMem.className = avgMem != null && avgMem >= 90 ? "bd" : "";
  const totNet = online.reduce((a, s) => a + s.inSpeed + s.outSpeed, 0);
  const kNet = $("#kpiNet");
  kNet.textContent = all.length ? fmtSpeed(totNet) : "–";
  kNet.className = "ac";
  const kAlerts = $("#kpiAlerts");
  kAlerts.textContent = String(offline.length);
  kAlerts.className = offline.length ? "bd" : "";
  // hero chart (the one visualization)
  $("#heroCpuNow").textContent = avgCpu != null ? avgCpu.toFixed(1) + "%" : "";
  drawArea($("#chartFleet"), fleetHist, (v) => v.toFixed(0) + "%");
  // table
  const arr = visibleServers();
  $("#emptyHint").hidden = arr.length !== 0;
  const wanted = new Map(arr.map((s) => [s.raw.id, s]));
  for (const el of [...tbody.querySelectorAll("tr")]) {
    if (!wanted.has(Number(el.dataset.id))) el.remove();
  }
  arr.forEach((s) => {
    let tr = tbody.querySelector(`tr[data-id="${s.raw.id}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.id = s.raw.id;
      tr.tabIndex = 0;
      tr.innerHTML = `<td class="cell-server"><div class="cell-name"></div><div class="cell-sub"></div></td>
        <td><span class="status-pill"><i></i><em></em></span></td>
        <td class="num"><span class="cpu-cell"><b></b><canvas width="144" height="52"></canvas></span></td>
        <td class="num mem-cell"></td>
        <td class="num disk-cell hide-md"></td>
        <td class="num net-up-cell"></td>
        <td class="num net-down-cell hide-md"></td>
        <td class="num load-cell hide-md"></td>
        <td class="num uptime-cell hide-md"></td>`;
      tr.addEventListener("click", () => openDetail(s.raw.id));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(s.raw.id); });
      tbody.appendChild(tr);
    }
    updateRow(tr, s);
    // appendChild moves an existing row — this reorders the DOM to the sort
    tbody.appendChild(tr);
  });
}
function updateRow(tr, s) {
  const raw = s.raw, host = raw.host || {}, st = raw.state || {};
  tr.classList.toggle("offline", !s.online);
  tr.querySelector(".cell-name").textContent = raw.name;
  const flag = flagEmoji(raw.country_code);
  tr.querySelector(".cell-sub").innerHTML = (flag ? `<span class="flag">${flag}</span>` : "") +
    esc([host.platform, host.arch].filter(Boolean).join(" · ") || "–");
  const pill = tr.querySelector(".status-pill");
  pill.classList.toggle("off", !s.online);
  pill.querySelector("em").textContent = s.online ? "在线" : "离线";
  pill.querySelector("em").style.fontStyle = "normal";
  // CPU: tweened number + inline sparkline (Stripe pattern)
  const target = s.online ? (st.cpu ?? 0) : 0;
  s.shownCpu += (target - s.shownCpu) * 0.25;
  if (Math.abs(target - s.shownCpu) < 0.05) s.shownCpu = target;
  const cpuB = tr.querySelector(".cpu-cell b");
  cpuB.textContent = s.shownCpu.toFixed(1) + "%";
  cpuB.className = s.online && target >= 90 ? "hot" : "";
  drawSpark(tr.querySelector(".cpu-cell canvas"), s.hist.cpu, s.online);
  const memP = pct(st.mem_used, host.mem_total);
  const diskP = pct(st.disk_used, host.disk_total);
  tr.querySelector(".mem-cell").innerHTML = s.online
    ? `${memP.toFixed(1)}%<span class="mini-bar"><i class="${barClass(memP)}" style="width:${memP.toFixed(1)}%"></i></span>` : "–";
  tr.querySelector(".disk-cell").innerHTML = s.online
    ? `${diskP.toFixed(1)}%<span class="mini-bar"><i class="${barClass(diskP)}" style="width:${diskP.toFixed(1)}%"></i></span>` : "–";
  tr.querySelector(".net-up-cell").textContent = s.online ? fmtSpeed(s.outSpeed) : "–";
  tr.querySelector(".net-down-cell").textContent = s.online ? fmtSpeed(s.inSpeed) : "–";
  tr.querySelector(".load-cell").textContent = s.online ? (st.load_1 ?? "–") : "–";
  tr.querySelector(".uptime-cell").textContent = s.online ? fmtUptime(st.uptime) : fmtTimeAgo(raw.last_active);
}
// keep numbers easing between messages
setInterval(() => { if (servers.size) renderAll(); }, 400);

function drawSpark(canvas, pts, online) {
  const { ctx, w, h } = setupCanvas(canvas);
  const accent = cssVar("--accent", "#7c7cff");
  ctx.clearRect(0, 0, w, h);
  if (!online || !pts || pts.length < 2) {
    ctx.strokeStyle = cssVar("--text-3", "#6b7280");
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const vals = pts.map((p) => p[1]);
  const max = Math.max(...vals, 5);
  const x = (i) => (i / (pts.length - 1)) * w;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = accent; ctx.lineWidth = 1.75; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
}

/* ---------- detail drawer : progressive disclosure ---------- */
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
  $("#dEyebrow").textContent = "服务器 · ID " + raw.id;
  $("#dName").textContent = raw.name;
  $("#dSub").textContent = (host.platform || "–") + (host.arch ? " · " + host.arch : "") +
    (host.cpu && host.cpu[0] ? " · " + host.cpu[0] : "") +
    " · " + (s.online ? "在线" : "离线 · 最后活跃 " + fmtTimeAgo(raw.last_active));
  const memP = pct(st.mem_used, host.mem_total);
  $("#dCpuBig").textContent = s.online && st.cpu != null ? st.cpu.toFixed(1) + "%" : "–";
  $("#dMemBig").textContent = s.online ? memP.toFixed(1) + "%" : "–";
  $("#dNetUpBig").textContent = s.online ? fmtSpeed(s.outSpeed) : "–";
  $("#dNetDownBig").textContent = s.online ? fmtSpeed(s.inSpeed) : "–";
  if (detailMetric === "cpu") drawArea($("#chartMain"), s.hist.cpu, (v) => v.toFixed(0) + "%");
  else if (detailMetric === "mem") drawArea($("#chartMain"), s.hist.mem, (v) => v.toFixed(0) + "%");
  else drawDualArea($("#chartMain"), s.hist.netIn, s.hist.netOut);
  $("#chartCap").textContent = s.online ? "实时曲线 · 最近 10 分钟" : "离线 · 曲线已停止";
  const diskP = pct(st.disk_used, host.disk_total);
  const swapP = pct(st.swap_used, host.swap_total);
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
      drawArea($("#chartHist"), pts.map((p) => [p.ts, p.value]), (v) => v.toFixed(0) + "%");
    })
    .catch(() => {
      if (detailId !== id) return;
      $("#dHistNote").textContent = "";
      $("#dHistEmpty").hidden = false;
    });
}

/* ---------- charts : one accent, soft area, muted grid ---------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 600, h = c.clientHeight || 180;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function drawArea(c, pts, fmtVal) {
  const { ctx, w, h } = setupCanvas(c);
  const accent = cssVar("--accent", "#7c7cff");
  const gray = cssVar("--text-3", "#6b7280");
  ctx.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) {
    ctx.fillStyle = gray; ctx.font = "12px sans-serif";
    ctx.fillText(pts && pts.length === 1 ? "采集中…" : "暂无数据", 6, 20);
    return;
  }
  const vals = pts.map((p) => p[1]);
  let max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  if (max - min < 1e-9) max = min + 1;
  const pad = (max - min) * 0.12; max += pad; min = Math.max(0, min - pad);
  const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 20 - ((v - min) / (max - min)) * (h - 32);
  ctx.font = "11px sans-serif";
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.14)");
  [0, 1].forEach((f) => {
    const yy = h - 20 - f * (h - 32);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtVal(min + f * (max - min)), 4, yy - 4);
  });
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, accent + "30"); grad.addColorStop(1, accent + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineTo(x(pts.length - 1), h - 20); ctx.lineTo(x(0), h - 20); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.fillStyle = gray;
  ctx.fillText(new Date(pts[0][0]).toLocaleTimeString("zh-CN", { hour12: false }), 2, h - 5);
  ctx.fillText(new Date(pts[pts.length - 1][0]).toLocaleTimeString("zh-CN", { hour12: false }), w - 52, h - 5);
}
function drawDualArea(c, downPts, upPts) {
  const { ctx, w, h } = setupCanvas(c);
  const accent = cssVar("--accent", "#7c7cff");
  const green = cssVar("--green", "#34d399");
  const gray = cssVar("--text-3", "#6b7280");
  ctx.clearRect(0, 0, w, h);
  const all = [...downPts.map((p) => p[1]), ...upPts.map((p) => p[1])];
  if (!all.length || (downPts.length < 2 && upPts.length < 2)) {
    ctx.fillStyle = gray; ctx.font = "12px sans-serif";
    ctx.fillText("采集中…", 6, 20);
    return;
  }
  const max = Math.max(...all, 1);
  const x = (i, n) => (i / (n - 1)) * (w - 4) + 2;
  const y = (v) => h - 20 - (v / max) * (h - 32);
  const line = (pts, color) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i, pts.length), y(p[1])) : ctx.lineTo(x(i, pts.length), y(p[1])); });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();
  };
  ctx.font = "11px sans-serif";
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.14)");
  [0, 1].forEach((f) => {
    const yy = h - 20 - f * (h - 32);
    ctx.beginPath(); ctx.moveTo(2, yy); ctx.lineTo(w - 2, yy); ctx.stroke();
    ctx.fillStyle = gray;
    ctx.fillText(fmtSpeed(max * f), 4, yy - 4);
  });
  line(downPts, accent);
  line(upPts, green);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = accent; ctx.fillText("— 下载", w - 92, 12);
  ctx.fillStyle = green; ctx.fillText("— 上传", w - 44, 12);
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
