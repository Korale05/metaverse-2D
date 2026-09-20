import { useState, useEffect, useRef, useCallback } from 'react';
import type { Space } from './Dashboard';


interface UserPos {
  userId: string;
  x: number;
  y: number;
}

interface LogEntry {
  id: string;
  timestamp: string;
  text: string;
  type: 'join' | 'move' | 'leave' | 'info';
}

interface MetaverseRoomProps {
  space: Space;
  token: string;
  currentUser: { userId: string; username: string };
  onLeaveSpace: () => void;
}

const WS_PORT = 8080;

export const MetaverseRoom: React.FC<MetaverseRoomProps> = ({
  space,
  token,
  currentUser,
  onLeaveSpace
}) => {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [myPos, setMyPos] = useState<{ x: number; y: number } | null>(null);
  const [remoteUsers, setRemoteUsers] = useState<Map<string, UserPos>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const gridWidth = space.width || 10;
  const gridHeight = space.height || 10;

  const addLog = useCallback((text: string, type: 'join' | 'move' | 'leave' | 'info' = 'info') => {
    const timeStr = new Date().toLocaleTimeString();
    setLogs((prev) => [
      { id: Math.random().toString(), timestamp: timeStr, text, type },
      ...prev.slice(0, 49) // Keep last 50 logs
    ]);
  }, []);

  // Connect to WebSocket
  useEffect(() => {
    const wsUrl = `ws://${window.location.hostname}:${WS_PORT}`;
    addLog(`Connecting to WebSocket server at ${wsUrl}...`, 'info');
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      addLog('WebSocket connection established!', 'info');
      // Send join room message
      const joinMsg = {
        type: 'join',
        payload: {
          spaceId: space.id,
          token: token
        }
      };
      ws.send(JSON.stringify(joinMsg));
      addLog(`Sent join request for space: ${space.name} (${space.id})`, 'info');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const { type, payload } = msg;

        switch (type) {
          case 'space-joined': {
            const spawnX = payload.spawn?.x ?? 0;
            const spawnY = payload.spawn?.y ?? 0;
            setMyPos({ x: spawnX, y: spawnY });
            addLog(`Spawned in space at position (${spawnX}, ${spawnY})`, 'join');

            // Set existing users
            const initialRemotes = new Map<string, UserPos>();
            if (Array.isArray(payload.users)) {
              payload.users.forEach((u: any) => {
                const uId = u.userId || u.id;
                if (uId && uId !== currentUser.userId) {
                  initialRemotes.set(uId, {
                    userId: uId,
                    x: typeof u.x === 'number' ? u.x : 0,
                    y: typeof u.y === 'number' ? u.y : 0
                  });
                }
              });
            }
            setRemoteUsers(initialRemotes);
            if (initialRemotes.size > 0) {
              addLog(`Found ${initialRemotes.size} other user(s) currently in this room`, 'info');
            }
            break;
          }

          case 'user-join': {
            const uId = payload.userId;
            const uX = payload.x ?? 0;
            const uY = payload.y ?? 0;
            if (uId && uId !== currentUser.userId) {
              setRemoteUsers((prev) => {
                const next = new Map(prev);
                next.set(uId, { userId: uId, x: uX, y: uY });
                return next;
              });
              addLog(`User ${uId.substring(0, 8)} joined space at (${uX}, ${uY})`, 'join');
            }
            break;
          }

          case 'move': {
            const uId = payload.userId;
            const uX = payload.x;
            const uY = payload.y;
            if (uId && uId !== currentUser.userId) {
              setRemoteUsers((prev) => {
                const next = new Map(prev);
                next.set(uId, { userId: uId, x: uX, y: uY });
                return next;
              });
              addLog(`User ${uId.substring(0, 8)} moved to (${uX}, ${uY})`, 'move');
            }
            break;
          }

          case 'user-leave': {
            const uId = payload.userId;
            if (uId) {
              setRemoteUsers((prev) => {
                const next = new Map(prev);
                next.delete(uId);
                return next;
              });
              addLog(`User ${uId.substring(0, 8)} left the space`, 'leave');
            }
            break;
          }

          case 'movement-rejected': {
            if (typeof payload.x === 'number' && typeof payload.y === 'number') {
              setMyPos({ x: payload.x, y: payload.y });
              addLog(`Move rejected by server! Position reset to (${payload.x}, ${payload.y})`, 'leave');
            }
            break;
          }
        }
      } catch (e) {
        console.error("Error parsing WS message", e);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setWsStatus('disconnected');
      addLog('WebSocket error encountered', 'leave');
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      addLog('WebSocket connection closed', 'leave');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [space.id, token, currentUser.userId, addLog]);

  // Handle player movement
  const sendMove = useCallback((targetX: number, targetY: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !myPos) return;

    // Bounds check
    if (targetX < 0 || targetX >= gridWidth || targetY < 0 || targetY >= gridHeight) return;

    // Update local optimistic position first
    setMyPos({ x: targetX, y: targetY });

    // Send move to WS server
    wsRef.current.send(JSON.stringify({
      type: 'move',
      payload: {
        x: targetX,
        y: targetY
      }
    }));
    addLog(`You moved to (${targetX}, ${targetY})`, 'move');
  }, [myPos, gridWidth, gridHeight, addLog]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!myPos) return;
      if (['ArrowUp', 'KeyW'].includes(e.code)) {
        e.preventDefault();
        sendMove(myPos.x, myPos.y - 1);
      } else if (['ArrowDown', 'KeyS'].includes(e.code)) {
        e.preventDefault();
        sendMove(myPos.x, myPos.y + 1);
      } else if (['ArrowLeft', 'KeyA'].includes(e.code)) {
        e.preventDefault();
        sendMove(myPos.x - 1, myPos.y);
      } else if (['ArrowRight', 'KeyD'].includes(e.code)) {
        e.preventDefault();
        sendMove(myPos.x + 1, myPos.y);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [myPos, sendMove]);

  // Render 2D Grid Cells
  const renderGrid = () => {
    const rows = [];
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        // Check if local player is here
        const isMe = myPos && myPos.x === x && myPos.y === y;
        
        // Check if any remote player is here
        const remotesHere: UserPos[] = [];
        remoteUsers.forEach((user) => {
          if (user.x === x && user.y === y) {
            remotesHere.push(user);
          }
        });

        rows.push(
          <div key={`${x}-${y}`} className="grid-cell">
            <span style={{ position: 'absolute', bottom: '2px', right: '3px', fontSize: '0.55rem', opacity: 0.3 }}>
              {x},{y}
            </span>

            {isMe && (
              <div className="avatar-marker me">
                👾
                <div className="avatar-tooltip">YOU ({currentUser.username})</div>
              </div>
            )}

            {!isMe && remotesHere.length > 0 && (
              <div className="avatar-marker other">
                👤
                <div className="avatar-tooltip">
                  {remotesHere[0].userId.substring(0, 6)}
                </div>
              </div>
            )}
          </div>
        );
      }
    }
    return rows;
  };

  return (
    <div className="space-view-container">
      {/* Left Panel: 2D Metaverse Canvas */}
      <div className="glass-panel grid-canvas-panel">
        <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>{space.name}</h2>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Dimension: {gridWidth} x {gridHeight} | Position: {myPos ? `(${myPos.x}, ${myPos.y})` : 'Spawning...'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="user-pill">
              <span className={`status-dot ${wsStatus}`}></span>
              {wsStatus.toUpperCase()}
            </span>
            <button className="glass-button secondary" onClick={onLeaveSpace}>
              Leave Room
            </button>
          </div>
        </div>

        {/* 2D Grid Representation */}
        <div className="space-grid-wrapper">
          <div
            className="space-grid"
            style={{
              gridTemplateColumns: `repeat(${gridWidth}, 44px)`,
              gridTemplateRows: `repeat(${gridHeight}, 44px)`
            }}
          >
            {renderGrid()}
          </div>
        </div>

        {/* Interactive D-Pad Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Use WASD / Arrow Keys or Onscreen D-Pad to move
          </span>
          <div className="dpad-controls">
            <div></div>
            <button 
              className="dpad-btn"
              onClick={() => myPos && sendMove(myPos.x, myPos.y - 1)}
              title="Move Up (W)"
            >
              ▲
            </button>
            <div></div>

            <button 
              className="dpad-btn"
              onClick={() => myPos && sendMove(myPos.x - 1, myPos.y)}
              title="Move Left (A)"
            >
              ◀
            </button>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
              🕹️
            </div>
            <button 
              className="dpad-btn"
              onClick={() => myPos && sendMove(myPos.x + 1, myPos.y)}
              title="Move Right (D)"
            >
              ▶
            </button>

            <div></div>
            <button 
              className="dpad-btn"
              onClick={() => myPos && sendMove(myPos.x, myPos.y + 1)}
              title="Move Down (S)"
            >
              ▼
            </button>
            <div></div>
          </div>
        </div>
      </div>

      {/* Right Panel: Live Activity Feed */}
      <div className="glass-panel activity-feed">
        <div className="feed-title">
          <span>📡</span> Real-time Event Stream
        </div>
        <div className="feed-logs">
          {logs.map((log) => (
            <div key={log.id} className={`log-item ${log.type}`}>
              <span style={{ opacity: 0.6, fontSize: '0.7rem', display: 'block' }}>[{log.timestamp}]</span>
              {log.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
