import { useEffect, useRef } from "react";

// Official TradingView Advanced Chart widget via the tv.js script.
// Compared to the raw widgetembed iframe, tv.js guarantees correct real-time
// data (TradingView's own WebSocket feed) and honors the timezone param,
// which fixes the X-axis time drift.
const TV_SCRIPT_URL = "https://s3.tradingview.com/tv.js";
const CONTAINER_ID = "tv_chart_container";

function loadTradingViewScript() {
  return new Promise((resolve, reject) => {
    if (window.TradingView?.widget) return resolve(window.TradingView);
    const existing = document.querySelector(`script[src^="${TV_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.TradingView));
      existing.addEventListener("error", () => reject(new Error("tv.js failed to load")));
      return;
    }
    const script = document.createElement("script");
    script.src = TV_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.TradingView);
    script.onerror = () => reject(new Error("tv.js failed to load"));
    document.head.appendChild(script);
  });
}

export default function TradingViewChart() {
  const hostRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let widget = null;

    loadTradingViewScript().then(TradingView => {
      if (disposed || !hostRef.current || !TradingView?.widget) return;
      // Guard against StrictMode/HMR double-mount: container must be empty.
      hostRef.current.innerHTML = "";
      widget = new TradingView.widget({
        container_id: CONTAINER_ID,
        autosize: true,               // fills 100% width/height of the container
        symbol: "OANDA:EURUSD",       // real-time forex feed from TradingView
        interval: "1",                // 1 minute
        timezone: "Europe/Moscow",    // fixes X-axis time drift
        theme: "light",               // classic light TradingView look
        style: "1",                   // Japanese candles
        locale: "ru",
        enable_publishing: false,
        allow_symbol_change: true,
        save_image: false,
        withdateranges: true,
        hide_side_toolbar: false,
        details: false,
        hotlist: false,
        calendar: false
      });
    }).catch(() => {
      // Offline / blocked script: leave the container empty, the app itself
      // keeps working (signals use their own WebSocket stream).
    });

    return () => {
      disposed = true;
      try { widget?.remove?.(); } catch { /* widget may still be initializing */ }
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, []);

  return (
    <div className="tv-chart-container">
      <div id={CONTAINER_ID} ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
