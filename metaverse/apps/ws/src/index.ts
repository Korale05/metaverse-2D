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