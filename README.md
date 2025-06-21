# Alarm Game 🚨🎮

Demo server for guessing the next alarm. This version runs without external npm
packages and uses a local sample API response.

## Quick Start

```bash
npm start
```

Open <http://localhost:3000> to view the game.

## API Endpoints

- `GET /api/alerts/:date` – alerts for a specific date
- `GET /api/stats` – statistics
- `GET /api/debug` – show the sample API response
- `GET /api/health` – health status
- `POST /api/check-now` – process the sample alerts
- `GET /api/gameData` – get stored game data
- `POST /api/gameData` – save game data

Alerts are taken from `sample_api_response.json` and stored in the `data`
folder that is created on first run.
