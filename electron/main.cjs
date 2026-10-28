const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0f0f1a",
    title: "Колобок",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5500";
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    // External pages are opened in the system browser, never with local app privileges.
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const ownOrigin = devUrl || "file://";
    if (!url.startsWith(ownOrigin)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("window:minimize", event => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:toggle-maximize", event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("news:list", async () => {
    const sources = [
      {
        title: "Рынок ждёт решения ФРС по ставке",
        summary: "Инвесторы оценивают риски изменения процентной политики США",
        icon: "📰",
        time: "Сегодня, 14:32"
      },
      {
        title: "Нефть Brent торгуется выше $82",
        summary: "Геополитическая напряжённость поддерживает цены на сырьё",
        icon: "🛢️",
        time: "Сегодня, 12:15"
      },
      {
        title: "EUR/USDT: рост на фоне ослабления доллара",
        summary: "Европейская валюта набирает силу на фоне слабых данных по ВВП США",
        icon: "💱",
        time: "Сегодня, 10:45"
      },
      {
        title: "Bitcoin пробил $68 000 на фоне оптимизма рынка",
        summary: "Криптовалюты растут на фоне ожиданий одобрения ETF",
        icon: "₿",
        time: "Сегодня, 09:20"
      },
      {
        title: "ЦБ РФ сохранил ставку на уровне 16%",
        summary: "Регулятор сохранил ключевую ставку, ожидая снижения инфляции",
        icon: "🏦",
        time: "Вчера, 18:00"
      },
      {
        title: "Акции NVIDIA растут после отчёта",
        summary: "Технологические акции лидируют на фоне сильного квартала",
        icon: "📈",
        time: "Вчера, 16:30"
      }
    ];
    return { ok: true, items: sources };
  });

  ipcMain.handle("window:close", event => BrowserWindow.fromWebContents(event.sender)?.close());

  // Fixed-origin, fixed-symbol market-data bridge. The renderer cannot request arbitrary URLs.
  ipcMain.handle("market:klines", async (_event, interval = "1h", limit = 120) => {
    const allowedIntervals = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
    const safeInterval = allowedIntervals.has(interval) ? interval : "1h";
    const safeLimit = Math.min(500, Math.max(30, Number.isFinite(Number(limit)) ? Number(limit) : 120));
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", "EURUSDT");
    url.searchParams.set("interval", safeInterval);
    url.searchParams.set("limit", String(safeLimit));
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length < 30) throw new Error("Not enough market candles returned");
    return rows.map(row => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }));
  });

  ipcMain.handle("market:quote", async () => {
    const url = new URL("https://api.binance.com/api/v3/ticker/24hr");
    url.searchParams.set("symbol", "EURUSDT");
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`Quote provider returned HTTP ${response.status}`);
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
  });

  ipcMain.handle("moex:status", async () => {
    try {
      const response = await fetch("https://iss.moex.com/iss/index.json", {
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        ok: true,
        note: "ISS API отвечает, но расписание сессий ещё не загружено. Статус торгов не подтверждён.",
        updatedAt: Date.now()
      };
    } catch {
      return { ok: false, note: "Расписание не подтверждено: источник недоступен.", updatedAt: null };
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});