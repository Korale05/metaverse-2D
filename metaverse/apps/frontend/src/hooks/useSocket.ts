import { useEffect, useState } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:8080`;

export const useSocket = () => {
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    console.log("Creating WebSocket!");
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("Connected!");
      setSocket(ws);
    };

    ws.onclose = () => {
      console.log("Disconnected!");
      setSocket(null);
    };

    return () => {
      ws.close();
    };
  }, []);

  return socket;
};
