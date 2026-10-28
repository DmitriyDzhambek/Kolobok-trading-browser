export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result = [];
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(current);
  for (let i = period; i < values.length; i++) {
    current = values[i] * multiplier + current * (1 - multiplier);
    result.push(current);
  }
  return result;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function getSignal(closes) {
  if (!Array.isArray(closes) || closes.length < 22) return { side: "NONE", reason: "Недостаточно свечей" };
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const prevFast = fast.at(-2), currFast = fast.at(-1);
  const prevSlow = slow.at(-2), currSlow = slow.at(-1);
  const currentRsi = rsi(closes, 14);

  if (prevFast <= prevSlow && currFast > currSlow && currentRsi >= 40 && currentRsi <= 68) {
    return { side: "BUY", rsi: currentRsi, reason: "EMA 9 пересекла EMA 21 снизу вверх; RSI подтверждает импульс" };
  }
  if (prevFast >= prevSlow && currFast < currSlow && currentRsi >= 32 && currentRsi <= 60) {
    return { side: "SELL", rsi: currentRsi, reason: "EMA 9 пересекла EMA 21 сверху вниз; RSI подтверждает импульс" };
  }
  return { side: "NONE", rsi: currentRsi, reason: "Подтверждённого условия нет" };
}