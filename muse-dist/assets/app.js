/* Muse theme for Nezha — pure static SPA.
 * Talks to the panel over same-origin relative paths:
 *   WS   /api/v1/ws/server            (live server list, ~2s, no auth)
 *   GET  /api/v1/setting              (site name)
 *   GET  /api/v1/server/:id/metrics?metric=&period=1d   (24h history, tsdb only)
 * The v2 API does NOT send net speeds — they are computed here from
 * transfer deltas between WebSocket messages. Offline = last_active
 * older than 30s (or the zero time 0001-01-01).
 */
"use strict";

const $ = (s) => document.querySelector(s);
const grid = $("#serverGrid");
const MAX_POINTS = 300;            // live chart ring buffer (~10 min @ 2s)
const OFFLINE_AFTER_MS = 30_000;

/* ---------- state ---------- */
const servers = new Map();         // id -> { raw, online, inSpeed, outSpeed, prevIn, prevOut, prevAt, hist: {cpu:[], mem:[], netIn:[], netOut:[]} }
let ws = null, wsTimer = null, reconnectDelay = 1000;
let detailId = null, detailHistLoaded = false;
let siteName = "";

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
  if (!cc || typeof cc !== "string" || cc.length !== 2) return "🌐";
  const up = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return "🌐";
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pct(used, total) {
  if (!total || total <= 0 || used == null) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
function barClass(p) { return p >= 90 ? "hot" : p >= 75 ? "warn" : ""; }
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
  if (name) { siteName = name; $("#siteName").textContent = name; }
}).catch(() => {});

/* ---------- websocket ---------- */
function setConn(ok, text) {
  const dot = $("#connDot");
  dot.classList.toggle("ok", !!ok);
  dot.classList.toggle("bad", ok === false);
  $("#connText").textContent = text;
}
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/api/v1/ws/server";
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  setConn(null, "连接中…");
  sock.onopen = () => { reconnectDelay = 1000; setConn(true, "实时连接"); };
  sock.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && Array.isArray(d.servers)) onServers(d.servers, d.now || Date.now());
  };
  sock.onclose = () => { setConn(false, "已断开，重连中…"); scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
function scheduleReconnect() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

/* ---------- ingest ---------- */
function onServers(list, nowMs) {
  const seen = new Set();
  for (const raw of list) {
    if (!raw || raw.id == null) continue;
    seen.add(raw.id);
    let s = servers.get(raw.id);
    if (!s) {
      s = { raw, online: false, inSpeed: 0, outSpeed: 0, prevIn: null, prevOut: null, prevAt: null,
            hist: { cpu: [], mem: [], netIn: [], netOut: [] } };
      servers.set(raw.id, s);
    }
    const st = raw.state || {};
    // net speed: computed from transfer deltas (the API sends no speed fields)
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
    // online?
    const la = Date.parse(raw.last_active);
    const hasState = raw.state && Object.keys(raw.state).length > 0;
    s.online = hasState && isFinite(la) && la > 0 && (nowMs - la) < OFFLINE_AFTER_MS;
    // live history ring buffer
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
  render();
  if (detailId != null) renderDetail();
}
function pushPoint(arr, t, v) {
  arr.push([t, v]);
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

/* ---------- filters / sort ---------- */
let currentSort = "name";
let onlineOnly = false;
document.querySelectorAll("#sortSeg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#sortSeg button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentSort = btn.dataset.sort;
    render();
  });
});
$("#onlineOnly").addEventListener("click", () => {
  onlineOnly = !onlineOnly;
  $("#onlineOnly").setAttribute("aria-checked", String(onlineOnly));
  render();
});
$("#searchInput").addEventListener("input", render);

function visibleServers() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  const sort = currentSort;
  let arr = [...servers.values()];
  if (onlineOnly) arr = arr.filter((s) => s.online);
  if (q) arr = arr.filter((s) => (s.raw.name || "").toLowerCase().includes(q));
  const byCpu = (s) => (s.raw.state && s.raw.state.cpu) || 0;
  const byMem = (s) => pct(s.raw.state && s.raw.state.mem_used, s.raw.host && s.raw.host.mem_total);
  const byNet = (s) => s.inSpeed + s.outSpeed;
  if (sort === "cpu") arr.sort((a, b) => byCpu(b) - byCpu(a));
  else if (sort === "mem") arr.sort((a, b) => byMem(b) - byMem(a));
  else if (sort === "net") arr.sort((a, b) => byNet(b) - byNet(a));
  else arr.sort((a, b) => String(a.raw.name).localeCompare(String(b.raw.name)));
  return arr;
}
/* ---------- render: list ---------- */
function render() {
  const arr = visibleServers();
  const online = [...servers.values()].filter((s) => s.online);
  $("#statOnline").textContent = online.length + " / " + servers.size;
  if (online.length) {
    const avgCpu = online.reduce((a, s) => a + ((s.raw.state && s.raw.state.cpu) || 0), 0) / online.length;
    const avgMem = online.reduce((a, s) => a + pct(s.raw.state && s.raw.state.mem_used, s.raw.host && s.raw.host.mem_total), 0) / online.length;
    const totNet = online.reduce((a, s) => a + s.inSpeed + s.outSpeed, 0);
    $("#statCpu").textContent = avgCpu.toFixed(1) + "%";
    $("#statMem").textContent = avgMem.toFixed(1) + "%";
    $("#statNet").textContent = fmtSpeed(totNet);
  } else {
    $("#statCpu").textContent = "–"; $("#statMem").textContent = "–"; $("#statNet").textContent = "–";
  }
  $("#statUpdated").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  $("#emptyHint").hidden = arr.length !== 0 || servers.size === 0 ? true : false;
  if (servers.size === 0) $("#emptyHint").hidden = false;

  grid.innerHTML = arr.map((s) => cardHtml(s)).join("");
  grid.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
  });
}
function cardHtml(s) {
  const raw = s.raw, host = raw.host || {}, st = raw.state || {};
  const cpu = st.cpu ?? 0;
  const memP = pct(st.mem_used, host.mem_total);
  const diskP = pct(st.disk_used, host.disk_total);
  const platform = host.platform ? esc(host.platform) : "–";
  const arch = host.arch ? " · " + esc(host.arch) : "";
  const cpuModel = host.cpu && host.cpu[0] ? esc(host.cpu[0]) : "";
  const up = s.online ? fmtUptime(st.uptime) : "离线";
  return `<article class="card${s.online ? "" : " offline"}" data-id="${raw.id}" tabindex="0" role="button" aria-label="${esc(raw.name)}">
    <div class="card-top">
      <span class="flag" aria-hidden="true">${flagEmoji(raw.country_code)}</span>
      <div style="min-width:0">
        <div class="card-name">${esc(raw.name)}</div>
        <div class="card-sub">${platform}${arch}${cpuModel ? " · " + cpuModel : ""}</div>
      </div>
      <span class="dot${s.online ? "" : " off"}" title="${s.online ? "在线" : "离线"}"></span>
    </div>
    <div class="meters">
      <div class="meter"><label>CPU</label><div class="bar"><i class="${barClass(cpu)}" style="width:${Math.min(100, cpu).toFixed(1)}%"></i></div><output>${cpu.toFixed(1)}%</output></div>
      <div class="meter"><label>内存</label><div class="bar"><i class="${barClass(memP)}" style="width:${memP.toFixed(1)}%"></i></div><output>${memP.toFixed(1)}%</output></div>
      <div class="meter"><label>磁盘</label><div class="bar"><i class="${barClass(diskP)}" style="width:${diskP.toFixed(1)}%"></i></div><output>${diskP.toFixed(1)}%</output></div>
    </div>
    <div class="card-foot">
      <span>↑ <b class="net-up">${fmtSpeed(s.outSpeed)}</b></span>
      <span>↓ <b class="net-down">${fmtSpeed(s.inSpeed)}</b></span>
      <span>负载 <b>${(st.load_1 ?? "–")}</b></span>
      <span>运行 <b>${up}</b></span>
    </div>
    ${s.online ? "" : `<div class="offline-note">离线 · 最后活跃 ${fmtTimeAgo(raw.last_active)}</div>`}
  </article>`;
}

/* ---------- detail panel ---------- */
function openDetail(id) {
  const s = servers.get(id);
  if (!s) return;
  detailId = id; detailHistLoaded = false;
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
grid.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("card")) openDetail(Number(e.target.dataset.id));
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
  const cells = [
    ["CPU", st.cpu != null ? st.cpu.toFixed(1) + "%" : "–"],
    ["内存", fmtBytes(st.mem_used) + " / " + fmtBytes(host.mem_total) + (memP ? "（" + memP.toFixed(1) + "%）" : "")],
    ["交换", fmtBytes(st.swap_used) + " / " + fmtBytes(host.swap_total) + (swapP ? "（" + swapP.toFixed(1) + "%）" : "")],
    ["磁盘", fmtBytes(st.disk_used) + " / " + fmtBytes(host.disk_total) + (diskP ? "（" + diskP.toFixed(1) + "%）" : "")],
    ["上传", fmtSpeed(s.outSpeed)],
    ["上传累计", fmtBytes(st.net_out_transfer)],
    ["下载", fmtSpeed(s.inSpeed)],
    ["下载累计", fmtBytes(st.net_in_transfer)],
    ["负载 1/5/15", [st.load_1, st.load_5, st.load_15].map((v) => v ?? "–").join(" / ")],
    ["运行时间", fmtUptime(st.uptime)],
    ["进程", st.process_count ?? "–"],
    ["TCP / UDP 连接", (st.tcp_conn_count ?? "–") + " / " + (st.udp_conn_count ?? "–")],
    ["启动时间", host.boot_time ? new Date(host.boot_time * 1000).toLocaleString("zh-CN") : "–"],
    ["国家", raw.country_code ? raw.country_code.toUpperCase() : "–"],
  ];
  $("#dInfo").innerHTML = cells.map(([k, v]) => `<div class="d-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  $("#dCpuNow").textContent = st.cpu != null ? st.cpu.toFixed(1) + "%" : "–";
  $("#dMemNow").textContent = memP.toFixed(1) + "%";
  $("#dNetNow").textContent = "↑ " + fmtSpeed(s.outSpeed) + "  ↓ " + fmtSpeed(s.inSpeed);
  drawChart($("#chartCpu"), s.hist.cpu, cssVar("--accent"), (v) => v.toFixed(1) + "%");
  drawChart($("#chartMem"), s.hist.mem, cssVar("--green"), (v) => v.toFixed(1) + "%");
  drawDualChart($("#chartNet"), s.hist.netIn, s.hist.netOut);
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
      drawChart($("#chartHist"), pts.map((p) => [p.ts, p.value]), cssVar("--accent", "#0071e3"), (v) => v.toFixed(1) + "%");
    })
    .catch(() => {
      if (detailId !== id) return;
      $("#dHistNote").textContent = "";
      $("#dHistEmpty").hidden = false;
    });
}

/* ---------- canvas charts ---------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 640, h = 140;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function drawChart(c, pts, color, fmtVal) {
  const { ctx, w, h } = setupCanvas(c);
  const gray = cssVar("--text-3", "#86868b");
  ctx.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) {
    ctx.fillStyle = gray; ctx.font = "12px sans-serif";
    ctx.fillText(pts && pts.length === 1 ? "采集中…" : "暂无数据", 8, 20);
    return;
  }
  const vals = pts.map((p) => p[1]);
  let max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  if (max - min < 1e-9) { max = min + 1; }
  const pad = (max - min) * 0.12; max += pad; min = Math.max(0, min - pad);
  const x = (i) => (i / (pts.length - 1)) * (w - 8) + 4;
  const y = (v) => h - 18 - ((v - min) / (max - min)) * (h - 30);
  // grid + labels
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.18)"); ctx.fillStyle = gray; ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((f) => {
    const yy = h - 18 - f * (h - 30);
    ctx.beginPath(); ctx.moveTo(4, yy); ctx.lineTo(w - 4, yy); ctx.stroke();
    ctx.fillText(fmtVal(min + f * (max - min)), 6, yy - 3);
  });
  // area + line
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + "55"); grad.addColorStop(1, color + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p[1])) : ctx.lineTo(x(i), y(p[1])); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.lineTo(x(pts.length - 1), h - 18); ctx.lineTo(x(0), h - 18); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // last value dot
  const lx = x(pts.length - 1), ly = y(pts[pts.length - 1][1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.fillStyle = gray;
  ctx.fillText(new Date(pts[0][0]).toLocaleTimeString("zh-CN", { hour12: false }), 4, h - 4);
  ctx.fillText(new Date(pts[pts.length - 1][0]).toLocaleTimeString("zh-CN", { hour12: false }), w - 52, h - 4);
}
function drawDualChart(c, downPts, upPts) {
  const { ctx, w, h } = setupCanvas(c);
  const gray = cssVar("--text-3", "#86868b");
  const blue = cssVar("--blue", "#0071e3");
  const green = cssVar("--green", "#34c759");
  ctx.clearRect(0, 0, w, h);
  const all = [...downPts.map((p) => p[1]), ...upPts.map((p) => p[1])];
  if (!all.length || (downPts.length < 2 && upPts.length < 2)) {
    ctx.fillStyle = gray; ctx.font = "12px sans-serif";
    ctx.fillText("采集中…", 8, 20);
    return;
  }
  let max = Math.max(...all, 1);
  const x = (i, n) => (i / (n - 1)) * (w - 8) + 4;
  const y = (v) => h - 18 - (v / max) * (h - 30);
  const line = (pts, color) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i, pts.length), y(p[1])) : ctx.lineTo(x(i, pts.length), y(p[1])); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  };
  ctx.strokeStyle = cssVar("--line", "rgba(128,128,128,.18)"); ctx.fillStyle = gray; ctx.font = "11px sans-serif";
  [0, 0.5, 1].forEach((f) => {
    const yy = h - 18 - f * (h - 30);
    ctx.beginPath(); ctx.moveTo(4, yy); ctx.lineTo(w - 4, yy); ctx.stroke();
    ctx.fillText(fmtSpeed(max * f), 6, yy - 3);
  });
  line(downPts, blue);
  line(upPts, green);
  // legend at top-right, clear of the left-aligned axis labels
  ctx.font = "11px sans-serif";
  ctx.fillStyle = green; ctx.fillText("↑ 上传", w - 52, 12);
  ctx.fillStyle = blue; ctx.fillText("↓ 下载", w - 108, 12);
}

/* ---------- clock ---------- */
function tickClock() {
  $("#footClock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}
setInterval(tickClock, 1000); tickClock();

/* ---------- boot ---------- */
connectWS();
