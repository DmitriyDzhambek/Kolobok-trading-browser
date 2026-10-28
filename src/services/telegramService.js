// Thin wrapper over the Telegram Mini Apps SDK (window.Telegram.WebApp).
// Every method is safe to call outside Telegram: in Electron or a plain browser
// the service degrades to no-ops and reports isTelegram = false.

const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;

export const isTelegram = Boolean(tg?.initData || tg?.platform === "web");

// Telegram paints its own header/webview background, so we mirror its colors
// into our CSS variables to avoid a white flash on open.
function applyTheme() {
  if (!tg) return;
  const root = document.documentElement;
  const params = tg.themeParams || {};
  if (params.bg_color) root.style.setProperty("--bg", normalizeColor(params.bg_color));
  if (params.text_color) root.style.setProperty("--beige", normalizeColor(params.text_color));
  if (params.hint_text_color) root.style.setProperty("--muted", normalizeColor(params.hint_text_color));
  if (params.link_color) root.style.setProperty("--green", normalizeColor(params.link_color));
}

function normalizeColor(value) {
  return String(value).startsWith("#") ? value : `#${value}`;
}

export function initTelegram() {
  if (!tg) {
    return { isTelegram: false, platform: "electron-or-browser" };
  }
  try {
    tg.ready();
    tg.expand();
    applyTheme();
    tg.setHeaderColor?.("#0f0f1a");
    tg.setBackgroundColor?.("#0f0f1a");
    tg.disableVerticalSwipes?.();
    tg.onEvent?.("themeChanged", applyTheme);
  } catch (error) {
    console.warn("Telegram WebApp init skipped:", error);
  }
  return { isTelegram: true, platform: tg.platform, initUnsafe: tg.initDataUnsafe };
}

export function haptic(style = "light") {
  if (!isTelegram) return;
  try { tg.HapticFeedback?.impactOccurred(style); } catch { /* older clients */ }
}

export function hapticNotification(type = "success") {
  if (!isTelegram) return;
  try { tg.HapticFeedback?.notificationOccurred(type); } catch { /* older clients */ }
}

export function hapticSelection() {
  if (!isTelegram) return;
  try { tg.HapticFeedback?.selectionChanged?.(); } catch { /* older clients */ }
}

export function showPopup(title, message, onOk) {
  if (!isTelegram) return false;
  try {
    tg.showPopup({ title, message }, button => { if (button === "OK") onOk?.(); });
    return true;
  } catch {
    return false;
  }
}

export function showDataSync(key, value) {
  if (!isTelegram) return false;
  try { tg.CloudStorage?.setItem(key, JSON.stringify(value), () => {}); return true; }
  catch { return false; }
}

export function readDataSync(key, cb) {
  if (!isTelegram) return cb(null);
  try {
    tg.CloudStorage?.getItem(key, (err, value) => cb(err ? null : safeParse(value)));
  } catch { cb(null); }
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function backButton(title, onClick) {
  if (!isTelegram) return { show: () => {}, hide: () => {} };
  try {
    tg.BackButton?.setText?.(title);
    tg.BackButton?.onClick?.(onClick);
    return { show: () => tg.BackButton?.show?.(), hide: () => tg.BackButton?.hide?.() };
  } catch {
    return { show: () => {}, hide: () => {} };
  }
}

export function mainButton(title, onClick) {
  if (!isTelegram || !tg.MainButton) {
    return { show: () => {}, hide: () => {}, setText: () => {} };
  }
  const button = tg.MainButton;
  button.setText(title);
  button.onClick(onClick);
  return {
    show: () => button.show?.(),
    hide: () => button.hide?.(),
    setText: text => button.setText?.(text)
  };
}

export function shareUrl(url, text) {
  if (!isTelegram) return false;
  try { tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`); return true; }
  catch { return false; }
}

export function viewportHeight() {
  if (typeof document === "undefined") return 0;
  return isTelegram ? (tg?.viewportHeight || window.innerHeight) : window.innerHeight;
}

export function platformName() {
  return isTelegram ? tg?.platform : "desktop";
}
