# Muse — a fresh frontend theme for Nezha Monitoring

A brand-new, dependency-free user frontend for Nezha Dashboard v2.
Pure static SPA (one `index.html` + CSS + JS), no build step, no CDN,
no framework. Drop it in and it works.

## What it does

- **Live server list** over the panel's public WebSocket (`/api/v1/ws/server`,
  ~2s). No login, no token — same origin as the panel.
- **Net speed computed from transfer deltas.** The v2 API sends cumulative
  `net_in_transfer` / `net_out_transfer` only, no speed fields — this theme
  derives up/down speed from the difference between messages.
- **Offline detection** from `last_active` staleness (> 30s, or the zero time
  `0001-01-01` that offline servers report). Offline servers stay visible
  with their last-seen time instead of vanishing.
- **Server cards**: flag, platform + arch + CPU model, CPU / memory / disk
  bars (75% amber, 90% red), live up/down speed, load, uptime.
- **Detail panel** (click a card): host info, live CPU / memory / network
  charts drawn from an in-memory ring buffer (last ~10 min), plus a 24h CPU
  history chart from `/api/v1/server/:id/metrics` when the panel has tsdb
  enabled (gracefully shows "no history" otherwise).
- **Search, sort** (name / CPU / memory / net), **online-only** filter.
- **Dark-first** with a light mode toggle (persisted in localStorage,
  respects `prefers-color-scheme` by default).
- **Responsive** — single-column cards on phones.
- Handles the real API's quirks: sparse `host`/`state` (no
  `platform_version`/`gpu`/`temperatures`), lowercase `country_code`
  (`"us"`), `arch: "x86_64"`, `last_active` with a timezone offset.

## Format (how Nezha uses it)

This follows the official theme format (`frontend-templates.yaml` in
nezhahq/nezha): a static directory named `<name>-dist` containing
`index.html` + `assets/`, talking to the panel only through relative
`/api/v1/*` paths. The dashboard serves the directory named by
`user_template` in `data/config.yaml` (default `user-dist`), looking first
in its working directory and falling back to the copy built into the binary.

## Install

Nezha v2 keeps custom themes in a **frontend store**: `data/frontends/<id>/`,
with a `metadata.json` and the built files under `dist/`. The `user_template`
value in `data/config.yaml` is the theme id.

**Option A — install as a named theme (recommended):**

```bash
# 1. copy the theme into the store (next to the dashboard binary)
mkdir -p /path/to/nezha/data/frontends/muse-dist/dist
cp -r muse-dist/* /path/to/nezha/data/frontends/muse-dist/dist/
cat > /path/to/nezha/data/frontends/muse-dist/metadata.json <<'EOF'
{"path":"muse-dist","name":"Muse","author":"Muse","version":"v1.0.0","custom":true}
EOF
# 2. point the dashboard at it
#    in data/config.yaml:  user_template: muse-dist
# 3. restart the dashboard
```

Switch back anytime by setting `user_template: user-dist` and restarting —
no files need to be deleted.

**Option B — replace the built-in frontend (Docker):**

The built-in theme names (`user-dist`, `admin-dist`) are resolved against
the working directory first, so mounting over `user-dist` replaces the
frontend without touching the store:

```yaml
services:
  dashboard:
    volumes:
      - ./muse-dist:/dashboard/user-dist:ro
```

(Keep the directory name `user-dist` in this case, or set `user_template`
to match the mounted name.)

**Option C — register it as a named theme** (for the official list):
add an entry to `service/singleton/frontend-templates.yaml` in
nezhahq/nezha:

```yaml
- path: "muse-dist"
  name: "Muse"
  repository: "https://github.com/atmous/nezha-theme-muse"
  author: "Muse"
  version: "v1.0.0"
```

## Test

Against a running panel (default port 8008) with at least one agent online:

1. Install as in Option A and open the panel in a browser.
2. You should see the agent's card with live CPU / memory / disk and
   up/down speeds updating every ~2s.
3. Click the card — the detail panel shows host info and live charts.
4. Stop the agent — the card turns offline with its last-seen time.

## Files

```
muse-dist/
  index.html          SPA shell
  assets/
    style.css         all styles (dark-first, CSS variables)
    app.js            all logic (WebSocket, rendering, charts)
```

## License

MIT.
