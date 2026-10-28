// Single transport layer for all remote data.
// In Electron it reuses the existing privileged IPC bridge (window.kolobok).
// In the Telegram Mini App / any browser it calls the Vercel serverless
// functions under /api, which proxy the upstream providers and add CORS headers.

const API_BASE = "/api";

export const isElectronBridge = () =>
  typeof window !== "undefined" && Boolean(window.kolobok);

async function http(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit"
  });
  if (!response.ok) throw new Error(`${endpoint} responded with HTTP ${response.status}`);
  return response.json();
}

export async function requestCandles(interval, limit) {
  if (window.kolobok?.getCandles) return window.kolobok.getCandles(interval, limit);
  const data = await http("market", { type: "klines", interval, limit });
  if (!Array.isArray(data?.candles) || data.candles.length < 22) {
    throw new Error("Not enough candles in response");
  }
  return data.candles;
}

export async function requestQuote() {
  if (window.kolobok?.getQuote) return window.kolobok.getQuote();
  const data = await http("market", { type: "quote" });
  if (!Number.isFinite(data?.price)) throw new Error("Quote payload is invalid");
  return data;
}

export async function requestNews() {
  if (window.kolobok?.getNews) return window.kolobok.getNews();
  return http("news", { type: "list" });
}

export async function requestMoexStatus() {
  if (window.kolobok?.getMoex) return window.kolobok.getMoex();
  return http("news", { type: "moex" });
}
