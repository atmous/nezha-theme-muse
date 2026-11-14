# Muse — a fresh frontend theme for Nezha Monitoring

A brand-new, dependency-free user frontend for Nezha Dashboard v2.
Pure static SPA (one `index.html` + CSS + JS), no build step, no CDN,
no framework. Drop it in and it works.

## v3 — if Apple made this product

v3 is not a reskin. It rethinks the product the way Apple would:

- **One calm statement, not a dashboard.** The page opens with a single
  sentence — "一切正常" or "1 台服务器离线" — in huge, light type. If
  everything is fine, the product says so and gets out of the way.
- **A list, not cards.** Servers are rows with hairline dividers, like
  iOS Settings. No boxes, no shadows, no stats strip. Each row carries
  exactly one number — CPU — plus a tiny sparkline.
- **Color is information only.** Almost entirely monochrome (black /
  white / gray). Green appears only for "healthy", red only when
  something needs attention. The chart line is a single ink color.
- **One focused view at a time.** Tapping a server opens a sheet with
  one huge number and one chart; a segmented control switches the metric
  (CPU / 内存 / 网络) instead of showing three charts at once.
- **Motion is part of the feel.** Numbers ease toward their live value
  instead of jumping; rows and the sheet move on a spring curve.
- **Needs attention first.** Offline servers sort to the top
  automatically — the product decides the order, not the user.
  Search is a single Spotlight-style field (⌘K to focus).

v2 (Apple-flavored styling on a conventional dashboard) is kept in git
history; v3 replaces it.

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

- `preview-v3-light.png` / `preview-v3-dark.png` — list
- `preview-v3-detail-light.png` / `preview-v3-detail-dark.png` — detail sheet
- `preview-v3-mobile.png` — phone (bottom sheet)

## License

MIT.
