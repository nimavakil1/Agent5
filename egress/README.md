# LiveKit Egress (Self‑Hosted)

This directory contains a minimal Docker setup to run the LiveKit Egress worker so the backend can record calls using LiveKit’s native recording pipeline.

## Files
- `docker-compose.yml`: launches the `livekit/egress` worker
- `.env.egress.example`: template for the worker environment variables
- `output/`: local directory for file outputs when using local storage (created on first run)

## Configure
1) Copy the env template and fill values:

```bash
cp .env.egress.example .env.egress
# Edit .env.egress and set LIVEKIT_WS_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
# Choose either FILE_OUTPUT_LOCAL (local files) or S3_* variables
```

2) Start the worker:

```bash
docker compose up -d
```

3) Verify it’s running:

```bash
docker ps | grep livekit-egress
```

## Expected Backend Env
The backend already uses these variables:
- `LIVEKIT_API_URL` (HTTP/S API endpoint)
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

With the worker running, the backend will log lines like:
- `LiveKit egress started …`
- `LiveKit egress stopped … file: …`

The call log’s `audio_recording_url` will be set to the egress file path/URL.

## Notes
- Local file output writes into `./output` on the host. For production use S3.
- Ensure your LiveKit server accepts API requests at `LIVEKIT_API_URL` and WebSocket connections at `LIVEKIT_WS_URL`.

