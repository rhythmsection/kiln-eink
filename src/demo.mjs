// Sample data for previewing the layout without any accounts.
import { summarize } from "./kilnaid.mjs";
import { parseWeather } from "./weather.mjs";

function demoWeather(now, chances) {
  const time = [];
  for (let i = 0; i < 7; i++) time.push(new Date(now.getTime() + i * 86400000).toISOString().slice(0, 10));
  return parseWeather({
    timezone: "America/Los_Angeles",
    current: { temperature_2m: 58, weather_code: 2, is_day: 1 },
    daily: {
      time,
      weather_code: [2, 61, 80, 3, 0, 1, 45],
      temperature_2m_max: [64, 57, 55, 60, 68, 71, 62],
      temperature_2m_min: [47, 46, 44, 45, 49, 51, 48],
      precipitation_probability_max: chances,
      precipitation_sum: [0, 0.4, 0.2, 0, 0, 0, 0],
    },
  });
}

const ago = (now, days, hour = 9) => {
  const d = new Date(now.getTime() - days * 86400000);
  d.setUTCHours(hour + 7, 0, 0, 0);
  return d.toISOString();
};

function demoFirings(now) {
  return [
    { kiln: "Big L&L", program: "Cone 6 Glaze", start: ago(now, 2, 8), elapsedMin: 662, peak: 2232, scale: "F", outcome: "Complete" },
    { kiln: "Little Skutt", program: "Cone 04 Bisque", start: ago(now, 4, 18), elapsedMin: 571, peak: 1945, scale: "F", outcome: "Complete" },
    { kiln: "Big L&L", program: "Cone 04 Bisque", start: ago(now, 6, 7), elapsedMin: 98, peak: 640, scale: "F", outcome: "Stopped" },
    { kiln: "Big L&L", program: "Slow Bisque w/ Preheat", start: ago(now, 7, 20), elapsedMin: 754, peak: 1945, scale: "F", outcome: "Complete" },
    { kiln: "Little Skutt", program: "Cone 5 Glaze", start: ago(now, 12, 9), elapsedMin: 640, peak: 2167, scale: "F", outcome: "Complete" },
  ];
}

export const DEMOS = {
  firing: (now) => ({
    kiln: summarize({ name: "Big L&L", numZones: 3 }, {
      mode: "Firing", programName: "Cone 6 Glaze", segment: "Ramp 3 of 4",
      t1: 1838, t2: 1846, t3: 1851, setPoint: 2232, firingTime: "7:42", holdRemainingTime: "0:00",
      numZones: 3, updatedAt: new Date(now - 4 * 60000).toISOString(),
    }, now),
    kilnCount: 2,
    firings: demoFirings(now),
    weather: demoWeather(now, [5, 60, 35, 10, 0, 0, 15]),
  }),
  cooling: (now) => ({
    kiln: summarize({ name: "Big L&L" }, {
      mode: "Complete", programName: "Cone 6 Glaze", t1: 9999, t2: 612, t3: 9999,
      firingTime: "11:02", updatedAt: new Date(now - 3 * 60000).toISOString(),
    }, now),
    kilnCount: 2,
    firings: demoFirings(now),
    weather: demoWeather(now, [0, 5, 10, 0, 0, 0, 0]),
  }),
  idle: (now) => ({
    kiln: summarize({ name: "Big L&L" }, { mode: "Idle", t2: 71, updatedAt: new Date(now - 60000).toISOString() }, now),
    kilnCount: 1,
    firings: demoFirings(now).filter((f) => f.kiln === "Big L&L"),
    weather: demoWeather(now, [80, 90, 70, 65, 40, 20, 30]),
  }),
  "first-run": (now) => ({
    kiln: summarize({ name: "Big L&L" }, { mode: "Idle", t2: 68, updatedAt: new Date(now - 60000).toISOString() }, now),
    kilnCount: 1,
    firings: [],
    weather: demoWeather(now, [0, 0, 0, 20, 0, 0, 0]),
  }),
  errors: () => ({
    kiln: null,
    firings: [],
    kilnError: "KilnAid rejected the email or password",
    weather: null,
    weatherError: "Open-Meteo didn't answer in time",
  }),
};
