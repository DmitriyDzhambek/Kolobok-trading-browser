import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AudioLines, BarChart3, Bell, CalendarDays, CircleHelp,
  Clock3, Globe, LineChart, Mic, Minus, Plus, Search, Settings, ShieldCheck,
  Smile, SquareArrowOutUpRight, TrendingDown, TrendingUp, Volume2, Waves, X
} from "lucide-react";
import TradingViewChart from "./components/TradingViewChart.jsx";
import SystemStatusPanel from "./components/SystemStatusPanel.jsx";
import { fetchMoexCalendar, getQuote, getCandles } from "./services/marketData.js";
import { getSignal, rsi } from "./services/signalEngine.js";
import { speakSignal, stopSpeech } from "./services/speechService.js";
import { getNews } from "./services/newsService.js";
import { getKolobokBackendStatus } from "./services/kolobokBackend.js";
import {
  playTradeSignal, playTestTone, unlockAudio,
  getSoundSettings, setSoundEnabled, setSoundVolume
} from "./services/soundService.js";

const intervals = ["1m", "5m", "15m", "1h", "4h", "1d"];

const navItems = [
  { label: "Браузер", icon: Globe },
  { label: "Торговля", icon: BarChart3 },
  { label: "Аналитика", icon: LineChart },
  { label: "Календарь", icon: CalendarDays },
  { label: "ИИ Колобок", icon: Smile },
  { label: "Настройки", icon: Settings }
];

export default function App() {
  const [activeNav, setActiveNav] = useState("Браузер");
  const [address, setAddress] = useState("https://www.tradingview.com/chart/");
  const [signal, setSignal] = useState({ side: "NONE", reason: "Нажмите «Проверить сигнал», чтобы запустить анализ по живым котировкам." });
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [sound, setSound] = useState(() => getSoundSettings());
  const [moex, setMoex] = useState({ ok: false, note: "Проверяем доступность источника…" });
  const [assistantText, setAssistantText] = useState("Я Колобок. Готов спокойно наблюдать за рынком.");
  const [listening, setListening] = useState(false);
  const [tabs, setTabs] = useState([{ id: 1, title: "EUR/USDT | TradingView" }, { id: 2, title: "MOEX | Торговый календарь" }]);
  const [activeTab, setActiveTab] = useState(1);
  const [nextTab, setNextTab] = useState(3);
  const [now, setNow] = useState(new Date());
  const [marketCandles, setMarketCandles] = useState([]);
  const [marketLive, setMarketLive] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [showSettings, setShowSettings] = useState(false);
  const [autoSignals, setAutoSignals] = useState(false);
  const [searchHistory, setSearchHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [lastAutoSignalKey, setLastAutoSignalKey] = useState("");
  const [news, setNews] = useState([]);
  const [backendStatus, setBackendStatus] = useState(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [awayReport, setAwayReport] = useState("");
  const webviewRef = useRef(null);
  const [webviewLoading, setWebviewLoading] = useState(false);
  const [webviewCanGoBack, setWebviewCanGoBack] = useState(false);
  const [webviewCanGoForward, setWebviewCanGoForward] = useState(false);

  useEffect(() => {
    fetchMoexCalendar().then(setMoex).catch(() => setMoex({ ok: false, note: "Источник MOEX недоступен." }));
    getNews().then(data => { if (data?.ok) setNews(data.items); }).catch(() => setNews([]));
    const timer = setInterval(() => setNow(new Date()), 1000);
    async function refreshQuote() {
      try {
        const liveQuote = await getQuote();
        setQuote(liveQuote);
        setQuoteError("");
      } catch {
        setQuoteError("Котировки недоступны");
      }
    }
    refreshQuote();
    const quoteTimer = setInterval(refreshQuote, 30_000);
    return () => { clearInterval(timer); clearInterval(quoteTimer); };
  }, []);

  useEffect(() => {
    let alive = true;
    let controller;
    async function pollBackend() {
      controller?.abort();
      controller = new AbortController();
      try {
        const status = await getKolobokBackendStatus(controller.signal);
        if (!alive) return;
        setBackendStatus(status);
        setBackendConnected(true);
        if (status.report_while_away) setAwayReport(status.report_while_away);
        if (status.speech_bubble) setAssistantText(status.speech_bubble);
        const backendSignal = status.signal;
        if (backendSignal?.status === "BUY" || backendSignal?.status === "SELL") {
          setSignal({ side: backendSignal.status, reason: backendSignal.reason || "Сигнал фонового анализа" });
        } else if (backendSignal?.status === "WAIT") {
          setSignal(current => current.side === "NONE" ? current : { side: "NONE", reason: "Фоновый анализ ждёт подтверждения." });
        }
      } catch (error) {
        if (error?.name !== "AbortError" && alive) setBackendConnected(false);
      }
    }
    pollBackend();
    const timer = setInterval(pollBackend, 5000);
    return () => { alive = false; clearInterval(timer); controller?.abort(); };
  }, []);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadCandles() {
      try {
        const { candles, live } = await getCandles(timeframe, 180);
        if (!alive) return;
        setMarketCandles(candles);
        setMarketLive(live);
      } catch {
        if (alive) setMarketLive(false);
      }
    }
    loadCandles();
    const timer = setInterval(loadCandles, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [timeframe]);

  const clock = useMemo(() => new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit"
  }).format(now), [now]);

  function runSignal() {
    const result = getSignal(marketCandles.map(c => c.close));
    setSignal(result);
    if (result.side === "NONE") {
      setAssistantText("Пока нет подтверждённого условия. Терпение тоже приносит прибыль.");
      return;
    }
    const sideRu = result.side === "BUY" ? "ПОКУПКА" : "ПРОДАЖА";
    setAssistantText(`Обнаружено условие: ${sideRu}. ${marketLive ? "Проверьте котировки и риски перед решением." : "Источник данных недоступен — сигнал остаётся демонстрационным."}`);
    if (sound.enabled) playTradeSignal(result.side);
    if (voiceEnabled) speakSignal({ side: result.side, demo: !marketLive });
  }

  function addTab() {
    const id = nextTab;
    setNextTab(id + 1);
    setTabs(prev => [...prev, { id, title: "Новая вкладка" }]);
    setActiveTab(id);
    setActiveNav("Браузер");
    setAddress("");
  }

  function closeTab(id, event) {
    event.stopPropagation();
    if (tabs.length === 1) return;
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTab === id) {
      setActiveTab(remaining[0].id);
      setActiveNav(remaining[0].title.includes("MOEX") ? "Календарь" : "Браузер");
    }
  }

  function navigate(event) {
    event.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : raw.includes(".") && !raw.includes(" ")
        ? `https://${raw}`
        : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    setAddress(url);
    setSearchHistory(prev => [...prev.slice(0, historyIndex + 1), url]);
    setHistoryIndex(prev => prev + 1);
    setActiveNav("Браузер");
    if (webviewRef.current) {
      setWebviewLoading(true);
      webviewRef.current.loadURL(url);
    }
  }

  function webviewGoBack() {
    if (webviewRef.current?.canGoBack()) webviewRef.current.goBack();
  }

  function webviewGoForward() {
    if (webviewRef.current?.canGoForward()) webviewRef.current.goForward();
  }

  function webviewReload() {
    webviewRef.current?.reload();
  }

  function onWebviewNavigate(e) {
    if (e.url) setAddress(e.url);
  }

  function onWebviewState(e) {
    if (e.url) setAddress(e.url);
    if (e.canGoBack !== undefined) setWebviewCanGoBack(e.canGoBack);
    if (e.canGoForward !== undefined) setWebviewCanGoForward(e.canGoForward);
  }

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const handleNavigate = (e) => onWebviewNavigate(e);
    const handleState = (e) => onWebviewState(e);
    const handleStart = () => setWebviewLoading(true);
    const handleStop = () => setWebviewLoading(false);
    wv.addEventListener("did-navigate", handleNavigate);
    wv.addEventListener("did-navigate-in-page", handleState);
    wv.addEventListener("did-start-loading", handleStart);
    wv.addEventListener("did-stop-loading", handleStop);
    return () => {
      wv.removeEventListener("did-navigate", handleNavigate);
      wv.removeEventListener("did-navigate-in-page", handleState);
      wv.removeEventListener("did-start-loading", handleStart);
      wv.removeEventListener("did-stop-loading", handleStop);
    };
  });

  function openNav(label) {
    setActiveNav(label);
    if (label === "Настройки") setShowSettings(true);
  }

  useEffect(() => {
    if (!autoSignals || marketCandles.length < 22) return;
    const candleKey = `${timeframe}:${marketCandles.at(-1)?.time}`;
    if (!candleKey || candleKey === lastAutoSignalKey) return;
    setLastAutoSignalKey(candleKey);
    const result = getSignal(marketCandles.map(c => c.close));
    if (result.side !== "NONE") {
      setSignal(result);
      const sideRu = result.side === "BUY" ? "ПОКУПКА" : "ПРОДАЖА";
      setAssistantText(`Автоматическая проверка: ${sideRu}. ${marketLive ? "Проверьте график и риски." : "Источник недоступен — анализ остаётся демонстрационным."}`);
      if (sound.enabled) playTradeSignal(result.side);
      if (voiceEnabled) speakSignal({ side: result.side, demo: !marketLive });
    }
  }, [autoSignals, marketCandles, timeframe, lastAutoSignalKey, marketLive, voiceEnabled, sound.enabled]);

  function toggleListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setAssistantText("Распознавание речи недоступно в этой сборке. Синтез уведомлений может работать отдельно.");
      return;
    }
    if (listening) {
      setListening(false);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.onresult = e => {
      const phrase = e.results?.[0]?.[0]?.transcript || "";
      setAssistantText(`Я услышал: «${phrase}». Пока поддерживается демонстрационный режим команд.`);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    try { recognition.start(); setListening(true); }
    catch { setListening(false); setAssistantText("Не удалось запустить микрофон. Проверьте разрешение."); }
  }

  return (
    <div className="app-shell">
      <div className="starfield" />
      <header className="browser-chrome">
        <div className="brand">
          <div className="brand-coin">☺</div>
          <div><strong>Колобок</strong><small>Твой ИИ-ассистент в мире трейдинга</small></div>
        </div>
        <div className="tabs">
          {tabs.map(tab => <button key={tab.id} className={`tab ${activeTab === tab.id ? "active" : ""}`} onClick={() => { setActiveTab(tab.id); setActiveNav(tab.title.includes("MOEX") ? "Календарь" : "Браузер"); }}>
            <span className="tab-glyph">◈</span>{tab.title}
            {tabs.length > 1 && <X size={13} onClick={e => closeTab(tab.id, e)} />}
          </button>)}
          <button className="icon-button add-tab" onClick={addTab} title="Новая вкладка"><Plus size={17} /></button>
        </div>
        <div className="window-controls">
          <button type="button" className="window-control" title="Свернуть" onClick={() => window.kolobok?.minimizeWindow()}><Minus size={14}/></button>
          <button type="button" className="window-control" title="Развернуть / восстановить" onClick={() => window.kolobok?.toggleMaximizeWindow()}>□</button>
          <button type="button" className="window-control" title="Закрыть приложение" onClick={() => window.kolobok?.closeWindow()}><X size={16}/></button>
        </div>
      </header>

      <form className="address-row" onSubmit={navigate}>
        <button type="button" className="bare-icon" title="Назад" onClick={webviewGoBack} disabled={!webviewCanGoBack}><span>←</span></button>
        <button type="button" className="bare-icon" title="Вперёд" onClick={webviewGoForward} disabled={!webviewCanGoForward}><span>→</span></button>
        <button type="button" className="bare-icon" title="Обновить" onClick={webviewReload}><Activity size={17}/></button>
        <div className="address-input"><ShieldCheck size={15}/><input value={address} onChange={e => setAddress(e.target.value)} aria-label="Адрес сайта" placeholder="Введите адрес" /></div>
        <button className="bare-icon" type="button" title="Открыть адрес / поиск" onClick={() => { const form = document.querySelector(".address-row"); form?.requestSubmit(); }}><Search size={17}/></button>
        <button className="bare-icon" type="button" title="Микрофон" onClick={toggleListening}><Mic size={17}/></button>
        <button className="bare-icon" type="button" title="Настройки" onClick={() => openNav("Настройки")}><Settings size={17}/></button>
      </form>

      <div className="workspace">
        <aside className="sidebar">
          <nav>{navItems.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${activeNav === label ? "selected" : ""}`} onClick={() => openNav(label)}><Icon size={20}/><span>{label}</span></button>)}</nav>
          <div className="sidebar-art"><div className="kanji">取<br/>引</div><div className="mountain">富士</div><p>«Терпение тоже приносит прибыль»</p></div>
          <div className="sidebar-bottom"><span className="status-dot"/><span>Защищённый режим</span></div>
        </aside>

        {activeNav === "Браузер" && address && address !== "https://www.tradingview.com/chart/" && (
          <div className="webview-container">
            <webview ref={webviewRef} src="" className="embedded-webview" allowpopups="true" />
            {webviewLoading && <div className="webview-loading"><div className="loading-bar" /></div>}
          </div>
        )}

        <main className={`main-content ${activeNav === "Браузер" && address && address !== "https://www.tradingview.com/chart/" ? "hidden" : ""}`}>
          <section className="chart-panel panel">
            <div className="chart-toolbar">
              <div className="instrument"><Search size={19}/><strong>EUR/USD</strong><span className="separator"/><span className="muted">OANDA · реальные котировки TradingView</span></div>
              <div className="chart-tools"><button className="tv-label" onClick={() => { setAddress("https://www.tradingview.com/chart/"); window.open("https://www.tradingview.com/chart/", "_blank"); }}>TradingView</button></div>
            </div>
            <TradingViewChart />
          </section>

          <section className="assistant-area">
            <div className="assistant-copy">
              <div className="eyebrow">ВАШ СПОКОЙНЫЙ ПОМОЩНИК</div>
              <div className="speech-bubble">{backendStatus?.speech_bubble || assistantText}</div>
              <div className={`backend-presence ${backendConnected ? "online" : "offline"}`}><i />{backendConnected ? `Фоновый Колобок · ${backendStatus?.source_status === "connected" ? "подключён" : "проверка"}` : "Колобок off-line"}</div>
              {awayReport && <div className="away-report"><strong>Пока тебя не было</strong><span>{awayReport}</span><button onClick={() => setAwayReport("")} aria-label="Скрыть">×</button></div>}
              <div className="assistant-actions">
                <button className="gold-button" onClick={runSignal}><Activity size={15}/> Проверить сигнал</button>
                <button className={`round-button ${listening ? "listening" : ""}`} onClick={toggleListening} title="Голосовая команда"><Mic size={17}/></button>
                <button className="round-button" onClick={() => { stopSpeech(); setAssistantText("Голосовые уведомления остановлены."); }} title="Остановить голос"><Volume2 size={17}/></button>
              </div>
            </div>
            <div className="kolobok-wrap"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="kolobok-face"><span className="eye left"/><span className="eye right"/><span className="cheek left"/><span className="cheek right"/><span className="smile"/></div></div>
            <div className={`signal-card ${signal.side === "SELL" ? "sell" : ""}`}>
              <div className="waveform">{Array.from({length: 25}, (_, i) => <i key={i} style={{height: `${8 + Math.abs(Math.sin(i * 0.8)) * (i % 4 === 0 ? 30 : 17)}px`}} />)}</div>
              <div className="signal-result">{signal.side === "BUY" ? <TrendingUp size={24}/> : signal.side === "SELL" ? <TrendingDown size={24}/> : <Waves size={24}/>}<div><strong>{signal.side === "BUY" ? "BUY" : signal.side === "SELL" ? "SELL" : "WAIT"}</strong><small>{signal.reason || "Проверка сигнала"}</small></div></div>
              <button className={`voice-toggle ${voiceEnabled ? "enabled" : ""}`} onClick={() => setVoiceEnabled(v => !v)} title="Голосовые оповещения"><Mic size={19}/></button>
            </div>
          </section>
        </main>

        <aside className="right-column">
          <SystemStatusPanel />

          <section className="quote-card panel">
            <div className="card-heading"><div className="coin-icon">€</div><div><strong>EUR/USDT</strong><small>{quote ? "Публичные котировки Binance" : "Ожидание котировок"}</small></div><span className="badge-demo">DEMO</span></div>
            <div className="price">{quote ? quote.price.toFixed(5) : "—"} <span>{quote ? `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` : quoteError || "загрузка"}</span></div>
            <div className="quote-stats"><div><small>High 24ч</small><b>{quote ? quote.high.toFixed(5) : "—"}</b></div><div><small>Low 24ч</small><b>{quote ? quote.low.toFixed(5) : "—"}</b></div><div><small>Vol</small><b>{quote ? quote.volume.toFixed(0) : "—"}</b></div></div>
          </section>

          <section className="moex-card panel">
            <div className="section-heading"><div className="moex-logo">MOEX</div><div><strong>Московская Биржа</strong><small>Проверка доступности расписания</small></div></div>
            <div className="session-row"><div><strong>Валютный рынок</strong><small>Время по Москве · {clock}</small></div><span className="session-state"><i className="status-dot"/> {moex.ok ? "Открыто" : "Пауза"}</span></div>
            <div className="session-row"><div><strong>Срочный рынок</strong><small>Точное расписание не загружено</small></div><span className="session-state"><i className="status-dot gray"/> Демо</span></div>
            <p className="moex-note">{moex.note}</p>
            <a className="external-link" href="https://www.moex.com/ru/tradingcalendar" target="_blank" rel="noreferrer">Открыть календарь MOEX <SquareArrowOutUpRight size={13}/></a>
          </section>

          <section className="activity-card panel">
            <div className="section-title"><span>Последние события</span><Bell size={15}/></div>
            <div className="activity-row"><span className="activity-icon"><Activity size={15}/></span><div><strong>Аналитика</strong><small>{signal.reason}</small></div></div>
            <div className="activity-row"><span className="activity-icon"><AudioLines size={15}/></span><div><strong>Голосовой ассистент</strong><small>{voiceEnabled ? "Оповещения активны" : "Оповещения отключены"}</small></div></div>
            <div className="activity-row"><span className="activity-icon"><Clock3 size={15}/></span><div><strong>Сессии MOEX</strong><small>Статус будет показан после проверки в реальном времени.</small></div></div>
          </section>

          {news.length > 0 && (
            <section className="news-card panel">
              <div className="section-title"><span>Последние новости</span><Bell size={15}/></div>
              <div className="news-list">
                {news.slice(0, 5).map((item, i) => (
                  <div key={i} className="news-row">
                    <span className="news-icon">{item.icon}</span>
                    <div className="news-body">
                      <strong>{item.title}</strong>
                      <small>{item.time}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="hint-card">
            <CircleHelp size={16}/><p>Сигналы носят информационный характер и не являются финансовой рекомендацией.</p>
          </section>
        </aside>
      </div>

      {activeNav !== "Браузер" && activeNav !== "Настройки" && (
        <div className="page-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setActiveNav("Браузер"); }}>
          <section className="page-dialog">
            <div className="page-dialog-head"><h2>{activeNav}</h2><button className="round-button" onClick={() => setActiveNav("Браузер")} aria-label="Закрыть"><X size={17}/></button></div>
            {activeNav === "Торговля" && <><p>Рыночный обзор EUR/USDT. Здесь отображаются данные из подключённого источника; при отсутствии связи система сохраняет текущее состояние, а не падает.</p></>}
            {activeNav === "Аналитика" && <><p>{signal.reason}. EMA 9/21 и RSI 14 используются как базовые фильтры для демонстрационного анализа.</p></>}
            {activeNav === "Календарь" && <><p>Часы по Москве: {clock}. Доступность MOEX API никак не отменяет демонстрационный режим при отсутствии данных.</p></>}
            {activeNav === "ИИ Колобок" && <><p>{assistantText}</p><div className="page-grid"><div className="page-tile"><strong>Голосовые оповещения</strong><span>{voiceEnabled ? "Включены" : "Выключены"}</span></div><div className="page-tile"><strong>Звук</strong><span>{sound.enabled ? "Включён" : "Выключен"}</span></div></div></>}
          </section>
        </div>
      )}

      {showSettings && (
        <div className="page-overlay" onMouseDown={e => { if (e.target === e.currentTarget) { setShowSettings(false); setActiveNav("Браузер"); } }}>
          <section className="page-dialog">
            <div className="page-dialog-head"><h2>Настройки «Колобка»</h2><button className="round-button" onClick={() => { setShowSettings(false); setActiveNav("Браузер"); }} aria-label="Закрыть"><X size={17}/></button></div>
            <div className="setting-row"><span><strong>Голосовые уведомления</strong><br/><small className="muted">Русский синтез речи Web Speech API</small></span><input type="checkbox" checked={voiceEnabled} onChange={() => setVoiceEnabled(v => !v)} /></div>
            <div className="setting-row"><span><strong>Звук о входе в сделку</strong><br/><small className="muted">Мелодичный колокольчик Web Audio при сигнале</small></span><input type="checkbox" checked={sound.enabled} onChange={() => setSound(setSoundEnabled(!sound.enabled))} /></div>
            <div className="setting-row slider-row"><span><strong>Громкость сигнала</strong><br/><small className="muted">{sound.supported ? `${Math.round(sound.volume * 100)}%` : "Не поддерживается"}</small></span><div className="volume-control"><input type="range" min="0" max="1" step="0.05" value={sound.volume} disabled={!sound.supported} onChange={e => setSound(setSoundVolume(e.target.value))} /><button className="dialog-button" disabled={!sound.supported} onClick={() => { unlockAudio(); playTestTone(); }}>Тест</button></div></div>
            <div className="setting-row"><span><strong>Автоматически проверять сигналы</strong><br/><small className="muted">При обновлении набора свечей</small></span><input type="checkbox" checked={autoSignals} onChange={() => setAutoSignals(v => !v)} /></div>
            <div className="setting-row"><span><strong>Таймфрейм графика</strong><br/><small className="muted">Меняет период запрашиваемых свечей</small></span><select value={timeframe} onChange={e => setTimeframe(e.target.value)}>{intervals.map(v => <option key={v} value={v}>{v}</option>)}</select></div>
            <p>Приложение не совершает сделки. При недоступности API оно явно помечает демонстрационные данные и продолжает работать в безопасном режиме.</p>
            <div className="dialog-actions"><button className="dialog-button" onClick={() => { setShowSettings(false); setActiveNav("Браузер"); }}>Готово</button><button className="dialog-button secondary" onClick={() => { setShowSettings(false); setActiveNav("Браузер"); }}>Закрыть</button></div>
          </section>
        </div>
      )}
      <footer className="statusbar"><span>Колобок <b>v1.0.0</b></span><span><span className="status-dot"/> {marketLive ? "График TradingView · сигналы по живым котировкам" : "График TradingView · демонстрационный режим"}</span></footer>
    </div>
  );
}
