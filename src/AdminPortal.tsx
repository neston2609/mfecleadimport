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
  FileUp,
  FileSpreadsheet,
  Eye,
  Upload,
} from "lucide-react";
import { api } from "./lib/api";
import { LeadSyncLogin as Login } from "./LeadSyncLogin";
import { LeadSyncHeader } from "./LeadSyncChrome";
import { PipelineWorkspace } from "./PipelineWorkspace";
import { App as RegionManagement } from "./App";
import { GenesysIntegrationSettings } from "./GenesysIntegrationSettings";
import { ContactListConfiguration } from "./ContactListConfiguration";
import { Footer } from "./Footer";
import type {
  ContactListConfiguration as ContactListConfig,
  ImportJob,
  LeadPreview,
} from "../server/domain/pipeline-types";
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
      { key: "file-import", label: "File Import", icon: FileSpreadsheet },
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
                  | "file-import"
                  | "schedule-import"
              }
            />
          ) : section === "file-import" ? (
            <FileImporter />
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
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");
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
  async function restore() {
    if (!restoreFile) return;
    const confirmation = window.prompt(
      "Restoring replaces configured sources, mappings, leads and schedules. Genesys credentials and contact identities are preserved; schedules are restored disabled. Type RESTORE to continue.",
    );
    if (confirmation !== "RESTORE") return;
    setRestoreBusy(true);
    setError("");
    setRestoreMessage("");
    try {
      const backupData = JSON.parse(await restoreFile.text()) as {
        files?: Record<string, unknown>;
      };
      if (!backupData.files || typeof backupData.files !== "object")
        throw new Error("Choose a valid MFEC LeadSync JSON backup");
      const required = new Set([
        "genesys-contact-list-configurations.json",
        "source-integrations.json",
        "source-mappings.json",
        "lead-definitions.json",
        "lead-import-schedules.json",
      ]);
      const files = Object.fromEntries(
        Object.entries(backupData.files).filter(
          ([name]) =>
            required.has(name) ||
            /^source-files\/[a-f0-9-]{36}\.txt$/i.test(name),
        ),
      );
      const result = await api<{ restored: string[]; safetyBackup: string }>(
        base + "/settings/restore",
        {
          method: "POST",
          body: JSON.stringify({ confirmation, files }),
        },
      );
      setRestoreMessage(
        `Configuration restored. Safety backup: ${result.safetyBackup}. Schedules were restored disabled.`,
      );
      setRestoreFile(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Restore failed");
    } finally {
      setRestoreBusy(false);
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
        <section className="admin-panel">
          <FileUp size={28} />
          <h2>Import configuration</h2>
          <p className="pipe-muted">
            Restore an MFEC LeadSync JSON backup. Existing Genesys credentials
            and contact identities are preserved, and restored schedules remain
            disabled until reviewed.
          </p>
          <label className="ls-file-picker">
            Configuration backup (.json)
            <input
              type="file"
              accept="application/json,.json"
              disabled={restoreBusy}
              onChange={(event) => {
                setRestoreFile(event.target.files?.[0] || null);
                setRestoreMessage("");
              }}
            />
          </label>
          {restoreFile && <small>{restoreFile.name}</small>}
          <button
            className="admin-danger"
            disabled={!restoreFile || restoreBusy}
            onClick={() => void restore()}
          >
            <FileUp size={16} />
            {restoreBusy ? "Restoring configuration…" : "Import configuration"}
          </button>
          {restoreMessage && <p className="admin-success">{restoreMessage}</p>}
        </section>
      </div>
    </div>
  );
}

function FileImporter() {
  const [lists, setLists] = useState<ContactListConfig[]>([]);
  const [contactListId, setContactListId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [keyField, setKeyField] = useState("");
  const [preview, setPreview] = useState<LeadPreview | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    api<{ items: ContactListConfig[] }>("/api/admin/pipeline/contact-lists")
      .then((result) => {
        if (active) setLists(result.items);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!job || job.status !== "RUNNING") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api<ImportJob>(
          `/api/admin/pipeline/imports/${job.id}`,
        );
        if (!active) return;
        setJob(latest);
        if (latest.status === "RUNNING")
          timer = setTimeout(() => void poll(), 900);
      } catch (reason) {
        if (active) {
          setError((reason as Error).message);
          timer = setTimeout(() => void poll(), 2500);
        }
      }
    };
    timer = setTimeout(() => void poll(), 700);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status]);

  async function inspect(nextListId: string, nextFile: File | null) {
    setPreview(null);
    setFields([]);
    setKeyField("");
    setContent("");
    setError("");
    if (!nextListId || !nextFile) return;
    if (!/\.(csv|json)$/i.test(nextFile.name)) {
      setError("Choose a CSV or JSON file.");
      return;
    }
    if (nextFile.size > 5 * 1024 * 1024) {
      setError("Files must be 5 MB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const text = await nextFile.text();
      const result = await api<{
        fields: string[];
        total: number;
        contactListName: string;
      }>("/api/admin/pipeline/file-import/inspect", {
        method: "POST",
        body: JSON.stringify({
          contactListId: nextListId,
          fileName: nextFile.name,
          content: text,
        }),
      });
      setContent(text);
      setFields(result.fields);
      const suggested = result.fields.find((field) =>
        /^(id|.*_id|.*id|customer_?id|record_?id)$/i.test(field),
      );
      setKeyField(suggested || result.fields[0] || "");
      setMessage(
        `File fields match ${result.contactListName}. ${result.total.toLocaleString()} records detected.`,
      );
    } catch (reason) {
      setError((reason as Error).message);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    if (!file || !contactListId || !keyField || !content) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await api<LeadPreview>(
        "/api/admin/pipeline/file-import/preview",
        {
          method: "POST",
          body: JSON.stringify({
            contactListId,
            fileName: file.name,
            content,
            keyField,
          }),
        },
      );
      setPreview(result);
      setJob(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start(reimport = false) {
    if (!preview || !file || !content) return;
    if (
      !window.confirm(
        reimport
          ? `Re-import ${preview.summary.synced} already synchronized records? Existing Genesys contacts will be updated; no new contacts will be created.`
          : `Import ${preview.summary.eligible} eligible records into ${preview.destination.name}?`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      setJob(
        await api<ImportJob>("/api/admin/pipeline/file-import", {
          method: "POST",
          body: JSON.stringify({
            contactListId,
            fileName: file.name,
            content,
            keyField,
            revision: preview.revision,
            reimport,
          }),
        }),
      );
      setMessage(reimport ? "Re-import started." : "File import started.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || Boolean(job?.status === "RUNNING");
  return (
    <div className="pipeline-workspace">
      <header className="admin-page-head">
        <div>
          <span>LEAD IMPORTER</span>
          <h1>File Import</h1>
          <p>
            Choose a Genesys Contact List and a CSV/JSON file. Confirm its
            fields and preview records before importing.
          </p>
        </div>
      </header>
      {error && <div className="admin-error">{error}</div>}
      {message && <div className="admin-success">{message}</div>}
      <section className="admin-panel ls-file-import">
        <div className="pipe-field-grid">
          <label>
            Genesys Contact List <em>*</em>
            <select
              value={contactListId}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value;
                setContactListId(value);
                setPreview(null);
                void inspect(value, file);
              }}
            >
              <option value="">Select destination Contact List first</option>
              {lists.map((list) => (
                <option key={list.contactListId} value={list.contactListId}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            CSV or JSON file <em>*</em>
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              disabled={!contactListId || disabled}
              onChange={(event) => {
                const next = event.target.files?.[0] || null;
                setFile(next);
                void inspect(contactListId, next);
              }}
            />
          </label>
          <label>
            Unique record ID field <em>*</em>
            <select
              value={keyField}
              disabled={!fields.length || disabled}
              onChange={(event) => {
                setKeyField(event.target.value);
                setPreview(null);
              }}
            >
              <option value="">Select a unique field</option>
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="pipe-muted">
          File columns must exactly match the selected Contact List. Files are
          limited to 5 MB and 10,000 records. The chosen ID field must be unique
          for safe re-imports.
        </p>
        <div className="ls-import-actions">
          <button
            className="admin-secondary"
            disabled={!fields.length || !keyField || disabled}
            onClick={() => void loadPreview()}
          >
            <Eye size={17} /> Preview file
          </button>
          <button
            className="admin-primary"
            disabled={
              !preview?.summary.eligible || disabled || preview.truncated
            }
            onClick={() => void start(false)}
          >
            <Upload size={17} /> Import eligible (
            {preview?.summary.eligible || 0})
          </button>
          <button
            className="admin-secondary"
            disabled={!preview?.summary.synced || disabled || preview.truncated}
            onClick={() => void start(true)}
          >
            <Upload size={17} /> Re-import synced (
            {preview?.summary.synced || 0})
          </button>
        </div>
      </section>
      {job && (
        <section className="admin-panel pipe-import-progress">
          <div className="pipe-section-head">
            <h3>Import progress</h3>
            <span>{job.status}</span>
          </div>
          <progress max={Math.max(1, job.total)} value={job.processed} />
          <p>{job.message}</p>
          <small>
            {job.created} created · {job.updated} updated · {job.failed} failed
          </small>
        </section>
      )}
      {preview && (
        <section className="admin-panel">
          <div className="ls-preview-heading">
            <h3>
              Preview Data{" "}
              <span>({preview.total.toLocaleString()} records)</span>
            </h3>
            <p>
              {preview.summary.eligible} eligible · {preview.summary.synced}{" "}
              synced · {preview.summary.invalid} excluded
            </p>
          </div>
          {preview.truncated && (
            <div className="pipe-warning">
              File exceeds the 10,000 record import limit.
            </div>
          )}
          <div className="pipe-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Record ID</th>
                  {preview.fields.map((field) => (
                    <th key={field}>{field}</th>
                  ))}
                  <th>Validation</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.status}</td>
                    <td>{row.sourceKey}</td>
                    {preview.fields.map((field) => (
                      <td key={field}>{row.data[field]}</td>
                    ))}
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.total > preview.rows.length && (
            <p className="pipe-muted">
              Showing {preview.rows.length} rows in preview. All valid rows are
              included when you start the import.
            </p>
          )}
        </section>
      )}
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
