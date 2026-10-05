import React, { useEffect, useState } from "react";

const TELEMETRY_ITEMS = [
  { label: "Core Node Health", value: "Operational (99.98% Uptime)", tone: "#10b981" },
  { label: "Database Synchronization", value: "PostgreSQL 16 Live & Healthy", tone: "#0ea5e9" },
  { label: "Security Gateway", value: "256-Bit Encrypted TLS Active", tone: "#6366f1" },
  { label: "Audit & Compliance Engine", value: "Real-time Event Logging Active", tone: "#14b8a6" },
  { label: "BOM & Inventory Ledger", value: "Synchronized across Plants", tone: "#f59e0b" },
];

export default function Login({
  localEmail,
  setLocalEmail,
  localPassword,
  setLocalPassword,
  loginBusy,
  loginError,
  localLogin,
}) {
  const [authTab, setAuthTab] = useState("google"); // 'google' | 'local'
  const [tickerIndex, setTickerIndex] = useState(0);

  // Cycling Telemetry Ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setTickerIndex((prev) => (prev + 1) % TELEMETRY_ITEMS.length);
    }, 3800);
    return () => clearInterval(timer);
  }, []);

  const currentTelemetry = TELEMETRY_ITEMS[tickerIndex];

  return (
    <div className="login-viewport-wrapper">
      <div className="login-shell">
        <div className="login-shell__grid">
          {/* Left Hero Panel */}
          <section className="login-hero login-hero-compact">
            <div className="brand-lockup">
              <img
                className="brand-logo"
                src="/absstem_logo.svg"
                alt="absstem"
                width={180}
                height={28}
              />
              <div>
                <div className="eyebrow-pill">JOSH ERP</div>
                <h1 className="brand-headline">Command Center for On-Site PSA Gas Generation &amp; Industrial Engineering.</h1>
              </div>
            </div>

            <p className="login-hero-copy">
              Powering end-to-end execution for Absstem Systems—from molecular sieve BOM governance and shop-floor kitting to precision Idos/nGEN plant dispatch and IIoT asset telemetry.
            </p>

            {/* Live Telemetry Ticker */}
            <div className="login-telemetry-ticker">
              <div className="ticker-header">
                <span className="ticker-pulse-dot" style={{ background: currentTelemetry.tone }} />
                <span className="ticker-title">Live System Telemetry</span>
                <span className="ticker-badge">LIVE</span>
              </div>
              <div className="ticker-content" key={tickerIndex}>
                <span className="ticker-label">{currentTelemetry.label}</span>
                <strong className="ticker-value" style={{ color: currentTelemetry.tone }}>
                  {currentTelemetry.value}
                </strong>
              </div>
            </div>
          </section>

          {/* Right Auth Card with Segmented Tabs */}
          <section className="login-auth login-auth-compact">
            <div className="auth-header">
              <div>
                <div className="eyebrow-pill">Access Console</div>
                <h2>Secure Enterprise Gateway</h2>
              </div>
              <div className="status-chip">Auth Live</div>
            </div>

            {/* Segmented Auth Tabs */}
            <div className="auth-tab-bar">
              <button
                type="button"
                className={`auth-tab-btn ${authTab === "google" ? "active" : ""}`}
                onClick={() => setAuthTab("google")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 6 }}>
                  <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/>
                </svg>
                Internal (Google SSO)
              </button>
              <button
                type="button"
                className={`auth-tab-btn ${authTab === "local" ? "active" : ""}`}
                onClick={() => setAuthTab("local")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Partner Portal (Local Login)
              </button>
            </div>

            {/* Tab Stage 1: Google SSO */}
            {authTab === "google" && (
              <div className="auth-tab-pane fade-in">
                <article className="auth-card auth-card-feature">
                  <div className="panel-kicker">Internal Staff Route</div>
                  <h3>Continue with Absstem Identity</h3>
                  <p>For internal team members signing in with an approved <code>@absstem.com</code> Google account.</p>
                  <a className="auth-link-button micro-bounce" href="/auth/google?redirectTo=/">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 8 }}>
                      <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/>
                    </svg>
                    Sign in with Google Workspace
                  </a>
                </article>
              </div>
            )}

            {/* Tab Stage 2: Channel Partner Local Login */}
            {authTab === "local" && (
              <div className="auth-tab-pane fade-in">
                <form className="auth-card auth-card-form" onSubmit={localLogin}>
                  <div className="panel-kicker">Channel Partner Route</div>
                  <h3>Access Partner Portal</h3>
                  <p>Enter your designated Channel Partner credentials to manage accounts and quotes.</p>
                  <div className="field-stack">
                    <label className="field-label">
                      Email Address
                      <input
                        className="shell-input modern-input"
                        value={localEmail}
                        onChange={(e) => setLocalEmail(e.target.value)}
                        placeholder="partner@domain.com"
                        autoComplete="username"
                        required
                        disabled={loginBusy}
                      />
                    </label>
                    <label className="field-label">
                      Account Password
                      <input
                        className="shell-input modern-input"
                        value={localPassword}
                        onChange={(e) => setLocalPassword(e.target.value)}
                        placeholder="••••••••••••"
                        type="password"
                        autoComplete="current-password"
                        required
                        disabled={loginBusy}
                      />
                    </label>
                  </div>
                  <button type="submit" className="button-primary auth-submit micro-bounce" disabled={loginBusy}>
                    {loginBusy ? "Authenticating…" : "Enter Partner Workspace"}
                  </button>
                  {loginError ? <div className="form-error">{loginError}</div> : null}
                </form>
              </div>
            )}

            {/* Note Footer Strip */}
            <div className="auth-note-strip">
              <span>IMT Manesar Production Hub</span>
              <span>PSA Systems Active</span>
              <span>IIoT Telemetry Gateway</span>
              <span>256-Bit TLS Secured</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
