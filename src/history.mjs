// Firing log. KilnAid's status API only reports what a kiln is doing right now,
// so the server watches each kiln and records firings itself: when one starts,
// which program ran, how hot it got, and how it ended.
//
// Records live in a small SQLite database (DATA_DIR/kiln.db) using the SQLite
// built into Node, so there's nothing extra to install or pay for. Put DATA_DIR
// on a Railway volume so it survives redeploys. Every firing is kept; the
// screen shows the latest few, and /firings.csv downloads them all.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readings } from "./kilnaid.mjs";

const KEEP = 50; // records kept in memory for the screen
const GAP_MINUTES = 30; // a gap this long between observations marks a record "partial"

const COLUMNS = [
  "id", "kilnId", "kiln", "program", "start", "end", "elapsedMin", "peak",
  "setPoint", "scale", "outcome", "partial", "lastSeen", "isOpen", "loggedAt",
];

/** "7:42" -> minutes */
export function minutesOf(value) {
  const m = String(value ?? "").match(/^(\d+):(\d{1,2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export class FiringLog {
  constructor(dir) {
    if (dir) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dir ? join(dir, "kiln.db") : ":memory:");
    this.db.exec(`CREATE TABLE IF NOT EXISTS firings (
      id TEXT PRIMARY KEY,
      kilnId TEXT NOT NULL,
      kiln TEXT,
      program TEXT,
      start TEXT,          -- ISO time heating began (null if unknown)
      end TEXT,            -- ISO time heating ended
      elapsedMin INTEGER,  -- minutes of heating
      peak INTEGER,        -- highest temperature seen
      setPoint INTEGER,    -- highest target temperature seen
      scale TEXT,          -- F or C
      outcome TEXT,        -- Firing, Complete, Stopped, Error
      partial INTEGER,     -- 1 if some of the firing wasn't observed
      lastSeen TEXT,
      isOpen INTEGER NOT NULL DEFAULT 0,
      loggedAt TEXT NOT NULL
    )`);
    this.upsert = this.db.prepare(
      `INSERT OR REPLACE INTO firings (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => "$" + c).join(", ")})`,
    );
    const fromRow = (r) => ({ ...r, partial: Boolean(r.partial) });
    this.records = this.db.prepare("SELECT * FROM firings WHERE isOpen = 0 ORDER BY loggedAt DESC LIMIT ?").all(KEEP).map(fromRow);
    this.open = {};
    for (const r of this.db.prepare("SELECT * FROM firings WHERE isOpen = 1").all()) this.open[r.kilnId] = fromRow(r);
    this.dirty = new Set();
  }

  write(rec, isOpen) {
    rec.loggedAt ??= new Date().toISOString();
    const row = {};
    for (const c of COLUMNS) row["$" + c] = rec[c] ?? null;
    row.$partial = rec.partial ? 1 : 0;
    row.$isOpen = isOpen ? 1 : 0;
    this.upsert.run(row);
  }

  /**
   * Write only what changed: a row when a firing starts and the same row
   * updated once when it ends. The checks in between stay in memory.
   */
  save() {
    for (const r of this.dirty) this.write(r, this.open[r.kilnId] === r);
    this.dirty.clear();
  }

  /** Every saved firing, oldest first, as CSV. */
  csv(timezone) {
    const rows = this.db.prepare("SELECT * FROM firings ORDER BY COALESCE(start, loggedAt)").all();
    const local = (iso) =>
      iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: timezone }).slice(0, 16) : "";
    const cell = (v) => {
      const t = String(v ?? "");
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ["kiln", "program", "started", "ended", "hours", "peak", "target", "unit", "outcome", "partly_observed"];
    const lines = rows.map((r) =>
      [
        r.kiln, r.program, local(r.start), local(r.end),
        r.elapsedMin === null ? "" : (r.elapsedMin / 60).toFixed(2),
        r.peak, r.setPoint, r.scale, r.isOpen ? "In progress" : r.outcome, r.partial ? "yes" : "",
      ].map(cell).join(","),
    );
    return [head.join(","), ...lines].join("\n") + "\n";
  }

  /**
   * Feed one observation of a kiln. Returns true if the log changed.
   * `meta` is the kiln's KilnAid settings (name, numZones, ...).
   */
  observe(meta, status, now = new Date()) {
    if (!status) return false;
    const id = meta.id;
    const mode = String(status.mode ?? "").trim().toLowerCase();
    const seenAt = status.updatedAt && !Number.isNaN(new Date(status.updatedAt)) ? new Date(status.updatedAt) : now;
    const temps = readings(status, meta);
    const top = temps.length ? Math.max(...temps) : null;
    const elapsed = minutesOf(status.firingTime);
    const program = status.programName ? String(status.programName) : null;
    let open = this.open[id];
    let changed = false;

    if (mode === "firing") {
      // A new firing: nothing open, a different program, or the elapsed clock went backwards.
      const restarted =
        open &&
        ((program && open.program && program !== open.program) ||
          (elapsed !== null && open.elapsedMin !== null && elapsed + 5 < open.elapsedMin));
      if (open && restarted) {
        this.close(id, "Stopped", null);
        open = null;
      }
      if (!open) {
        const start = elapsed !== null ? new Date(seenAt - elapsed * 60000) : seenAt;
        open = this.open[id] = {
          id: `${id}-${start.getTime()}`,
          kilnId: id,
          kiln: meta.name || meta.serialNumber || "Kiln",
          program,
          start: start.toISOString(),
          end: null,
          elapsedMin: elapsed,
          peak: top,
          setPoint: null,
          scale: String(status.temperatureScale ?? meta.temperatureScale ?? "F").toUpperCase().startsWith("C") ? "C" : "F",
          outcome: "Firing",
          partial: elapsed === null,
          lastSeen: seenAt.toISOString(),
        };
        this.dirty.add(open);
        changed = true;
      } else {
        if ((seenAt - new Date(open.lastSeen)) / 60000 > GAP_MINUTES) open.partial = true;
        if (program && !open.program) open.program = program;
        if (elapsed !== null) open.elapsedMin = Math.max(open.elapsedMin ?? 0, elapsed);
        if (top !== null) open.peak = Math.max(open.peak ?? top, top);
        open.lastSeen = seenAt.toISOString();
      }
      const sp = Number(status.setPoint);
      if (Number.isFinite(sp) && sp > 0 && sp < 3000) open.setPoint = Math.max(open.setPoint ?? 0, Math.round(sp));
    } else if (open) {
      // Heating has ended. Bartlett reports "Complete" for a normal finish;
      // anything else (back to Idle, an error) means it stopped early.
      const outcome = mode === "complete" ? "Complete" : /err|fail|alarm/.test(mode) ? "Error" : "Stopped";
      if (elapsed !== null) open.elapsedMin = Math.max(open.elapsedMin ?? 0, elapsed);
      if (top !== null) open.peak = Math.max(open.peak ?? top, top);
      this.close(id, outcome, seenAt);
      changed = true;
    } else if (mode === "complete" && !this.records.some((r) => r.kilnId === id)) {
      // First time we see this kiln, and it has a finished firing on it: record
      // it so the list isn't empty, but mark the date as unknown.
      this.records.unshift({
        id: `${id}-seed`,
        kilnId: id,
        kiln: meta.name || meta.serialNumber || "Kiln",
        program,
        start: null,
        end: null,
        elapsedMin: elapsed,
        peak: null,
        scale: "F",
        outcome: "Complete",
        partial: true,
      });
      this.dirty.add(this.records[0]);
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  close(kilnId, outcome, seenAt) {
    const open = this.open[kilnId];
    if (!open) return;
    // Heating ended somewhere between the last "firing" observation and now.
    // The controller's own clock is most precise; otherwise use the last time
    // we saw it firing (at most one poll interval early).
    const startMs = new Date(open.start).getTime();
    const lastSeen = new Date(open.lastSeen).getTime();
    const byClock = open.elapsedMin !== null ? startMs + open.elapsedMin * 60000 : 0;
    let endMs = Math.max(byClock, lastSeen);
    if (seenAt && endMs > seenAt.getTime()) endMs = seenAt.getTime();
    if (seenAt && (seenAt - lastSeen) / 60000 > GAP_MINUTES) open.partial = true;
    open.end = new Date(endMs).toISOString();
    open.elapsedMin = Math.max(open.elapsedMin ?? 0, Math.round((endMs - startMs) / 60000));
    open.outcome = outcome;
    delete this.open[kilnId];
    this.dirty.add(open);
    this.records.unshift(open);
    this.records = this.records.slice(0, KEEP);
  }

  /** Finished firings, newest first. */
  recent(limit = 5) {
    return this.records.slice(0, limit);
  }

  /** Kiln ids with a firing in progress. */
  activeKilns() {
    return Object.keys(this.open);
  }

  /** When each kiln last finished a firing (ms), for choosing which kiln to show. */
  lastFired(kilnId) {
    const r = this.records.find((x) => x.kilnId === kilnId && x.end);
    return r ? new Date(r.end).getTime() : 0;
  }
}
