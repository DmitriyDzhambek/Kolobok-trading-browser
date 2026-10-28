// Vercel serverless function: /api/market?type=klines|quote
// Proxies the fixed Binance public endpoints so the Mini App never talks to the
// exchange directly and never exposes arbitrary URL fetching.

const BINANCE_BASE = "https://api.binance.com/api/v3";
const SYMBOL = "EURUSDT";
const ALLOWED_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

async function klines(query) {
  const interval = ALLOWED_INTERVALS.has(query.interval) ? query.interval : "1h";
  const limit = Math.min(500, Math.max(30, Number.parseInt(query.limit, 10) || 180));
  const url = new URL(`${BINANCE_BASE}/klines`);
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`provider ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length < 22) throw new Error("not enough candles");

  const candles = rows.map(row => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }));
  return { candles, source: "Binance public market data", live: true };
}

async function quote() {
  const url = new URL(`${BINANCE_BASE}/ticker/24hr`);
  url.searchParams.set("symbol", SYMBOL);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`provider ${response.status}`);
  const q = await response.json();
  return {
    symbol: "EUR/USDT",
    price: Number(q.lastPrice),
    changePercent: Number(q.priceChangePercent),
    high: Number(q.highPrice),
    low: Number(q.lowPrice),
    volume: Number(q.volume),
    updatedAt: Date.now()
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  const type = req.query?.type || "quote";
  try {
    const payload = type === "klines" ? await klines(req.query || {}) : await quote();
    send(res, 200, payload);
  } catch (error) {
    send(res, 502, { error: "market_unavailable", detail: String(error?.message || error) });
  }
};
