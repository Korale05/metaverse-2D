import React, { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import AuthLayout from './Authlayout';

const HTTP_URL = `http://${window.location.hostname}:3000`;

export default function SignUp() {
  const navigate = useNavigate();

  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirmpassword = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const usernameValue = username.current?.value.trim();
    const passwordValue = password.current?.value;
    const confirmPasswordValue = confirmpassword.current?.value;

    if (!usernameValue || !passwordValue || !confirmPasswordValue) {
      setError("Please fill in all required fields.");
      return;
    }

    if (passwordValue !== confirmPasswordValue) {
      setError("Passwords do not match.");
      return;
    }

    if (passwordValue.length < 6) {
      setError("Password must be at least 6 characters!");
      return;
    }

    setLoading(true);

    try {
      const response = await axios.post(
        `${HTTP_URL}/api/v1/signup`,
        {
          username: usernameValue,
          password: passwordValue,
          type: "user"
        },
        { withCredentials: true }
      );

      console.log(response.data);

      const token = response.data.token || response.data.accessToken;
      if (token) {
        localStorage.setItem('metaverse_token', token);
        localStorage.setItem('metaverse_user', JSON.stringify({ userId: response.data.userId, username: usernameValue }));
        document.cookie = `accessToken=${token}; path=/; max-age=604800; SameSite=Lax`;
        document.cookie = `accessToekn=${token}; path=/; max-age=604800; SameSite=Lax`;
      }

      setSuccess("Account created successfully!");
      setTimeout(() => {
        navigate("/signin");
      }, 1000);

    } catch (err: any) {
      if (axios.isAxiosError(err)) {
        console.error(err.response?.data);
        setError(err.response?.data?.message || err.response?.data?.msg || "Signup failed!");
      } else {
        console.error(err);
        setError("Something went wrong!");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Join Metaverse 2D and step into the virtual world.">
      {/* Tabs */}
      <div className="auth-tabs">
        <Link to="/signin" className="auth-tab">
          Sign In
        </Link>
        <button type="button" className="auth-tab auth-tab--active" aria-current="page">
          Sign Up
        </button>
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
      <form onSubmit={createAccount} className="auth-form">
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

        <div className="auth-field">
          <label htmlFor="confirmpassword" className="auth-label">
            Confirm password
          </label>
          <input
            id="confirmpassword"
            ref={confirmpassword}
            type="password"
            className="auth-input"
            placeholder="Confirm password..."
            required
          />
        </div>

        <button type="submit" disabled={loading} className="auth-button">
          {loading ? 'Creating Account...' : 'Create Account'}
        </button>
      </form>

      {/* Footer link */}
      <p className="auth-footer">
        Already have an account?{' '}
        <Link to="/signin" className="auth-link">
          Sign In
        </Link>
      </p>
    </AuthLayout>
  );
}