import { useEffect, useState, type FormEvent } from "react";
import {
  Home,
  Network,
  Database,
  Filter,
  Settings,
  MapPin,
  SlidersHorizontal,
  CloudUpload,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  LogOut,
  X,
  KeyRound,
  DatabaseBackup,
  ArrowDownToLine,
} from "lucide-react";
import { api } from "./lib/api";
import { LeadSyncLogin as Login } from "./LeadSyncLogin";
import { LeadSyncHeader } from "./LeadSyncChrome";
import { PipelineWorkspace } from "./PipelineWorkspace";
import { App as RegionManagement } from "./App";
import { GenesysIntegrationSettings } from "./GenesysIntegrationSettings";
import { ContactListConfiguration } from "./ContactListConfiguration";
import { Footer } from "./Footer";
const base = "/api/admin";
type Portal = "genesys";
const navigationGroups = [
  { label: "", items: [{ key: "overview", label: "Dashboard", icon: Home }] },
  {
    label: "Genesys Configuration",
    items: [
      { key: "regions", label: "Region Management", icon: MapPin },
      {
        key: "integration",
        label: "Integration Setting",
        icon: SlidersHorizontal,
      },
      {
        key: "contact-lists",
        label: "Contact List Configuration",
        icon: Database,
      },
    ],
  },
  {
    label: "Source Configuration",
    items: [
      { key: "sources", label: "Source Integration", icon: Database },
      { key: "mappings", label: "Source Mapping", icon: Filter },
    ],
  },
  {
    label: "",
    items: [{ key: "leads", label: "Lead Configuration", icon: Settings }],
  },
  {
    label: "Lead Importer",
    items: [
      { key: "manual-import", label: "Manual Import Lead", icon: CloudUpload },
      { key: "schedule-import", label: "Schedule Import", icon: CalendarDays },
    ],
  },
  {
    label: "",
    items: [{ key: "settings", label: "System settings", icon: Settings }],
  },
];
export function Root() {
  const portal: Portal = "genesys";
  const path = window.location.pathname;
  const [session, setSession] = useState<{
    authenticated: boolean;
    username: string;
  } | null>(null);
  useEffect(() => {
    document.title = "MFEC LeadSync";
    api<{ authenticated: boolean; username: string }>(
      `${base}/auth/session?portal=${portal}`,
    )
      .then(setSession)
      .catch(() => setSession({ authenticated: false, username: "" }));
  }, []);
  if (!session) return <div className="admin-loading">Loading...</div>;
  if (!session.authenticated)
    return (
      <Login
        portal={portal}
        returnPath={
          path === "/login"
            ? "/"
            : path + window.location.search + window.location.hash
        }
        onLogin={setSession}
      />
    );
  if (path === "/login") window.history.replaceState({}, "", "/");
  return <AdminPortal username={session.username} portal={portal} />;
}

function AdminPortal({
  username,
  portal,
}: {
  username: string;
  portal: Portal;
}) {
  const requested = window.location.pathname.split("/")[1] || "overview";
  const section =
    (
      {
        "import-leads": "manual-import",
        scheduler: "schedule-import",
      } as Record<string, string>
    )[requested] || requested;
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = navigationGroups.flatMap((group) => group.items);
  async function logout() {
    await api(base + "/auth/logout", {
      method: "POST",
      body: JSON.stringify({ portal }),
    });
    window.location.href = "/login";
  }
  return (
    <div className="admin-shell genesys-portal leadsync-theme">
      <LeadSyncHeader
        username={username}
        onMenu={() => setMenuOpen(!menuOpen)}
        onLogout={logout}
      />
      {menuOpen && (
        <button
          className="ls-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside className={menuOpen ? "admin-sidebar open" : "admin-sidebar"}>
        <nav aria-label="Main navigation">
          {navigationGroups.map((group, index) =>
            group.label ? (
              <details key={index} className="ls-nav-section" open>
                <summary>
                  <Network size={19} />
                  <span>{group.label}</span>
                  <ChevronDown size={15} />
                </summary>
                <div className="ls-nav-children">
                  {group.items.map(({ key, label, icon: Icon }) => (
                    <a
                      href={"/" + key}
                      key={key}
                      className={section === key ? "active" : ""}
                      aria-current={section === key ? "page" : undefined}
                    >
                      <Icon size={18} />
                      {label}
                    </a>
                  ))}
                </div>
              </details>
            ) : (
              <div className="ls-nav-section" key={index}>
                {group.items.map(({ key, label, icon: Icon }) => (
                  <a
                    href={key === "overview" ? "/" : "/" + key}
                    key={key}
                    className={section === key ? "active" : ""}
                    aria-current={section === key ? "page" : undefined}
                  >
                    <Icon size={18} />
                    {label}
                  </a>
                ))}
              </div>
            ),
          )}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => void logout()}>
            <LogOut size={17} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="admin-main">
        <div className="ls-page-breadcrumb">
          <a href="/">Home</a>
          <ChevronRight size={12} />
          <span>
            {navigation.find((item) => item.key === section)?.label || "Page"}
          </span>
        </div>
        <main className="admin-content">
          {[
            "overview",
            "sources",
            "mappings",
            "leads",
            "manual-import",
            "schedule-import",
          ].includes(section) ? (
            <PipelineWorkspace
              page={
                section as
                  | "overview"
                  | "sources"
                  | "mappings"
                  | "leads"
                  | "manual-import"
                  | "schedule-import"
              }
            />
          ) : section === "regions" ? (
            <RegionManagement />
          ) : section === "integration" ? (
            <GenesysIntegrationSettings />
          ) : section === "contact-lists" ? (
            <ContactListConfiguration />
          ) : section === "settings" ? (
            <SystemSettings />
          ) : (
            <div className="empty-state">Page not found</div>
          )}
        </main>
        <Footer />
      </div>
    </div>
  );
}
function SystemSettings() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState("");
  async function backup() {
    setBusy(true);
    setError("");
    try {
      const value = await api<{ downloadUrl: string }>(
        base + "/settings/backup",
        { method: "POST", body: "{}" },
      );
      setDownload(value.downloadUrl);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pipeline-workspace">
      <header className="admin-page-head">
        <div>
          <span>SYSTEM</span>
          <h1>System settings</h1>
          <p>Administrator account and configuration backups</p>
        </div>
      </header>
      {error && <div className="admin-error">{error}</div>}
      <div className="settings-grid">
        <PasswordSettings />
        <section className="admin-panel">
          <DatabaseBackup size={28} />
          <h2>Backup configuration</h2>
          <p className="pipe-muted">
            Back up configured sources, mappings, leads, contact identities and
            schedules. Downloaded backups exclude credentials.
          </p>
          <button
            className="admin-primary"
            disabled={busy}
            onClick={() => void backup()}
          >
            Create backup
          </button>
          {download && (
            <a className="admin-secondary" href={download}>
              <ArrowDownToLine size={15} />
              Download backup
            </a>
          )}
        </section>
      </div>
    </div>
  );
}
function PasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api(`${base}/auth/change-password`, {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      window.location.href = "/login?passwordChanged=1";
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not change password",
      );
      setCurrentPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel credential-panel">
      <KeyRound size={28} />
      <h2>Change administrator password</h2>
      <form className="credential-form" onSubmit={changePassword}>
        <div className="credential-fields">
          <label>
            Current password
            <input
              autoComplete="current-password"
              required
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            New password
            <input
              autoComplete="new-password"
              required
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              autoComplete="new-password"
              required
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
        </div>
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        <button className="admin-primary" disabled={busy} type="submit">
          <KeyRound size={16} /> {busy ? "Saving..." : "Save new password"}
        </button>
      </form>
    </section>
  );
}
