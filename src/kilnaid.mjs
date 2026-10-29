// Read-only client for Bartlett's KilnAid cloud (the same calls the phone app
// makes). The API is undocumented and unofficial: it can change without notice,
// and this must never be relied on as a kiln safety system.

export const LOGIN_URL = "https://bartinst-user-service-prod.herokuapp.com/login";
export const KILN_API = "https://kiln.bartinst.com";

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.body = String(body);
  }
}

export async function httpJson(method, url, headers = {}, body = undefined, timeoutMs = 20000) {
  const init = {
    method,
    headers: { "User-Agent": "kiln-weather-trmnl/1.0", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const raw = await response.text();
  if (!response.ok) throw new HttpError(response.status, raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class KilnAid {
  constructor(email, password) {
    this.email = String(email).trim();
    this.password = password;
    this.token = null;
  }

  async login() {
    let data;
    try {
      data = await httpJson(
        "POST",
        LOGIN_URL,
        { Accept: "application/json", "kaid-version": "kaid-plus" },
        { email: this.email, password: this.password },
      );
    } catch (err) {
      if (err instanceof HttpError && [400, 401, 403].includes(err.status)) {
        throw new Error("KilnAid rejected the email or password");
      }
      throw err;
    }
    if (!data || typeof data !== "object" || !data.authentication_token) {
      throw new Error("KilnAid login returned an unexpected response");
    }
    this.token = String(data.authentication_token);
  }

  async post(path, body, retry = true) {
    if (!this.token) await this.login();
    const headers = {
      Accept: "application/json",
      "auth-token": `binst-cookie=${this.token}`,
      email: this.email,
      "kaid-version": "kaid-plus",
      "x-app-name-token": "kiln-aid",
    };
    try {
      return await httpJson("POST", KILN_API + path, headers, body);
    } catch (err) {
      const expired =
        err instanceof HttpError &&
        ([401, 403].includes(err.status) ||
          (err.status === 400 && err.body.toLowerCase().includes("authentication")));
      if (expired && retry) {
        this.token = null;
        return this.post(path, body, false);
      }
      throw err;
    }
  }

  /** Every kiln claimed on the account, in the order KilnAid lists them. */
  async kilns() {
    const claimed = await this.post("/kilns/settings", {});
    if (!Array.isArray(claimed)) throw new Error("KilnAid returned an unexpected kiln list");
    const list = claimed.filter((k) => k && typeof k === "object" && k.kiln_id);
    if (!list.length) return [];
    const ids = list.map((k) => String(k.kiln_id));
    const details = await this.post("/kilnaid-data/settings", { externalIds: ids });
    const byId = new Map();
    if (Array.isArray(details)) {
      for (const d of details) if (d && d.externalId) byId.set(String(d.externalId), d);
    }
    return list.map((k) => ({ id: String(k.kiln_id), ...k, ...(byId.get(String(k.kiln_id)) ?? {}) }));
  }

  /** Status for several kilns in one request: Map of id -> status object. */
  async statuses(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const data = await this.post("/kilnaid-data/status", { externalIds: ids });
    if (Array.isArray(data)) {
      for (const item of data) if (item && item.externalId) out.set(String(item.externalId), item);
    }
    return out;
  }
}

/**
 * Pick which claimed kilns go in the two slots. A slot can name a kiln by its
 * KilnAid name or serial number; unnamed slots take the remaining kilns in order.
 */
export function assignSlots(kilns, wanted) {
  const used = new Set();
  const matches = (k, needle) =>
    [k.name, k.serialNumber, k.serial_number, k.id]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle));
  const slots = wanted.map((w) => {
    if (!w) return null;
    const needle = w.toLowerCase();
    const k = kilns.find((x) => !used.has(x.id) && matches(x, needle));
    if (k) used.add(k.id);
    return k ?? { missing: w };
  });
  return slots.map((s) => {
    if (s) return s;
    const k = kilns.find((x) => !used.has(x.id));
    if (k) used.add(k.id);
    return k ?? null;
  });
}

// ---------------------------------------------------------------------------
// Turning a raw status into something to draw
// ---------------------------------------------------------------------------

const toNumber = (v) => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
};

// Unused thermocouple slots come back as 9999 (or junk); ignore anything a
// pottery kiln can't actually read.
const plausible = (t) => t !== null && t > -60 && t < 3000;

/** Thermocouple readings in zone order. Single-zone kilns report in t2. */
export function readings(status, meta = {}) {
  const zones = toNumber(status.numZones ?? meta.numZones) ?? 1;
  const slots = zones <= 1 ? [2, 1, 3] : [1, 2, 3].slice(0, Math.min(zones, 3));
  const temps = [];
  for (const z of slots) {
    const t = toNumber(status[`t${z}`]);
    if (plausible(t)) {
      temps.push(t);
      if (zones <= 1) break; // first good one wins
    }
  }
  return temps;
}

/** Hours:minutes strings like "5:42" -> "5h 42m". */
function hm(value) {
  if (value === undefined || value === null || value === "") return null;
  const m = String(value).match(/^(\d+):(\d{1,2})/);
  if (!m) return String(value);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!h && !min) return null;
  return h ? `${h}h ${String(min).padStart(2, "0")}m` : `${min}m`;
}

const STALE_MINUTES = 20;

/**
 * Summarize a kiln for the screen. Returns a plain object the renderer can
 * draw without knowing anything about KilnAid.
 */
export function summarize(meta, status, now = new Date()) {
  const name = meta.label || meta.name || (meta.serialNumber ? `Kiln ${meta.serialNumber}` : "Kiln");
  if (!status) return { name, state: "offline", headline: "NO DATA", temps: [], details: [] };

  const scale = String(status.temperatureScale ?? meta.temperatureScale ?? "F").toUpperCase().startsWith("C") ? "C" : "F";
  const temps = readings(status, meta);
  const mode = String(status.mode ?? "").trim();
  const modeKey = mode.toLowerCase();
  const hot = temps.length && Math.max(...temps) >= (scale === "C" ? 65 : 150);

  let state = "idle";
  let headline = "IDLE";
  if (modeKey === "firing") {
    state = "firing";
    const hold = hm(status.holdRemainingTime);
    headline = /hold/i.test(String(status.segment ?? "")) || hold ? "HOLDING" : "FIRING";
  } else if (modeKey === "complete") {
    state = hot ? "cooling" : "done";
    headline = hot ? "COOLING" : "COMPLETE";
  } else if (modeKey === "idle" || modeKey === "") {
    state = hot ? "cooling" : "idle";
    headline = hot ? "COOLING" : "IDLE";
  } else if (modeKey === "not connected") {
    state = "offline";
    headline = "OFFLINE";
  } else {
    // Anything else (error codes, delay start, etc.) is shown as Bartlett names it.
    state = /err|fail|alarm/i.test(mode) ? "error" : "other";
    headline = mode.toUpperCase().slice(0, 14);
  }

  let updated = null;
  if (status.updatedAt) {
    const d = new Date(status.updatedAt);
    if (!Number.isNaN(d.getTime())) updated = d;
  }
  const stale = updated ? (now - updated) / 60000 > STALE_MINUTES : false;

  const details = [];
  if (state === "firing") {
    if (status.programName) details.push(["Program", String(status.programName)]);
    if (status.segment) details.push(["Segment", String(status.segment)]);
    const sp = toNumber(status.setPoint);
    if (plausible(sp)) details.push(["Target", `${sp}°${scale}`]);
    const elapsed = hm(status.firingTime);
    if (elapsed) details.push(["Elapsed", elapsed]);
    const hold = hm(status.holdRemainingTime);
    if (hold) details.push(["Hold left", hold]);
  } else if (state === "cooling" || state === "done") {
    if (status.programName) details.push(["Last fired", String(status.programName)]);
    const elapsed = hm(status.firingTime);
    if (elapsed) details.push(["Fire time", elapsed]);
  } else if (status.alarmAbbreviation && !/^off$/i.test(String(status.alarmAbbreviation))) {
    details.push(["Alarm", String(status.alarmAbbreviation)]);
  }

  return { name, state, headline, temps, scale, details, updated, stale };
}
