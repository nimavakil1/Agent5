Nginx vhost: ai.acropaq.com

- HTTP → HTTPS redirect on port 80
- Backend app proxied at `/` → `127.0.0.1:3000`
- LiveKit WebSocket at `/rtc` → `127.0.0.1:7880` (no path strip)
- LiveKit Admin/Twirp at `/twirp` → `127.0.0.1:7880` (no path strip)

Verification

- Admin (Twirp):
  - `curl -sS https://ai.acropaq.com/twirp/livekit.RoomService/ListRooms -H "Content-Type: application/json" -u $LIVEKIT_API_KEY:$LIVEKIT_API_SECRET -d '{}'`
  - Expect JSON (not 404). A 401 means auth issue; a 404 means Nginx routing issue.
- WebSocket (RTC):
  - Connect a LiveKit client to `wss://ai.acropaq.com` and ensure it negotiates on `/rtc` via Nginx.

Env Hints

- `LIVEKIT_SERVER_URL=wss://ai.acropaq.com`
- `LIVEKIT_API_URL=https://ai.acropaq.com`
- `TELNYX_STREAM_URL=wss://ai.acropaq.com/pstn-websocket`

