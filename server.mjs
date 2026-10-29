#!/usr/bin/env node
/*
Kiln + weather dashboard for a TRMNL e-ink display.

Your TRMNL kit keeps its stock firmware; you point it at this server instead
of trmnl.com (Bring Your Own Server). Each time the display wakes, it asks this
server for a picture. The server shows whichever kiln matters right now (the
one firing, else the one cooling, else the one fired last), a list of recent
firings, and a 7-day forecast, then tells the display to sleep until the top
of the next hour.

KilnAid only reports what a kiln is doing right now, so the server checks your
kilns every few minutes in the background and keeps its own firing log in
DATA_DIR/kiln.db (SQLite). Download it any time from /firings.csv.

  node server.mjs            run the server (Railway runs this)
  node server.mjs --demo     write sample screens to ./preview (no accounts needed)
  node server.mjs --once     write the live screen to ./preview/screen.png and exit
  node server.mjs --dump     print the raw KilnAid data for your kilns and exit

The kiln side is read-only and uses Bartlett's undocumented KilnAid API, which
may change without notice. Never rely on it as a kiln safety system.
*/

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMOS } from "./src/demo.mjs";
import { FiringLog } from "./src/history.mjs";
import { KilnAid, summarize } from "./src/kilnaid.mjs";
import { renderScreen } from "./src/render.mjs";
import { fetchWeather } from "./src/weather.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadEnvFile() {
  for (const name of ["kiln.env", ".env"]) {
    const path = join(HERE, name);
    if (!existsSync(path)) continue;
    for (let line of readFileSync(path, "utf8").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const at = line.indexOf("=");
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadEnvFile();

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const num = (name, fallback) => {
  const v = Number(env(name));
  return Number.isFinite(v) && env(name) !== "" ? v : fallback;
};

const config = {
  email: env("KILNAID_EMAIL"),
  password: env("KILNAID_PASSWORD"),
  kilnFilter: env("KILNS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  pollMinutes: Math.max(2, num("POLL_MINUTES", 5)),
  dataDir: env("DATA_DIR", join(HERE, "data")),
  latitude: env("LATITUDE"),
  longitude: env("LONGITUDE"),
  locationName: env("LOCATION_NAME"),
  units: /^c/i.test(env("TEMP_UNIT", "F")) ? "celsius" : "fahrenheit",
  rainThreshold: num("RAIN_THRESHOLD", 10),
  timezone: env("TIMEZONE", "America/Los_Angeles"),
  refreshMinutes: Math.max(5, num("REFRESH_MINUTES", 60)),
  deviceIds: env("DEVICE_ID").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  publicUrl: env("PUBLIC_URL") || (env("RAILWAY_PUBLIC_DOMAIN") ? `https://${env("RAILWAY_PUBLIC_DOMAIN")}` : ""),
  port: num("PORT", 8080),
};

function log(msg) {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: config.timezone });
  console.log(`[${stamp}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Data (cached so the display's hourly wake-up is fast)
// ---------------------------------------------------------------------------

const DATA_MAX_AGE = 10 * 60 * 1000; // refetch weather if older than this when the display asks
const KILN_LIST_MAX_AGE = 6 * 3600 * 1000;

const kilnaid = config.email && config.password ? new KilnAid(config.email, config.password) : null;
const firings = new FiringLog(config.dataDir);
const cache = {
  kilnList: null, kilnListAt: 0,
  statuses: new Map(), kilnsAt: 0, kilnError: null,
  weather: null, weatherAt: 0, weatherError: null,
};

function wantedKilns(list) {
  if (!config.kilnFilter.length) return list;
  return list.filter((k) =>
    config.kilnFilter.some((f) =>
      [k.name, k.serialNumber, k.serial_number, k.id].filter(Boolean).some((v) => String(v).toLowerCase().includes(f))));
}

/** Read every kiln's status and feed the firing log. Runs every POLL_MINUTES. */
async function pollKilns() {
  if (!kilnaid) {
    cache.kilnError = "Set KILNAID_EMAIL and KILNAID_PASSWORD";
    return;
  }
  try {
    if (!cache.kilnList || Date.now() - cache.kilnListAt > KILN_LIST_MAX_AGE) {
      cache.kilnList = wantedKilns(await kilnaid.kilns());
      cache.kilnListAt = Date.now();
      log(`Watching ${cache.kilnList.length} kiln(s): ${cache.kilnList.map((k) => k.name || k.id).join(", ") || "none"}`);
    }
    const fresh = await kilnaid.statuses(cache.kilnList.map((k) => k.id));
    const now = new Date();
    for (const k of cache.kilnList) {
      const st = fresh.get(k.id);
      if (!st) continue;
      cache.statuses.set(k.id, st);
      const wasOpen = Boolean(firings.open[k.id]);
      firings.observe(k, st, now);
      const isOpen = Boolean(firings.open[k.id]);
      if (!wasOpen && isOpen) log(`${k.name || k.id}: firing started (${st.programName || "program unknown"})`);
      if (wasOpen && !isOpen) log(`${k.name || k.id}: firing ended (${firings.records[0]?.outcome})`);
    }
    cache.kilnsAt = Date.now();
    cache.kilnError = null;
  } catch (err) {
    cache.kilnError = err.message || String(err);
    log(`KilnAid problem: ${cache.kilnError}`);
  }
}

async function refreshWeather(force = false) {
  if (!config.latitude || !config.longitude) {
    cache.weatherError = "Set LATITUDE and LONGITUDE";
    return;
  }
  if (!force && Date.now() - cache.weatherAt < DATA_MAX_AGE) return;
  try {
    cache.weather = await fetchWeather({ latitude: config.latitude, longitude: config.longitude, units: config.units });
    cache.weatherAt = Date.now();
    cache.weatherError = null;
  } catch (err) {
    cache.weatherError = err.message || String(err);
    log(`Weather problem: ${cache.weatherError}`);
  }
}

async function refreshAll(force = false) {
  const kilnsStale = Date.now() - cache.kilnsAt > config.pollMinutes * 60000 + 30000;
  await Promise.all([force || kilnsStale ? pollKilns() : null, refreshWeather(force)]);
}

/**
 * The one kiln to show: the one firing, else the hottest one cooling, else the
 * one that finished a firing most recently, else the first on the account.
 */
function featuredKiln(now) {
  const list = cache.kilnList ?? [];
  if (!list.length) return null;
  const view = list.map((k, order) => ({ k, order, s: summarize(k, cache.statuses.get(k.id), now) }));
  const temp = (v) => (v.s.temps.length ? Math.max(...v.s.temps) : -Infinity);
  const firing = view.filter((v) => v.s.state === "firing" && !v.s.stale);
  if (firing.length) return firing.sort((a, b) => temp(b) - temp(a))[0].s;
  const cooling = view.filter((v) => v.s.state === "cooling" && !v.s.stale);
  if (cooling.length) return cooling.sort((a, b) => temp(b) - temp(a))[0].s;
  return view.sort((a, b) => firings.lastFired(b.k.id) - firings.lastFired(a.k.id) || a.order - b.order)[0].s;
}

/** Milliseconds the configured time zone is ahead of UTC at a given moment. */
function tzOffset(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Next wake-up: the next whole multiple of REFRESH_MINUTES on the local clock (60 = top of the hour). */
function nextRefresh(now) {
  const step = config.refreshMinutes * 60000;
  const offset = tzOffset(now);
  const local = now.getTime() + offset;
  return new Date(Math.floor(local / step) * step + step - offset);
}

function batteryLevel(voltage) {
  const v = Number(voltage);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(0, Math.min(1, (v - 3.3) / (4.15 - 3.3)));
}

function buildModel(now, battery = null) {
  return {
    now,
    tz: config.timezone,
    nextRefresh: nextRefresh(now),
    battery,
    rainThreshold: config.rainThreshold,
    locationName: config.locationName,
    kiln: featuredKiln(now),
    kilnCount: cache.kilnList?.length ?? 0,
    firings: firings.recent(5),
    kilnError: cache.kilnList ? null : cache.kilnError,
    weather: cache.weather,
    weatherError: cache.weatherError,
  };
}

// ---------------------------------------------------------------------------
// Images: kept briefly in memory by content hash so the display can fetch them
// ---------------------------------------------------------------------------

const images = new Map(); // hash -> { bmp, png, at }
function storeImage(model) {
  const { bmp, png } = renderScreen(model);
  const hash = createHash("sha256").update(bmp).digest("hex").slice(0, 16);
  images.set(hash, { bmp, png, at: Date.now() });
  while (images.size > 8) images.delete(images.keys().next().value);
  return hash;
}

// ---------------------------------------------------------------------------
// HTTP: the TRMNL device API plus a preview page
// ---------------------------------------------------------------------------

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0] || "http";
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

const deviceKey = (mac) =>
  createHmac("sha256", env("DEVICE_SECRET") || `${config.email}:${config.password}`)
    .update(String(mac).toUpperCase()).digest("base64url").slice(0, 22);

function deviceAllowed(mac) {
  if (!config.deviceIds.length) return true;
  return config.deviceIds.includes(String(mac || "").trim().toUpperCase());
}

function send(res, status, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiln + weather display</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#eceae6;color:#222;display:flex;flex-direction:column;align-items:center;padding:28px 16px}
.frame{background:#fff;padding:14px;border-radius:14px;box-shadow:0 2px 14px rgba(0,0,0,.12);max-width:100%}
img{display:block;width:800px;max-width:100%;height:auto;image-rendering:pixelated}
nav{margin-top:18px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
a{color:#222;background:#fff;border:1px solid #ccc;border-radius:999px;padding:4px 12px;text-decoration:none;font-size:13px}
a.on{background:#222;color:#fff;border-color:#222}p{color:#666;font-size:13px;max-width:640px;text-align:center}
</style></head><body><div class="frame"><img src="/preview.png?demo=%DEMO%&t=${Date.now()}" alt="Display preview"></div>
<nav>%LINKS%<a href="/firings.csv">Download firing log (CSV)</a></nav><p>This is exactly what the display shows (1-bit, 800×480). "Live" uses your real KilnAid and forecast data; the others are samples.</p></body></html>`;

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const mac = req.headers["id"];

  if (path === "/api/setup") {
    if (!mac) return send(res, 200, { status: 404, api_key: null, friendly_id: null, image_url: null, filename: null });
    if (!deviceAllowed(mac)) {
      log(`Setup refused for device ${mac} (not in DEVICE_ID)`);
      return send(res, 200, { status: 404, api_key: null, friendly_id: null, image_url: null, filename: null });
    }
    log(`Device ${mac} set up`);
    await refreshAll();
    const hash = storeImage(buildModel(new Date()));
    return send(res, 200, {
      status: 200,
      api_key: deviceKey(mac),
      friendly_id: deviceKey(mac).slice(0, 6).toUpperCase(),
      image_url: `${baseUrl(req)}/screen/${hash}.bmp`,
      filename: hash,
    });
  }

  if (path === "/api/display") {
    if (!deviceAllowed(mac)) return send(res, 200, { status: 500, error: "Device not found" });
    await refreshAll();
    const now = new Date();
    const battery = batteryLevel(req.headers["battery-voltage"]);
    const hash = storeImage(buildModel(now, battery));
    const seconds = Math.max(60, Math.round((nextRefresh(now) - now) / 1000) + 30);
    log(`Display ${mac || "?"} (battery ${req.headers["battery-voltage"] ?? "?"}V, fw ${req.headers["fw-version"] ?? "?"}) -> sleeps ${Math.round(seconds / 60)} min`);
    return send(res, 200, {
      status: 0,
      image_url: `${baseUrl(req)}/screen/${hash}.bmp`,
      filename: hash,
      refresh_rate: String(seconds),
      reset_firmware: false,
      update_firmware: false,
      firmware_url: null,
    });
  }

  if (path === "/api/log" || path === "/api/logs") {
    let body = "";
    for await (const chunk of req) body += chunk;
    log(`Device log: ${body.slice(0, 500)}`);
    res.writeHead(204).end();
    return;
  }

  const m = path.match(/^\/screen\/([a-f0-9]{16})\.(bmp|png)$/);
  if (m) {
    const img = images.get(m[1]);
    if (!img) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, m[2] === "bmp" ? img.bmp : img.png, m[2] === "bmp" ? "image/bmp" : "image/png");
  }

  if (path === "/preview.png") {
    const demo = url.searchParams.get("demo");
    const now = new Date();
    let model;
    if (demo && DEMOS[demo]) {
      model = { ...buildModel(now, 0.8), kilnError: null, weatherError: null, locationName: config.locationName || "Your town", ...DEMOS[demo](now) };
    } else {
      await refreshAll();
      model = buildModel(now);
    }
    return send(res, 200, renderScreen(model).png, "image/png");
  }

  if (path === "/") {
    const current = url.searchParams.get("demo") || "";
    const links = [["", "Live"], ...Object.keys(DEMOS).map((k) => [k, `Sample: ${k}`])]
      .map(([k, label]) => `<a class="${k === current ? "on" : ""}" href="/${k ? `?demo=${k}` : ""}">${label}</a>`).join("");
    return send(res, 200, PAGE.replace("%DEMO%", encodeURIComponent(current)).replace("%LINKS%", links), "text/html; charset=utf-8");
  }

  if (path === "/firings.csv") {
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="kiln-firings.csv"',
      "Cache-Control": "no-store",
    });
    return res.end(firings.csv(config.timezone));
  }

  if (path === "/healthz") return send(res, 200, { ok: true });
  return send(res, 404, { error: "Not found" });
}

function startServer() {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`Request failed: ${err.stack || err}`);
      if (!res.headersSent) send(res, 500, { status: 500, error: "Server error" });
    });
  });
  server.listen(config.port, () => {
    log(`Listening on port ${config.port}${config.publicUrl ? ` (${config.publicUrl})` : ""}`);
    if (!kilnaid) log("KILNAID_EMAIL / KILNAID_PASSWORD not set: kiln panel will show a setup message");
    if (!config.latitude || !config.longitude) log("LATITUDE / LONGITUDE not set: weather panel will show a setup message");
  });
  // Check the kilns now and every POLL_MINUTES, so firings are logged accurately;
  // refresh the weather just before each scheduled wake-up.
  refreshAll(true);
  setInterval(() => pollKilns(), config.pollMinutes * 60000);
  const schedule = () => {
    const wait = Math.max(5000, nextRefresh(new Date()) - Date.now() - 60000);
    setTimeout(() => refreshWeather(true).finally(schedule), wait);
  };
  schedule();
  return server;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

async function main(argv) {
  const has = (f) => argv.includes(f);
  const out = join(HERE, "preview");
  if (has("--demo")) {
    mkdirSync(out, { recursive: true });
    const now = new Date();
    for (const [name, make] of Object.entries(DEMOS)) {
      const model = { ...buildModel(now, 0.8), kilnError: null, weatherError: null, locationName: config.locationName || "Your town", ...make(now) };
      const { png, bmp } = renderScreen(model);
      writeFileSync(join(out, `${name}.png`), png);
      writeFileSync(join(out, `${name}.bmp`), bmp);
      console.log(`preview/${name}.png`);
    }
    return;
  }
  if (has("--dump")) {
    if (!kilnaid) throw new Error("Set KILNAID_EMAIL and KILNAID_PASSWORD first");
    const kilns = await kilnaid.kilns();
    const statuses = await kilnaid.statuses(kilns.map((k) => k.id));
    for (const k of kilns) console.log(JSON.stringify({ kiln: k, status: statuses.get(k.id) ?? null }, null, 2));
    if (!kilns.length) console.log("No kilns are claimed on this KilnAid account.");
    console.log(`\nFiring log (${firings.records.length} saved in ${config.dataDir}):`);
    console.log(JSON.stringify(firings.recent(10), null, 2));
    return;
  }
  if (has("--once")) {
    await refreshAll(true);
    mkdirSync(out, { recursive: true });
    const { png, bmp } = renderScreen(buildModel(new Date()));
    writeFileSync(join(out, "screen.png"), png);
    writeFileSync(join(out, "screen.bmp"), bmp);
    console.log("preview/screen.png");
    return;
  }
  startServer();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
