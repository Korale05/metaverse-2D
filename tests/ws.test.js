import WebSocket from "ws";
import axios from "axios";
import jwt from "jsonwebtoken";

const BACKEND_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:8080";
const JWT_PASSWORD = "IloveOnkar";

// Axios instance configured for API helpers
const api = axios.create({
    baseURL: BACKEND_URL,
    validateStatus: () => true,
});

// Helper: sign up and sign in a user via HTTP API
async function signupAndSignin(role = "user") {
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const username = `ws_user_${uniqueSuffix}`;
    const password = "password123";

    const signupRes = await api.post("/api/v1/signup", {
        username,
        password,
        type: role,
    });
    expect(signupRes.status).toBe(200);
    const userId = signupRes.data.userId;

    const signinRes = await api.post("/api/v1/signin", {
        username,
        password,
    });
    expect(signinRes.status).toBe(200);
    const token = signinRes.data.accessToken;

    return {
        userId,
        username,
        password,
        token,
        authHeaders: {
            headers: {
                Authorization: token,
            },
        },
    };
}

// Helper: create a space via HTTP API
async function createSpace(authHeaders, name = "Test Space", dimensions = "100x100") {
    const res = await api.post(
        "/api/v1/space",
        {
            name,
            dimensions,
        },
        authHeaders
    );
    expect(res.status).toBe(200);
    return res.data.spaceId;
}

// Helper: WebSocket client wrapper with event queues and promise-based message waiting
function createWsClient(url = WS_URL) {
    const ws = new WebSocket(url);
    const messages = [];
    const messageWaiters = [];
    let isClosed = false;
    let closeCode = null;
    let closeReason = null;
    const closeWaiters = [];

    ws.on("message", (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            messages.push(parsed);

            // Check any waiting message listeners
            for (let i = messageWaiters.length - 1; i >= 0; i--) {
                const waiter = messageWaiters[i];
                if (waiter.predicate(parsed)) {
                    messageWaiters.splice(i, 1);
                    waiter.resolve(parsed);
                }
            }
        } catch {
            messages.push(data.toString());
        }
    });

    ws.on("close", (code, reason) => {
        isClosed = true;
        closeCode = code;
        closeReason = reason?.toString();
        for (const waiter of closeWaiters) {
            waiter.resolve({ code, reason: closeReason });
        }
    });

    return {
        ws,
        get messages() {
            return [...messages];
        },
        get isClosed() {
            return isClosed;
        },
        get closeCode() {
            return closeCode;
        },
        waitForOpen(timeout = 3000) {
            return new Promise((resolve, reject) => {
                if (ws.readyState === WebSocket.OPEN) {
                    return resolve();
                }
                const timer = setTimeout(() => {
                    reject(new Error("Timeout waiting for WebSocket open"));
                }, timeout);

                ws.on("open", () => {
                    clearTimeout(timer);
                    resolve();
                });
                ws.on("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
            });
        },
        send(data) {
            const payload = typeof data === "string" ? data : JSON.stringify(data);
            return new Promise((resolve, reject) => {
                ws.send(payload, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        },
        waitForMessage(predicate, timeout = 3000) {
            // Check already received messages first
            const existing = messages.find(predicate);
            if (existing) {
                return Promise.resolve(existing);
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = messageWaiters.findIndex((w) => w.resolve === resolve);
                    if (idx !== -1) messageWaiters.splice(idx, 1);
                    reject(new Error(`Timeout waiting for WS message. Received messages: ${JSON.stringify(messages)}`));
                }, timeout);

                messageWaiters.push({
                    predicate,
                    resolve: (msg) => {
                        clearTimeout(timer);
                        resolve(msg);
                    },
                });
            });
        },
        waitForClose(timeout = 3000) {
            if (isClosed) {
                return Promise.resolve({ code: closeCode, reason: closeReason });
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error("Timeout waiting for WebSocket close"));
                }, timeout);

                closeWaiters.push({
                    resolve: (val) => {
                        clearTimeout(timer);
                        resolve(val);
                    },
                });
            });
        },
        close() {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        },
    };
}

describe("WebSocket Server Test Suite (ws://localhost:8080)", () => {
    let testUser1;
    let testUser2;
    let testUser3;
    let testSpaceId;
    let secondSpaceId;
    let gridSpaceId;

    // Helper to safely navigate a client across coordinates step-by-step
    const navigateClient = async (client, fromX, fromY, toX, toY) => {
        let curX = fromX;
        let curY = fromY;
        while (curX !== toX) {
            curX += (toX > curX ? 1 : -1);
            await client.send({ type: "move", payload: { x: curX, y: curY } });
            await new Promise((r) => setTimeout(r, 15));
        }
        while (curY !== toY) {
            curY += (toY > curY ? 1 : -1);
            await client.send({ type: "move", payload: { x: curX, y: curY } });
            await new Promise((r) => setTimeout(r, 15));
        }
        return { x: curX, y: curY };
    };

    beforeAll(async () => {
        testUser1 = await signupAndSignin("user");
        testUser2 = await signupAndSignin("user");
        testUser3 = await signupAndSignin("user");

        testSpaceId = await createSpace(testUser1.authHeaders, "Primary WS Test Space", "200x200");
        secondSpaceId = await createSpace(testUser2.authHeaders, "Isolated WS Test Space", "150x150");
        gridSpaceId = await createSpace(testUser1.authHeaders, "Grid WS Test Space", "10x10");
    });

    // =========================================================================
    // 1. Connection & Initial Handshake Tests
    // =========================================================================
    describe("1. Connection & Initial Handshake", () => {
        test("should successfully connect to WebSocket server", async () => {
            const client = createWsClient();
            await client.waitForOpen();
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            client.close();
        });

        test("should handle immediate client disconnect cleanly", async () => {
            const client = createWsClient();
            await client.waitForOpen();
            client.close();
            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should safely ignore non-JSON raw strings without crashing", async () => {
            const client = createWsClient();
            await client.waitForOpen();
            await client.send("THIS_IS_NOT_VALID_JSON_STRING");
            // Wait a moment and check connection is still alive
            await new Promise((r) => setTimeout(r, 200));
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            client.close();
        });

        test("should safely ignore unknown message types without crashing", async () => {
            const client = createWsClient();
            await client.waitForOpen();
            await client.send({
                type: "unknown_message_type_xyz",
                payload: { foo: "bar" },
            });
            await new Promise((r) => setTimeout(r, 200));
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            client.close();
        });
    });

    // =========================================================================
    // 2. Authentication & Join Endpoint Tests
    // =========================================================================
    describe("2. Join Endpoint (Authentication & Room Joining)", () => {
        test("should successfully join space with valid token and spaceId", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: testUser1.token,
                },
            });

            const response = await client.waitForMessage((m) => m.type === "space-joined");
            expect(response).toBeDefined();
            expect(response.type).toBe("space-joined");
            expect(response.payload).toHaveProperty("spawn");
            expect(typeof response.payload.spawn.x).toBe("number");
            expect(typeof response.payload.spawn.y).toBe("number");
            expect(response.payload.spawn.x).toBeGreaterThanOrEqual(0);
            expect(response.payload.spawn.y).toBeGreaterThanOrEqual(0);
            expect(Array.isArray(response.payload.users)).toBe(true);

            client.close();
        });

        test("should close connection when join payload is missing token", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when join payload is missing spaceId", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    token: testUser1.token,
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when join payload has invalid/corrupted JWT token", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: "invalid.jwt.token",
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when JWT is signed with incorrect secret", async () => {
            const fakeToken = jwt.sign({ userId: testUser1.userId }, "wrong_secret_key_123");
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: fakeToken,
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when JWT payload has no userId", async () => {
            const tokenWithoutUserId = jwt.sign({ role: "admin" }, JWT_PASSWORD);
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: tokenWithoutUserId,
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when spaceId does not exist in DB", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: "non_existent_space_cuid_12345",
                    token: testUser1.token,
                },
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });

        test("should close connection when join payload is empty", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {},
            });

            await client.waitForClose();
            expect(client.isClosed).toBe(true);
        });
    });

    // =========================================================================
    // 3. Multi-User Joining & Room State Broadcast Tests
    // =========================================================================
    describe("3. Multi-User Joining & Room State Broadcasts", () => {
        test("existing user should receive 'user-join' broadcast when a new user joins the same space", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await client1.waitForOpen();
            await client2.waitForOpen();

            // Client 1 joins space
            await client1.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: testUser1.token,
                },
            });
            const client1JoinRes = await client1.waitForMessage((m) => m.type === "space-joined");
            expect(client1JoinRes.type).toBe("space-joined");

            // Client 2 joins space
            await client2.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: testUser2.token,
                },
            });

            // Client 2 should receive space-joined with existing users containing Client 1
            const client2JoinRes = await client2.waitForMessage((m) => m.type === "space-joined");
            expect(client2JoinRes.type).toBe("space-joined");
            expect(client2JoinRes.payload.users.some((u) => u.id === testUser1.userId)).toBe(true);

            // Client 1 should receive user-join broadcast about Client 2
            const broadcast = await client1.waitForMessage((m) => m.type === "user-join");
            expect(broadcast.type).toBe("user-join");
            expect(broadcast.payload.userId).toBe(testUser2.userId);
            expect(broadcast.payload.x).toBe(client2JoinRes.payload.spawn.x);
            expect(broadcast.payload.y).toBe(client2JoinRes.payload.spawn.y);

            client1.close();
            client2.close();
        });

        test("multiple existing users should all receive 'user-join' broadcast when another user joins", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();
            const client3 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen(), client3.waitForOpen()]);

            // User 1 joins
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await client1.waitForMessage((m) => m.type === "space-joined");

            // User 2 joins
            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            // User 3 joins
            await client3.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser3.token },
            });

            const client3JoinRes = await client3.waitForMessage((m) => m.type === "space-joined");
            expect(client3JoinRes.payload.users.length).toBeGreaterThanOrEqual(2);

            // Both client1 and client2 should get user-join for user3
            const c1Broadcast = await client1.waitForMessage((m) => m.type === "user-join" && m.payload.userId === testUser3.userId);
            const c2Broadcast = await client2.waitForMessage((m) => m.type === "user-join" && m.payload.userId === testUser3.userId);

            expect(c1Broadcast.payload.userId).toBe(testUser3.userId);
            expect(c2Broadcast.payload.userId).toBe(testUser3.userId);

            client1.close();
            client2.close();
            client3.close();
        });

        test("space isolation: users in different spaces should not receive broadcasts or appear in user list", async () => {
            const clientA = createWsClient();
            const clientB = createWsClient();

            await Promise.all([clientA.waitForOpen(), clientB.waitForOpen()]);

            // Client A joins Space 1
            await clientA.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await clientA.waitForMessage((m) => m.type === "space-joined");

            // Client B joins Space 2
            await clientB.send({
                type: "join",
                payload: { spaceId: secondSpaceId, token: testUser2.token },
            });
            const clientBJoinRes = await clientB.waitForMessage((m) => m.type === "space-joined");

            // Client B should not see Client A
            expect(clientBJoinRes.payload.users.some((u) => u.id === testUser1.userId)).toBe(false);

            // Client A should not receive any user-join broadcast for Client B
            let receivedUnexpected = false;
            try {
                await clientA.waitForMessage((m) => m.type === "user-join" && m.payload.userId === testUser2.userId, 400);
                receivedUnexpected = true;
            } catch {
                receivedUnexpected = false;
            }
            expect(receivedUnexpected).toBe(false);

            clientA.close();
            clientB.close();
        });
    });

    // =========================================================================
    // 4. Movement Endpoint Tests (/move) - Valid, Invalid, and Rejection
    // =========================================================================
    describe("4. Movement Endpoint (Move Validation & Broadcasts)", () => {
        test("should successfully broadcast valid 1-step movement (+1 x) to other room members", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            // Both join same space
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");

            const initialX = join1.payload.spawn.x;
            const initialY = join1.payload.spawn.y;

            // Client 1 moves 1 unit right (x + 1)
            await client1.send({
                type: "move",
                payload: {
                    x: initialX + 1,
                    y: initialY,
                },
            });

            // Client 2 should receive move broadcast
            const moveBroadcast = await client2.waitForMessage((m) => m.type === "move" && m.payload.x === initialX + 1);
            expect(moveBroadcast).toBeDefined();
            expect(moveBroadcast.payload.x).toBe(initialX + 1);
            expect(moveBroadcast.payload.y).toBe(initialY);

            // Client 1 should NOT receive their own move broadcast
            const c1MoveBroadcast = client1.messages.find((m) => m.type === "move" && m.payload.x === initialX + 1);
            expect(c1MoveBroadcast).toBeUndefined();

            client1.close();
            client2.close();
        });

        test("should successfully broadcast valid 1-step movements in all 4 cardinal directions (right, left, down, up)", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");

            let currentX = join1.payload.spawn.x;
            let currentY = join1.payload.spawn.y;

            // 1. Move Right: (x + 1, y)
            currentX += 1;
            await client1.send({ type: "move", payload: { x: currentX, y: currentY } });
            const move1 = await client2.waitForMessage((m) => m.type === "move" && m.payload.x === currentX && m.payload.y === currentY);
            expect(move1.payload).toMatchObject({ x: currentX, y: currentY });

            // 2. Move Down / Up: (x, y + 1)
            currentY += 1;
            await client1.send({ type: "move", payload: { x: currentX, y: currentY } });
            const move2 = await client2.waitForMessage((m) => m.type === "move" && m.payload.x === currentX && m.payload.y === currentY);
            expect(move2.payload).toMatchObject({ x: currentX, y: currentY });

            // 3. Move Left: (x - 1, y)
            currentX -= 1;
            await client1.send({ type: "move", payload: { x: currentX, y: currentY } });
            const move3 = await client2.waitForMessage((m) => m.type === "move" && m.payload.x === currentX && m.payload.y === currentY);
            expect(move3.payload).toMatchObject({ x: currentX, y: currentY });

            // 4. Move Up / Down: (x, y - 1)
            currentY -= 1;
            await client1.send({ type: "move", payload: { x: currentX, y: currentY } });
            const move4 = await client2.waitForMessage((m) => m.type === "move" && m.payload.x === currentX && m.payload.y === currentY);
            expect(move4.payload).toMatchObject({ x: currentX, y: currentY });

            client1.close();
            client2.close();
        });

        test("should reject diagonal movement (x + 1, y + 1) with 'movement-rejected'", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const spawnX = join.payload.spawn.x;
            const spawnY = join.payload.spawn.y;

            // Attempt diagonal move
            await client.send({
                type: "move",
                payload: {
                    x: spawnX + 1,
                    y: spawnY + 1,
                },
            });

            const rejection = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rejection.type).toBe("movement-rejected");
            expect(rejection.payload.x).toBe(spawnX);
            expect(rejection.payload.y).toBe(spawnY);

            client.close();
        });

        test("should reject large multi-step jump / teleport with 'movement-rejected'", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const spawnX = join.payload.spawn.x;
            const spawnY = join.payload.spawn.y;

            // Attempt teleport jump
            await client.send({
                type: "move",
                payload: {
                    x: spawnX + 10,
                    y: spawnY,
                },
            });

            const rejection = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rejection.type).toBe("movement-rejected");
            expect(rejection.payload.x).toBe(spawnX);
            expect(rejection.payload.y).toBe(spawnY);

            client.close();
        });

        test("should reject 0-step move (same position) with 'movement-rejected'", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const spawnX = join.payload.spawn.x;
            const spawnY = join.payload.spawn.y;

            // Move to exactly the same spot
            await client.send({
                type: "move",
                payload: {
                    x: spawnX,
                    y: spawnY,
                },
            });

            const rejection = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rejection.type).toBe("movement-rejected");
            expect(rejection.payload.x).toBe(spawnX);
            expect(rejection.payload.y).toBe(spawnY);

            client.close();
        });

        test("rejected moves should not be broadcast to other room members", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");

            // Client 1 attempts illegal teleport
            await client1.send({
                type: "move",
                payload: {
                    x: join1.payload.spawn.x + 50,
                    y: join1.payload.spawn.y + 50,
                },
            });

            // Client 1 gets rejection
            await client1.waitForMessage((m) => m.type === "movement-rejected");

            // Client 2 should not receive any move broadcast
            let receivedMove = false;
            try {
                await client2.waitForMessage((m) => m.type === "move" && m.payload.x === join1.payload.spawn.x + 50, 400);
                receivedMove = true;
            } catch {
                receivedMove = false;
            }
            expect(receivedMove).toBe(false);

            client1.close();
            client2.close();
        });

        test("user position should remain consistent after rejected move", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const spawnX = join.payload.spawn.x;
            const spawnY = join.payload.spawn.y;

            // 1. Illegal move
            await client.send({
                type: "move",
                payload: { x: spawnX + 99, y: spawnY + 99 },
            });
            await client.waitForMessage((m) => m.type === "movement-rejected");

            // 2. Move relative to hypothetical rejected position (+100) -> should be rejected
            await client.send({
                type: "move",
                payload: { x: spawnX + 100, y: spawnY + 99 },
            });
            const rejection2 = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rejection2.payload.x).toBe(spawnX);
            expect(rejection2.payload.y).toBe(spawnY);

            // 3. Move 1 step from actual initial spawn position -> should be accepted (no rejection)
            await client.send({
                type: "move",
                payload: { x: spawnX + 1, y: spawnY },
            });
            // Wait brief moment and confirm no rejection
            await new Promise((r) => setTimeout(r, 200));
            const rejections = client.messages.filter((m) => m.type === "movement-rejected");
            expect(rejections.length).toBe(2); // Only the first two

            client.close();
        });

        test("should ignore move requests if user has not joined any space yet", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "move",
                payload: { x: 10, y: 10 },
            });

            await new Promise((r) => setTimeout(r, 200));
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            expect(client.messages.length).toBe(0);

            client.close();
        });

        test("should safely ignore malformed move payloads (non-numeric coordinates)", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await client.waitForMessage((m) => m.type === "space-joined");

            await client.send({
                type: "move",
                payload: { x: "string_x", y: null },
            });

            await new Promise((r) => setTimeout(r, 200));
            expect(client.ws.readyState).toBe(WebSocket.OPEN);

            client.close();
        });

        test("movement in one space should not broadcast to users in another space", async () => {
            const clientA = createWsClient();
            const clientB = createWsClient();

            await Promise.all([clientA.waitForOpen(), clientB.waitForOpen()]);

            // Client A in Space 1
            await clientA.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const joinA = await clientA.waitForMessage((m) => m.type === "space-joined");

            // Client B in Space 2
            await clientB.send({
                type: "join",
                payload: { spaceId: secondSpaceId, token: testUser2.token },
            });
            await clientB.waitForMessage((m) => m.type === "space-joined");

            // Client A moves
            await clientA.send({
                type: "move",
                payload: {
                    x: joinA.payload.spawn.x + 1,
                    y: joinA.payload.spawn.y,
                },
            });

            // Client B should not receive any move event
            let clientBReceivedMove = false;
            try {
                await clientB.waitForMessage((m) => m.type === "move", 400);
                clientBReceivedMove = true;
            } catch {
                clientBReceivedMove = false;
            }
            expect(clientBReceivedMove).toBe(false);

            clientA.close();
            clientB.close();
        });
    });

    // =========================================================================
    // 5. User Disconnection & Leave Broadcast Tests
    // =========================================================================
    describe("5. User Leave & Disconnection Broadcasts", () => {
        test("remaining users should receive 'user-leave' broadcast when a user closes connection", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            // User 1 joins
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await client1.waitForMessage((m) => m.type === "space-joined");

            // User 2 joins
            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            // User 2 leaves/disconnects
            client2.close();
            await client2.waitForClose();

            // User 1 should receive user-leave broadcast
            const leaveMsg = await client1.waitForMessage((m) => m.type === "user-leave");
            expect(leaveMsg.type).toBe("user-leave");
            expect(leaveMsg.payload.userId).toBe(testUser2.userId);
            expect(leaveMsg.payload.spaceId).toBe(testSpaceId);

            client1.close();
        });

        test("new users joining after someone leaves should not see the departed user in room", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();
            const client3 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen(), client3.waitForOpen()]);

            // User 1 joins
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await client1.waitForMessage((m) => m.type === "space-joined");

            // User 2 joins
            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");

            // User 2 leaves
            client2.close();
            await client2.waitForClose();
            await client1.waitForMessage((m) => m.type === "user-leave");

            // User 3 joins
            await client3.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser3.token },
            });
            const join3 = await client3.waitForMessage((m) => m.type === "space-joined");

            // User 3 should see User 1 but NOT User 2
            expect(join3.payload.users.some((u) => u.id === testUser1.userId)).toBe(true);
            expect(join3.payload.users.some((u) => u.id === testUser2.userId)).toBe(false);

            client1.close();
            client3.close();
        });
    });

    // Helper to position two clients adjacent to each other in a 2x2 grid
    const makeAdjacent = async (client1, client2, c1Spawn, c2Spawn) => {
        let c1 = { ...c1Spawn };
        let c2 = { ...c2Spawn };

        if (c1.x === c2.x && c1.y === c2.y) {
            // Both spawned at same tile -> move client2 one step
            const nextX = c2.x === 0 ? 1 : 0;
            await client2.send({ type: "move", payload: { x: nextX, y: c2.y } });
            try {
                await client1.waitForMessage((m) => m.type === "move" && m.payload.x === nextX && m.payload.y === c2.y, 1000);
            } catch {}
            c2.x = nextX;
        } else if (Math.abs(c1.x - c2.x) === 1 && Math.abs(c1.y - c2.y) === 1) {
            // Diagonal: move client1 along X to match c2.x (which is 1 step from c1 and not occupied)
            const nextX = c2.x;
            await client1.send({ type: "move", payload: { x: nextX, y: c1.y } });
            try {
                await client2.waitForMessage((m) => m.type === "move" && m.payload.x === nextX && m.payload.y === c1.y, 1000);
            } catch {}
            c1.x = nextX;
        }
        return { c1, c2 };
    };

    // =========================================================================
    // 6. Collision Detection & Prevention Tests
    // =========================================================================
    describe("6. Collision Detection & Prevention", () => {
        test("should reject movement when moving directly onto an adjacent occupied tile", async () => {
            const spaceId = await createSpace(testUser1.authHeaders, "Collision Space 1", "2x2");
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({
                type: "join",
                payload: { spaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId, token: testUser2.token },
            });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            // Bring client1 and client2 into adjacent positions
            const { c1, c2 } = await makeAdjacent(client1, client2, join1.payload.spawn, join2.payload.spawn);

            // Client 1 attempts to step directly into Client 2's occupied coordinate (c2.x, c2.y)
            await client1.send({
                type: "move",
                payload: { x: c2.x, y: c2.y },
            });

            // Client 1 MUST receive movement-rejected with their current position (c1.x, c1.y)
            const rejection = await client1.waitForMessage(
                (m) => m.type === "movement-rejected" && m.payload.x === c1.x && m.payload.y === c1.y
            );
            expect(rejection).toBeDefined();
            expect(rejection.payload.x).toBe(c1.x);
            expect(rejection.payload.y).toBe(c1.y);

            // Client 2 must NOT receive a move broadcast for that collided position
            let unexpectedMove = false;
            try {
                await client2.waitForMessage(
                    (m) => m.type === "move" && m.payload.x === c2.x && m.payload.y === c2.y && m.payload.userId === testUser1.userId,
                    200
                );
                unexpectedMove = true;
            } catch {
                unexpectedMove = false;
            }
            expect(unexpectedMove).toBe(false);

            client1.close();
            client2.close();
        });

        test("should allow moving into a tile after the occupant moves away (freed position)", async () => {
            const spaceId = await createSpace(testUser1.authHeaders, "Collision Space 2", "2x2");
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({
                type: "join",
                payload: { spaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId, token: testUser2.token },
            });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            const { c1, c2 } = await makeAdjacent(client1, client2, join1.payload.spawn, join2.payload.spawn);

            // 1. Client 1 tries to move onto Client 2 (collision) -> rejected
            await client1.send({ type: "move", payload: { x: c2.x, y: c2.y } });
            await client1.waitForMessage((m) => m.type === "movement-rejected");

            // 2. Client 2 moves to an adjacent unoccupied tile in 2x2 grid
            let targetC2X = c2.x;
            let targetC2Y = c2.y;
            if (c1.x === c2.x) {
                targetC2X = c2.x === 0 ? 1 : 0;
            } else {
                targetC2Y = c2.y === 0 ? 1 : 0;
            }

            await client2.send({ type: "move", payload: { x: targetC2X, y: targetC2Y } });
            await client1.waitForMessage((m) => m.type === "move" && m.payload.x === targetC2X && m.payload.y === targetC2Y);

            // 3. Client 1 now moves into (c2.x, c2.y) (now vacant) -> SUCCESS
            await client1.send({ type: "move", payload: { x: c2.x, y: c2.y } });
            const moveSuccess = await client2.waitForMessage(
                (m) => m.type === "move" && m.payload.x === c2.x && m.payload.y === c2.y && m.payload.userId === testUser1.userId
            );
            expect(moveSuccess).toBeDefined();
            expect(moveSuccess.payload.x).toBe(c2.x);
            expect(moveSuccess.payload.y).toBe(c2.y);

            client1.close();
            client2.close();
        });

        test("should allow moving into a tile after the occupant disconnects from space", async () => {
            const spaceId = await createSpace(testUser1.authHeaders, "Collision Space 3", "2x2");
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({
                type: "join",
                payload: { spaceId, token: testUser1.token },
            });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({
                type: "join",
                payload: { spaceId, token: testUser2.token },
            });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            const { c1, c2 } = await makeAdjacent(client1, client2, join1.payload.spawn, join2.payload.spawn);

            // Client 1 attempts move onto Client 2 -> Rejected
            await client1.send({ type: "move", payload: { x: c2.x, y: c2.y } });
            await client1.waitForMessage((m) => m.type === "movement-rejected");

            // Client 2 disconnects
            client2.close();
            await client2.waitForClose();
            await client1.waitForMessage((m) => m.type === "user-leave");

            // Client 1 now steps into the vacated coordinate (c2.x, c2.y) -> should succeed without rejection
            await client1.send({ type: "move", payload: { x: c2.x, y: c2.y } });

            // Verify no new movement-rejected is sent
            await new Promise((r) => setTimeout(r, 100));
            const rejections = client1.messages.filter((m) => m.type === "movement-rejected");
            expect(rejections.length).toBe(1); // Only the first rejection before disconnect

            client1.close();
        });

        test("multi-user collision cascade across 3 positioned users", async () => {
            const spaceId = await createSpace(testUser1.authHeaders, "Collision Cascade Space", "4x2");
            const client1 = createWsClient();
            const client2 = createWsClient();
            const client3 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen(), client3.waitForOpen()]);

            // 1. Client 1 joins (alone in space) -> position at (0, 0)
            await client1.send({ type: "join", payload: { spaceId, token: testUser1.token } });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");
            let c1 = { ...join1.payload.spawn };
            if (c1.y !== 0) {
                await client1.send({ type: "move", payload: { x: c1.x, y: 0 } });
                c1.y = 0;
            }
            while (c1.x > 0) {
                c1.x -= 1;
                await client1.send({ type: "move", payload: { x: c1.x, y: 0 } });
                await new Promise((r) => setTimeout(r, 20));
            }

            // 2. Client 2 joins -> position at (1, 0)
            await client2.send({ type: "join", payload: { spaceId, token: testUser2.token } });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");
            let c2 = { ...join2.payload.spawn };
            if (c2.x === 0 && c2.y === 0) {
                await client2.send({ type: "move", payload: { x: 0, y: 1 } });
                c2 = { x: 0, y: 1 };
            }
            if (c2.y !== 1) {
                await client2.send({ type: "move", payload: { x: c2.x, y: 1 } });
                c2.y = 1;
            }
            while (c2.x < 1) {
                c2.x += 1;
                await client2.send({ type: "move", payload: { x: c2.x, y: 1 } });
                await new Promise((r) => setTimeout(r, 20));
            }
            while (c2.x > 1) {
                c2.x -= 1;
                await client2.send({ type: "move", payload: { x: c2.x, y: 1 } });
                await new Promise((r) => setTimeout(r, 20));
            }
            // Move up to (1, 0)
            await client2.send({ type: "move", payload: { x: 1, y: 0 } });
            c2 = { x: 1, y: 0 };

            // 3. Client 3 joins -> position at (2, 0)
            await client3.send({ type: "join", payload: { spaceId, token: testUser3.token } });
            const join3 = await client3.waitForMessage((m) => m.type === "space-joined");
            let c3 = { ...join3.payload.spawn };
            if (c3.y === 0 && (c3.x === 0 || c3.x === 1)) {
                await client3.send({ type: "move", payload: { x: c3.x, y: 1 } });
                c3.y = 1;
            }
            if (c3.y !== 1) {
                await client3.send({ type: "move", payload: { x: c3.x, y: 1 } });
                c3.y = 1;
            }
            while (c3.x < 2) {
                c3.x += 1;
                await client3.send({ type: "move", payload: { x: c3.x, y: 1 } });
                await new Promise((r) => setTimeout(r, 20));
            }
            while (c3.x > 2) {
                c3.x -= 1;
                await client3.send({ type: "move", payload: { x: c3.x, y: 1 } });
                await new Promise((r) => setTimeout(r, 20));
            }
            // Move up to (2, 0)
            await client3.send({ type: "move", payload: { x: 2, y: 0 } });
            c3 = { x: 2, y: 0 };

            // Cascade verification:
            // Client 1 at (0, 0) attempts to step into Client 2 at (1, 0) -> rejected
            await client1.send({ type: "move", payload: { x: 1, y: 0 } });
            const rej1 = await client1.waitForMessage((m) => m.type === "movement-rejected" && m.payload.x === 0 && m.payload.y === 0);
            expect(rej1).toBeDefined();

            // Client 2 at (1, 0) attempts to step into Client 3 at (2, 0) -> rejected
            await client2.send({ type: "move", payload: { x: 2, y: 0 } });
            const rej2 = await client2.waitForMessage((m) => m.type === "movement-rejected" && m.payload.x === 1 && m.payload.y === 0);
            expect(rej2).toBeDefined();

            // Client 3 at (2, 0) moves down to (2, 1) freeing (2, 0)
            await client3.send({ type: "move", payload: { x: 2, y: 1 } });
            await client2.waitForMessage((m) => m.type === "move" && m.payload.x === 2 && m.payload.y === 1);

            // Now Client 2 can move into (2, 0)
            await client2.send({ type: "move", payload: { x: 2, y: 0 } });
            await client1.waitForMessage((m) => m.type === "move" && m.payload.x === 2 && m.payload.y === 0);

            // Now Client 1 can move into (1, 0)
            await client1.send({ type: "move", payload: { x: 1, y: 0 } });
            await client2.waitForMessage((m) => m.type === "move" && m.payload.x === 1 && m.payload.y === 0);

            client1.close();
            client2.close();
            client3.close();
        });
    });

    // =========================================================================
    // 7. Boundary Checking & Coordinate Validation Tests
    // =========================================================================
    describe("7. Boundary Checking & Coordinate Validation", () => {
        test("spawn point coordinates must strictly lie within the space boundary dimensions", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");

            // Primary space is 200x200 (width: 200, height: 200)
            expect(join.payload.spawn.x).toBeGreaterThanOrEqual(0);
            expect(join.payload.spawn.x).toBeLessThan(200);
            expect(join.payload.spawn.y).toBeGreaterThanOrEqual(0);
            expect(join.payload.spawn.y).toBeLessThan(200);

            client.close();
        });

        test("should reject multi-tile leaps across coordinate boundaries with movement-rejected", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const { x, y } = join.payload.spawn;

            // Multi-step jump (+2 on x)
            await client.send({ type: "move", payload: { x: x + 2, y: y } });
            let rej = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rej.payload).toEqual({ x, y });

            // Multi-step jump (-2 on y)
            await client.send({ type: "move", payload: { x: x, y: y - 2 } });
            rej = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rej.payload).toEqual({ x, y });

            client.close();
        });

        test("should reject extreme negative and excessively large out-of-bounds coordinates safely", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            const { x, y } = join.payload.spawn;

            // Extreme negative coordinate
            await client.send({ type: "move", payload: { x: -999999, y: -999999 } });
            let rej = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rej.payload).toEqual({ x, y });

            // Excessively large coordinate
            await client.send({ type: "move", payload: { x: 1000000, y: 1000000 } });
            rej = await client.waitForMessage((m) => m.type === "movement-rejected");
            expect(rej.payload).toEqual({ x, y });

            expect(client.ws.readyState).toBe(WebSocket.OPEN);
            client.close();
        });
    });

    // =========================================================================
    // 8. Duplicate Join (Same Connection) Tests
    // =========================================================================
    describe("8. Duplicate Join on Same WebSocket Connection", () => {
        test("sending duplicate join on the same socket connection re-registers spawn and sends space-joined", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            // First Join
            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const firstJoin = await client.waitForMessage((m) => m.type === "space-joined");
            expect(firstJoin.type).toBe("space-joined");
            expect(typeof firstJoin.payload.spawn.x).toBe("number");

            // Second Join on same socket
            await client.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await new Promise((r) => setTimeout(r, 200));

            // Should receive another space-joined confirmation
            const joinMessages = client.messages.filter((m) => m.type === "space-joined");
            expect(joinMessages.length).toBe(2);

            // Client connection remains OPEN and functional
            expect(client.ws.readyState).toBe(WebSocket.OPEN);

            client.close();
        });

        test("subsequent moves work seamlessly after a duplicate join on the same socket", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            // Client 2 in space as observer
            await client2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser2.token },
            });
            await client2.waitForMessage((m) => m.type === "space-joined");

            // Client 1 joins first time
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await client1.waitForMessage((m) => m.type === "space-joined");

            // Client 1 joins second time
            await client1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await new Promise((r) => setTimeout(r, 100));

            const joinMessages = client1.messages.filter((m) => m.type === "space-joined");
            const latestSpawn = joinMessages[joinMessages.length - 1].payload.spawn;

            // Client 1 makes a valid 1-step move from latest spawn
            await client1.send({
                type: "move",
                payload: { x: latestSpawn.x + 1, y: latestSpawn.y },
            });

            // Client 2 should receive the move broadcast
            const moveBroadcast = await client2.waitForMessage(
                (m) => m.type === "move" && m.payload.x === latestSpawn.x + 1 && m.payload.userId === testUser1.userId
            );
            expect(moveBroadcast).toBeDefined();

            client1.close();
            client2.close();
        });
    });

    // =========================================================================
    // 9. Multi-Session Login (Join Same User Twice on Separate Sockets)
    // =========================================================================
    describe("9. Join Same User Twice (Multi-Session with Same User Token)", () => {
        test("two separate websocket connections joining with the same user token both succeed", async () => {
            const session1 = createWsClient();
            const session2 = createWsClient();

            await Promise.all([session1.waitForOpen(), session2.waitForOpen()]);

            // Session 1 joins as testUser1
            await session1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join1 = await session1.waitForMessage((m) => m.type === "space-joined");
            expect(join1.type).toBe("space-joined");

            // Session 2 joins as testUser1
            await session2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join2 = await session2.waitForMessage((m) => m.type === "space-joined");
            expect(join2.type).toBe("space-joined");

            // Session 1 receives user-join broadcast when Session 2 connects
            const session1JoinNotice = await session1.waitForMessage((m) => m.type === "user-join" && m.payload.userId === testUser1.userId);
            expect(session1JoinNotice).toBeDefined();
            expect(session1JoinNotice.payload.userId).toBe(testUser1.userId);

            session1.close();
            session2.close();
        });

        test("moves from one session are broadcast to the second session of the same user", async () => {
            const session1 = createWsClient();
            const session2 = createWsClient();

            await Promise.all([session1.waitForOpen(), session2.waitForOpen()]);

            await session1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join1 = await session1.waitForMessage((m) => m.type === "space-joined");

            await session2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join2 = await session2.waitForMessage((m) => m.type === "space-joined");

            const s1X = join1.payload.spawn.x;
            const s1Y = join1.payload.spawn.y;

            // Session 1 moves
            await session1.send({
                type: "move",
                payload: { x: s1X + 1, y: s1Y },
            });

            // Session 2 receives the move broadcast with the same userId
            const moveMsg = await session2.waitForMessage(
                (m) => m.type === "move" && m.payload.x === s1X + 1 && m.payload.userId === testUser1.userId
            );
            expect(moveMsg).toBeDefined();
            expect(moveMsg.payload.userId).toBe(testUser1.userId);

            // Session 2 moves
            const s2X = join2.payload.spawn.x;
            const s2Y = join2.payload.spawn.y;
            await session2.send({
                type: "move",
                payload: { x: s2X + 1, y: s2Y },
            });

            // Session 1 receives the move broadcast
            const s1MoveMsg = await session1.waitForMessage(
                (m) => m.type === "move" && m.payload.x === s2X + 1 && m.payload.userId === testUser1.userId
            );
            expect(s1MoveMsg).toBeDefined();

            session1.close();
            session2.close();
        });

        test("disconnecting one session emits user-leave to the remaining session without closing it", async () => {
            const session1 = createWsClient();
            const session2 = createWsClient();

            await Promise.all([session1.waitForOpen(), session2.waitForOpen()]);

            await session1.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            await session1.waitForMessage((m) => m.type === "space-joined");

            await session2.send({
                type: "join",
                payload: { spaceId: testSpaceId, token: testUser1.token },
            });
            const join2 = await session2.waitForMessage((m) => m.type === "space-joined");

            // Session 1 disconnects
            session1.close();
            await session1.waitForClose();

            // Session 2 receives user-leave
            const leaveMsg = await session2.waitForMessage((m) => m.type === "user-leave" && m.payload.userId === testUser1.userId);
            expect(leaveMsg).toBeDefined();
            expect(leaveMsg.payload.userId).toBe(testUser1.userId);

            // Session 2 is still open and can move
            expect(session2.ws.readyState).toBe(WebSocket.OPEN);
            const s2X = join2.payload.spawn.x;
            const s2Y = join2.payload.spawn.y;
            await session2.send({
                type: "move",
                payload: { x: s2X + 1, y: s2Y },
            });
            await new Promise((r) => setTimeout(r, 100));
            expect(session2.ws.readyState).toBe(WebSocket.OPEN);

            session2.close();
        });
    });

    // =========================================================================
    // 10. Concurrent Moves & Race Conditions Tests
    // =========================================================================
    describe("10. Concurrent Moves & Race Conditions", () => {
        test("two users executing parallel concurrent moves into independent tiles", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({ type: "join", payload: { spaceId: testSpaceId, token: testUser1.token } });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({ type: "join", payload: { spaceId: testSpaceId, token: testUser2.token } });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");

            const c1X = join1.payload.spawn.x;
            const c1Y = join1.payload.spawn.y;
            const c2X = join2.payload.spawn.x;
            const c2Y = join2.payload.spawn.y;

            // Fire moves concurrently via Promise.all
            await Promise.all([
                client1.send({ type: "move", payload: { x: c1X + 1, y: c1Y } }),
                client2.send({ type: "move", payload: { x: c2X, y: c2Y + 1 } }),
            ]);

            // Client 1 receives Client 2's move
            const c1Received = await client1.waitForMessage(
                (m) => m.type === "move" && m.payload.y === c2Y + 1 && m.payload.userId === testUser2.userId
            );
            expect(c1Received).toBeDefined();

            // Client 2 receives Client 1's move
            const c2Received = await client2.waitForMessage(
                (m) => m.type === "move" && m.payload.x === c1X + 1 && m.payload.userId === testUser1.userId
            );
            expect(c2Received).toBeDefined();

            client1.close();
            client2.close();
        });

        test("race condition: two users racing concurrently for the same unoccupied tile", async () => {
            const spaceId = await createSpace(testUser1.authHeaders, "Race Condition Space", "3x1");
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            // Client 1 joins space and positions at (0, 0)
            await client1.send({ type: "join", payload: { spaceId, token: testUser1.token } });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");
            let c1X = join1.payload.spawn.x;
            if (c1X === 2) {
                await client1.send({ type: "move", payload: { x: 1, y: 0 } });
                await new Promise((r) => setTimeout(r, 20));
                c1X = 1;
            }
            if (c1X === 1) {
                await client1.send({ type: "move", payload: { x: 0, y: 0 } });
                await new Promise((r) => setTimeout(r, 20));
                c1X = 0;
            }

            // Client 2 joins space and positions at (2, 0)
            await client2.send({ type: "join", payload: { spaceId, token: testUser2.token } });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");
            await client1.waitForMessage((m) => m.type === "user-join");

            let c2X = join2.payload.spawn.x;
            if (c2X === 0) {
                await client2.send({ type: "move", payload: { x: 1, y: 0 } });
                await new Promise((r) => setTimeout(r, 20));
                c2X = 1;
            }
            if (c2X === 1) {
                await client2.send({ type: "move", payload: { x: 2, y: 0 } });
                await new Promise((r) => setTimeout(r, 20));
                c2X = 2;
            }

            // Flush prior messages
            await new Promise((r) => setTimeout(r, 50));
            const c1InitialRejections = client1.messages.filter((m) => m.type === "movement-rejected").length;
            const c2InitialRejections = client2.messages.filter((m) => m.type === "movement-rejected").length;

            // Both users send move to common middle tile (1, 0) simultaneously
            await Promise.all([
                client1.send({ type: "move", payload: { x: 1, y: 0 } }),
                client2.send({ type: "move", payload: { x: 1, y: 0 } }),
            ]);

            // Give server brief moment to process
            await new Promise((r) => setTimeout(r, 200));

            // Check new movement-rejected messages
            const c1NewRejections = client1.messages.filter((m) => m.type === "movement-rejected").length - c1InitialRejections;
            const c2NewRejections = client2.messages.filter((m) => m.type === "movement-rejected").length - c2InitialRejections;

            // Exactly ONE client should receive movement-rejected, and the other successfully moved
            expect(Boolean(c1NewRejections > 0) !== Boolean(c2NewRejections > 0)).toBe(true);

            client1.close();
            client2.close();
        });

        test("high concurrency: rapid bursts of 10 parallel movements without connection drops", async () => {
            const client1 = createWsClient();
            const client2 = createWsClient();

            await Promise.all([client1.waitForOpen(), client2.waitForOpen()]);

            await client1.send({ type: "join", payload: { spaceId: testSpaceId, token: testUser1.token } });
            const join1 = await client1.waitForMessage((m) => m.type === "space-joined");

            await client2.send({ type: "join", payload: { spaceId: testSpaceId, token: testUser2.token } });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");

            let c1X = join1.payload.spawn.x;
            let c1Y = join1.payload.spawn.y;
            let c2X = join2.payload.spawn.x;
            let c2Y = join2.payload.spawn.y;

            // Send 10 consecutive moves from both clients
            for (let i = 1; i <= 10; i++) {
                c1X += 1;
                c2Y += 1;
                await Promise.all([
                    client1.send({ type: "move", payload: { x: c1X, y: c1Y } }),
                    client2.send({ type: "move", payload: { x: c2X, y: c2Y } }),
                ]);
                await client2.waitForMessage((m) => m.type === "move" && m.payload.x === c1X && m.payload.userId === testUser1.userId);
                await client1.waitForMessage((m) => m.type === "move" && m.payload.y === c2Y && m.payload.userId === testUser2.userId);
            }

            expect(client1.ws.readyState).toBe(WebSocket.OPEN);
            expect(client2.ws.readyState).toBe(WebSocket.OPEN);

            client1.close();
            client2.close();
        });
    });

    // =========================================================================
    // 11. Edge Cases, Robustness & Lifecycle Scenarios
    // =========================================================================
    describe("11. Lifecycle, Edge Cases & Robustness", () => {
        test("rapid join-move-leave-rejoin cycle on fresh sockets", async () => {
            for (let cycle = 0; cycle < 3; cycle++) {
                const client = createWsClient();
                await client.waitForOpen();

                await client.send({
                    type: "join",
                    payload: { spaceId: testSpaceId, token: testUser1.token },
                });
                const join = await client.waitForMessage((m) => m.type === "space-joined");
                expect(join.type).toBe("space-joined");

                // Perform a move
                await client.send({
                    type: "move",
                    payload: { x: join.payload.spawn.x + 1, y: join.payload.spawn.y },
                });
                await new Promise((r) => setTimeout(r, 50));

                client.close();
                await client.waitForClose();
                expect(client.isClosed).toBe(true);
            }
        });

        test("empty room cleanup: single user leaves room completely, then new user joins fresh room", async () => {
            // First user joins and leaves
            const client1 = createWsClient();
            await client1.waitForOpen();
            await client1.send({
                type: "join",
                payload: { spaceId: secondSpaceId, token: testUser1.token },
            });
            await client1.waitForMessage((m) => m.type === "space-joined");
            client1.close();
            await client1.waitForClose();

            // Second user joins the now empty space
            const client2 = createWsClient();
            await client2.waitForOpen();
            await client2.send({
                type: "join",
                payload: { spaceId: secondSpaceId, token: testUser2.token },
            });
            const join2 = await client2.waitForMessage((m) => m.type === "space-joined");

            // Should see 0 existing users in the empty room
            expect(join2.payload.users.length).toBe(0);

            client2.close();
        });

        test("should ignore extra unexpected properties in join and move payloads gracefully", async () => {
            const client = createWsClient();
            await client.waitForOpen();

            await client.send({
                type: "join",
                payload: {
                    spaceId: testSpaceId,
                    token: testUser1.token,
                    extraField: "ignored_value",
                    nested: { a: 1, b: [1, 2, 3] },
                },
            });
            const join = await client.waitForMessage((m) => m.type === "space-joined");
            expect(join.type).toBe("space-joined");

            await client.send({
                type: "move",
                payload: {
                    x: join.payload.spawn.x + 1,
                    y: join.payload.spawn.y,
                    metadata: "extra",
                    speed: 100,
                },
            });
            await new Promise((r) => setTimeout(r, 100));
            expect(client.ws.readyState).toBe(WebSocket.OPEN);

            client.close();
        });
    });
});
