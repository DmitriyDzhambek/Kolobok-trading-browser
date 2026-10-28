// Sound notifications for trade entries, synthesized with the Web Audio API.
// No audio files are shipped, so it works in the Telegram Mini App, in Electron
// and in a plain browser tab. Mobile WebViews require a user gesture before an
// AudioContext may start, therefore everything is gated behind unlock().
import { hapticNotification } from "./telegramService.js";

const STORAGE_KEY = "kolobok.sound.settings";
const SETTINGS_DEFAULTS = { enabled: true, volume: 0.6 };

let context = null;
let masterGain = null;
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : SETTINGS_DEFAULTS.enabled,
      volume: clamp(Number.isFinite(parsed.volume) ? parsed.volume : SETTINGS_DEFAULTS.volume, 0, 1)
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureContext() {
  if (typeof window === "undefined") return null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!context) {
    context = new AudioCtor();
    masterGain = context.createGain();
    masterGain.gain.value = settings.volume;
    // A soft low-pass keeps the bell warm instead of harsh.
    const warmth = context.createBiquadFilter();
    warmth.type = "lowpass";
    warmth.frequency.value = 4200;
    warmth.Q.value = 0.4;
    masterGain.connect(warmth);
    warmth.connect(context.destination);
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

// Call from a click/tap handler so autoplay policies are satisfied.
export function unlockAudio() {
  ensureContext();
}

export function isAudioSupported() {
  return typeof window !== "undefined" && Boolean(window.AudioContext || window.webkitAudioContext);
}

// One warm bell partial group: fundamental + quiet octave, exponential decay.
function playNote(frequency, startAt, duration, peak) {
  const ctx = ensureContext();
  if (!ctx || !masterGain) return;

  const osc = ctx.createOscillator();
  const sub = ctx.createOscillator();
  const gain = ctx.createGain();
  const subGain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = frequency;
  sub.type = "triangle";
  sub.frequency.value = frequency * 2;
  subGain.gain.value = 0.18;

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  subGain.gain.setValueAtTime(0.0001, startAt);
  subGain.gain.exponentialRampToValueAtTime(peak * 0.18, startAt + 0.03);
  subGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration * 0.7);

  osc.connect(gain);
  sub.connect(subGain);
  gain.connect(masterGain);
  subGain.connect(masterGain);

  osc.start(startAt);
  sub.start(startAt);
  osc.stop(startAt + duration + 0.05);
  sub.stop(startAt + duration + 0.05);
}

// Gentle rising arpeggio for a BUY entry (A major pentatonic feel).
const BUY_SEQUENCE = [
  { freq: 523.25, offset: 0.00, duration: 0.55, peak: 0.30 }, // C5
  { freq: 659.25, offset: 0.11, duration: 0.60, peak: 0.28 }, // E5
  { freq: 783.99, offset: 0.22, duration: 0.75, peak: 0.26 }, // G5
  { freq: 1046.5, offset: 0.34, duration: 1.10, peak: 0.20 }  // C6 tail
];

// Softer, slightly darker descending figure for a SELL entry.
const SELL_SEQUENCE = [
  { freq: 783.99, offset: 0.00, duration: 0.55, peak: 0.26 }, // G5
  { freq: 659.25, offset: 0.11, duration: 0.60, peak: 0.25 }, // E5
  { freq: 523.25, offset: 0.22, duration: 0.85, peak: 0.24 }, // C5
  { freq: 392.00, offset: 0.33, duration: 1.10, peak: 0.18 }  // G4 tail
];

function playSequence(sequence) {
  const ctx = ensureContext();
  if (!ctx || !settings.enabled) return false;
  const start = ctx.currentTime + 0.02;
  sequence.forEach(note => playNote(note.freq, start + note.offset, note.duration, note.peak));
  return true;
}

// Public entry point: side is "BUY" or "SELL".
export function playTradeSignal(side) {
  const played = playSequence(side === "SELL" ? SELL_SEQUENCE : BUY_SEQUENCE);
  hapticNotification(side === "SELL" ? "warning" : "success");
  return played;
}

// Two-note chime used by the "test sound" control in settings.
export function playTestTone() {
  return playSequence([
    { freq: 659.25, offset: 0.00, duration: 0.45, peak: 0.28 },
    { freq: 987.77, offset: 0.14, duration: 0.90, peak: 0.22 }
  ]);
}

export function setSoundEnabled(enabled) {
  settings = { ...settings, enabled: Boolean(enabled) };
  persist();
  if (settings.enabled) unlockAudio();
  return settings;
}

export function setSoundVolume(volume) {
  settings = { ...settings, volume: clamp(Number(volume) || 0, 0, 1) };
  persist();
  if (masterGain && context) {
    masterGain.gain.setTargetAtTime(settings.volume, context.currentTime, 0.05);
  }
  return settings;
}

export function getSoundSettings() {
  return { ...settings, supported: isAudioSupported() };
}
