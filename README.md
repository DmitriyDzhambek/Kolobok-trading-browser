# Колобок — трейдинг-браузер (Electron + Telegram Mini App)

Тёмный интерфейс в эстетике «Японская свеча»: React + Vite. Один и тот же код работает как десктоп (Electron) и как Telegram Mini App на Vercel. Реальный график — официальный виджет TradingView (OANDA:EURUSD), сигналы считаются по живым котировкам Binance, звуковое оповещение о входе в сделку синтезируется через Web Audio.

## Запуск веб-версии (Telegram Mini App)
```bash
npm install
npm run dev        # http://127.0.0.1:5500
```
Данные берутся из serverless-функций `api/market.js` и `api/news.js`. Для их локального запуска нужен Vercel CLI: `npm i -g vercel && npm run vercel:dev`. Без API приложение не падает — котировки/новости просто помечаются недоступными.

## Деплой на Vercel
1. Запушьте репозиторий в GitHub.
2. В Vercel импортируйте проект: framework — Vite, build command `npm run build`, output `dist` (всё это уже в `vercel.json`).
3. После деплоя откройте BotFather → `/newapp` (или «Set Menu Button») и укажите HTTPS-ссылку на Vercel.
4. `initTelegram()` в `src/main.jsx` сам вызывает `ready()`, `expand()` и подхватывает тему Telegram.

## Десктоп (Electron)
```bash
npm run dev:electron   # web + Electron c privileged IPC-мостом
npm run dist           # сборка Windows-установщика
```
В Electron данные идут через IPC (`window.kolobok`), в вебе — через `/api`. Транспорт выбирается автоматически в `src/services/bridge.js`.

## Звук о входе в сделку
`src/services/soundService.js` синтезирует тёплый колокольчик (Web Audio, без аудиофайлов): восходящая пентатоника для BUY, нисходящая для SELL. Громкость и вкл/выкл — в «Настройках», там же кнопка «Тест». На мобильных и в Telegram воспроизведение возможно только после первого касания — разблокировка встроена. Дополнительно дублируется хаптикой Telegram.

## Важные ограничения
- Виджет TradingView — официальный публичный embed; полноценную страницу `tradingview.com/chart/` в iframe встроить нельзя (403).
- Панель MOEX проверяет доступность ISS API, но не загружает расписание сессий и не утверждает, что торги открыты.
- Сигналы EMA/RSI — не финансовая рекомендация; реальные ордера и ключи биржи не подключены.

## Безопасность
Serverless-функции проксируют строго фиксированные endpoint'ы (Binance EURUSDT, Google News RSS, MOEX ISS) и не позволяют запрашивать произвольные URL. В Electron включены `contextIsolation`, отключён `nodeIntegration`, sandbox включён.


## Фоновый ИИ-бэкенд 24/7

Полный сервис добавлен в `backend/`: `worker.py` (WebSocket, M1-свечи, H1-тренд, паттерны, SQLite-память), `brain.py` (LLM-комментарии с кэшем и локальным fallback), `main.py` (FastAPI), `config.py`, Dockerfile и Compose. Фронтенд опрашивает `http://127.0.0.1:8000/api/status` каждые 5 секунд и показывает фоновый статус/отчёт о возвращении.

```bash
cd backend
cp .env.example .env
# Впишите KOLOBOK_TWELVEDATA_API_KEY; LLM API key необязателен
docker compose up --build -d
docker compose logs -f
```

Подробности, переменные окружения и API см. в [`backend/README.md`](backend/README.md). Для настоящих котировок EUR/USD нужен ключ провайдера Twelve Data. Без него сервис остаётся живым и не молчит, но честно сообщает, что live-данных нет. Forex tick-volume — только прокси по числу обновлений котировки, а не централизованный объём торгов. Сигналы информационные и не исполняют ордера.
