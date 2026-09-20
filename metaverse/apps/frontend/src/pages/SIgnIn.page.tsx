import React, { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import AuthLayout from './Authlayout';

const HTTP_URL = `http://${window.location.hostname}:3000`;

export default function SignIn() {
  const navigate = useNavigate();

  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function Login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const usernameValue = username.current?.value.trim();
    const passwordValue = password.current?.value;

    if (!usernameValue || !passwordValue) {
      setError("Please enter both username and password.");
      return;
    }

    setLoading(true);

    try {
      const response: any = await axios.post(
        `${HTTP_URL}/api/v1/signin`,
        { username: usernameValue, password: passwordValue },
        { withCredentials: true }
      );

      console.log(response.data);

      const token = response.data.token || response.data.accessToken;
      const userId = response.data.userId || 'user_' + Math.random().toString(36).substring(2, 7);

      if (token) {
        localStorage.setItem('metaverse_token', token);
        localStorage.setItem('metaverse_user', JSON.stringify({ userId, username: usernameValue }));
        document.cookie = `accessToken=${token}; path=/; max-age=604800; SameSite=Lax`;
        document.cookie = `accessToekn=${token}; path=/; max-age=604800; SameSite=Lax`;
      }

      setSuccess("Login successful! Redirecting...");
      setTimeout(() => {
        navigate("/Game");
      }, 1000);

    } catch (err: any) {
      if (axios.isAxiosError(err)) {
        console.error(err.response?.data);
        setError(
          err.response?.data?.message ||
          err.response?.data?.msg ||
          "Invalid credentials. Please check your username and password."
        );
      } else {
        console.error(err);
        setError("Something went wrong connecting to the server.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to enter your virtual workspace.">
      {/* Tabs */}
      <div className="auth-tabs">
        <button type="button" className="auth-tab auth-tab--active" aria-current="page">
          Sign In
        </button>
        <Link to="/signup" className="auth-tab">
          Sign Up
        </Link>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="auth-alert auth-alert--error">
          <span className="auth-dot" />
          <div>{error}</div>
        </div>
      )}

      {/* Success */}
      {success && (
        <div role="status" className="auth-alert auth-alert--success">
          <span className="auth-dot" />
          <div>{success}</div>
        </div>
      )}

      {/* Form */}
      <form onSubmit={Login} className="auth-form">
        <div className="auth-field">
          <label htmlFor="username" className="auth-label">
            Username
          </label>
          <input
            id="username"
            ref={username}
            type="text"
            className="auth-input"
            placeholder="Enter username..."
            required
          />
        </div>

        <div className="auth-field">
          <label htmlFor="password" className="auth-label">
            Password
          </label>
          <input
            id="password"
            ref={password}
            type="password"
            className="auth-input"
            placeholder="Enter password..."
            required
          />
        </div>

        <button type="submit" disabled={loading} className="auth-button">
          {loading ? 'Signing In...' : 'Sign In'}
        </button>
      </form>

      {/* Footer link */}
      <p className="auth-footer">
        Don't have an account?{' '}
        <Link to="/signup" className="auth-link">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}