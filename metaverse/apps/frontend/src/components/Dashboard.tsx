import { useState, useEffect } from 'react';
import axios from 'axios';

export interface Space {
  id: string;
  name: string;
  width: number;
  height: number;
}

interface DashboardProps {
  token: string;
  onSelectSpace: (space: Space) => void;
}

const HTTP_URL = `http://${window.location.hostname}:3000`;

export const Dashboard = ({ token, onSelectSpace }: DashboardProps) => {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New Space Form State
  const [showCreate, setShowCreate] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [dimensions, setDimensions] = useState('10x10');
  const [creating, setCreating] = useState(false);

  const fetchSpaces = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${HTTP_URL}/api/v1/space/all`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        withCredentials: true
      });
      if (res.data && res.data.space) {
        setSpaces(res.data.space);
      } else {
        setSpaces([]);
      }
    } catch (err: any) {
      setError("Failed to fetch spaces from server.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSpaces();
  }, [token]);

  const handleCreateSpace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spaceName.trim()) return;

    setCreating(true);
    try {
      const res = await axios.post(`${HTTP_URL}/api/v1/space`, {
        name: spaceName,
        dimensions: dimensions
      }, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        withCredentials: true
      });

      const data = res.data;

      setSpaceName('');
      setShowCreate(false);
      await fetchSpaces();
      if (data.spaceId) {
        const dims = dimensions.split('x');
        onSelectSpace({
          id: data.spaceId,
          name: spaceName,
          width: Number(dims[0]) || 10,
          height: Number(dims[1]) || 10
        });
      }
    } catch (err: any) {
      const serverMsg = err.response?.data?.message || err.response?.data?.msg;
      alert(serverMsg || 'Failed to create space');
    } finally {
      setCreating(false);
    }
  };


  // Demo space quick creator if no space exists
  const handleQuickDemoSpace = async () => {
    setSpaceName('Metaverse Lounge');
    setDimensions('12x12');
    setShowCreate(true);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Your Spaces</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Select or create a 2D space to enter the real-time world</p>
        </div>
        <button 
          className="glass-button" 
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : '+ Create New Space'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(244, 63, 94, 0.15)', border: '1px solid rgba(244, 63, 94, 0.3)', borderRadius: '8px', color: '#fecdd3', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      {showCreate && (

        <form onSubmit={handleCreateSpace} className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '1.1rem' }}>Create 2D Space</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label>Space Name</label>
              <input
                type="text"
                className="glass-input"
                placeholder="e.g. Cyberpunk Hub"
                value={spaceName}
                onChange={(e) => setSpaceName(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Grid Dimensions (WxH)</label>
              <select
                className="glass-input"
                value={dimensions}
                onChange={(e) => setDimensions(e.target.value)}
                style={{ background: '#0a0d14' }}
              >
                <option value="10x10">10 x 10 Grid</option>
                <option value="12x12">12 x 12 Grid</option>
                <option value="15x15">15 x 15 Grid</option>
                <option value="20x20">20 x 20 Grid</option>
              </select>
            </div>
          </div>
          <button type="submit" className="glass-button" disabled={creating} style={{ alignSelf: 'flex-start' }}>
            {creating ? 'Creating...' : 'Launch Space'}
          </button>
        </form>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          Loading spaces...
        </div>
      ) : spaces.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div style={{ fontSize: '2.5rem' }}>🌐</div>
          <h3 style={{ fontSize: '1.2rem' }}>No Spaces Found</h3>
          <p style={{ color: 'var(--text-muted)', maxWidth: '400px' }}>
            Create your first 2D metaverse room to test real-time connections and multi-user player movement.
          </p>
          <button className="glass-button" onClick={handleQuickDemoSpace}>
            Create Demo Lounge (12x12)
          </button>
        </div>
      ) : (
        <div className="dashboard-grid">
          {spaces.map((s) => (
            <div key={s.id} className="glass-panel space-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="space-card-title">{s.name}</div>
                <span className="user-pill" style={{ fontSize: '0.75rem' }}>
                  {s.width || 10}x{s.height || 10}
                </span>
              </div>
              <div className="space-card-meta">
                Real-time 2D Grid Room
              </div>
              <button
                className="glass-button"
                onClick={() => onSelectSpace(s)}
              >
                Enter Space 🚀
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
