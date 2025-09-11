Backend (Agent5)

Run locally

- Node 18+ required.
- Copy `.env.example` to `.env` and fill values.
- Install deps: `npm install`
- Start: `npm start`

Environment

- Required: `MONGO_URI`, `AUTH_TOKEN`, `OPENAI_API_KEY`, `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PHONE_NUMBER`, `TELNYX_PUBLIC_KEY_PEM`, `LIVEKIT_SERVER_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- Recommended: `TELNYX_STREAM_URL` (e.g., `wss://your-domain/websocket`), `CORS_ORIGIN`, `TRUST_PROXY=1`, `PROTECT_RECORDINGS=1`.

Security & Ops

- Webhooks verified with Ed25519 and timestamp tolerance.
- All `/api/*` routes rate-limited and protected via bearer token.
- Security headers via Helmet; structured logs via pino-http.
- Health: `GET /healthz`, `GET /readyz`.
- Recordings: written to `src/recordings` as WAV (G.711 u-law 8kHz). Protected when `PROTECT_RECORDINGS=1`.

Prospects & Campaigns (Phase 1)

- Phone-level DNC: `/api/prospects/phone/:e164/opt-out` toggles opt-out for a phone (E.164).
- Field definitions: `GET/POST/PATCH/DELETE /api/prospects/field-defs` to manage dynamic fields.
- CSV template: `GET /api/prospects/template.csv` generated from field defs + base columns.
- CSV upload: `POST /api/prospects/upload` (multipart `csv`) upserts customers + deliveries, applies DNC per phone.
- Prospects list: `GET /api/prospects?scope=invoice|delivery|both&tags=a,b&lang=xx&lang_confirmed=0|1&opt_out=0|1&q=...` returns rows with derived opt_out per phone.

Docker

- Build: `docker build -t agent5-backend ./backend`
- Run: `docker run --env-file ./backend/.env -p 3000:3000 agent5-backend`
