# Muse — Nezha frontend theme

A from-scratch Nezha Monitoring frontend. Pure static SPA, zero
dependencies, no build step. Live data over the public WebSocket
`/api/v1/ws/server`; net speeds are computed from transfer deltas
(v2 API sends no speed fields); offline = last_active older than 30s.

## Versions

- **v1** — Muse: cards, top stats, search, sort, only-online, detail
  drawer, dark/light, responsive.
- **v2** — Apple-flavoured: #f5f5f7 / pure black, Apple blue, frosted
  top bar and drawer, pill search, segmented sort, toggle switch.
- **v3** — "If Apple made it": one sentence on the home page, servers
  as thin list rows (one big CPU number + a sparkline), near-monochrome,
  Spotlight-style search (⌘K).
- **v4** — Sci-fi HUD: dark blue-black, neon cyan, monospace, faint
  grid + scanline, corner-bracket panels, glowing numbers and curves.
- **v5** — Restraint, after Linear / Stripe / Vercel: true grey
  #0b0d10, hairline borders, one indigo accent, KPI strip, one hero
  chart, sortable server table with inline sparklines, drawer.
- **v6 — Aurora**: flowing aurora light + glass. Deep indigo /
  violet / teal fields drift slowly behind frosted glass panels;
  data stays calm and monochrome, the aurora is the atmosphere. One
  gradient accent (indigo → violet → teal) for the hero number, the
  hero chart and active states. Structure follows v5.
- **v7 — Aurora, rethought layout** (current): the diagnosis was
  that v1–v6 only re-skinned the same skeleton (KPI strip + hero
  chart + table). v7 drops the skeleton: no KPI strip, no hero
  chart, no table. One verdict line ("1 台服务器离线" / "一切正
  常") answers in 5 seconds; the servers ARE the page — each one a
  full-width band with its own sparkline and key numbers, offline
  first and visibly distinct; full chart / info / 24h history live
  in the detail drawer on demand. Aurora + glass atmosphere kept.

## Install (Nezha v2.6.1)

Copy `muse-dist/` to `data/frontends/muse-dist/` (metadata.json must
have `"path": "muse-dist", "custom": true`, files under `dist/`),
set `user_template: muse-dist` in `data/config.yaml`, restart.

## Files

- `muse-dist/index.html`, `muse-dist/assets/style.css`, `muse-dist/assets/app.js`
- `preview-v7-*.png` — screenshots of v7 (dark / light / detail / mobile)
