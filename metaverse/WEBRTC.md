# WebRTC / mediasoup — Proximity-Based Audio/Video Calling

## Architecture Overview

```
┌──────────────┐   WebSocket    ┌──────────────────────────────────┐
│   Frontend   │◄──────────────►│  WS Server (apps/ws)             │
│  (React +    │                │  ├── User.ts — WS handlers       │
│  mediasoup-  │                │  ├── RoomManager.ts — proximity  │
│  client)     │                │  ├── mediaManager.ts — mediasoup │
│              │   WebRTC/UDP   │  │   ├── Workers (1 per CPU)     │
│              │◄──────────────►│  │   ├── Routers (1 per space)   │
└──────────────┘                │  │   └── Peers + Transports      │
                                └──────────────────────────────────┘
```

### How It Works

1. **Proximity detection**: When users move on the grid, `RoomManager.computeGroups()` runs a BFS flood-fill over 4-directional neighbors to find connected components. Users in the same component (even via chains of other users) form a "proximity group."

2. **Proximity → Media bridge**: `RoomManager.updateProximity()` diffs each user's nearby set against a cache. When the set changes, it sends `PROXIMITY_UPDATE` to the client and calls `MediaManager.syncConsumers()` which creates/removes mediasoup Consumers.

3. **Publish-always, subscribe-by-proximity**: Every user produces audio/video on join. The SFU only delivers tracks to users who are in the same proximity group. Moving away triggers a 300ms debounce before consumers are closed (prevents thrashing on tile boundaries).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JWT_PASSWORD` | *(required)* | JWT signing secret. Server exits if missing. |
| `DATABASE_URL` | — | Postgres connection string |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | IP address mediasoup listens on |
| `MEDIASOUP_ANNOUNCED_IP` | `127.0.0.1` | Public IP announced to clients. Use your public/host IP in production. |
| `RTC_MIN_PORT` | `40000` | Start of UDP port range for WebRTC |
| `RTC_MAX_PORT` | `40100` | End of UDP port range for WebRTC |

---

## Running Locally

### Prerequisites
- Node.js ≥ 22
- C++ build tools (mediasoup compiles native code):
  - **Windows**: Visual Studio Build Tools with "Desktop development with C++"
  - **Linux**: `build-essential`, `python3`
  - **macOS**: Xcode command line tools

### Steps

```bash
# 1. Install dependencies
cd metaverse
npm install

# 2. Set environment variables (already in apps/ws/.env for dev)
#    JWT_PASSWORD, DATABASE_URL, etc.

# 3. Build and start
npm run dev
```

### HTTPS Requirement

`getUserMedia()` (camera/mic access) **requires HTTPS** outside `localhost`. For development:
- `http://localhost:5173` works fine
- For remote testing, use a tool like `mkcert` to generate local certs and configure Vite's HTTPS mode

---

## Docker

```bash
# Set required env vars
export JWT_PASSWORD="your-secret-here"
export MEDIASOUP_ANNOUNCED_IP="your.public.ip"

# Run
docker-compose up --build
```

The `ws` service exposes:
- TCP port `8080` for WebSocket connections
- UDP ports `40000-40100` for WebRTC media traffic

---

## Follow-Up: TURN Server

For networks that block UDP (corporate firewalls, symmetric NAT), a TURN relay is needed. **Not required for the first pass.** Recommended setup:

1. Deploy [coturn](https://github.com/coturn/coturn) on a public server
2. Configure `iceServers` in the mediasoup-client transport options:
   ```js
   device.createSendTransport({
     // ...existing params,
     iceServers: [
       { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
     ]
   });
   ```
3. Expose coturn in docker-compose with appropriate port mappings

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `getUserMedia` fails | Check HTTPS, camera permissions, or try audio-only |
| No media connection | Check firewall allows UDP 40000-40100, verify `MEDIASOUP_ANNOUNCED_IP` |
| mediasoup build fails | Install C++ build tools for your platform |
| Workers crash on start | Check port range availability, reduce if ports conflict |
| Consumer not created | Verify both users have completed transport setup (check console logs) |
