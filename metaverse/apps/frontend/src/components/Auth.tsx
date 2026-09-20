import React, { useState } from 'react';

interface AuthProps {
  onSuccess: (userData: { userId: string; username: string; token: string }) => void;
}

const HTTP_URL = `http://${window.location.hostname}:3000`;

export const Auth: React.FC<AuthProps> = ({ onSuccess }) => {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'User' | 'Admin'>('User');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const endpoint = mode === 'signin' ? '/api/v1/signin' : '/api/v1/signup';
    const payload = mode === 'signin' 
      ? { username, password }
      : { username, password, type: role === 'Admin' ? 'admin' : 'user' };

    try {
      const res = await fetch(`${HTTP_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // sends and receives cookies
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.msg || 'Authentication failed');
      }

      const token = data.token || data.accessToken;
      const userId = data.userId || 'user_' + Math.random().toString(36).substring(2, 7);
      
      // Store in localStorage & document.cookie for resilience
      if (token) {
        localStorage.setItem('metaverse_token', token);
        localStorage.setItem('metaverse_user', JSON.stringify({ userId, username }));
        document.cookie = `accessToken=${token}; path=/; max-age=604800; SameSite=Lax`;
        document.cookie = `accessToekn=${token}; path=/; max-age=604800; SameSite=Lax`;
      }

      onSuccess({
        userId,
        username,
        token: token || '',
      });
    } catch (err: any) {
      setError(err.message || 'Network error connecting to backend');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrapper glass-panel">
      <div className="auth-header">
        <h1>Welcome to Metaverse 2D</h1>
        <p>Real-time virtual workspace & multiplayer demo</p>
      </div>

      <div className="auth-tabs">
        <button
          type="button"
          className={`tab-btn ${mode === 'signin' ? 'active' : ''}`}
          onClick={() => { setMode('signin'); setError(null); }}
        >
          Sign In
        </button>
        <button
          type="button"
          className={`tab-btn ${mode === 'signup' ? 'active' : ''}`}
          onClick={() => { setMode('signup'); setError(null); }}
        >
          Sign Up
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px',
          borderRadius: '8px',
          backgroundColor: 'rgba(244, 63, 94, 0.15)',
          border: '1px solid rgba(244, 63, 94, 0.3)',
          color: '#fecdd3',
          fontSize: '0.85rem'
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="form-group">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            className="glass-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username..."
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="glass-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password..."
            required
          />
        </div>

        {mode === 'signup' && (
          <div className="form-group">
            <label htmlFor="role">Account Role</label>
            <select
              id="role"
              className="glass-input"
              value={role}
              onChange={(e) => setRole(e.target.value as 'User' | 'Admin')}
              style={{ background: '#0a0d14' }}
            >
              <option value="User">Standard User</option>
              <option value="Admin">Admin</option>
            </select>
          </div>
        )}

        <button type="submit" className="glass-button" disabled={loading} style={{ marginTop: '8px' }}>
          {loading ? 'Processing...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
        </button>
      </form>
    </div>
  );
};
