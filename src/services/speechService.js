export function speakSignal({ side, symbol = "EUR/USDT", demo = false }) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    return { ok: false, reason: "Браузер не поддерживает синтез речи" };
  }

  window.speechSynthesis.cancel();
  const direction = side === "BUY" ? "потенциальный сигнал на покупку" : "потенциальный сигнал на продажу";
  const suffix = demo ? " Источник котировок недоступен, проверьте данные вручную." : "";
  const utterance = new SpeechSynthesisUtterance(
    `Я от бабушки ушёл, я от дедушки ушёл, а на ${symbol} обнаружен ${direction}. Проверьте график и риски.${suffix}`
  );
  utterance.lang = "ru-RU";
  utterance.rate = 0.92;
  utterance.pitch = 1.05;
  utterance.volume = 0.9;
  window.speechSynthesis.speak(utterance);
  return { ok: true };
}

export function stopSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}