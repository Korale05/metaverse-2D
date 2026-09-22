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