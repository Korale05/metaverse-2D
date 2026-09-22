import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { useMediasoup } from '../hooks/useMediasoup';
import './auth.css';
import './game.css';
import './call-panel.css';

const HTTP_URL = `http://${window.location.hostname}:3000`;
const WS_URL = `ws://${window.location.hostname}:8080`;

export interface Space {
  id: string;
  name: string;
  width: number;
  height: number;
  createrId?: string;
}

export interface UserPos {
  userId: string;
  x: number;
  y: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  text: string;
  type: 'join' | 'move' | 'leave' | 'info' | 'PROXIMITY_UPDATE';
}

export default function Game() {
  const navigate = useNavigate();

  // User & Auth State
  const [token, setToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ userId: string; username: string } | null>(null);

  // Spaces state
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpace, setActiveSpace] = useState<Space | null>(null);
  const [loadingSpaces, setLoadingSpaces] = useState<boolean>(false);
  const [manualSpaceId, setManualSpaceId] = useState<string>('');

  // Create space form state
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newSpaceName, setNewSpaceName] = useState<string>('');
  const [newSpaceDimension, setNewSpaceDimension] = useState<string>('10x10');
  const [creatingSpace, setCreatingSpace] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Real-time WebSocket Arena State
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [myPos, setMyPos] = useState<{ x: number; y: number } | null>(null);
  const [remoteUsers, setRemoteUsers] = useState<Map<string, UserPos>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // mediasoup hook
  const media = useMediasoup();

  // Logger helper
  const addLog = useCallback((text: string, type: 'join' | 'move' | 'leave' | 'info'| 'PROXIMITY_UPDATE' = 'info') => {
    const timeStr = new Date().toLocaleTimeString();
    setLogs((prev) => [
      { id: Math.random().toString(36).substring(2, 9), timestamp: timeStr, text, type },
      ...prev.slice(0, 49)
    ]);
  }, []);

  // Initialize Auth & User details from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem('metaverse_token');
    const savedUser = localStorage.getItem('metaverse_user');

    if (savedToken) {
      setToken(savedToken);
    }

    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        setCurrentUser(parsed);
      } catch (e) {
        console.error("Failed to parse saved user details", e);
      }
    }
  }, []);

  // Fetch spaces from Backend API
  const fetchSpaces = useCallback(async () => {
    if (!token) return;
    setLoadingSpaces(true);
    setErrorMsg(null);
    try {
      const response = await axios.get(`${HTTP_URL}/api/v1/space/all`, {
        headers: { Authorization: `Bearer ${token}` },
        withCredentials: true
      });

      if (response.data && response.data.space) {
        setSpaces(response.data.space);
      } else {
        setSpaces([]);
      }
    } catch (err: any) {
      console.error("Fetch spaces error:", err);
      setErrorMsg("Failed to load spaces from server.");
    } finally {
      setLoadingSpaces(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchSpaces();
    }
  }, [token, fetchSpaces]);

  // Create a new space with 0 default elements
  const handleCreateSpace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSpaceName.trim() || !token) return;

    setCreatingSpace(true);
    setErrorMsg(null);

    try {
      const response = await axios.post(
        `${HTTP_URL}/api/v1/space`,
        {
          name: newSpaceName.trim(),
          dimensions: newSpaceDimension
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          withCredentials: true
        }
      );

      const data = response.data;
      setNewSpaceName('');
      setShowCreateModal(false);
      await fetchSpaces();

      if (data.spaceId) {
        const [wStr, hStr] = newSpaceDimension.split('x');
        const createdSpace: Space = {
          id: data.spaceId,
          name: newSpaceName.trim(),
          width: Number(wStr) || 10,
          height: Number(hStr) || 10,
          createrId: currentUser?.userId
        };
        joinSpace(createdSpace);
      }
    } catch (err: any) {
      const serverMsg = err.response?.data?.message || err.response?.data?.msg || "Failed to create space";
      setErrorMsg(serverMsg);
    } finally {
      setCreatingSpace(false);
    }
  };

  // Join a Space
  const joinSpace = (space: Space) => {
    setActiveSpace(space);
    setMyPos(null);
    setRemoteUsers(new Map());
    setLogs([]);
  };

  // Leave active space
  const leaveSpace = () => {
    media.cleanup();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setActiveSpace(null);
    setWsStatus('disconnected');
    setMyPos(null);
    setRemoteUsers(new Map());
  };

  // WebSocket Connection Lifecycle
  useEffect(() => {
    if (!activeSpace || !token) return;

    setWsStatus('connecting');
    addLog(`Connecting to real-time WebSocket server at ${WS_URL}...`, 'info');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      addLog(`Connected! Sending join request for space: ${activeSpace.name}`, 'info');

      // Send join event matching backend WS server protocol
      ws.send(JSON.stringify({
        type: 'join',
        payload: {
          spaceId: activeSpace.id,
          token: token
        }
      }));
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
            addLog(`Successfully joined! Spawned at position (${spawnX}, ${spawnY})`, 'join');

            // Populate existing online users
            const usersMap = new Map<string, UserPos>();
            if (Array.isArray(payload.users)) {
              payload.users.forEach((u: any) => {
                const uId = u.userId || u.id;
                if (uId && uId !== currentUser?.userId) {
                  usersMap.set(uId, {
                    userId: uId,
                    x: typeof u.x === 'number' ? u.x : 0,
                    y: typeof u.y === 'number' ? u.y : 0
                  });
                }
              });
            }
            setRemoteUsers(usersMap);
            if (usersMap.size > 0) {
              addLog(`${usersMap.size} other user(s) currently active in this space`, 'info');
            }

            // Initialize mediasoup media pipeline
            media.initMedia(ws);
            break;
          }

          case 'user-join': {
            const uId = payload.userId;
            const uX = payload.x ?? 0;
            const uY = payload.y ?? 0;
            if (uId && uId !== currentUser?.userId) {
              setRemoteUsers((prev) => {
                const next = new Map(prev);
                next.set(uId, { userId: uId, x: uX, y: uY });
                return next;
              });
              addLog(`User ${uId.substring(0, 8)} joined the space at (${uX}, ${uY})`, 'join');
            }
            break;
          }

          case 'move': {
            const uId = payload.userId;
            const uX = payload.x;
            const uY = payload.y;
            if (uId && uId !== currentUser?.userId) {
              setRemoteUsers((prev) => {
                const next = new Map(prev);
                next.set(uId, { userId: uId, x: uX, y: uY });
                return next;
              });
              addLog(`User ${uId.substring(0, 8)} moved to (${uX}, ${uY})`, 'move');
            }
            break;
          }

          case 'movement-rejected': {
            if (typeof payload.x === 'number' && typeof payload.y === 'number') {
              setMyPos({ x: payload.x, y: payload.y });
              addLog(`Move rejected by server! Reset to position (${payload.x}, ${payload.y})`, 'leave');
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

          case 'producer-closed': {
            // A specific producer closed (peer stopped a track)
            break;
          }

          case 'error': {
            console.error('Server error:', payload.message);
            break;
          }

          default:
            console.log("Unhandled message type:", type, payload);
        }
      } catch (err) {
        console.error("Failed to parse incoming WS message:", err);
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
  }, [activeSpace, token, currentUser?.userId, addLog]);

  // Handle Player Movement (Step displacement dx + dy = 1)
  const movePlayer = useCallback((targetX: number, targetY: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !myPos || !activeSpace) return;

    const gridW = activeSpace.width || 10;
    const gridH = activeSpace.height || 10;

    // Bounds check
    if (targetX < 0 || targetX >= gridW || targetY < 0 || targetY >= gridH) {
      return;
    }

    // Local optimistic position update
    setMyPos({ x: targetX, y: targetY });

    // Broadcast move message to WS server
    wsRef.current.send(JSON.stringify({
      type: 'move',
      payload: {
        x: targetX,
        y: targetY
      }
    }));

    addLog(`You moved to (${targetX}, ${targetY})`, 'move');
  }, [myPos, activeSpace, addLog]);

  // Keyboard navigation listener (Arrow keys / WASD)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!myPos || !activeSpace) return;

      if (['ArrowUp', 'KeyW'].includes(e.code)) {
        e.preventDefault();
        movePlayer(myPos.x, myPos.y - 1);
      } else if (['ArrowDown', 'KeyS'].includes(e.code)) {
        e.preventDefault();
        movePlayer(myPos.x, myPos.y + 1);
      } else if (['ArrowLeft', 'KeyA'].includes(e.code)) {
        e.preventDefault();
        movePlayer(myPos.x - 1, myPos.y);
      } else if (['ArrowRight', 'KeyD'].includes(e.code)) {
        e.preventDefault();
        movePlayer(myPos.x + 1, myPos.y);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [myPos, activeSpace, movePlayer]);

  // Logout handler
  const handleLogout = () => {
    localStorage.removeItem('metaverse_token');
    localStorage.removeItem('metaverse_user');
    document.cookie = "accessToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    navigate('/signin');
  };

  // If user is not authenticated
  if (!token) {
    return (
      <div className="game-page">
        <header className="game-header">
          <div className="game-brand">
            <div className="game-logo">2D</div>
            <div className="game-title-group">
              <span className="game-title">Metaverse 2D</span>
              <span className="game-subtitle">Real-time Virtual Workspace</span>
            </div>
          </div>
        </header>
        <main className="game-container">
          <div className="game-card" style={{ textAlign: 'center', maxWidth: '480px', margin: '40px auto' }}>
            <h2 className="game-title" style={{ marginBottom: '12px' }}>Authentication Required</h2>
            <p style={{ color: '#64748b', fontSize: '0.95rem', marginBottom: '24px' }}>
              Please sign in to access real-time 2D spaces and interact with other users.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <Link to="/signin" className="btn-primary" style={{ textDecoration: 'none' }}>
                Sign In
              </Link>
              <Link to="/signup" className="btn-secondary" style={{ textDecoration: 'none' }}>
                Sign Up
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Render 2D Grid Cells for Active Arena
  const renderArenaGrid = () => {
    if (!activeSpace) return null;

    const width = activeSpace.width || 10;
    const height = activeSpace.height || 10;
    const tiles = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const isMe = myPos && myPos.x === x && myPos.y === y;

        const remotesHere: UserPos[] = [];
        remoteUsers.forEach((user) => {
          if (user.x === x && user.y === y) {
            remotesHere.push(user);
          }
        });

        tiles.push(
          <div key={`${x}-${y}`} className={`arena-tile ${isMe ? 'is-me' : ''}`}>
            <span className="tile-coord">{x},{y}</span>

            {/* Local Player Marker */}
            {isMe && (
              <div className="player-avatar-wrapper">
                <span className="avatar-nametag me">YOU</span>
                <div className="avatar-circle me">👾</div>
              </div>
            )}

            {/* Remote Players Marker */}
            {!isMe && remotesHere.length > 0 && (
              <div className="player-avatar-wrapper">
                <span className="avatar-nametag">{remotesHere[0].userId.substring(0, 6)}</span>
                <div className="avatar-circle other">👤</div>
              </div>
            )}
          </div>
        );
      }
    }

    return (
      <div
        className="arena-grid"
        style={{
          gridTemplateColumns: `repeat(${width}, 48px)`,
          gridTemplateRows: `repeat(${height}, 48px)`
        }}
      >
        {tiles}
      </div>
    );
  };

  return (
    <div className="game-page">
      {/* App Navigation Header */}
      <header className="game-header">
        <div className="game-brand">
          <div className="game-logo">2D</div>
          <div className="game-title-group">
            <span className="game-title">Metaverse 2D - Game Arena</span>
            <span className="game-subtitle">Real-Time Multi-User Space Demo</span>
          </div>
        </div>

        <div className="game-header-actions">
          {currentUser && (
            <div className="user-pill-tag">
              <span>👤</span>
              <span>{currentUser.username}</span>
            </div>
          )}
          {!activeSpace && (
            <button className="btn-primary" onClick={() => setShowCreateModal(!showCreateModal)}>
              {showCreateModal ? 'Close Form' : '+ New Space'}
            </button>
          )}
          {activeSpace && (
            <button className="btn-secondary" onClick={leaveSpace}>
              ← Leave Space
            </button>
          )}
          <button className="btn-secondary" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <main className="game-container">
        {/* Global Error Banner */}
        {errorMsg && (
          <div className="auth-alert auth-alert--error">
            <span className="auth-dot" />
            <div>{errorMsg}</div>
          </div>
        )}

        {/* ================= SPACE SELECTION / CREATION VIEW ================= */}
        {!activeSpace && (
          <div className="game-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <h2 className="game-title">Select or Create a Space</h2>
                <p style={{ color: '#64748b', fontSize: '0.9rem', marginTop: '4px' }}>
                  Join any 2D virtual space to see present members and their real-time movements.
                </p>
              </div>
              <button className="btn-primary" onClick={() => setShowCreateModal(!showCreateModal)}>
                {showCreateModal ? 'Cancel' : '+ Create Space'}
              </button>
            </div>

            {/* Create Space Form */}
            {showCreateModal && (
              <form onSubmit={handleCreateSpace} className="create-space-card">
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>Create New Space (0 Default Elements)</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                  <div className="form-group-game">
                    <label className="form-label-game">Space Name</label>
                    <input
                      type="text"
                      className="form-input-game"
                      placeholder="e.g. Realtime Lounge"
                      value={newSpaceName}
                      onChange={(e) => setNewSpaceName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group-game">
                    <label className="form-label-game">Dimensions (WxH)</label>
                    <select
                      className="form-input-game"
                      value={newSpaceDimension}
                      onChange={(e) => setNewSpaceDimension(e.target.value)}
                    >
                      <option value="10x10">10 x 10 Grid</option>
                      <option value="12x12">12 x 12 Grid</option>
                      <option value="15x15">15 x 15 Grid</option>
                    </select>
                  </div>
                </div>
                <button type="submit" className="btn-primary" disabled={creatingSpace} style={{ alignSelf: 'flex-start' }}>
                  {creatingSpace ? 'Creating Space...' : 'Launch Space'}
                </button>
              </form>
            )}

            {/* Manual Join by Space ID */}
            <div style={{ marginTop: '24px', display: 'flex', gap: '12px', alignItems: 'center' }}>
              <input
                type="text"
                className="form-input-game"
                placeholder="Enter Space ID directly to join..."
                value={manualSpaceId}
                onChange={(e) => setManualSpaceId(e.target.value)}
                style={{ maxWidth: '380px' }}
              />
              <button
                className="btn-secondary"
                disabled={!manualSpaceId.trim()}
                onClick={() => {
                  if (manualSpaceId.trim()) {
                    joinSpace({
                      id: manualSpaceId.trim(),
                      name: `Space (${manualSpaceId.substring(0, 6)})`,
                      width: 10,
                      height: 10
                    });
                  }
                }}
              >
                Join by ID
              </button>
            </div>

            {/* User Spaces List */}
            <div style={{ marginTop: '32px' }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginBottom: '16px' }}>
                Your Created Spaces
              </h3>
              {loadingSpaces ? (
                <p style={{ color: '#64748b' }}>Loading available spaces...</p>
              ) : spaces.length === 0 ? (
                <div style={{ padding: '32px', textAlign: 'center', background: '#f8fafc', borderRadius: '16px', border: '1px dashed #cbd5e1' }}>
                  <p style={{ color: '#64748b', fontWeight: 600 }}>No spaces found yet.</p>
                  <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '4px' }}>
                    Click "+ Create Space" above to start your first real-time arena with zero elements.
                  </p>
                </div>
              ) : (
                <div className="spaces-grid">
                  {spaces.map((space) => (
                    <div key={space.id} className="space-card-item">
                      <div>
                        <div className="space-name">{space.name}</div>
                        <div className="space-meta">
                          <span>📐 Dimensions: {space.width || 10}x{space.height || 10}</span>
                        </div>
                      </div>
                      <button className="btn-primary" onClick={() => joinSpace(space)}>
                        Join Space 🚀
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= REAL-TIME GAME ARENA VIEW ================= */}
        {activeSpace && (
          <div className="arena-view">
            {/* Main Arena Canvas Card */}
            <div className="game-card arena-main">
              <div className="arena-topbar">
                <div>
                  <h2 className="arena-title">{activeSpace.name}</h2>
                  <div className="arena-subtitle">
                    ID: {activeSpace.id} | Size: {activeSpace.width || 10}x{activeSpace.height || 10}
                    {myPos && ` | Your Pos: (${myPos.x}, ${myPos.y})`}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className={`status-badge ${wsStatus}`}>
                    <span className="auth-dot" />
                    WS: {wsStatus.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* 2D Interactive Grid */}
              <div className="arena-grid-box">
                {renderArenaGrid()}
              </div>

              {/* Directional D-Pad Controls */}
              <div className="dpad-container">
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>
                  Move with Arrow Keys / WASD or D-Pad
                </span>
                <div className="dpad-grid">
                  <div />
                  <button
                    className="dpad-button"
                    onClick={() => myPos && movePlayer(myPos.x, myPos.y - 1)}
                    title="Move Up"
                  >
                    ▲
                  </button>
                  <div />

                  <button
                    className="dpad-button"
                    onClick={() => myPos && movePlayer(myPos.x - 1, myPos.y)}
                    title="Move Left"
                  >
                    ◀
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem' }}>
                    🕹️
                  </div>
                  <button
                    className="dpad-button"
                    onClick={() => myPos && movePlayer(myPos.x + 1, myPos.y)}
                    title="Move Right"
                  >
                    ▶
                  </button>

                  <div />
                  <button
                    className="dpad-button"
                    onClick={() => myPos && movePlayer(myPos.x, myPos.y + 1)}
                    title="Move Down"
                  >
                    ▼
                  </button>
                  <div />
                </div>
              </div>
            </div>

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

            {/* Sidebar: Active Members & Real-time Logs */}
            <div className="arena-sidebar">
              {/* Creator Rules & Permissions Notice */}
              <div className="creator-info-box">
                <strong>💡 Creator Permissions Info:</strong>
                <p style={{ marginTop: '6px' }}>
                  Only the <strong>Space Creator</strong> can add or delete space elements (`/api/v1/space/element`). All joined members can move around in real time and see everyone's live movements.
                </p>
              </div>

              {/* Present Members Panel */}
              <div className="sidebar-card">
                <div className="sidebar-title">
                  <span>👥 Members in Space</span>
                  <span className="user-pill-tag" style={{ padding: '2px 8px', fontSize: '0.75rem' }}>
                    {1 + remoteUsers.size} Online
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                  {/* Local User */}
                  <div className="member-item" style={{ borderLeft: '3px solid #3b52d4' }}>
                    <span>👾 YOU ({currentUser?.username || 'You'})</span>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      {myPos ? `(${myPos.x}, ${myPos.y})` : 'Spawning'}
                    </span>
                  </div>

                  {/* Remote Users */}
                  {Array.from(remoteUsers.values()).map((user) => (
                    <div key={user.userId} className="member-item">
                      <span>👤 {user.userId.substring(0, 8)}...</span>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        ({user.x}, {user.y})
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Real-time Event Stream */}
              <div className="sidebar-card">
                <div className="sidebar-title">
                  <span>📡 Real-time Log Stream</span>
                </div>
                <div className="log-scroll">
                  {logs.map((log) => (
                    <div key={log.id} className={`log-row ${log.type}`}>
                      <span style={{ fontSize: '0.65rem', color: '#94a3b8', display: 'block' }}>
                        [{log.timestamp}]
                      </span>
                      {log.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Helper: Local Video Element ─────────────────────────────────────────────

function LocalVideo({ stream, videoOff }: { stream: MediaStream; videoOff: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (videoOff) {
    return (
      <div className="call-video-placeholder">
        <span>📷</span>
        <span className="call-video-placeholder-text">Camera off</span>
      </div>
    );
  }

  return <video ref={videoRef} autoPlay playsInline muted />;
}

// ─── Helper: Remote Video Element ────────────────────────────────────────────

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline />;
}