/* Muse v7 — Aurora, rethought layout.
 * The diagnosis that drove v7:
 *   v1–v6 all kept the same skeleton (KPI strip + hero chart + table)
 *   and only changed the skin. The skeleton was the problem.
 *   - The KPI strip and the hero chart are fleet aggregates nobody
 *     acts on. With a small fleet they repeat what the servers say.
 *   - A table treats every server like a spreadsheet row: uniform,
 *     no hierarchy, no identity. The thing that needs you (offline,
 *     hot) looks the same as the thing that doesn't.
 *   - The page answered "what are the numbers?" before it answered
 *     "are we OK?".
 * The new skeleton:
 *   1. A verdict line — the 5-second answer, in one sentence.
 *   2. The servers ARE the page. Each one is a full-width band with
 *      its own sparkline and its key numbers — a list, not a table.
 *      Offline sorts first and is visibly distinct.
 *   3. Everything else (full chart, full info, 24h history) lives in
 *      the detail drawer, on demand.
 * Data layer (unchanged): WS /api/v1/ws/server (live, no auth),
 * GET /api/v1/setting, GET /api/v1/server/:id/metrics (24h, tsdb only).
 * Net speeds are computed here from transfer deltas. Offline =
 * last_active older than 30s (or the zero time).
 */
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function cssVar(name, fallback) { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; }

const MAXH = 300, OFFLINE_MS = 30000;

/* ---------------- theme ---------------- */
function initTheme() {
  const saved = localStorage.getItem("muse-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "light";
  else document.documentElement.dataset.theme = "dark";
}
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("muse-theme", cur);
});
initTheme();

/* ---------------- state ---------------- */
const servers = new Map(); // id -> {id, name, host, state, online, cpuHist[], memHist[], netUpHist[], netDownHist[], lastNetIn, lastNetOut, lastTs, netUp, netDown, updatedAt}
let siteName = "";
let lastMsgAt = 0;
let searchQ = "";
let sortKey = "status";
let selectedId = null;
let detailMetric = "cpu";
let chartRaf = null;

const flagCache = {};
function countryFlag(code) {
  if (!code) return "";
  code = String(code).toLowerCase();
  if (flagCache[code] !== undefined) return flagCache[code];
  if (!/^[a-z]{2}$/.test(code)) { flagCache[code] = ""; return ""; }
  const f = String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 97));
  flagCache[code] = f;
  return f;
}
function fmtBytes(n) {
  if (n == null || !isFinite(n)) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + u[i];
}
function fmtSpeed(n) { return n == null ? "–" : fmtBytes(n) + "/s"; }
function fmtUptime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "–";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return d + "天 " + h + "小时";
  if (h > 0) return h + "小时 " + m + "分";
  if (m > 0) return m + "分";
  return Math.floor(sec) + "秒";
}
function fmtAgo(ts) {
  if (!ts) return "从未上线";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  return Math.floor(s / 3600) + " 小时前";
}
function fmtClock(d) {
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + fmtClock(d);
}
function pct(v) { return v == null || !isFinite(v) ? "–" : (v * 100).toFixed(1) + "%"; }
function parseLastActive(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  if (!t || t < 1e12) return 0; // zero time 0001-01-01
  return t;
}

/* ---------------- websocket ---------------- */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(proto + "//" + location.host + "/api/v1/ws/server");
  const dot = $("#connDot"), txt = $("#connText");
  dot.classList.remove("ok", "bad"); txt.textContent = "连接中…";
  ws.onopen = () => { dot.classList.add("ok"); txt.textContent = "实时连接"; };
  ws.onclose = () => {
    dot.classList.remove("ok"); dot.classList.add("bad"); txt.textContent = "已断开，正在重连…";
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !Array.isArray(msg.servers)) return;
    lastMsgAt = Date.now();
    const now = msg.now || Date.now();
    for (const s of msg.servers) {
      const id = s.id;
      let rec = servers.get(id);
      if (!rec) {
        rec = { id, cpuHist: [], memHist: [], netUpHist: [], netDownHist: [], lastNetIn: null, lastNetOut: null, lastTs: null, netUp: null, netDown: null };
        servers.set(id, rec);
      }
      rec.name = s.name || ("服务器 " + id);
      rec.host = s.host || {};
      rec.state = s.state || {};
      rec.countryCode = s.country_code || rec.host.country_code || "";
      // last_active / country_code live at the SERVER level in the WS
      // payload (host only carries platform/cpu/mem_total/disk_total/
      // swap_total/arch/boot_time). Keep the host-level fallback.
      const la = parseLastActive(s.last_active || rec.host.last_active);
      rec.lastActive = la;
      rec.online = la > 0 && (now - la) < OFFLINE_MS && Object.keys(rec.state).length > 0;
      const st = rec.state;
      const cpu = typeof st.cpu === "number" ? st.cpu / 100 : null;
      // mem_total / disk_total / swap_total live in host, not state
      const memTotal = rec.host.mem_total;
      const mem = (typeof st.mem_used === "number" && typeof memTotal === "number" && memTotal > 0)
        ? st.mem_used / memTotal : null;
      if (rec.online) {
        if (cpu != null) { rec.cpuHist.push([now, cpu]); if (rec.cpuHist.length > MAXH) rec.cpuHist.shift(); }
        if (mem != null) { rec.memHist.push([now, mem]); if (rec.memHist.length > MAXH) rec.memHist.shift(); }
        const ni = st.net_in_transfer, no = st.net_out_transfer;
        if (typeof ni === "number" && typeof no === "number" && rec.lastNetIn != null && rec.lastTs != null) {
          const dt = (now - rec.lastTs) / 1000;
          if (dt > 0 && dt < 60) {
            rec.netDown = Math.max(0, (ni - rec.lastNetIn) / dt);
            rec.netUp = Math.max(0, (no - rec.lastNetOut) / dt);
            rec.netDownHist.push([now, rec.netDown]); if (rec.netDownHist.length > MAXH) rec.netDownHist.shift();
            rec.netUpHist.push([now, rec.netUp]); if (rec.netUpHist.length > MAXH) rec.netUpHist.shift();
          }
        }
        rec.lastNetIn = ni; rec.lastNetOut = no; rec.lastTs = now;
      }
      rec.updatedAt = now;
    }
    render();
    if (selectedId != null && $("#detail").classList.contains("open")) refreshDetail();
  };
}

/* ---------------- setting ---------------- */
fetch("/api/v1/setting").then((r) => r.json()).then((d) => {
  if (d && d.data && d.data.site_name) { siteName = d.data.site_name; $("#siteName").textContent = siteName; }
}).catch(() => { /* keep default title */ });

/* ---------------- verdict ---------------- */
function renderVerdict() {
  const line = $("#verdictLine"), sub = $("#verdictSub");
  const all = Array.from(servers.values());
  if (all.length === 0) {
    line.textContent = "正在连接…";
    sub.textContent = "–";
    return;
  }
  const online = all.filter((s) => s.online);
  const offline = all.filter((s) => !s.online);
  const hot = online.filter((s) => {
    const st = s.state || {};
    const cpu = typeof st.cpu === "number" ? st.cpu : 0;
    const mem = (typeof st.mem_used === "number" && typeof s.host.mem_total === "number" && s.host.mem_total > 0)
      ? st.mem_used / s.host.mem_total * 100 : 0;
    return cpu >= 80 || mem >= 90;
  });
  if (offline.length > 0) {
    const n = offline.length;
    line.innerHTML = "<b class=\"bad\">" + n + " 台服务器离线</b>";
  } else if (hot.length > 0) {
    line.innerHTML = "<b>" + hot.length + " 台服务器负载较高</b>";
  } else {
    line.innerHTML = "<span class=\"ok\">一切正常</span>";
  }
  const parts = [all.length + " 台服务器", online.length + " 台在线"];
  if (offline.length) parts.push(offline.length + " 台离线");
  if (hot.length) parts.push(hot.length + " 台负载高");
  sub.textContent = parts.join(" · ") + " · " + fmtClock(new Date());
  $("#listCount").textContent = "服务器 · " + all.length + " 台";
}

/* ---------------- sorting ---------------- */
function sortedServers() {
  const all = Array.from(servers.values());
  const q = searchQ.trim().toLowerCase();
  const filtered = q ? all.filter((s) => (s.name || "").toLowerCase().includes(q) || JSON.stringify(s.host || {}).toLowerCase().includes(q)) : all;
  const cpuOf = (s) => (s.online && typeof s.state.cpu === "number") ? s.state.cpu : -1;
  const memOf = (s) => {
    if (!s.online) return -1;
    const st = s.state || {};
    return (typeof st.mem_used === "number" && typeof s.host.mem_total === "number" && s.host.mem_total > 0) ? st.mem_used / s.host.mem_total : -1;
  };
  filtered.sort((a, b) => {
    if (sortKey === "cpu") return cpuOf(b) - cpuOf(a);
    if (sortKey === "mem") return memOf(b) - memOf(a);
    if (sortKey === "name") return (a.name || "").localeCompare(b.name || "");
    // status: offline first, then CPU desc
    if (a.online !== b.online) return a.online ? 1 : -1;
    return cpuOf(b) - cpuOf(a);
  });
  return filtered;
}

/* ---------------- bands ---------------- */
function metricHTML(cls, label, valueHTML, extra) {
  return "<div class=\"b-metric " + cls + "\"><label>" + label + "</label><b>" + valueHTML + "</b>" + (extra || "") + "</div>";
}
function bandHTML(s) {
  const st = s.state || {};
  const host = s.host || {};
  const cpu = s.online && typeof st.cpu === "number" ? st.cpu : null;
  const mem = (s.online && typeof st.mem_used === "number" && typeof host.mem_total === "number" && host.mem_total > 0)
    ? st.mem_used / host.mem_total * 100 : null;
  const disk = (s.online && typeof st.disk_used === "number" && typeof host.disk_total === "number" && host.disk_total > 0)
    ? st.disk_used / host.disk_total * 100 : null;
  const uptime = s.online && typeof st.uptime === "number" ? fmtUptime(st.uptime) : "–";
  const subParts = [];
  const flag = countryFlag(s.countryCode || host.country_code);
  if (flag) subParts.push("<span class=\"flag\">" + flag + "</span>");
  if (host.platform) subParts.push(esc(host.platform));
  if (host.arch) subParts.push(esc(host.arch));
  subParts.push(s.online ? "在线" : (s.lastActive ? "离线 · " + fmtAgo(s.lastActive) : "从未上线"));
  const cpuCls = cpu != null && cpu >= 80 ? " class=\"hot\"" : "";
  const memBar = mem != null
    ? "<span class=\"mini-bar\"><i class=\"" + (mem >= 90 ? "hot" : mem >= 80 ? "warn" : "") + "\" style=\"width:" + clamp(mem, 0, 100).toFixed(1) + "%\"></i></span>" : "";
  return "<div class=\"b-id\"><span class=\"b-dot\"></span><div style=\"min-width:0\"><div class=\"b-name\">" + esc(s.name) + "</div><div class=\"b-sub\">" + subParts.join(" · ") + "</div></div></div>"
    + "<canvas class=\"b-spark\" width=\"300\" height=\"76\"></canvas>"
    + metricHTML("m-cpu", "CPU", cpu != null ? "<span" + cpuCls + ">" + cpu.toFixed(1) + "%</span>" : "–")
    + metricHTML("m-mem", "内存", mem != null ? mem.toFixed(1) + "%" : "–", memBar)
    + metricHTML("m-disk hide-lg", "磁盘", disk != null ? disk.toFixed(1) + "%" : "–")
    + metricHTML("m-up hide-md", "上传", s.online ? fmtSpeed(s.netUp) : "–")
    + metricHTML("m-down hide-lg", "下载", s.online ? fmtSpeed(s.netDown) : "–")
    + metricHTML("m-uptime hide-sm", "运行时间", uptime);
}
function renderBands() {
  const list = $("#serverList");
  const ordered = sortedServers();
  $("#emptyHint").hidden = ordered.length !== 0 || servers.size === 0;
  const seen = new Set();
  for (const s of ordered) {
    seen.add(s.id);
    let el = list.querySelector("[data-id=\"" + s.id + "\"]");
    if (!el) {
      el = document.createElement("article");
      el.className = "band";
      el.dataset.id = s.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.addEventListener("click", () => openDetail(s.id));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(s.id); } });
      list.appendChild(el);
    }
    el.classList.toggle("offline", !s.online);
    el.innerHTML = bandHTML(s);
    const spark = el.querySelector(".b-spark");
    if (spark) drawSpark(spark, s.cpuHist, s.online);
  }
  $$(".band", list).forEach((el) => { if (!seen.has(Number(el.dataset.id))) el.remove(); });
  // order DOM to match sort
  for (const s of ordered) {
    const el = list.querySelector("[data-id=\"" + s.id + "\"]");
    if (el) list.appendChild(el);
  }
}
function render() {
  renderVerdict();
  renderBands();
}

/* ---------------- charts ---------------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawSpark(c, pts, online) {
  const { ctx, w, h } = setupCanvas(c);
  if (!online || !pts || pts.length < 2) {
    ctx.strokeStyle = cssVar("--text-3", "#71717a");
    ctx.setLineDash([3, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => h - 3 - clamp(v, 0, 1) * (h - 6);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  const a1 = cssVar("--accent", "#818cf8"), a2 = cssVar("--accent-2", "#c084fc");
  grad.addColorStop(0, a1 + "30"); grad.addColorStop(1, a2 + "00");
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1])); });
  ctx.lineTo(x(pts[pts.length - 1][0]), h); ctx.lineTo(x(pts[0][0]), h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1])); });
  ctx.strokeStyle = a1; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
}
function drawArea(c, pts, unit) {
  const { ctx, w, h } = setupCanvas(c);
  const accent = cssVar("--accent", "#818cf8");
  const gray = cssVar("--text-3", "#71717a");
  ctx.font = "11px sans-serif";
  ctx.fillStyle = gray;
  let max = 0;
  for (const p of pts) max = Math.max(max, p[1]);
  max = max > 0 ? max * 1.15 : 1;
  const t0 = pts.length ? pts[0][0] : 0, t1 = pts.length ? pts[pts.length - 1][0] : 1;
  const x = (t) => 34 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 40);
  const y = (v) => (h - 22) - (v / max) * (h - 34);
  ctx.strokeStyle = cssVar("--line", "rgba(255,255,255,.09)");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const yy = y(max * i / 2);
    ctx.beginPath(); ctx.moveTo(34, yy); ctx.lineTo(w - 6, yy); ctx.stroke();
    ctx.fillText(unit === "pct" ? Math.round(max * i / 2 * 100) + "%" : fmtBytes(max * i / 2), 0, yy + 4);
  }
  if (pts.length >= 2) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const a1 = cssVar("--accent", "#818cf8"), a2 = cssVar("--accent-2", "#c084fc"), a3 = cssVar("--accent-3", "#2dd4bf");
    grad.addColorStop(0, a1 + "38"); grad.addColorStop(.55, a2 + "16"); grad.addColorStop(1, a3 + "00");
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1])); });
    ctx.lineTo(x(pts[pts.length - 1][0]), h - 22); ctx.lineTo(x(pts[0][0]), h - 22); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1])); });
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();
    const d0 = new Date(t0), d1 = new Date(t1);
    ctx.fillStyle = gray;
    ctx.fillText(fmtClock(d0), 34, h - 6);
    const t1s = fmtClock(d1);
    ctx.fillText(t1s, w - 6 - ctx.measureText(t1s).width, h - 6);
  }
}
function drawDualArea(c, downPts, upPts) {
  const { ctx, w, h } = setupCanvas(c);
  const accent = cssVar("--accent", "#818cf8");
  const teal = cssVar("--accent-3", "#2dd4bf");
  const gray = cssVar("--text-3", "#71717a");
  let max = 0;
  for (const p of downPts) max = Math.max(max, p[1]);
  for (const p of upPts) max = Math.max(max, p[1]);
  max = max > 0 ? max * 1.15 : 1;
  const all = downPts.concat(upPts);
  const t0 = all.length ? Math.min(...all.map((p) => p[0])) : 0;
  const t1 = all.length ? Math.max(...all.map((p) => p[0])) : 1;
  const x = (t) => 34 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 40);
  const y = (v) => (h - 22) - (v / max) * (h - 34);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = gray;
  ctx.strokeStyle = cssVar("--line", "rgba(255,255,255,.09)");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const yy = y(max * i / 2);
    ctx.beginPath(); ctx.moveTo(34, yy); ctx.lineTo(w - 6, yy); ctx.stroke();
    ctx.fillText(fmtBytes(max * i / 2), 0, yy + 4);
  }
  function line(pts, color) {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1])); });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();
  }
  line(downPts, accent);
  line(upPts, teal);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = accent; ctx.fillText("— 下载", w - 92, 12);
  ctx.fillStyle = teal; ctx.fillText("— 上传", w - 44, 12);
}

/* ---------------- detail drawer ---------------- */
function openDetail(id) {
  selectedId = id;
  const s = servers.get(id);
  if (!s) return;
  $("#detail").classList.add("open");
  $("#detail").setAttribute("aria-hidden", "false");
  $("#detailBackdrop").hidden = false;
  refreshDetail();
  loadHistory(id);
}
function closeDetail() {
  selectedId = null;
  $("#detail").classList.remove("open");
  $("#detail").setAttribute("aria-hidden", "true");
  $("#detailBackdrop").hidden = true;
  if (chartRaf) { cancelAnimationFrame(chartRaf); chartRaf = null; }
}
$("#detailClose").addEventListener("click", closeDetail);
$("#detailBackdrop").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedId != null) closeDetail();
});
$$("#metricSeg button").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#metricSeg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    detailMetric = b.dataset.metric;
    refreshDetail();
  });
});
function refreshDetail() {
  const s = servers.get(selectedId);
  if (!s) return;
  const st = s.state || {};
  const host = s.host || {};
  $("#dEyebrow").textContent = "服务器 · ID " + s.id;
  $("#dName").textContent = s.name;
  const subParts = [];
  if (host.platform) subParts.push(host.platform);
  if (host.arch) subParts.push(host.arch);
  const cpuInfo = host.cpu_info || (Array.isArray(host.cpu) ? host.cpu.join(", ") : host.cpu);
  if (cpuInfo) subParts.push(cpuInfo);
  subParts.push(s.online ? "在线" : (s.lastActive ? "离线 · " + fmtAgo(s.lastActive) : "从未上线"));
  $("#dSub").textContent = subParts.join(" · ");
  $("#dCpuBig").textContent = s.online && typeof st.cpu === "number" ? st.cpu.toFixed(1) + "%" : "–";
  $("#dMemBig").textContent = (s.online && typeof st.mem_used === "number" && typeof host.mem_total === "number")
    ? (st.mem_used / host.mem_total * 100).toFixed(1) + "%" : "–";
  $("#dNetUpBig").textContent = s.online ? fmtSpeed(s.netUp) : "–";
  $("#dNetDownBig").textContent = s.online ? fmtSpeed(s.netDown) : "–";
  const rows = [];
  const memPct = (typeof st.mem_used === "number" && typeof host.mem_total === "number" && host.mem_total > 0)
    ? (st.mem_used / host.mem_total * 100).toFixed(1) + "%" : null;
  rows.push(["内存", memPct != null ? fmtBytes(st.mem_used) + " / " + fmtBytes(host.mem_total) + "（" + memPct + "）" : "–"]);
  rows.push(["交换", (typeof st.swap_used === "number" && typeof host.swap_total === "number")
    ? fmtBytes(st.swap_used) + " / " + fmtBytes(host.swap_total) + "（" + (host.swap_total > 0 ? (st.swap_used / host.swap_total * 100).toFixed(1) : "0") + "%）" : "–"]);
  const diskPct = (typeof st.disk_used === "number" && typeof host.disk_total === "number" && host.disk_total > 0)
    ? (st.disk_used / host.disk_total * 100).toFixed(1) + "%" : null;
  rows.push(["磁盘", diskPct != null ? fmtBytes(st.disk_used) + " / " + fmtBytes(host.disk_total) + "（" + diskPct + "）" : "–"]);
  rows.push(["上传", s.online ? fmtSpeed(s.netUp) + " · 累计 " + fmtBytes(st.net_out_transfer) : "–"]);
  rows.push(["下载", s.online ? fmtSpeed(s.netDown) + " · 累计 " + fmtBytes(st.net_in_transfer) : "–"]);
  rows.push(["负载 1 / 5 / 15", (typeof st.load_1 === "number" && typeof st.load_5 === "number" && typeof st.load_15 === "number")
    ? st.load_1.toFixed(2) + " / " + st.load_5.toFixed(2) + " / " + st.load_15.toFixed(2) : "–"]);
  rows.push(["运行时间", s.online && typeof st.uptime === "number" ? fmtUptime(st.uptime) : "–"]);
  rows.push(["进程", typeof st.process_count === "number" ? String(st.process_count) : "–"]);
  rows.push(["TCP / UDP 连接", (typeof st.tcp_conn_count === "number" ? st.tcp_conn_count : "–") + " / " + (typeof st.udp_conn_count === "number" ? st.udp_conn_count : "–")]);
  if (host.version) rows.push(["Agent 版本", esc(host.version)]);
  if (host.boot_time) rows.push(["启动时间", fmtDateTime(new Date(host.boot_time * 1000))]);
  $("#dInfo").innerHTML = rows.map((r) => "<div class=\"d-row\"><span>" + r[0] + "</span><b>" + r[1] + "</b></div>").join("");
  const cap = $("#chartCap");
  if (detailMetric === "cpu") { drawArea($("#chartMain"), s.cpuHist, "pct"); cap.textContent = "实时曲线 · 最近 10 分钟 · CPU 使用率"; }
  else if (detailMetric === "mem") { drawArea($("#chartMain"), s.memHist, "pct"); cap.textContent = "实时曲线 · 最近 10 分钟 · 内存占用率"; }
  else { drawDualArea($("#chartMain"), s.netDownHist, s.netUpHist); cap.textContent = "实时曲线 · 最近 10 分钟 · 网络速率"; }
}
async function loadHistory(id) {
  const note = $("#dHistNote"), empty = $("#dHistEmpty");
  empty.hidden = true;
  try {
    const r = await fetch("/api/v1/server/" + id + "/metrics?metric=&period=1d");
    const d = await r.json();
    const pts = (d && d.data && Array.isArray(d.data.data_points)) ? d.data.data_points : [];
    if (!pts.length) {
      empty.hidden = false;
      note.textContent = "";
      const { ctx, w, h } = setupCanvas($("#chartHist"));
      ctx.clearRect(0, 0, w, h);
      return;
    }
    note.textContent = "· " + pts.length + " 个点";
    const series = pts.map((p) => [p.timestamp * 1000, (p.cpu || 0) / 100]);
    drawArea($("#chartHist"), series, "pct");
  } catch (e) {
    empty.hidden = false;
    note.textContent = "";
  }
}

/* ---------------- search / sort / clock ---------------- */
$("#searchInput").addEventListener("input", (e) => { searchQ = e.target.value; renderBands(); });
$("#sortSelect").addEventListener("change", (e) => { sortKey = e.target.value; renderBands(); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#searchInput").focus();
  }
});
setInterval(() => {
  const now = new Date();
  $("#footClock").textContent = fmtDateTime(now);
  if (servers.size) renderVerdict();
}, 1000);
$("#footClock").textContent = fmtDateTime(new Date());

connectWS();
