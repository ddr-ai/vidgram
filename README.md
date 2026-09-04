# Vidgram — Telegram Media Viewer

Watch videos from your Telegram channels and groups in a dark desktop-style viewer.

Live frontend: https://ddr-ai.github.io/vidgram

## Project layout

```
backend/   Express API + Telegram client (GramJS)
frontend/  React app (Create React App)
```

## Local setup

### 1. Telegram API credentials

1. Open https://my.telegram.org
2. Create an application
3. Copy `backend/.env.example` to `backend/.env`
4. Fill in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`

### 2. Backend

```bash
cd backend
npm install
npm start
```

API: http://localhost:3001/api

### 3. Frontend

```bash
cd frontend
npm install
npm start
```

UI: http://localhost:3000

## GitHub Pages

The frontend is built and published to GitHub Pages on every push to `main`.

GitHub Pages is static. Login, channel lists, and video streaming need the Node backend running somewhere (your machine, or a host that can keep a long-lived Telegram session). Point the frontend at that API with `REACT_APP_API_URL`.
