import React from 'react';
import './auth.css';

type AuthLayoutProps = {
  title: string;
  subtitle: string;
  children: React.ReactNode;
};

export default function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="auth-page">
      {/* Brand Side */}
      <aside className="auth-aside">
        <div className="auth-brand">
          <span className="auth-mark">2D</span>
          <span className="auth-wordmark">Metaverse 2D</span>
        </div>

        {/* Top-down view of a shared 2D space SVG illustration */}
        <svg
          className="auth-art"
          viewBox="0 0 480 360"
          role="img"
          aria-label="Top-down view of a shared virtual workspace with 2D avatars"
        >
          {/* Rooms */}
          <g fill="#ffffff" stroke="#c7d5f8" strokeWidth="2">
            <rect x="16" y="24" width="210" height="150" rx="18" />
            <rect x="246" y="24" width="218" height="110" rx="18" />
            <rect x="16" y="194" width="150" height="142" rx="18" />
            <rect x="186" y="182" width="278" height="154" rx="18" />
          </g>

          {/* Furniture */}
          <g fill="#dfe7fd" stroke="#b6c6f3" strokeWidth="2">
            <rect x="56" y="70" width="130" height="44" rx="10" />
            <rect x="270" y="48" width="96" height="34" rx="12" />
            <circle cx="432" cy="64" r="16" />
            <rect x="40" y="226" width="100" height="28" rx="8" />
            <circle cx="325" cy="259" r="46" />
          </g>

          {/* Path */}
          <path
            d="M176 140 C 200 170, 220 230, 258 250"
            fill="none"
            stroke="#3b52d4"
            strokeWidth="2"
            strokeDasharray="4 7"
            strokeLinecap="round"
            opacity="0.7"
          />

          {/* Avatars */}
          <g stroke="#ffffff" strokeWidth="3">
            <circle cx="80" cy="54" r="10" fill="#2b3a8f" />
            <circle cx="124" cy="54" r="10" fill="#8fa5f0" />
            <circle cx="170" cy="54" r="10" fill="#3b52d4" />
            <circle cx="96" cy="136" r="10" fill="#141b3d" />
            <circle cx="172" cy="130" r="10" fill="#2b3a8f" />
            <circle cx="300" cy="106" r="10" fill="#3b52d4" />
            <circle cx="60" cy="286" r="10" fill="#8fa5f0" />
            <circle cx="112" cy="290" r="10" fill="#2b3a8f" />
            <circle cx="325" cy="199" r="10" fill="#141b3d" />
            <circle cx="385" cy="259" r="10" fill="#3b52d4" />
            <circle cx="325" cy="319" r="10" fill="#8fa5f0" />
            <circle cx="265" cy="259" r="10" fill="#2b3a8f" />
          </g>

          {/* Chat bubble */}
          <rect x="396" y="216" width="52" height="26" rx="13" fill="#3b52d4" />
          <g fill="#ffffff">
            <circle cx="411" cy="229" r="2.6" />
            <circle cx="422" cy="229" r="2.6" />
            <circle cx="433" cy="229" r="2.6" />
          </g>
        </svg>

        <p className="auth-tagline">Real-time virtual workspace &amp; multiplayer demo</p>
      </aside>

      {/* Form Side */}
      <main className="auth-main">
        <div className="auth-card">
          <header className="auth-header">
            <h1 className="auth-title">{title}</h1>
            <p className="auth-subtitle">{subtitle}</p>
          </header>
          {children}
        </div>
      </main>
    </div>
  );
}
