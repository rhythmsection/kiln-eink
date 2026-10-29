# Kiln + weather display (TRMNL)

An 800×480 e-ink dashboard for the Seeed TRMNL 7.5" (OG) DIY Kit:

- **Kiln:** one kiln at a time from Bartlett KilnAid: temperature, status
  (firing / holding / cooling / idle / no signal), program, segment, target and
  elapsed time. It shows the kiln that's firing; if none is, the one still
  cooling; otherwise the one fired most recently. A second kiln is picked up
  automatically once it's claimed in KilnAid.
- **Recent firings:** the last five firings across your kilns, with program,
  date, duration and peak temperature. Firings that ended early are tagged
  STOPPED or ERROR.
- **Weather:** a 7-day forecast from Open-Meteo with highs, lows and chance of
  precipitation. Any day **above 10%** is drawn inverted (white on black) and
  listed in a warning tag at the top of the section.
- **Updates on the hour:** the display sleeps until just after the next hour
  (local time), wakes, fetches a new screen and goes back to sleep.

The display keeps its stock TRMNL firmware but talks to this server instead of
trmnl.com (TRMNL calls this "BYOS"). No TRMNL license is needed.

## Files

| Path | What it is |
|---|---|
| `server.mjs` | The server: TRMNL device API, caching, preview page, command-line tools |
| `src/kilnaid.mjs` | Read-only KilnAid client and kiln status summary |
| `src/history.mjs` | Firing log: detects starts and ends, saves to SQLite (`DATA_DIR/kiln.db`) |
| `src/weather.mjs` | Open-Meteo forecast and weather-code icons |
| `src/render.mjs` | Screen layout (SVG) → 1-bit BMP/PNG |
| `src/demo.mjs` | Sample data for previews |
| `fonts/` | Inter (SIL Open Font License), bundled so the server needs no system fonts |

## Try it locally

Needs Node.js 22.13 or newer (for its built-in SQLite). No database server to install.

```
npm install
npm run demo                 # sample screens in ./preview, no accounts needed
cp kiln.env.example kiln.env # then fill it in
npm run dump                 # print raw KilnAid data for your kilns
npm run once                 # render the live screen to ./preview/screen.png
npm start                    # server + preview page at http://localhost:8080
```

## Deploy on Railway

1. Push this folder to a GitHub repo and create a Railway service from it.
   Railway detects Node and runs `npm start`.
2. Add **Variables** (see `kiln.env.example`): at minimum `KILNAID_EMAIL`,
   `KILNAID_PASSWORD`, `LATITUDE`, `LONGITUDE`, and `TIMEZONE`.
3. Add a **Volume** to the service, mounted at `/data`, and set the variable
   `DATA_DIR=/data`. The firing log is a small SQLite database file there.
   Volumes are billed only for the space used, and this file stays a few
   kilobytes, so the cost rounds to zero and is covered by Hobby's included
   usage. Without a volume, the log is wiped every time Railway redeploys.
4. Under **Settings → Networking**, generate a public domain. The server picks
   it up automatically (or set `PUBLIC_URL`).
5. Open the domain in a browser. You should see the live screen, plus sample
   screens you can switch between.

Keep the service always-on (don't enable serverless/app sleeping). It checks
your kilns every 5 minutes in the background, which is how firings get logged.

## Point the display at your server

1. Connect the display to the driver board (FPC cable, metal contacts facing
   up) and switch it on. Kits ship with TRMNL firmware installed. If yours
   doesn't have it, flash the "TRMNL DIY Kit" firmware from
   https://usetrmnl.com/flash.
2. When the display shows its Wi-Fi setup screen, join the **TRMNL** Wi-Fi
   network from your phone. The setup page opens.
3. Pick your Wi-Fi and enter the password. In the **custom server / API URL**
   field, enter your Railway URL, e.g. `https://your-app.up.railway.app`.
4. Save. Within a minute the display should show the dashboard.

To lock the server to your display, copy its MAC address from the Railway logs
(`Device AA:BB:… set up`) into `DEVICE_ID`.

## Settings

| Name | Default | What it does |
|---|---|---|
| `KILNAID_EMAIL`, `KILNAID_PASSWORD` | — | Your KilnAid sign-in (read-only use). |
| `KILNS` | all kilns | Comma-separated parts of KilnAid names or serial numbers, to watch only some kilns. |
| `POLL_MINUTES` | `5` | How often the server checks the kilns (minimum 2). This sets how precise logged start and end times are. |
| `DATA_DIR` | `./data` | Folder for the firing log database (`kiln.db`). Use `/data` with a Railway volume. |
| `LATITUDE`, `LONGITUDE` | — | Forecast location. |
| `LOCATION_NAME` | — | Shown in the weather heading. |
| `TEMP_UNIT` | `F` | `F` or `C` for the forecast. |
| `RAIN_THRESHOLD` | `10` | Highlight days whose chance of precipitation is above this %. |
| `TIMEZONE` | `America/Los_Angeles` | Clock used for "on the hour" and the times shown. |
| `REFRESH_MINUTES` | `60` | Minutes between refreshes, aligned to the clock (minimum 5). Shorter means faster battery drain. |
| `DEVICE_ID` | any device | Comma-separated MAC addresses allowed to use the server. |
| `DEVICE_SECRET` | derived | Secret used to make device API keys. |
| `PUBLIC_URL` | Railway domain | Base URL put in image links. |

## Endpoints

| Path | Used by |
|---|---|
| `GET /api/setup`, `GET /api/display`, `POST /api/log` | The display (TRMNL firmware protocol) |
| `GET /screen/<id>.bmp` | The display: 800×480 1-bit BMP3 (48,062 bytes) |
| `GET /firings.csv` | You: every logged firing as a spreadsheet (kiln, program, start, end, hours, peak, target, outcome) |
| `GET /` and `/preview.png?demo=firing\|cooling\|idle\|first-run\|errors` | You, in a browser |

## Good to know

- **Unofficial kiln API.** KilnAid's API isn't published. It's the same one the
  phone app and the earlier Vestaboard project use, and Bartlett could change it.
  Run `npm run dump` and compare the output if the panel ever looks wrong.
  **This is not a kiln safety monitor.**
- **The firing log starts empty.** KilnAid's API only reports what a kiln is
  doing right now. It has no list of past firings, so the server builds its
  own log by watching. Firings from before you deploy aren't included, except
  that a kiln already showing "Complete" adds its last program with the date
  shown as "Earlier". Start times come from the controller's elapsed-time
  clock, so they're accurate even if the server first sees a firing midway.
  Firings that happen while the server is down are missed.
- **Hourly screen.** The kiln panel shows the reading as of the last refresh,
  with its timestamp. If a controller hasn't reported for 20 minutes, the
  panel says NO SIGNAL and shows when it was last heard from.
- **Weather** comes from Open-Meteo's free API (no key, non-commercial use).
- **Battery:** a refresh once an hour is light use. The server reads the
  battery voltage the display sends and shows a gauge in the top-right corner.
- The preview page and `/firings.csv` have no password. They show only your
  kiln and firing data, at an address nobody else knows.
