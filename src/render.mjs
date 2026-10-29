// Draws the 800x480 screen as SVG, rasterizes it without anti-aliasing, and
// encodes it as the 1-bit BMP the TRMNL firmware expects (plus a PNG preview).
import { Resvg } from "@resvg/resvg-js";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { describe } from "./weather.mjs";

export const W = 800;
export const H = 480;
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fonts");
const FONT_FILES = readdirSync(FONT_DIR).filter((f) => /\.(otf|ttf)$/i.test(f)).map((f) => join(FONT_DIR, f));

const K = "#000";
const P = "#fff";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Exact rendered width of a run of Inter text (cached). */
const widthCache = new Map();
function textWidth(str, size, weight = 400, spacing = 0) {
  const key = `${str}|${size}|${weight}|${spacing}`;
  if (widthCache.has(key)) return widthCache.get(key);
  let w = 0;
  if (String(str).trim()) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${size * 2}">` +
      text(0, size * 1.5, str, { size, weight, spacing }) + `</svg>`;
    const box = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" } }).getBBox();
    w = box ? box.x + box.width : 0;
  }
  widthCache.set(key, w);
  return w;
}
function fit(text, maxPx, size, weight) {
  if (text === undefined || text === null) return "";
  let t = String(text ?? "");
  if (textWidth(t, size, weight) <= maxPx) return t;
  while (t.length > 1 && textWidth(t + "…", size, weight) > maxPx) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

function text(x, y, str, { size = 16, weight = 400, fill = K, anchor = "start", spacing = 0 } = {}) {
  const ls = spacing ? ` letter-spacing="${spacing}"` : "";
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls}>${esc(str)}</text>`;
}

// ---------------------------------------------------------------------------
// Weather icons, drawn in a 40x40 box
// ---------------------------------------------------------------------------

function cloudPath(fg, bg, dy = 0) {
  return `<path transform="translate(0 ${dy})" d="M11 29 H30 A7 7 0 0 0 30 15 A10 10 0 0 0 11.5 12.5 A8.3 8.3 0 0 0 11 29 Z" fill="${bg}" stroke="${fg}" stroke-width="3" stroke-linejoin="round"/>`;
}
function sun(fg, cx = 20, cy = 20, r = 7.5, ray = 5) {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 3.5), y1 = cy + Math.sin(a) * (r + 3.5);
    const x2 = cx + Math.cos(a) * (r + 3.5 + ray), y2 = cy + Math.sin(a) * (r + 3.5 + ray);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${fg}" stroke-width="3" stroke-linecap="round"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-width="3"/>${rays}`;
}
function icon(name, x, y, fg = K, bg = P, scale = 1) {
  let g = "";
  const drops = (n, style) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      const cx = 13 + i * 7;
      if (style === "rain") s += `<line x1="${cx + 1.5}" y1="31" x2="${cx - 1.5}" y2="38" stroke="${fg}" stroke-width="3" stroke-linecap="round"/>`;
      else if (style === "drizzle") s += `<circle cx="${cx}" cy="34.5" r="1.9" fill="${fg}"/>`;
      else if (style === "snow") s += `<g stroke="${fg}" stroke-width="2" stroke-linecap="round"><line x1="${cx}" y1="31" x2="${cx}" y2="38"/><line x1="${cx - 3}" y1="32.7" x2="${cx + 3}" y2="36.3"/><line x1="${cx - 3}" y1="36.3" x2="${cx + 3}" y2="32.7"/></g>`;
    }
    return s;
  };
  switch (name) {
    case "sun": g = sun(fg); break;
    case "partly": g = sun(fg, 26, 13, 6, 3.5) + cloudPath(fg, bg, 3); break;
    case "cloud": g = cloudPath(fg, bg, 2); break;
    case "fog":
      g = cloudPath(fg, bg, -4) + [30, 35].map((yy) => `<line x1="8" y1="${yy}" x2="32" y2="${yy}" stroke="${fg}" stroke-width="3" stroke-linecap="round"/>`).join("");
      break;
    case "rain": g = cloudPath(fg, bg, -4) + drops(3, "rain"); break;
    case "drizzle": g = cloudPath(fg, bg, -4) + drops(3, "drizzle"); break;
    case "snow": g = cloudPath(fg, bg, -4) + drops(3, "snow"); break;
    case "storm": g = cloudPath(fg, bg, -4) + `<path d="M21 26 L15 34 H20 L17 40 L26 31 H21 L24 26 Z" fill="${fg}"/>`; break;
    default: g = text(20, 27, "?", { size: 22, weight: 700, fill: fg, anchor: "middle" });
  }
  return `<g transform="translate(${x} ${y}) scale(${scale})">${g}</g>`;
}

function dropGlyph(x, y, fill) {
  return `<path transform="translate(${x} ${y})" d="M5 0 C5 0 0 6 0 9 A5 5 0 0 0 10 9 C10 6 5 0 5 0 Z" fill="${fill}"/>`;
}

function warnGlyph(x, y, fg, bg) {
  return `<g transform="translate(${x} ${y})"><path d="M9 0 L18 16 H0 Z" fill="${fg}"/><rect x="8" y="5" width="2" height="6" fill="${bg}"/><rect x="8" y="12.5" width="2" height="2" fill="${bg}"/></g>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function fmtTime(date, tz) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

function header(model) {
  const { now, tz, nextRefresh, battery } = model;
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  let s = `<rect x="0" y="0" width="${W}" height="40" fill="${K}"/>`;
  s += text(16, 27, day, { size: 19, weight: 700, fill: P });
  let right = `Updated ${fmtTime(now, tz)}`;
  if (nextRefresh) right += `  ·  next ${fmtTime(nextRefresh, tz)}`;
  let rx = W - 16;
  if (battery !== null && battery !== undefined) {
    // Battery outline with fill, then the text to its left.
    const bx = W - 16 - 30;
    s += `<rect x="${bx}" y="13" width="26" height="14" rx="2" fill="none" stroke="${P}" stroke-width="2"/><rect x="${bx + 26}" y="17" width="3" height="6" fill="${P}"/>`;
    const level = Math.max(0, Math.min(1, battery));
    if (level > 0.02) s += `<rect x="${bx + 3}" y="16" width="${Math.max(1, Math.round(20 * level))}" height="8" fill="${P}"/>`;
    rx = bx - 10;
  }
  s += text(rx, 26, right, { size: 15, weight: 500, fill: P, anchor: "end" });
  return s;
}

function sectionLabel(x, y, label, width) {
  const w = textWidth(label, 13, 800, 1.5);
  return text(x, y, label, { size: 13, weight: 800, spacing: 1.5 }) +
    `<rect x="${x + w + 10}" y="${y - 5}" width="${width - w - 10}" height="2" fill="${K}"/>`;
}

function statusPill(x, y, label, filled) {
  const w = Math.round(textWidth(label, 13, 800, 0.8) + 22);
  const bx = x - w;
  return `<rect x="${bx}" y="${y}" width="${w}" height="24" rx="12" fill="${filled ? K : P}" stroke="${K}" stroke-width="2"/>` +
    text(bx + w / 2, y + 17, label, { size: 13, weight: 800, fill: filled ? P : K, anchor: "middle", spacing: 0.8 });
}

function kilnCard(x, y, w, h, kiln, model) {
  const { tz } = model;
  let s = "";
  if (!kiln || kiln.empty) {
    s += `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="10" fill="none" stroke="${K}" stroke-width="2" stroke-dasharray="7 6"/>`;
    s += text(x + w / 2, y + h / 2 - 10, kiln?.name || "Kiln", { size: 22, weight: 700, anchor: "middle" });
    s += text(x + w / 2, y + h / 2 + 18, kiln?.note || "Not connected yet", { size: 16, weight: 500, anchor: "middle" });
    return s;
  }
  s += `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="10" fill="none" stroke="${K}" stroke-width="3"/>`;
  const pad = 16;
  const active = ["firing", "cooling", "error"].includes(kiln.state);
  s += statusPill(x + w - pad, y + 14, kiln.stale ? "NO SIGNAL" : kiln.headline, active && !kiln.stale);
  const pillW = textWidth(kiln.stale ? "NO SIGNAL" : kiln.headline, 13, 800, 0.8) + 22;
  s += text(x + pad, y + 33, fit(kiln.name, w - pad * 2 - pillW - 10, 20, 700), { size: 20, weight: 700 });

  // Big temperature, with the unit raised beside it
  const temps = kiln.temps || [];
  const big = temps.length ? String(Math.round(temps.reduce((a, b) => a + b, 0) / temps.length)) : "—";
  const unit = temps.length ? `°${kiln.scale || "F"}` : "";
  s += `<text x="${x + pad - 2}" y="${y + 98}" font-family="Inter" font-size="62" font-weight="800" letter-spacing="-1.5" fill="${K}">${esc(big)}` +
    (unit ? `<tspan font-size="24" font-weight="700" letter-spacing="0" dx="5" dy="-30">${unit}</tspan>` : "") + `</text>`;

  // Right of the temperature: when the reading was taken, and per-zone temps
  if (kiln.updated) {
    const when = kiln.updated.toLocaleString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: tz,
      ...(model.now - kiln.updated > 20 * 3600 * 1000 ? { month: "short", day: "numeric" } : {}),
    });
    if (kiln.stale) {
      const msg = `Last heard ${when}`;
      const mw = textWidth(msg, 13, 700);
      s += warnGlyph(x + w - pad - mw - 24, y + 57, K, P);
      s += text(x + w - pad, y + 71, msg, { size: 13, weight: 700, anchor: "end" });
    } else {
      s += text(x + w - pad, y + 71, `Reading ${when}`, { size: 13, weight: 500, anchor: "end" });
    }
  }
  if (temps.length > 1) {
    s += text(x + w - pad, y + 95, `Zones ${temps.join(" / ")}`, { size: 13, weight: 600, anchor: "end" });
  }

  // Details: two columns of label/value pairs
  s += `<rect x="${x + pad}" y="${y + 112}" width="${w - pad * 2}" height="1.5" fill="${K}"/>`;
  const rows = (kiln.details || []).slice(0, 4);
  const colW = (w - pad * 2) / 2;
  rows.forEach(([label, value], i) => {
    const cx = x + pad + (i % 2) * colW;
    const cy = y + 131 + Math.floor(i / 2) * 37;
    s += text(cx, cy, label.toUpperCase(), { size: 11, weight: 700, spacing: 0.8 });
    s += text(cx, cy + 18, fit(value, colW - 10, 16, 600), { size: 16, weight: 600 });
  });
  if (!rows.length) {
    const note = kiln.state === "idle" ? "Ready to load" : kiln.state === "offline" ? "Controller not reporting" : "";
    if (note) s += text(x + pad, y + 145, note, { size: 16, weight: 500 });
  }
  return s;
}

function fmtDuration(min) {
  if (min === null || min === undefined) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function firingDate(rec, now, tz) {
  if (!rec.start) return "Earlier";
  const d = new Date(rec.start);
  const key = (x) => x.toLocaleDateString("en-CA", { timeZone: tz });
  if (key(d) === key(now)) return "Today";
  if (key(d) === key(new Date(now.getTime() - 86400000))) return "Yesterday";
  const sameYear = d.toLocaleDateString("en-US", { year: "numeric", timeZone: tz }) === now.toLocaleDateString("en-US", { year: "numeric", timeZone: tz });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "2-digit" }), timeZone: tz });
}

function firingList(x, y, w, h, model) {
  const { firings = [], now, tz, kilnCount } = model;
  let s = "";
  if (!firings.length) {
    s += text(x, y + 30, "No firings logged yet", { size: 17, weight: 700 });
    s += text(x, y + 54, "Firings are recorded as they happen,", { size: 14, weight: 500 });
    s += text(x, y + 74, "starting now.", { size: 14, weight: 500 });
    return s;
  }
  const rowH = 39;
  const rows = firings.slice(0, Math.floor(h / rowH));
  rows.forEach((r, i) => {
    const ry = y + i * rowH;
    if (i > 0) s += `<rect x="${x}" y="${ry}" width="${w}" height="1" fill="${K}"/>`;
    const date = firingDate(r, now, tz);
    const dw = textWidth(date, 14, 700);
    s += text(x + w, ry + 18, date, { size: 14, weight: 700, anchor: "end" });
    s += text(x, ry + 18, fit(r.program || "Unknown program", w - dw - 12, 16, 700), { size: 16, weight: 700 });
    const bits = [];
    if (kilnCount > 1 && r.kiln) bits.push(r.kiln);
    const dur = fmtDuration(r.elapsedMin);
    if (dur) bits.push(dur);
    if (r.peak) bits.push(`${r.peak}°${r.scale || "F"}`);
    const outcome = r.outcome && r.outcome !== "Complete" ? r.outcome.toUpperCase() : "";
    let line = bits.join("  ·  ");
    const ow = outcome ? textWidth(outcome, 11, 800, 0.6) + 12 : 0;
    s += text(x, ry + 34, fit(line, w - ow - 6, 13, 500), { size: 13, weight: 500 });
    if (outcome) {
      s += `<rect x="${x + w - ow}" y="${ry + 23}" width="${ow}" height="15" rx="3" fill="${K}"/>`;
      s += text(x + w - ow / 2, ry + 34.5, outcome, { size: 11, weight: 800, fill: P, anchor: "middle", spacing: 0.6 });
    }
  });
  return s;
}

function kilnSection(model) {
  const top = 54;
  const cardY = top + 22;
  const cardH = 196;
  const cardW = 440;
  const listX = 16 + cardW + 24;
  const listW = W - 16 - listX;
  let s = sectionLabel(16, top + 10, "KILN", cardW);
  s += sectionLabel(listX, top + 10, "RECENT FIRINGS", listW);

  if (!model.kiln) {
    s += `<rect x="17" y="${cardY + 1}" width="${cardW - 2}" height="${cardH - 2}" rx="10" fill="none" stroke="${K}" stroke-width="3"/>`;
    const title = model.kilnError ? "Can't reach KilnAid" : "No kilns in KilnAid";
    const note = model.kilnError || "Claim your kiln in the KilnAid app";
    s += warnGlyph(16 + cardW / 2 - 9, cardY + 58, K, P);
    s += text(16 + cardW / 2, cardY + 108, title, { size: 22, weight: 700, anchor: "middle" });
    s += text(16 + cardW / 2, cardY + 136, fit(note, cardW - 40, 15, 500), { size: 15, weight: 500, anchor: "middle" });
  } else {
    s += kilnCard(16, cardY, cardW, cardH, model.kiln, model);
  }
  s += firingList(listX, cardY + 2, listW, cardH, model);
  return s;
}

function weatherSection(model) {
  const top = 288;
  const { weather, rainThreshold, locationName } = model;
  let s = "";
  const label = locationName ? `WEATHER  ·  ${locationName.toUpperCase()}` : "WEATHER";

  if (!weather) {
    s += sectionLabel(16, top + 10, label, W - 32);
    s += text(W / 2, top + 100, "Forecast unavailable", { size: 22, weight: 700, anchor: "middle" });
    if (model.weatherError) s += text(W / 2, top + 128, fit(model.weatherError, W - 100, 15, 500), { size: 15, weight: 500, anchor: "middle" });
    return s;
  }

  const days = weather.days.slice(0, 7);
  const wet = days.filter((d) => d.precipChance !== null && d.precipChance > rainThreshold);
  const dayName = (d, i) =>
    i === 0 ? "TODAY" : new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();

  // Section label with the alert (or all-clear) on the right
  let alert;
  if (wet.length) {
    const names = wet.map((d) => dayName(d, days.indexOf(d)));
    const msg = wet.length >= 5 ? `RAIN LIKELY ${wet.length} OF 7 DAYS` : `RAIN: ${names.join(", ")}`;
    const aw = Math.round(textWidth(msg, 13, 800, 0.8) + 44);
    alert = `<rect x="${W - 16 - aw}" y="${top - 8}" width="${aw}" height="24" rx="4" fill="${K}"/>` +
      warnGlyph(W - 16 - aw + 9, top - 4, P, K) +
      text(W - 16 - aw + 34, top + 9, msg, { size: 13, weight: 800, fill: P, spacing: 0.8 });
    const lw = textWidth(label, 13, 800, 1.5);
    s += text(16, top + 10, label, { size: 13, weight: 800, spacing: 1.5 });
    s += `<rect x="${16 + lw + 10}" y="${top + 5}" width="${W - 32 - lw - 10 - aw - 12}" height="2" fill="${K}"/>`;
  } else {
    const msg = "NO RAIN EXPECTED";
    const aw = textWidth(msg, 13, 800, 1.5);
    const lw = textWidth(label, 13, 800, 1.5);
    s += text(16, top + 10, label, { size: 13, weight: 800, spacing: 1.5 });
    s += `<rect x="${16 + lw + 10}" y="${top + 5}" width="${W - 32 - lw - 22 - aw}" height="2" fill="${K}"/>`;
    s += text(W - 16, top + 10, msg, { size: 13, weight: 800, spacing: 1.5, anchor: "end" });
  }
  if (alert) s += alert;

  // Seven day columns
  const colTop = top + 24;
  const colH = H - 10 - colTop;
  const colW = (W - 32) / 7;
  days.forEach((d, i) => {
    const x = 16 + i * colW;
    const flagged = d.precipChance !== null && d.precipChance > rainThreshold;
    const fg = flagged ? P : K;
    const bg = flagged ? K : P;
    const cx = x + colW / 2;
    if (flagged) s += `<rect x="${x + 3}" y="${colTop}" width="${colW - 6}" height="${colH}" rx="8" fill="${K}"/>`;
    else if (i > 0 && !(days[i - 1].precipChance > rainThreshold)) {
      s += `<rect x="${x}" y="${colTop + 10}" width="1.5" height="${colH - 20}" fill="${K}"/>`;
    }
    s += text(cx, colTop + 25, dayName(d, i), { size: 14, weight: 800, fill: fg, anchor: "middle", spacing: 1 });
    s += icon(describe(d.code).icon, cx - 22, colTop + 34, fg, bg, 1.1);
    const hi = d.high === null ? "—" : `${Math.round(d.high)}°`;
    const lo = d.low === null ? "—" : `${Math.round(d.low)}°`;
    s += text(cx, colTop + 109, hi, { size: 23, weight: 800, fill: fg, anchor: "middle" });
    s += text(cx, colTop + 130, lo, { size: 15, weight: 500, fill: fg, anchor: "middle" });

    // Chance of precipitation: drop + percent
    const pc = d.precipChance;
    const pct = pc === null ? "—" : `${Math.round(pc)}%`;
    const tw = textWidth(pct, 17, 800);
    const startX = cx - (tw + 15) / 2;
    s += dropGlyph(startX, colTop + 141, fg);
    s += text(startX + 15, colTop + 155, pct, { size: 17, weight: 800, fill: fg });
  });
  return s;
}

export function buildSvg(model) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${P}"/>` +
    header(model) + kilnSection(model) + weatherSection(model) +
    `</svg>`;
}

// ---------------------------------------------------------------------------
// Rasterize + encode
// ---------------------------------------------------------------------------

/** Returns a Uint8Array of W*H values: 1 = white, 0 = black. */
export function rasterize(svg) {
  const r = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
    shapeRendering: 0, // optimizeSpeed: no anti-aliasing, crisp 1-bit edges
    textRendering: 0,
    background: "#ffffff",
  });
  const img = r.render();
  const px = img.pixels;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const luma = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    out[i] = luma >= 128 ? 1 : 0;
  }
  return out;
}

/** 1-bit BMP3, 800x480, 48,062 bytes: the exact format TRMNL's docs specify. */
export function toBmp(bits) {
  const rowBytes = W / 8; // 100, already a multiple of 4
  const dataSize = rowBytes * H;
  const buf = Buffer.alloc(62 + dataSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(62, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22); // positive height: rows stored bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(2, 46);
  buf.writeUInt32LE(2, 50);
  // Palette: index 0 = black, index 1 = white
  buf.writeUInt32LE(0x00000000, 54);
  buf.writeUInt32LE(0x00ffffff, 58);
  for (let y = 0; y < H; y++) {
    const dst = 62 + (H - 1 - y) * rowBytes;
    for (let xb = 0; xb < rowBytes; xb++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[y * W + xb * 8 + b];
      buf[dst + xb] = byte;
    }
  }
  return buf;
}

/** 1-bit grayscale PNG of the same pixels, for previewing in a browser. */
export function toPng(bits) {
  const rowBytes = W / 8;
  const raw = Buffer.alloc((rowBytes + 1) * H);
  for (let y = 0; y < H; y++) {
    const o = y * (rowBytes + 1);
    raw[o] = 0;
    for (let xb = 0; xb < rowBytes; xb++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[y * W + xb * 8 + b];
      raw[o + 1 + xb] = byte;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderScreen(model) {
  const bits = rasterize(buildSvg(model));
  return { bmp: toBmp(bits), png: toPng(bits) };
}
