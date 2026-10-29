// 7-day forecast from Open-Meteo (free, no API key, non-commercial use).
import { httpJson } from "./kilnaid.mjs";

export async function fetchWeather({ latitude, longitude, units = "fahrenheit" }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    temperature_unit: units,
    precipitation_unit: units === "fahrenheit" ? "inch" : "mm",
    timezone: "auto",
    forecast_days: "7",
  });
  const data = await httpJson("GET", `https://api.open-meteo.com/v1/forecast?${params}`);
  return parseWeather(data, units);
}

export function parseWeather(data, units = "fahrenheit") {
  const d = data?.daily;
  if (!d || !Array.isArray(d.time)) throw new Error("Open-Meteo returned no daily forecast");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const days = d.time.slice(0, 7).map((date, i) => ({
    date, // YYYY-MM-DD in the location's own time zone
    code: num(d.weather_code?.[i]),
    high: num(d.temperature_2m_max?.[i]),
    low: num(d.temperature_2m_min?.[i]),
    precipChance: num(d.precipitation_probability_max?.[i]),
    precipAmount: num(d.precipitation_sum?.[i]),
  }));
  return {
    unit: units === "fahrenheit" ? "F" : "C",
    timezone: data.timezone,
    current: data.current
      ? { temp: num(data.current.temperature_2m), code: num(data.current.weather_code), isDay: data.current.is_day !== 0 }
      : null,
    days,
  };
}

/** WMO weather code -> icon name + short label. */
export function describe(code) {
  if (code === null || code === undefined) return { icon: "unknown", label: "—" };
  if (code === 0) return { icon: "sun", label: "Clear" };
  if (code === 1) return { icon: "sun", label: "Mostly clear" };
  if (code === 2) return { icon: "partly", label: "Partly cloudy" };
  if (code === 3) return { icon: "cloud", label: "Overcast" };
  if (code === 45 || code === 48) return { icon: "fog", label: "Fog" };
  if (code >= 51 && code <= 57) return { icon: "drizzle", label: "Drizzle" };
  if (code >= 61 && code <= 67) return { icon: "rain", label: code >= 65 ? "Heavy rain" : "Rain" };
  if (code >= 71 && code <= 77) return { icon: "snow", label: "Snow" };
  if (code >= 80 && code <= 82) return { icon: "rain", label: "Showers" };
  if (code === 85 || code === 86) return { icon: "snow", label: "Snow showers" };
  if (code >= 95) return { icon: "storm", label: "Thunderstorm" };
  return { icon: "cloud", label: "Cloudy" };
}
