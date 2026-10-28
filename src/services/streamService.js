// Real-time market stream for the signal engine.
// Transport: browser-native WebSocket to Binance public combined stream
// (kline_1m + kline_1h). No REST polling on the signal path: one REST call
// bootstraps history, then every update arrives as a push event.
// Analysis is event-driven — subscribers are notified only when a minute
// candle actually closes (k.x === true), i.e. at the 00-second boundary.

import { requestCandles } from "./bridge.js";

const WS_URL = "wss://stream.binance.com:9443/stream?streams=eurusdt@kline_1m/eurusdt@kline_1h";
const BUFFER_SIZE = 160; // keep >100 closed M1 candles for the analysis package
const RECONNECT_MAX_MS = 15_000;

let socket = null;
let reconnectDelay = 1_000;
let reconnectTimer = null;
let manuallyStopped = false;

const closedM1 = [];      // rolling buffer of closed M1 candles
let lastH1 = null;        // latest closed H1 candle (trend context)
let formingM1 = null;     // current incomplete M1 candle

const listeners = { tick: new Set(), close: new Set(), status: new Set() };

function emit(kind, payload) {
  listeners[kind].forEach(fn => { try { fn(payload); } catch { /* listener error */ } });
}

function toCandle(k) {
  return {
    time: Math.floor(k.t / 1000),
    open: Number(k.o), high: Number(k.h), low: Number(k.l),
    close: Number(k.c), volume: Number(k.v)
  };
}

function pushClosed(candle) {
  const last = closedM1.at(-1);
  if (last && last.time === candle.time) closedM1[closedM1.length - 1] = candle;
  else closedM1.push(candle);
  if (closedM1.length > BUFFER_SIZE) closedM1.splice(0, closedM1.length - BUFFER_SIZE);
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const k = msg?.data?.k;
  if (!k) return;
  const candle = toCandle(k);
  const isM1 = msg.stream.endsWith("@kline_1m");

  if (isM1) {
    formingM1 = candle;
    emit("tick", { price: candle.close, time: candle.time });
    if (k.x === true) {           // candle closed on the exchange clock
      pushClosed(candle);
      formingM1 = null;
      emit("close", { candles: getBuffer(), closed: candle });
    }
  } else if (k.x === true) {
    lastH1 = candle;
  }
}

function connect() {
  if (typeof WebSocket === "undefined") {
    emit("status", { state: "offline", detail: "WebSocket недоступен" });
    return;
  }
  emit("status", { state: "connecting" });
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    reconnectDelay = 1_000;
    emit("status", { state: "live", detail: "Binance kline stream" });
  };
  socket.onmessage = event => handleMessage(event.data);
  socket.onclose = scheduleReconnect;
  socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
}

function scheduleReconnect() {
  if (manuallyStopped) return;
  emit("status", { state: "reconnecting", retryInMs: reconnectDelay });
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

// One-time history bootstrap (not polling): fills the M1 buffer and the H1
// trend context, then the WebSocket keeps both in sync via push events.
async function bootstrap() {
  try {
    const m1 = await requestCandles("1m", 120);
    closedM1.length = 0;
    closedM1.push(...m1.slice(0, -1)); // drop the still-forming candle
  } catch { /* stream will fill the buffer over time */ }
  try {
    const h1 = await requestCandles("1h", 30);
    lastH1 = h1.at(-2) || h1.at(-1) || null;
  } catch { /* trend stays unknown until first H1 close */ }
}

export function startStream() {
  manuallyStopped = false;
  connect();
  bootstrap();
  return stopStream;
}

export function stopStream() {
  manuallyStopped = true;
  clearTimeout(reconnectTimer);
  try { socket?.close(); } catch { /* noop */ }
  socket = null;
}

export function getBuffer() {
  return closedM1.slice(-120);
}

// Analysis package per spec: last 100 closed M1 candles + current H1 trend.
export function buildAnalysisPackage() {
  return {
    symbol: "EURUSDT",
    candles: closedM1.slice(-100),
    trendH1: lastH1 ? {
      time: lastH1.time,
      close: lastH1.close,
      direction: lastH1.close >= lastH1.open ? "UP" : "DOWN"
    } : null,
    price: formingM1?.close ?? closedM1.at(-1)?.close ?? null,
    sentAt: Date.now()
  };
}

export function onStreamEvent(kind, handler) {
  if (!listeners[kind]) return () => {};
  listeners[kind].add(handler);
  return () => listeners[kind].delete(handler);
}
