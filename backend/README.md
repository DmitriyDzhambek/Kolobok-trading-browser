# Kolobok background market assistant

The backend is an always-on FastAPI service. The worker runs as an asyncio task in the same container, reconnects to the live quote stream with exponential backoff, aggregates ticks into M1 candles, stores candles/events in SQLite, computes trend/pattern/tick-volume conditions, and generates a quiet observation at least every five minutes.

## Important data note

EUR/USD is an OTC forex pair: there is no single consolidated exchange volume. The worker therefore uses the count of incoming quote updates per minute as a **tick-volume proxy**, labels it explicitly, and does not pretend it is traded volume. H1 trend is estimated from retained M1 closes, with EMA20/EMA50; this is a practical rolling proxy, not a provider's canonical H1 candle. The worker never fabricates missing candles or live prices.

## Run with Docker

```bash
cd backend
cp .env.example .env
# Edit .env and set KOLOBOK_TWELVEDATA_API_KEY. LLM key is optional.
docker compose up --build -d
docker compose logs -f kolobok-backend
```

The API listens on `http://127.0.0.1:8000`. Check `/health`, `/api/status`, `/api/events`. The container restarts after a crash and SQLite data is persisted in the `kolobok-data` volume.

## Run without Docker

Python 3.11+ is recommended.

```bash
cd backend
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env
python main.py
```

To run the worker standalone (without HTTP API), use `python worker.py`; for server use `uvicorn main:app --host 0.0.0.0 --port 8000`.

## Environment variables

Settings use `KOLOBOK_` prefix. `KOLOBOK_TWELVEDATA_API_KEY` is required for live data. `KOLOBOK_LLM_API_KEY` is optional; if absent or the LLM fails, local deterministic commentary is generated so the assistant does not stay silent. The LLM cache is keyed by normalized market state and expires after 300 seconds by default. Never commit `.env` or real API keys.

## API

- `GET /health` — service and worker liveness.
- `GET /api/status` — mood, current assistant speech, last signal, market analysis, and an away report if the previous visit was more than five minutes ago. Poll every five seconds while the UI is open; requests also update the last-seen timestamp.
- `GET /api/events?limit=50` — recent persistent event log.
- `GET /api/report` — compact event report.

Signals are informational only. The service does not connect to a broker, execute orders, or guarantee outcomes. Configure provider/API plans and confirm their terms and limits before production deployment.

## systemd (Linux server)

Для systemd скопируйте проект в `/opt/kolobok`, создайте системного пользователя `kolobok`, установите зависимости в `/opt/kolobok/backend/.venv`, создайте `/opt/kolobok/backend/data`, заполните `.env`, затем установите unit:

```bash
sudo useradd --system --home /opt/kolobok --shell /usr/sbin/nologin kolobok
sudo mkdir -p /opt/kolobok/backend/data
sudo chown -R kolobok:kolobok /opt/kolobok/backend
sudo cp /opt/kolobok/backend/kolobok-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kolobok-backend
sudo journalctl -u kolobok-backend -f
```

Сервис стартует через FastAPI lifespan, который поднимает `worker.run()` в отдельной asyncio-задаче. Не запускайте параллельно отдельный `python worker.py`, если API уже работает с той же SQLite-базой.
