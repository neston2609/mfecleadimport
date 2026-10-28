import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Globe2,
  LockKeyhole,
  Mail,
  CircleHelp,
  ShieldCheck,
} from "lucide-react";
import { api } from "./lib/api";
import { MfecBrand, ThemeToggle } from "./Theme";

export function LeadSyncLogin({
  portal,
  returnPath,
  onLogin,
}: {
  portal: "genesys";
  returnPath: string;
  onLogin: (value: { authenticated: boolean; username: string }) => void;
}) {
  const [username, setUsername] = useState(
    () => localStorage.getItem("leadsync.username") || "admin",
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() =>
    Boolean(localStorage.getItem("leadsync.username")),
  );
  const [visible, setVisible] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ authenticated: boolean; username: string }>(
        "/api/admin/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password, portal }),
        },
      );
      if (remember) localStorage.setItem("leadsync.username", username);
      else localStorage.removeItem("leadsync.username");
      window.history.replaceState({}, "", returnPath);
      onLogin(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ls-login">
      <aside className="ls-login-hero">
        <img
          src="/images/leadsync-login-hero.png"
          alt="MFEC LeadSync. Turn Data into Opportunities. Connect, Transform, Engage. Unify customer leads from Database, Web Service, CSV and JSON, and activate campaigns in Genesys Cloud."
        />
        <div className="ls-hero-brand">
          <MfecBrand />
          <small>INTEGRATE · MANAGE · ACTIVATE</small>
        </div>
      </aside>
      <main className="ls-login-side">
        <div className="ls-login-preferences">
          <ThemeToggle />
          <div className="ls-language">
            <Globe2 size={17} /> English
          </div>
        </div>
        <div className="ls-login-form-wrap">
          <MfecBrand className="ls-login-brand" />
          <div className="ls-login-eyebrow">MFEC LEADSYNC</div>
          <h1>Welcome back</h1>
          <p className="ls-login-subtitle">Sign in to MFEC LeadSync</p>
          <form onSubmit={submit}>
            {new URLSearchParams(window.location.search).has(
              "passwordChanged",
            ) && (
              <div className="admin-success" role="status">
                Password updated. Sign in with your new password.
              </div>
            )}
            <label htmlFor="ls-username">Username or work email</label>
            <div className="ls-login-input">
              <Mail size={20} />
              <input
                id="ls-username"
                autoComplete="username"
                required
                placeholder="name@company.com"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <label htmlFor="ls-password">Password</label>
            <div className="ls-login-input">
              <LockKeyhole size={20} />
              <input
                id="ls-password"
                autoComplete="current-password"
                required
                placeholder="Enter your password"
                type={visible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                aria-label={visible ? "Hide password" : "Show password"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
            <div className="ls-login-options">
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Remember username
              </label>
              <button
                type="button"
                className="ls-text-button"
                onClick={() => setHelp(!help)}
              >
                Forgot password?
              </button>
            </div>
            {error && (
              <div className="admin-error" role="alert">
                {error}
              </div>
            )}
            <button className="ls-signin" disabled={busy} type="submit">
              {busy ? "Signing in…" : "Sign In"}
              <ArrowRight size={19} />
            </button>
          </form>
          <div className="ls-login-divider">
            <span />
            or continue with
            <span />
          </div>
          <div className="ls-sso-options">
            <button
              type="button"
              disabled
              title="Microsoft Entra ID single sign-on is not configured"
            >
              <ShieldCheck size={19} />
              Microsoft Entra ID
            </button>
            <button
              type="button"
              disabled
              title="Google single sign-on is not configured"
            >
              <Globe2 size={19} />
              Google
            </button>
          </div>
          <p className="ls-sso-note">Single sign-on is not configured.</p>
          <div className="ls-login-help">
            Need help?{" "}
            <button className="ls-text-button" onClick={() => setHelp(!help)}>
              Contact your administrator
            </button>
          </div>
          {help && (
            <div className="ls-help-message" role="status">
              <CircleHelp size={19} />
              <span>
                Contact your organization's MFEC LeadSync administrator for
                account access or a password reset. Your existing administrator
                username is supported.
              </span>
            </div>
          )}
        </div>
        <footer>
          © {new Date().getFullYear()} MFEC Public Company Limited. All rights
          reserved.
        </footer>
      </main>
    </div>
  );
}
