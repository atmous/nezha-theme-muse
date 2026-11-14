# Muse — a fresh frontend theme for Nezha Monitoring

A brand-new, dependency-free user frontend for Nezha Dashboard v2.
Pure static SPA (one `index.html` + CSS + JS), no build step, no CDN,
no framework. Drop it in and it works.

## v5 — restraint, after Linear / Stripe / Vercel (current)

v5 is research-grounded, not a guess. The references (a 2026 roundup of
the best SaaS dashboards) converge on one answer for "premium":

- **Linear** — radical restraint: near-monochrome surfaces, one accent,
  low-contrast borders, crisp type; everything non-essential absent.
- **Stripe** — tables are the product: right-aligned tabular numerals,
  muted gridlines, inline sparklines; one hero metric visualized,
  everything else numeric; the chart is a summary, the table is the truth.
- **Vercel** — hierarchy from spacing and type weight; color = meaning only.

Applied to Nezha:

- **True-grey base** (`#0b0d10`, not pure black), layered elevation by
  background lightness, hairline borders, **one refined indigo accent**,
  muted semantic colors. No glow, no neon, no decoration competing
  with the data.
- **KPI strip**: one primary metric (online servers, largest type),
  four quiet secondaries.
- **One hero chart**: fleet-average CPU as a single indigo area chart.
- **The server table**: sortable columns (click a header), right-aligned
  tabular numerals, status pills, inline sparklines in the CPU column,
  mini-bars for memory/disk. Click a row for the detail drawer.
- **Progressive disclosure**: detail drawer shows four KPIs, one chart
  (segmented CPU / 内存 / 网络), an info list, and 24h history.

v4 (sci-fi HUD), v3 (Apple-minimal) and v2 remain in git history.

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

- `preview-v5-dark.png` / `preview-v5-light.png` — dashboard
- `preview-v5-detail-dark.png` — detail drawer
- `preview-v5-mobile.png` — phone

## License

MIT.
