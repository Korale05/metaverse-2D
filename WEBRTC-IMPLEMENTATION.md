# Proximity-Based WebRTC Audio/Video Calling Implementation Guide

This document is the definitive architectural and implementation reference for the real-time proximity-based audio and video calling subsystem in the `metaverse-2D` platform. It covers everything from grid topology algorithms and co-located mediasoup SFU orchestration to React client WebRTC pipelines and deployment configurations.

---

# 1. Overview

This feature provides seamless, spatial proximity-based video and audio communication on top of a 2D grid metaverse. When a user navigates their avatar within 1 Manhattan grid unit of another user (or joins an existing chain of adjacent players), the system automatically initiates a zero-click, bidirectional WebRTC audio and video call among all connected members of that cluster. Moving away from the cluster breaks adjacency and gracefully terminates the WebRTC tracks after a 300ms debounce threshold.

The media server (mediasoup SFU) is co-located directly inside the `apps/ws` WebSocket server process. WebSocket connections handle avatar movement, collision detection, and WebRTC SDP/ICE signaling, while WebRTC RTP audio and video packets flow over UDP directly between the client browser and the co-located mediasoup worker processes.

```mermaid
graph TB
    subgraph Client ["Browser Client (apps/frontend)"]
        UI["Game UI & Video Tiles"]
        MSClient["mediasoup-client Device"]
        WSClient["WebSocket Client"]
    end

    subgraph Server ["Co-located Server Process (apps/ws : Node.js)"]
        WSServer["WebSocket Server (:8080)"]
        RM["RoomManager (Grid & Proximity Engine)"]
        MM["MediaManager (SFU Controller Singleton)"]
        
        subgraph MediasoupWorkers ["mediasoup C++ Workers"]
            Worker1["Worker (CPU Core 0)"]
            WorkerN["Worker (CPU Core N)"]
            Router["Space Router (audio/opus, video/VP8)"]
        end
    end

    %% Signaling and Movement Flow
    WSClient <== "WebSocket (Port 8080)\nMovement, Collision, & WebRTC Signaling" ==> WSServer
    WSServer --> RM
    RM -->|"updateProximity()\nsyncConsumers()"| MM
    MM --> Router

    %% Media Transport Flow
    MSClient <== "WebRTC / UDP (Ports 40000-40100)\nEncrypted SRTP Media Streams" ==> Router
    Router --- Worker1
```

---

# 2. Before/After Architecture

### The Old Proximity Architecture
Prior to this implementation, proximity was either unhandled or evaluated strictly per-mover against direct 1-hop distance. When User A moved, only User A's immediate coordinates were checked against other users, notifying only the mover and failing to form groups when chains of multiple people met.

```mermaid
graph TD
    A1["User A Moves to (X, Y)"] --> B1["Check 1-hop distance against all users"]
    B1 --> C1["Compute local nearby array for User A only"]
    C1 --> D1["Send notification ONLY to User A"]
    D1 -.-> E1["Failures: Transitive chains (A-B-C) unsupported.<br/>Stationary users (B & C) never notified of change.<br/>No WebRTC media synchronization."]
```

### The New Proximity Architecture
The new architecture treats proximity as an undirected graph connectivity problem. Every user move, join, or disconnect triggers a space-wide Breadth-First Search (BFS) flood-fill that decomposes all users into disjoint connected components (groups). Diffing against a cache prevents message spam, and updates feed directly into both the WebSocket notification pipeline and the `MediaManager` SFU consumer synchronizer.

```mermaid
graph TD
    MoveEvent["User Action (Join / Move / Leave)"] --> BFS["RoomManager.computeGroups(spaceId)\nBFS Flood-Fill on Manhattan Grid"]
    BFS --> GroupGen["Partition all users into Disjoint Connected Components"]
    GroupGen --> ProximityMap["Generate userId -> string[] nearby mapping"]
    ProximityMap --> DiffCheck{"Signature == lastSentProximity[userId]?"}
    DiffCheck -- "Yes (Unchanged)" --> Skip["Suppress duplicate message"]
    DiffCheck -- "No (Changed)" --> CacheUpdate["Update lastSentProximity Cache"]
    CacheUpdate --> WSNotify["user.send('PROXIMITY_UPDATE')"]
    CacheUpdate --> SFUSync["MediaManager.syncConsumers(userId, nearby)"]
    SFUSync --> MediasoupAction["Create new Consumers / Debounce-close departed Consumers"]
```

### Why the Old Logic Could Not Support Chains
In a spatial collaboration environment, conversations naturally form groups: if User A is adjacent to User B, and User B is adjacent to User C, all three should hear and see each other in a unified call, even if User A and User C are separated by 2 tiles. Direct-neighbor checking only evaluates pair distances $\Delta x + \Delta y \le 1$. If A is at $(2, 2)$, B is at $(2, 3)$, and C is at $(2, 4)$, direct calculation gives $\text{dist}(A, C) = 2$, excluding them from each other's call and causing split audio states where B hears both A and C, but A and C cannot hear each other. The flood-fill algorithm treats every adjacency as an edge in an undirected graph and computes connected components, guaranteeing transitive closure: any path of adjacent users joins the entire cluster into one shared call.

---

# 3. File-by-File Changes

## `metaverse/apps/ws/src/RoomManager.ts`
**Status:** Modified

**What it did before:**
`RoomManager` was an in-memory singleton storing `rooms: Map<string, User[]>`. It provided basic methods: `addUser`, `removeUser`, and `broadcast`. It had no proximity awareness, no coordinate indexing, and no connection to media synchronization.

**What changed:**
1. Added `lastSentProximity: Map<string, string>` to store a serialized snapshot of the last proximity group sent to each user.
2. Added `computeGroups(spaceId: string): User[][]`, which executes a BFS flood-fill across 4-directional Manhattan neighbors to find transitive connected components.
3. Added `updateProximity(spaceId: string): void`, which computes components, diffs against `lastSentProximity`, broadcasts `PROXIMITY_UPDATE`, and triggers `MediaManager.getInstance().syncConsumers(userId, nearby)`.
4. Updated `removeUser` to purge proximity cache entries for disconnecting users.

**Full Before/After Code:**

### `removeUser`
```diff
<<<< Before
    public removeUser(user : User,spaceId : string){
        if(!this.rooms.has(spaceId)){
            return;
        }
        this.rooms.set(spaceId,this.rooms.get(spaceId)?.filter((u)=> u.id != user.id) ?? []);
    }
====
>>>> After
    public removeUser(user: User, spaceId: string) {
        if (!this.rooms.has(spaceId)) {
            return;
        }
        this.rooms.set(spaceId, this.rooms.get(spaceId)?.filter((u) => u.id != user.id) ?? []);

        // Clean up proximity cache for the removed user
        if (user.userId) {
            this.lastSentProximity.delete(user.userId);
        }
    }
```

### `computeGroups` (New Function)
```typescript
    /**
     * Build connected components of users on the grid via BFS flood-fill.
     * Two users are in the same group if there's a chain of adjacent (Manhattan distance 1)
     * users connecting them — transitive grouping.
     */
    public computeGroups(spaceId: string): User[][] {
        const users = this.rooms.get(spaceId);
        if (!users || users.length === 0) return [];

        // Build a position -> User map for quick 4-neighbor lookup
        const posMap = new Map<string, User>();
        for (const user of users) {
            const key = `${user.x},${user.y}`;
            posMap.set(key, user);
        }

        const visited = new Set<string>(); // track visited user connection ids
        const groups: User[][] = [];

        for (const user of users) {
            if (visited.has(user.id)) continue;

            // BFS flood-fill from this user
            const group: User[] = [];
            const queue: User[] = [user];
            visited.add(user.id);

            while (queue.length > 0) {
                const current = queue.shift()!;
                group.push(current);

                // Check all 4 neighbors (up, down, left, right)
                const neighbors = [
                    { x: current.x, y: current.y - 1 },
                    { x: current.x, y: current.y + 1 },
                    { x: current.x - 1, y: current.y },
                    { x: current.x + 1, y: current.y },
                ];

                for (const pos of neighbors) {
                    const key = `${pos.x},${pos.y}`;
                    const neighbor = posMap.get(key);
                    if (neighbor && !visited.has(neighbor.id)) {
                        visited.add(neighbor.id);
                        queue.push(neighbor);
                    }
                }
            }

            groups.push(group);
        }

        return groups;
    }
```

### `updateProximity` (New Function)
```typescript
    /**
     * Recompute proximity groups for a space and send PROXIMITY_UPDATE
     * to each user whose nearby set has changed since the last notification.
     * Sends stable userId strings (not connection ids).
     */
    public updateProximity(spaceId: string): void {
        const users = this.rooms.get(spaceId);
        if (!users) return;

        const groups = this.computeGroups(spaceId);

        // Build a userId -> nearby userId[] map from the groups
        const proximityMap = new Map<string, string[]>();

        for (const group of groups) {
            if (group.length < 2) {
                // Solo user — their nearby is empty
                for (const user of group) {
                    if (user.userId) {
                        proximityMap.set(user.userId, []);
                    }
                }
                continue;
            }

            // Multi-user group — each member's nearby is all OTHER members
            for (const user of group) {
                if (!user.userId) continue;
                const nearby = group
                    .filter((u) => u.userId && u.userId !== user.userId)
                    .map((u) => u.userId!)
                    .sort();
                proximityMap.set(user.userId, nearby);
            }
        }

        // Send PROXIMITY_UPDATE only when the set has changed
        for (const [userId, nearby] of proximityMap) {
            const signature = JSON.stringify(nearby);
            const lastSignature = this.lastSentProximity.get(userId);

            if (signature !== lastSignature) {
                this.lastSentProximity.set(userId, signature);

                // Find the user object to send to
                const user = users.find((u) => u.userId === userId);
                if (user) {
                    user.send({
                        type: "PROXIMITY_UPDATE",
                        payload: {
                            nearby: nearby
                        }
                    });
                }

                // Bridge proximity → media: sync consumers for this user
                if (MediaManager.getInstance().hasPeer(userId)) {
                    MediaManager.getInstance().syncConsumers(userId, nearby);
                }
            }
        }
    }
```

**New dependencies introduced:**
- Imports `MediaManager` from `./mediaManager.js` and calls `MediaManager.getInstance().syncConsumers(userId, nearby)` and `MediaManager.getInstance().hasPeer(userId)`.

---

## `metaverse/apps/ws/src/User.ts`
**Status:** Modified

**What it did before:**
Handled incoming WebSocket messages (`join`, `move`). Allowed insecure JWT fallback (`process.env.JWT_PASSWORD ?? "IloveOnkar"`). Kept player coordinates `x` and `y` private. On disconnect, did not clean up media peers.

**What changed:**
1. Made `x: number` and `y: number` public so `RoomManager.computeGroups` can inspect positions.
2. Removed insecure `"IloveOnkar"` JWT fallback; closes connection immediately if `JWT_PASSWORD` is unset.
3. On `"join"`, creates a media peer via `MediaManager.getInstance().createPeer` and invokes `RoomManager.getInstance().updateProximity(spaceId)`.
4. On `"move"`, invokes `RoomManager.getInstance().updateProximity(this.spaceId)` after broadcasting position.
5. Added handlers for mediasoup WebRTC signaling: `get-router-rtp-capabilities`, `set-rtp-capabilities`, `create-transport`, `connect-transport`, `produce`, and `resume-consumer`.
6. Updated `destroy()` to call `MediaManager.getInstance().removePeer(this.userId)` and trigger `updateProximity` for remaining users.

**Full Before/After Code:**

### User Class Fields & JWT Verification
```diff
<<<< Before
export class User {
    public id: string;
    private spaceId?: string;
    private x: number;
    private y: number;
    public userId: (string | null);

    constructor(private ws: WebSocket) {
        this.id = randomString();
        this.x = 0;
        this.y = 0;
        this.userId = null;
    }
...
                    const JWT_PASSWORD = process.env.JWT_PASSWORD ?? "IloveOnkar";
                    let userID: string | undefined;
====
>>>> After
export class User {
    public id: string;
    private spaceId?: string;
    public x: number;
    public y: number;
    public userId: (string | null);

    constructor(private ws: WebSocket) {
        this.id = randomString();
        this.x = 0;
        this.y = 0;
        this.userId = null;
    }
...
                    const JWT_PASSWORD = process.env.JWT_PASSWORD;
                    if (!JWT_PASSWORD) {
                        console.error("JWT_PASSWORD env var is not set");
                        return this.ws.close();
                    }
                    let userID: string | undefined;
```

### `initHandlers` — `join` Case
```diff
<<<< Before
                    // This message goes to everyone else in the room
                    RoomManager.getInstance().broadcast({
                        type: "user-join",
                        payload: {
                            x: this.x,
                            userId: this.userId,
                            y: this.y
                        }
                    }, this, spaceId);
                    break;
====
>>>> After
                    // This message goes to everyone else in the room
                    RoomManager.getInstance().broadcast({
                        type: "user-join",
                        payload: {
                            x: this.x,
                            userId: this.userId,
                            y: this.y
                        }
                    }, this, spaceId);

                    // Compute proximity groups after joining
                    RoomManager.getInstance().updateProximity(spaceId);

                    // Create a media peer for this user
                    try {
                        await MediaManager.getInstance().createPeer(
                            this.userId,
                            spaceId,
                            (msg: any) => this.send(msg)
                        );
                    } catch (err) {
                        console.error("Failed to create media peer:", err);
                    }
                    break;
```

### `initHandlers` — `move` Case
```diff
<<<< Before
                        this.x = moveX;
                        this.y = moveY;
                        RoomManager.getInstance().broadcast({
                            type: "move",
                            payload: {
                                x: this.x,
                                y: this.y,
                                userId: this.userId
                            }
                        }, this, this.spaceId);
                        return;
====
>>>> After
                        this.x = moveX;
                        this.y = moveY;
                        RoomManager.getInstance().broadcast({
                            type: "move",
                            payload: {
                                x: this.x,
                                y: this.y,
                                userId: this.userId
                            }
                        }, this, this.spaceId);

                        // Recompute proximity groups for the entire space after movement
                        RoomManager.getInstance().updateProximity(this.spaceId);
                        return;
```

### Media Signaling Switch Cases (Added to `initHandlers`)
```typescript
                // ── Media signaling messages ──────────────────────────────

                case "get-router-rtp-capabilities": {
                    if (!this.spaceId || !this.userId) return;
                    try {
                        const caps = MediaManager.getInstance().getRouterRtpCapabilities(this.spaceId);
                        this.send({
                            type: "router-rtp-capabilities",
                            payload: { rtpCapabilities: caps }
                        });
                    } catch (err) {
                        console.error("Failed to get router capabilities:", err);
                    }
                    break;
                }

                case "set-rtp-capabilities": {
                    if (!this.userId) return;
                    const rtpCaps = parsedData.payload?.rtpCapabilities;
                    if (rtpCaps) {
                        MediaManager.getInstance().setRtpCapabilities(this.userId, rtpCaps);
                    }
                    break;
                }

                case "create-transport": {
                    if (!this.userId) return;
                    const direction = parsedData.payload?.direction;
                    if (direction !== "send" && direction !== "recv") return;
                    try {
                        const transportInfo = await MediaManager.getInstance().createWebRtcTransport(
                            this.userId,
                            direction
                        );
                        this.send({
                            type: "transport-created",
                            payload: {
                                direction,
                                ...transportInfo
                            }
                        });
                    } catch (err) {
                        console.error("Failed to create transport:", err);
                        this.send({ type: "error", payload: { message: "Failed to create transport" } });
                    }
                    break;
                }

                case "connect-transport": {
                    if (!this.userId) return;
                    const { transportId, dtlsParameters } = parsedData.payload ?? {};
                    if (!transportId || !dtlsParameters) return;
                    try {
                        await MediaManager.getInstance().connectTransport(
                            this.userId,
                            transportId,
                            dtlsParameters
                        );
                        this.send({ type: "transport-connected", payload: { transportId } });
                    } catch (err) {
                        console.error("Failed to connect transport:", err);
                        this.send({ type: "error", payload: { message: "Failed to connect transport" } });
                    }
                    break;
                }

                case "produce": {
                    if (!this.userId) return;
                    const { transportId: prodTransportId, kind, rtpParameters } = parsedData.payload ?? {};
                    if (!prodTransportId || !kind || !rtpParameters) return;
                    try {
                        const producerId = await MediaManager.getInstance().produce(
                            this.userId,
                            prodTransportId,
                            kind,
                            rtpParameters
                        );
                        this.send({
                            type: "produced",
                            payload: { id: producerId, kind }
                        });
                    } catch (err) {
                        console.error("Failed to produce:", err);
                        this.send({ type: "error", payload: { message: "Failed to produce" } });
                    }
                    break;
                }

                case "resume-consumer": {
                    if (!this.userId) return;
                    const { consumerId } = parsedData.payload ?? {};
                    if (!consumerId) return;
                    try {
                        await MediaManager.getInstance().resumeConsumer(this.userId, consumerId);
                    } catch (err) {
                        console.error("Failed to resume consumer:", err);
                    }
                    break;
                }
```

### `destroy`
```diff
<<<< Before
    destroy() {
        if (this.spaceId) {
            // This tell all other users that you left the room 
            RoomManager.getInstance().broadcast({
                type: "user-leave",
                payload: {
                    userId: this.userId,
                    spaceId: this.spaceId
                }
            }, this, this.spaceId);

            RoomManager.getInstance().removeUser(this, this.spaceId);
        }
    }
====
>>>> After
    destroy() {
        if (this.spaceId) {
            const spaceId = this.spaceId;

            // Remove media peer first (closes transports, producers, consumers)
            if (this.userId) {
                MediaManager.getInstance().removePeer(this.userId);
            }

            // This tell all other users that you left the room 
            RoomManager.getInstance().broadcast({
                type: "user-leave",
                payload: {
                    userId: this.userId,
                    spaceId: spaceId
                }
            }, this, spaceId);

            RoomManager.getInstance().removeUser(this, spaceId);

            // Recompute proximity for remaining users after this user leaves
            RoomManager.getInstance().updateProximity(spaceId);
        }
    }
```

**New dependencies introduced:**
- Calls `MediaManager.getInstance().createPeer()`, `removePeer()`, `getRouterRtpCapabilities()`, `setRtpCapabilities()`, `createWebRtcTransport()`, `connectTransport()`, `produce()`, and `resumeConsumer()`.
- Calls `RoomManager.getInstance().updateProximity()`.

---

## `metaverse/apps/ws/src/index.ts`
**Status:** Modified

**What it did before:**
Immediately instantiated `new WebSocketServer({ port: 8080 })` synchronously upon execution.

**What changed:**
1. Added fail-fast environment check for `JWT_PASSWORD`. If missing, logs a fatal error and calls `process.exit(1)`.
2. Wrapped server bootstrap in an asynchronous IIFE to initialize mediasoup Workers (`MediaManager.getInstance().init()`) before accepting incoming WebSocket connections.

**Full Before/After Code:**
```diff
<<<< Before
import "dotenv/config";
import { WebSocketServer } from 'ws';
import { User } from "./User.js";

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', function connection(ws) {
  let user: User | null = new User(ws);
  user.initHandlers();

  ws.on('error', console.error);

  ws.on("close", () => {
    user?.destroy();
  });
});
====
>>>> After
import "dotenv/config";
import { WebSocketServer } from 'ws';
import { User } from "./User.js";
import { MediaManager } from "./mediaManager.js";

// Fail fast if JWT_PASSWORD is not configured
if (!process.env.JWT_PASSWORD) {
    console.error("FATAL: JWT_PASSWORD environment variable is required. Set it in .env or your environment.");
    process.exit(1);
}

// Initialize mediasoup workers, then start the WS server
(async () => {
    try {
        await MediaManager.getInstance().init();
        console.log("[Server] mediasoup Workers initialized");
    } catch (err) {
        console.error("[Server] Failed to initialize mediasoup:", err);
        process.exit(1);
    }

    const wss = new WebSocketServer({ port: 8080 });
    console.log("WebSocket server started on port 8080");

    wss.on('connection', function connection(ws) {
        let user: User | null = new User(ws);
        user.initHandlers();

        ws.on('error', console.error);

        ws.on("close", () => {
            user?.destroy();
        });
    });
})();
```

**New dependencies introduced:**
- Imports `MediaManager` from `./mediaManager.js` and calls `MediaManager.getInstance().init()`.

---

## `metaverse/apps/ws/src/mediaManager.ts`
**Status:** New file

**What it does:**
Acts as the central SFU media coordinator singleton. Responsibilities:
1. **Worker Pool Management**: Creates $N$ mediasoup Workers matching `os.cpus().length` and binds them to the configured port range (`RTC_MIN_PORT` to `RTC_MAX_PORT`).
2. **Router Lifecycle**: Creates one mediasoup Router per space on a round-robin Worker, configured with Opus audio and VP8 video codecs. Cleans up routers when spaces empty.
3. **Transport Management**: Creates and connects `send` and `recv` `WebRtcTransport` instances for each peer using `MEDIASOUP_LISTEN_IP` and `MEDIASOUP_ANNOUNCED_IP`.
4. **Publish-Always Model**: Manages audio and video `Producer` instances per peer.
5. **Proximity-Gated Consumption**: Implements `syncConsumers(userId, nearbyUserIds)`:
   - When users enter proximity, creates paused consumers on the subscriber's `recvTransport` and sends `new-consumer` to the client.
   - When users leave proximity, sets a 300ms debounce timer before tearing down the consumer and notifying the client with `consumer-closed`.

**Key Architectural Methods in `mediaManager.ts`:**
- `init(): Promise<void>`: Spawns CPU-matched worker processes.
- `getOrCreateRouter(spaceId: string)`: Ensures an active Router exists for the space.
- `createPeer(userId, spaceId, sendFn)`: Registers peer metadata and WebSocket delivery callback.
- `createWebRtcTransport(userId, direction)`: Allocates ICE/DTLS server-side transport.
- `connectTransport(userId, transportId, dtlsParameters)`: Completes DTLS handshake with browser parameters.
- `produce(userId, transportId, kind, rtpParameters)`: Starts ingest and broadcasts to existing nearby users via `syncNewProducer`.
- `syncConsumers(userId, nearbyUserIds)`: The core proximity bridge logic with 300ms disconnect debounce.

**New dependencies introduced:**
- `mediasoup` (native Node.js WebRTC SFU engine).
- `os` (for CPU core count).

---

## `metaverse/apps/ws/package.json`
**Status:** Modified

**What it did before:**
Contained dependencies for basic WebSocket routing (`ws`, `jsonwebtoken`, `dotenv`, `@repo/db`).

**What changed:**
Added `"mediasoup": "^3.14.16"` to support native server-side WebRTC pipelines.

**Full Before/After Code:**
```diff
<<<< Before
    "@types/jsonwebtoken": "^9.0.10",
    "dotenv": "^18.0.0",
    "jsonwebtoken": "^9.0.3",
    "ws": "^8.21.3"
====
>>>> After
    "@types/jsonwebtoken": "^9.0.10",
    "dotenv": "^18.0.0",
    "jsonwebtoken": "^9.0.3",
+   "mediasoup": "^3.14.16",
    "ws": "^8.21.3"
```

---

## `metaverse/apps/frontend/package.json`
**Status:** Modified

**What it did before:**
Contained standard React SPA dependencies (`react`, `react-dom`, `react-router-dom`, `axios`).

**What changed:**
Added `"mediasoup-client": "^3.7.17"` to enable browser WebRTC device management, ICE/DTLS transport negotiation, and track production/consumption.

**Full Before/After Code:**
```diff
<<<< Before
    "@types/axios": "^0.9.36",
    "@types/react-router-dom": "^5.3.3",
    "axios": "^1.20.0",
    "react": "^19.2.8",
====
>>>> After
    "@types/axios": "^0.9.36",
    "@types/react-router-dom": "^5.3.3",
    "axios": "^1.20.0",
+   "mediasoup-client": "^3.7.17",
    "react": "^19.2.8",
```

---

## `metaverse/apps/ws/.env`
**Status:** Modified

**What it did before:**
Contained database URL and fallback JWT secrets.

**What changed:**
Configured IP and port boundaries for mediasoup WebRTC communication.

**Full Before/After Code:**
```diff
<<<< Before
JWT_PASSWORD="IloveOnkar"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
====
>>>> After
JWT_PASSWORD="IloveOnkar"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
+ MEDIASOUP_LISTEN_IP=0.0.0.0
+ MEDIASOUP_ANNOUNCED_IP=127.0.0.1
+ RTC_MIN_PORT=40000
+ RTC_MAX_PORT=40100
```

---

## `metaverse/apps/frontend/src/hooks/useMediasoup.ts`
**Status:** New file

**What it does:**
Encapsulates all client-side WebRTC and mediasoup operations inside a reusable React hook:
1. **Device Initialization**: Manages the `mediasoup-client.Device` instance, loads router capabilities, and requests send/recv WebRtcTransports over WebSocket.
2. **Media Capture**: Calls `navigator.mediaDevices.getUserMedia` for 320x240 @ 15fps video and Opus audio, with automatic fallback to audio-only if camera access is denied.
3. **Transport Handshakes**: Handles `connect` and `produce` events from `mediasoup-client.Transport`, coordinating asynchronously with WebSocket request/response cycles.
4. **Track Consumption**: Ingests remote RTP tracks when receiving `new-consumer`, builds composite `MediaStream` objects per peer, attaches them to state, and acknowledges activation via `resume-consumer`.
5. **Mute/Video Toggles**: Supports local hardware mute/camera-off by toggling `track.enabled`.
6. **Cleanup**: Closes all producers, consumers, and transports when leaving the space.

**New dependencies introduced:**
- `mediasoup-client` (browser WebRTC wrapper).

---

## `metaverse/apps/frontend/src/pages/Game.page.tsx`
**Status:** Modified

**What it did before:**
Rendered the 2D grid, avatar markers, WASD keyboard movement, and event stream logs. When receiving `PROXIMITY_UPDATE`, it merely logged the payload to console without initiating calls.

**What changed:**
1. Imported and instantiated `useMediasoup()`.
2. Initialized the media pipeline (`media.initMedia(ws)`) immediately upon receiving `space-joined`.
3. Wired WebSocket media message handlers (`router-rtp-capabilities`, `transport-created`, `transport-connected`, `produced`, `new-consumer`, `consumer-closed`).
4. Bound `PROXIMITY_UPDATE` to `media.handleProximityUpdate(nearby)`.
5. Added UI components: Call Panel with call indicator badge, Mute/Unmute microphone button, Camera toggle button, Local video mirror tile, and dynamic Remote Video tiles.
6. Cleaned up media resources in `leaveSpace()`.

**Full Before/After Code:**

### Imports & Hook Integration
```diff
<<<< Before
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import './auth.css';
import './game.css';
====
>>>> After
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
+import { useMediasoup } from '../hooks/useMediasoup';
import './auth.css';
import './game.css';
+import './call-panel.css';
...
  const wsRef = useRef<WebSocket | null>(null);

+ // mediasoup hook
+ const media = useMediasoup();
```

### WebSocket Dispatcher (`switch (type)`)
```diff
<<<< Before
          case 'space-joined': {
            setMyPos({ x: payload.spawn.x, y: payload.spawn.y });
            const usersMap = new Map<string, UserPos>();
            payload.users.forEach((u: any) => {
              usersMap.set(u.userId, { userId: u.userId, x: u.x, y: u.y });
            });
            setRemoteUsers(usersMap);
            addLog(`Spawned at (${payload.spawn.x}, ${payload.spawn.y})`, 'join');
            if (usersMap.size > 0) {
              addLog(`${usersMap.size} other user(s) currently active in this space`, 'info');
            }
            break;
          }
====
>>>> After
          case 'space-joined': {
            setMyPos({ x: payload.spawn.x, y: payload.spawn.y });
            const usersMap = new Map<string, UserPos>();
            payload.users.forEach((u: any) => {
              usersMap.set(u.userId, { userId: u.userId, x: u.x, y: u.y });
            });
            setRemoteUsers(usersMap);
            addLog(`Spawned at (${payload.spawn.x}, ${payload.spawn.y})`, 'join');
            if (usersMap.size > 0) {
              addLog(`${usersMap.size} other user(s) currently active in this space`, 'info');
            }

+           // Initialize mediasoup media pipeline
+           media.initMedia(ws);
            break;
          }
```

```diff
<<<< Before
          case 'PROXIMITY_UPDATE' : {
            console.log("proximity update " , payload.nearby);
            break;
          }
====
>>>> After
          case 'PROXIMITY_UPDATE' : {
            const nearby = payload.nearby || [];
            media.handleProximityUpdate(nearby);
            if (nearby.length > 0) {
              addLog(`In call with ${nearby.length} user(s): ${nearby.map((id: string) => id.substring(0, 6)).join(', ')}`, 'PROXIMITY_UPDATE');
            } else {
              addLog('No nearby users', 'PROXIMITY_UPDATE');
            }
            break;
          }

          // ── Media signaling responses ──────────────────────

          case 'router-rtp-capabilities': {
            media.handleRouterRtpCapabilities(payload);
            break;
          }

          case 'transport-created': {
            media.handleTransportCreated(payload);
            break;
          }

          case 'transport-connected': {
            media.handleTransportConnected(payload);
            break;
          }

          case 'produced': {
            media.handleProduced(payload);
            break;
          }

          case 'new-consumer': {
            media.handleNewConsumer(payload);
            addLog(`Receiving ${payload.kind} from ${payload.peerId?.substring(0, 6)}`, 'join');
            break;
          }

          case 'consumer-closed': {
            media.handleConsumerClosed(payload);
            addLog(`Call ended with ${payload.peerId?.substring(0, 6)}`, 'leave');
            break;
          }
```

### Call Panel Rendering & Video Elements
```tsx
            {/* ─── Call Panel ──────────────────────────────── */}
            {(media.inCall || media.mediaReady) && (
              <div className="call-panel">
                <div className="call-panel-header">
                  <div className="call-panel-title">
                    📞 Proximity Call
                  </div>
                  <div className={`call-indicator ${media.inCall ? 'active' : 'inactive'}`}>
                    <span className="call-indicator-dot" />
                    {media.inCall ? `In call with ${media.nearbyPeers.length}` : 'Waiting for nearby'}
                  </div>
                </div>

                {/* Controls */}
                <div className="call-controls">
                  <button
                    className={`call-control-btn mute-btn ${media.audioMuted ? 'muted' : ''}`}
                    onClick={media.toggleAudio}
                    title={media.audioMuted ? 'Unmute' : 'Mute'}
                  >
                    {media.audioMuted ? '🔇' : '🎤'}
                  </button>
                  <button
                    className={`call-control-btn video-btn ${media.videoOff ? 'video-off' : ''}`}
                    onClick={media.toggleVideo}
                    title={media.videoOff ? 'Turn Camera On' : 'Turn Camera Off'}
                  >
                    {media.videoOff ? '📷' : '📹'}
                  </button>
                  <div className={`media-status ${media.mediaReady ? 'ready' : 'loading'}`}>
                    {media.mediaReady ? '✅ Media ready' : '⏳ Setting up...'}
                  </div>
                </div>

                {/* Video tiles */}
                <div className="call-video-grid">
                  {/* Local video */}
                  {media.localStream && (
                    <div className="call-video-tile local-tile">
                      <LocalVideo stream={media.localStream} videoOff={media.videoOff} />
                      <span className="call-video-label me-label">You</span>
                    </div>
                  )}

                  {/* Remote videos */}
                  {Array.from(media.remoteStreams.entries()).map(([peerId, stream]) => (
                    <div key={peerId} className="call-video-tile">
                      <RemoteVideo stream={stream} />
                      <span className="call-video-label">{peerId.substring(0, 6)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
```

**New dependencies introduced:**
- Imports `useMediasoup` from `../hooks/useMediasoup`.
- Imports `./call-panel.css`.

---

## `metaverse/apps/frontend/src/pages/call-panel.css`
**Status:** New file

**What it does:**
Contains styles and animations for the call interface:
- Glassmorphic card styling for `.call-panel`.
- Pulsing active call status pill (`.call-indicator.active` with `@keyframes callPulse`).
- Circular interactive controls with active/muted states (`.mute-btn`, `.video-btn`).
- Responsive video grid (`.call-video-grid`) using auto-fit minmax tiles.
- Video aspect ratio constraints (4:3), object-fit cover, and mirrored transform for local self-view (`transform: scaleX(-1)`).
- Subdued overlay labels indicating username / peer ID.

---

## `metaverse/docker-compose.yaml`
**Status:** Modified

**What it did before:**
Had hardcoded `JWT_PASSWORD: IloveOnkar` for both `http` and `ws` services. Did not expose WebRTC UDP port ranges for the `ws` container.

**What changed:**
1. Replaced hardcoded credentials with `${JWT_PASSWORD}` environment variable interpolation.
2. Exposed UDP port range `40000-40100:40000-40100/udp` on the `ws` container for WebRTC media packet exchange.
3. Added mediasoup network configuration environment variables (`MEDIASOUP_LISTEN_IP`, `MEDIASOUP_ANNOUNCED_IP`, `RTC_MIN_PORT`, `RTC_MAX_PORT`).

**Full Before/After Code:**
```diff
<<<< Before
  http:
    build:
      context: .
      dockerfile: apps/http/Dockerfile
    ports:
      - "3000:3000"
    environment:
      JWT_PASSWORD: IloveOnkar
      DATABASE_URL: postgresql://postgres:postgres@host.docker.internal:5433/postgres

  ws:
    build:
      context: .
      dockerfile: apps/ws/Dockerfile

    ports:
      - "8080:8080"
    container_name: metaverse-ws
    environment:
      JWT_PASSWORD: IloveOnkar
      DATABASE_URL: postgresql://postgres:postgres@host.docker.internal:5433/postgres
====
>>>> After
  http:
    build:
      context: .
      dockerfile: apps/http/Dockerfile
    ports:
      - "3000:3000"
    environment:
      JWT_PASSWORD: "${JWT_PASSWORD}"
      DATABASE_URL: postgresql://postgres:postgres@host.docker.internal:5433/postgres

  ws:
    build:
      context: .
      dockerfile: apps/ws/Dockerfile
    ports:
      - "8080:8080"
      - "40000-40100:40000-40100/udp"
    container_name: metaverse-ws
    environment:
      JWT_PASSWORD: "${JWT_PASSWORD}"
      DATABASE_URL: postgresql://postgres:postgres@host.docker.internal:5433/postgres
      MEDIASOUP_LISTEN_IP: "0.0.0.0"
      MEDIASOUP_ANNOUNCED_IP: "${MEDIASOUP_ANNOUNCED_IP:-127.0.0.1}"
      RTC_MIN_PORT: "40000"
      RTC_MAX_PORT: "40100"
```

---

# 4. The Proximity Algorithm, Explained

### Step-by-Step Walkthrough with Worked Example

Consider a space with 5 active users positioned on the grid:
- **User A**: $(2, 2)$
- **User B**: $(2, 3)$
- **User C**: $(2, 4)$
- **User D**: $(5, 5)$
- **User E**: $(5, 6)$

```mermaid
graph TD
    subgraph GridSpace ["Grid Topology Example"]
        subgraph Group1 ["Connected Component 1 (Proximity Group 1)"]
            A["User A (2,2)"] --- B["User B (2,3)"]
            B --- C["User C (2,4)"]
        end
        
        subgraph Group2 ["Connected Component 2 (Proximity Group 2)"]
            D["User D (5,5)"] --- E["User E (5,6)"]
        end
    end
```

#### Step 1: Coordinate Map Construction (`posMap`)
A hash map mapping `"x,y"` strings to user instances is constructed in $O(N)$ time:
```text
posMap = {
  "2,2" => User A,
  "2,3" => User B,
  "2,4" => User C,
  "5,5" => User D,
  "5,6" => User E
}
```

#### Step 2: BFS Flood-Fill Visiting Order
The loop iterates through `[User A, User B, User C, User D, User E]`, tracking a `visited` set:

1. **Visit User A**:
   - `visited = { A }`, `queue = [A]`, `group = []`
   - Dequeue `A`: add to `group = [A]`
   - Inspect neighbors of $(2, 2)$:
     - $(2, 1) \rightarrow$ empty
     - $(2, 3) \rightarrow$ finds **User B**. `visited.add(B)`, `queue.push(B)`
     - $(1, 2) \rightarrow$ empty
     - $(3, 2) \rightarrow$ empty
   - Dequeue `B`: add to `group = [A, B]`
   - Inspect neighbors of $(2, 3)$:
     - $(2, 2) \rightarrow$ already in `visited`
     - $(2, 4) \rightarrow$ finds **User C**. `visited.add(C)`, `queue.push(C)`
     - $(1, 3) \rightarrow$ empty
     - $(3, 3) \rightarrow$ empty
   - Dequeue `C`: add to `group = [A, B, C]`
   - Inspect neighbors of $(2, 4)$:
     - $(2, 3) \rightarrow$ already in `visited`
     - $(2, 5) \rightarrow$ empty
     - $(1, 4) \rightarrow$ empty
     - $(3, 4) \rightarrow$ empty
   - Queue is now empty. `groups.push([A, B, C])`.

2. **Visit User B**: Already in `visited`. Skip.
3. **Visit User C**: Already in `visited`. Skip.
4. **Visit User D**:
   - `visited.add(D)`, `queue = [D]`, `group = []`
   - Dequeue `D`: add to `group = [D]`
   - Inspect neighbors of $(5, 5)$:
     - $(5, 6) \rightarrow$ finds **User E**. `visited.add(E)`, `queue.push(E)`
   - Dequeue `E`: add to `group = [D, E]`
   - Queue is empty. `groups.push([D, E])`.
5. **Visit User E**: Already in `visited`. Skip.

**Final Result of `computeGroups()`:**
```text
[
  [User A, User B, User C],
  [User D, User E]
]
```

### Proximity Diffing & The `lastSentProximity` Cache
In `updateProximity(spaceId)`:
1. Solo users receive `nearby: []`.
2. Multi-user groups receive an array of all *other* member IDs, sorted alphabetically:
   - User A: `["B", "C"]`
   - User B: `["A", "C"]`
   - User C: `["A", "B"]`
   - User D: `["E"]`
   - User E: `["D"]`
3. Before dispatching messages, the array is stringified to a signature (e.g. `'["B","C"]'`) and compared against `lastSentProximity.get(userId)`.

**Why this cache is critical:**
On a 2D canvas, a user walking across the room generates dozens of consecutive `move` events. If Player A walks inside an existing cluster, every single step re-evaluates proximity. Without `lastSentProximity`:
- Every movement step would dispatch redundant `PROXIMITY_UPDATE` packets to every player in the space.
- Every step would trigger `MediaManager.syncConsumers()`, repeatedly re-evaluating transports and creating consumer thrash.
The cache guarantees that WebSocket messages and media synchronization fire **strictly on group boundary transitions**.

---

# 5. The mediasoup Data Model, Explained

### Concept Definitions
- **Worker**: An independent, single-threaded C++ OS child process spawned by Node.js that handles low-level UDP socket I/O, encryption, and media packet routing for a specific set of CPU cores.
- **Router**: An audio/video multiplexing hub inside a Worker that manages RTP capabilities, codec negotiation, and track routing for all users inside a specific virtual space.
- **WebRtcTransport**: A bidirectional ICE/DTLS network endpoint on the Router representing a browser's WebRTC connection (one dedicated for sending media to the SFU, one dedicated for receiving media from the SFU).
- **Producer**: A server-side ingest track created on a send transport that receives and demultiplexes a single incoming audio or video RTP stream from a user's microphone or camera.
- **Consumer**: A server-side egress track created on a user's receive transport that duplicates and forwards RTP packets from another peer's Producer to that user's browser.

---

### Handshake: One User Joining and Producing

```mermaid
sequenceDiagram
    autonumber
    participant Browser as Client (useMediasoup)
    participant WS as WebSocket Server (User.ts)
    participant MM as MediaManager
    participant Router as mediasoup Router

    Note over Browser,WS: User joins space and receives 'space-joined'
    Browser->>WS: {"type": "get-router-rtp-capabilities"}
    WS->>MM: getRouterRtpCapabilities(spaceId)
    MM-->>WS: Router RTP Capabilities
    WS-->>Browser: {"type": "router-rtp-capabilities", payload: {rtpCapabilities}}

    Note over Browser: device = new Device()<br/>device.load({routerRtpCapabilities})
    Browser->>WS: {"type": "set-rtp-capabilities", payload: {rtpCapabilities: device.rtpCapabilities}}
    WS->>MM: setRtpCapabilities(userId, rtpCapabilities)

    %% Send Transport Creation
    Browser->>WS: {"type": "create-transport", payload: {direction: "send"}}
    WS->>MM: createWebRtcTransport(userId, "send")
    MM->>Router: createWebRtcTransport(...)
    Router-->>MM: sendTransport
    MM-->>WS: transportInfo (id, iceParameters, iceCandidates, dtlsParameters)
    WS-->>Browser: {"type": "transport-created", payload: {direction: "send", ...transportInfo}}
    Note over Browser: sendTransport = device.createSendTransport(...)

    %% Recv Transport Creation
    Browser->>WS: {"type": "create-transport", payload: {direction: "recv"}}
    WS->>MM: createWebRtcTransport(userId, "recv")
    MM->>Router: createWebRtcTransport(...)
    Router-->>MM: recvTransport
    MM-->>WS: transportInfo (id, iceParameters, iceCandidates, dtlsParameters)
    WS-->>Browser: {"type": "transport-created", payload: {direction: "recv", ...transportInfo}}
    Note over Browser: recvTransport = device.createRecvTransport(...)

    %% Produce Media
    Note over Browser: getUserMedia({audio: true, video: true})<br/>sendTransport.produce({track: audioTrack})
    Browser->>WS: {"type": "connect-transport", payload: {transportId, dtlsParameters}}
    WS->>MM: connectTransport(userId, transportId, dtlsParameters)
    MM-->>WS: OK
    WS-->>Browser: {"type": "transport-connected", payload: {transportId}}

    Browser->>WS: {"type": "produce", payload: {transportId, kind: "audio", rtpParameters}}
    WS->>MM: produce(userId, transportId, "audio", rtpParameters)
    MM->>Router: sendTransport.produce(...)
    Router-->>MM: audioProducer
    MM-->>WS: producerId
    WS-->>Browser: {"type": "produced", payload: {id: producerId, kind: "audio"}}

    Note over Browser: Repeat produce for "video" track
```

---

### Proximity Trigger: Second User Enters Adjacency

When User B moves adjacent to User A, both peers mutually consume each other's tracks:

```mermaid
sequenceDiagram
    autonumber
    participant B_Client as User B Browser
    participant WS as WebSocket Server
    participant RM as RoomManager
    participant MM as MediaManager
    participant A_Client as User A Browser

    Note over B_Client,A_Client: User B moves adjacent to User A
    B_Client->>WS: {"type": "move", payload: {x: 2, y: 3}}
    WS->>RM: updateProximity(spaceId)
    RM->>RM: computeGroups() -> [User A, User B]
    
    %% Notifications
    RM->>WS: Send PROXIMITY_UPDATE to both users
    WS-->>A_Client: {"type": "PROXIMITY_UPDATE", payload: {nearby: ["B"]}}
    WS-->>B_Client: {"type": "PROXIMITY_UPDATE", payload: {nearby: ["A"]}}

    %% Media Synchronization
    RM->>MM: syncConsumers("A", ["B"])
    RM->>MM: syncConsumers("B", ["A"])

    %% Consume User B on User A
    Note over MM: Create Consumer for A consuming B's audio & video
    MM-->>A_Client: {"type": "new-consumer", payload: {peerId: "B", kind: "audio", ...}}
    MM-->>A_Client: {"type": "new-consumer", payload: {peerId: "B", kind: "video", ...}}
    A_Client->>WS: {"type": "resume-consumer", payload: {consumerId}}
    WS->>MM: resumeConsumer("A", consumerId)

    %% Consume User A on User B
    Note over MM: Create Consumer for B consuming A's audio & video
    MM-->>B_Client: {"type": "new-consumer", payload: {peerId: "A", kind: "audio", ...}}
    MM-->>B_Client: {"type": "new-consumer", payload: {peerId: "A", kind: "video", ...}}
    B_Client->>WS: {"type": "resume-consumer", payload: {consumerId}}
    WS->>MM: resumeConsumer("B", consumerId)

    Note over A_Client,B_Client: Both browsers render remote video and play remote audio
```

---

### Walking Apart: 300ms Debounce Disconnect

```mermaid
sequenceDiagram
    autonumber
    participant Client as User A Browser
    participant WS as WebSocket Server
    participant MM as MediaManager

    Note over Client,MM: User B walks away from User A
    WS->>MM: syncConsumers("A", [])
    Note over MM: Start 300ms Debounce Timer for (A -> B)
    
    alt User B steps back within 300ms
        WS->>MM: syncConsumers("A", ["B"])
        Note over MM: clearTimeout(timer) — Call remains uninterrupted!
    else 300ms Timer Expires
        Note over MM: Timer fires: closeConsumersForPeer("A", "B")
        MM->>Client: {"type": "consumer-closed", payload: {peerId: "B"}}
        Note over Client: Remote video tile removed, tracks stopped
    end
```

**Why the debounce exists:**
In a grid-based game, players regularly navigate around obstacles, traverse narrow corridors, or change directions. Without a debounce window, stepping across diagonal tiles or momentarily passing another player would instantly terminate WebRTC consumer pipelines and recreate them 100ms later. This would cause video freeze frames, DTLS handshake thrashing, and audio pops. The 300ms grace period absorbs boundary jitter.

---

# 6. WebSocket Message Catalog

| Direction | Type String | Payload Shape | When Sent | Sent / Handled By |
|---|---|---|---|---|
| Client $\rightarrow$ Server | `join` | `{ spaceId: string, token: string }` | When opening connection to a space | `Game.page.tsx` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `space-joined` | `{ spawn: { x, y }, users: [...] }` | Confirmation that client joined space | `User.ts` $\rightarrow$ `Game.page.tsx` |
| Server $\rightarrow$ Client | `user-join` | `{ userId: string, x: number, y: number }` | Broadcast to space when another user joins | `User.ts` $\rightarrow$ `Game.page.tsx` |
| Client $\rightarrow$ Server | `move` | `{ x: number, y: number }` | When user presses arrow keys or WASD | `Game.page.tsx` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `move` | `{ userId: string, x: number, y: number }` | Broadcast to space when another user moves | `User.ts` $\rightarrow$ `Game.page.tsx` |
| Server $\rightarrow$ Client | `movement-rejected` | `{ x: number, y: number }` | When move is invalid (collision / out-of-bounds) | `User.ts` $\rightarrow$ `Game.page.tsx` |
| Server $\rightarrow$ Client | `user-leave` | `{ userId: string, spaceId: string }` | Broadcast to space when user disconnects | `User.ts` $\rightarrow$ `Game.page.tsx` |
| Server $\rightarrow$ Client | `PROXIMITY_UPDATE` | `{ nearby: string[] }` | Sent when user's adjacent cluster members change | `RoomManager.ts` $\rightarrow$ `Game.page.tsx` |
| Client $\rightarrow$ Server | `get-router-rtp-capabilities` | `{}` | Sent immediately after joining space | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `router-rtp-capabilities` | `{ rtpCapabilities: object }` | Provides SFU router codec capabilities | `User.ts` $\rightarrow$ `useMediasoup.ts` |
| Client $\rightarrow$ Server | `set-rtp-capabilities` | `{ rtpCapabilities: object }` | Informs SFU of client device capabilities | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Client $\rightarrow$ Server | `create-transport` | `{ direction: "send" \| "recv" }` | Requests creation of a WebRtcTransport | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `transport-created` | `{ direction, id, iceParameters, iceCandidates, dtlsParameters }` | Returns server transport connection parameters | `User.ts` $\rightarrow$ `useMediasoup.ts` |
| Client $\rightarrow$ Server | `connect-transport` | `{ transportId: string, dtlsParameters: object }` | Supplies client DTLS parameters to server | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `transport-connected` | `{ transportId: string }` | Confirms transport DTLS connection ready | `User.ts` $\rightarrow$ `useMediasoup.ts` |
| Client $\rightarrow$ Server | `produce` | `{ transportId: string, kind: "audio" \| "video", rtpParameters: object }` | Publishes local audio/video track to SFU | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `produced` | `{ id: string, kind: string }` | Returns server producer ID for track | `User.ts` $\rightarrow$ `useMediasoup.ts` |
| Server $\rightarrow$ Client | `new-consumer` | `{ peerId, id, producerId, kind, rtpParameters }` | Tells client to consume a nearby peer's track | `mediaManager.ts` $\rightarrow$ `useMediasoup.ts` |
| Client $\rightarrow$ Server | `resume-consumer` | `{ consumerId: string }` | Asks SFU to unpause consumer after setup | `useMediasoup.ts` $\rightarrow$ `User.ts` |
| Server $\rightarrow$ Client | `consumer-closed` | `{ peerId: string }` | Notifies client that peer left proximity | `mediaManager.ts` $\rightarrow$ `useMediasoup.ts` |
| Server $\rightarrow$ Client | `producer-closed` | `{ peerId: string, consumerId: string }` | Notifies client that peer closed a track | `mediaManager.ts` $\rightarrow$ `useMediasoup.ts` |
| Server $\rightarrow$ Client | `error` | `{ message: string }` | Error report from media or signaling failure | `User.ts` $\rightarrow$ `useMediasoup.ts` |

---

# 7. Environment Variables

| Variable | Description | Dev Default | Production Setting |
|---|---|---|---|
| `JWT_PASSWORD` | Shared HMAC secret for verifying user authentication tokens. Server will not boot if missing. | Configured in `.env` | Cryptographically secure secret string ($>32$ chars). |
| `MEDIASOUP_LISTEN_IP` | Internal IP address for mediasoup WebRtcTransports to bind UDP/TCP sockets. | `0.0.0.0` | `0.0.0.0` (or the private NIC IP inside your container). |
| `MEDIASOUP_ANNOUNCED_IP` | Publicly routable IP address sent to browsers in ICE candidates. | `127.0.0.1` | The public static IP or Elastic IP of the server. |
| `RTC_MIN_PORT` | Lower bound of UDP port range allocated for WebRTC media transmission. | `40000` | `40000` (must match firewall / Docker UDP port forwarding). |
| `RTC_MAX_PORT` | Upper bound of UDP port range allocated for WebRTC media transmission. | `40100` | `40100` (expand to `40000-49999` for large production loads). |

---

# 8. What Was Removed and Why

1. **Hardcoded `"IloveOnkar"` JWT Fallback in `apps/ws/src/User.ts` and `docker-compose.yaml`**:
   - *What was removed*: `const JWT_PASSWORD = process.env.JWT_PASSWORD ?? "IloveOnkar";`
   - *Risk eliminated*: In production, if an operator omitted the `JWT_PASSWORD` environment variable, the server silently accepted tokens signed with the well-known string `"IloveOnkar"`, allowing arbitrary account impersonation. The server now checks explicitly and crashes immediately on startup if missing.
   - *Pending follow-up in HTTP service*: `apps/http/src/middlewares/auth.middleware.ts`, `apps/http/src/router/auth.router.ts`, and `apps/http/config.ts` still contain fallback defaults (`"IloveOnkar"`). These should be updated to strictly require `process.env.JWT_PASSWORD` in a future pass.

2. **Per-Mover Proximity Loop in `User.ts`**:
   - *What was removed*: Ad-hoc distance checks inside movement handlers that only alerted the player who initiated the move.
   - *Risk eliminated*: Avoided asymmetric game states where the moving player knew someone was near, but the stationary player received zero updates and never initiated their consumer pipeline.

3. **Silent Failure on Media Transport Creation**:
   - *What was removed*: Unhandled promise rejections during transport negotiation.
   - *Risk eliminated*: Replaced with explicit `error` message responses back to the client, preventing browser hangs.

---

# 9. Known Limitations / Follow-Ups

1. **Direct Host Candidates Only (No TURN Server Yet)**:
   - Mediasoup currently advertises only host ICE candidates (`MEDIASOUP_ANNOUNCED_IP`). This operates reliably on local networks, same-network testing, and public IPs with direct UDP access.
   - *Limitation*: Clients behind symmetric NAT or restrictive corporate firewalls that block outbound UDP traffic will fail ICE negotiation.
   - *Follow-Up*: Deploy a TURN relay (e.g., coturn) and configure `iceServers` inside `device.createSendTransport` and `device.createRecvTransport` in `useMediasoup.ts`.

2. **Co-located Architecture (Single Node)**:
   - Both WebSocket signaling and mediasoup C++ workers run on the same physical host.
   - *Limitation*: While efficient for lower resource overhead, a crash in the Node.js event loop drops both WebRTC media and movement, and horizontal scaling across multiple servers is not yet implemented (requires mediasoup PipeTransports across nodes).

3. **No Proximity Group Size Cap**:
   - Any number of adjacent players can join a group.
   - *Limitation*: If 30 players cluster in a single tile square, an $O(N^2)$ explosion of media tracks occurs ($30 \times 29 = 870$ consumers), which will overwhelm lower-end client CPUs.
   - *Follow-Up*: Enforce a `MAX_GROUP_SIZE` limit (e.g., 6 participants) or prioritize nearest audio-only feeds.

4. **Self-Signed / HTTP Limitations**:
   - Modern browsers disable `navigator.mediaDevices.getUserMedia` when loaded over plain HTTP on non-localhost domain names. Production deployments must terminate TLS (HTTPS).

---

# 10. How to Verify Locally

### Prerequisites
- Node.js $\ge 22$
- Postgres database running (default port `5433` as defined in `.env`)
- 3 separate browser profiles (or Chrome Incognito + Firefox + Edge) to avoid local storage token collisions.

---

### Step 1: Start the Backend and Frontend Services

Ensure environment variables exist in `metaverse/apps/ws/.env`:
```env
JWT_PASSWORD="IloveOnkar"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=127.0.0.1
RTC_MIN_PORT=40000
RTC_MAX_PORT=40100
```

Start the dev servers:
```bash
# Terminal 1: HTTP API Server
cd metaverse/apps/http
npm run dev

# Terminal 2: WebSocket & mediasoup SFU Server
cd metaverse/apps/ws
npm run dev

# Terminal 3: Frontend Client
cd metaverse/apps/frontend
npm run dev
```

In the `apps/ws` terminal, verify the following startup log appears:
```text
[MediaManager] Creating X mediasoup Workers (ports 40000-40100)
[MediaManager] X Workers created successfully
[Server] mediasoup Workers initialized
WebSocket server started on port 8080
```

---

### Step 2: Open 3 Browser Sessions

1. Open `http://localhost:5173` in Browser 1 (User A). Sign up / Log in and enter a Space.
2. Open `http://localhost:5173` in an Incognito Window / Browser 2 (User B). Log in and enter the same Space.
3. Open `http://localhost:5173` in a third browser (User C). Log in and enter the same Space.

Allow camera and microphone access when prompted by the browser.
Verify that all 3 browsers display their own mirrored local video stream in the Call Panel with the label **"You"** and the indicator **"Waiting for nearby"**.

---

### Step 3: Trigger Transitive Group Formation

Position the avatars using WASD or Arrow Keys:
- Move **User A** to coordinate $(2, 2)$.
- Move **User B** to coordinate $(2, 3)$ (adjacent to User A).
- Move **User C** to coordinate $(2, 5)$ (isolated, not adjacent).

**Observe State 1 (Pair Call):**
- Users A and B will see their indicator turn green: **"In call with 1"**.
- User A's panel renders a video tile for User B.
- User B's panel renders a video tile for User A.
- User C remains on **"Waiting for nearby"** with no remote tiles.
- Browser Console outputs:
  ```text
  [useMediasoup] Consuming audio from ...
  [useMediasoup] Consuming video from ...
  ```

**Move User C to Coordinate $(2, 4)$ (Chain Formation):**
- User C is now adjacent to User B.
- Because A is connected to B and B is connected to C, the flood-fill resolves a 3-member group `[A, B, C]`.
- All three browsers immediately update their indicator to **"In call with 2"**.
- User A now sees video tiles for **both B and C**, even though A and C are not directly adjacent.
- User C sees video tiles for **both A and B**.

---

### Step 4: Verify Debounced Teardown

- Move **User C** away from $(2, 4)$ to $(2, 6)$.
- Notice that for 300 milliseconds, the connection persists.
- After 300ms, the timer fires:
  - User C's panel transitions back to **"Waiting for nearby"** and clears remote tiles.
  - Users A and B transition to **"In call with 1"** and User C's tile disappears.
- Check the Activity Feed log in the sidebar:
  ```text
  Call ended with <UserC_ID>
  ```
