# Muse — a fresh frontend theme for Nezha Monitoring

A brand-new, dependency-free user frontend for Nezha Dashboard v2.
Pure static SPA (one `index.html` + CSS + JS), no build step, no CDN,
no framework. Drop it in and it works.

## v4 — sci-fi HUD (current)

v4 is the opposite of v3's minimalism: a dark, glowing, data-dense
mission-control console.

- **Deep blue-black + neon cyan**, monospace everywhere, faint grid
  background, a slow scanline sweeping the page.
- **Status strip** up top: SYS.STATUS / ONLINE / AVG CPU / AVG MEM /
  NET TOTAL / ALERTS / UPDATED — everything at a glance.
- **Server panels with corner brackets** (targeting-reticle frames),
  a huge glowing CPU number, a live glowing strip chart, CPU/MEM/DISK
  bars, and an 8-cell readout grid (MEM, NET ↑/↓, LOAD, UPTIME, PROCS,
  TCP/UDP, SWAP). Offline panels go red with "SIGNAL LOST".
- **Full-screen detail console**: four big glowing readouts, three live
  charts (CPU / MEM / NET), a 12-cell info grid, 24h history.
- **Live clock** with seconds, LINK status with blinking dot, search.
- Numbers ease toward their live value; panels and the overlay animate in.

v3 (Apple-minimal) and v2 (Apple-flavored dashboard) remain in git history.

## How it works

Data comes from the panel over same-origin relative paths:

- Live list: WebSocket `/api/v1/ws/server` (no auth, ~2s push)
- Site name: `GET /api/v1/setting`
- 24h history: `GET /api/v1/server/:id/metrics?metric=&period=1d`
  (only when the panel has tsdb enabled; otherwise it says so)

The v2 API sends no network speeds, so up/down rates are computed here
from `net_in_transfer` / `net_out_transfer` deltas. A server counts as
offline when `last_active` is older than 30 seconds (or the zero time).

## Install

Nezha v2.6.1 custom themes live under the panel's data directory:

```
<nezha data>/frontends/muse-dist/
  metadata.json        {"path": "muse-dist", "custom": true, ...}
  dist/index.html
  dist/assets/style.css
  dist/assets/app.js
```

Then set `user_template: muse-dist` in `data/config.yaml` and restart
the dashboard. (`metadata.json`'s `path` must match the directory name,
and `dist/index.html` must exist — dropping the theme into the working
directory does not work; only built-in names like `user-dist` do that.)

## Screenshots

- `preview-v4-dark.png` / `preview-v4-light.png` — HUD dashboard
- `preview-v4-detail-dark.png` — full-screen detail console
- `preview-v4-mobile.png` — phone

## License

MIT.
