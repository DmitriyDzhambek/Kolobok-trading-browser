// Market data access for the signal engine.
// The visible chart is the official TradingView widget; these candles are only
// used to compute EMA/RSI signals and always come from a live source.
// When the source is unavailable we return no candles instead of fake data.
import { requestCandles, requestQuote, requestMoexStatus } from "./bridge.js";

export async function getCandles(interval = "1h", limit = 180) {
  const candles = await requestCandles(interval, limit);
  return { candles, source: "Binance public market data", live: true };
}

export async function getQuote() {
  return requestQuote();
}

export async function fetchMoexCalendar() {
  // Connectivity check only — it never claims that a trading session is open.
  try {
    const data = await requestMoexStatus();
    return {
      ok: Boolean(data?.ok),
      note: data?.note || "Расписание не подтверждено: источник недоступен.",
      updatedAt: data?.updatedAt ? new Date(data.updatedAt) : null
    };
  } catch {
    return {
      ok: false,
      note: "Расписание не подтверждено: источник недоступен.",
      updatedAt: null
    };
  }
}

