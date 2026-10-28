import { useEffect, useState, type FormEvent } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Save,
  History,
  RefreshCcw,
  CheckCircle2,
  Loader2,
  Clock3,
} from "lucide-react";
import {
  api,
  type GenesysRegion,
  type RegionHistoryRecord,
  type RegionResponse,
  type EndpointResult,
} from "./lib/api";
type EditorMode = "create" | "edit";
type RegionEditor = {
  mode: EditorMode;
  region: GenesysRegion;
  history: RegionHistoryRecord[];
  testResults?: Record<string, EndpointResult>;
};

const emptyCustomRegion: GenesysRegion = {
  id: "",
  name: "",
  domain: "",
  applicationUrl: "",
  apiBaseUrl: "",
  authBaseUrl: "",
  defaultApplicationUrl: "",
  defaultApiBaseUrl: "",
  defaultAuthBaseUrl: "",
  systemRegion: false,
  enabled: true,
  modified: false,
  createdAt: "",
  updatedAt: "",
  updatedBy: "",
};

export function App() {
  const [regions, setRegions] = useState<GenesysRegion[]>([]),
    [editor, setEditor] = useState<RegionEditor | null>(null),
    [busy, setBusy] = useState(""),
    [toast, setToast] = useState(""),
    [error, setError] = useState("");
  async function loadAll() {
    const result = await api<{ regions: GenesysRegion[] }>(
      "/api/admin/genesys/regions",
    );
    setRegions(result.regions);
  }
  useEffect(() => {
    void loadAll().catch((reason) => setError((reason as Error).message));
  }, []);
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function openEditor(regionId: string) {
    await run(`edit-${regionId}`, async () => {
      const result = await api<RegionResponse>(
        `/api/admin/genesys/regions/${regionId}`,
      );
      setEditor({
        mode: "edit",
        region: result.region,
        history: result.history,
      });
    });
  }

  async function saveRegion(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    await run("save-region", async () => {
      const method = editor.mode === "create" ? "POST" : "PUT";
      const path =
        editor.mode === "create"
          ? "/api/admin/genesys/regions"
          : `/api/admin/genesys/regions/${editor.region.id}`;
      const result = await api<{ region: GenesysRegion }>(path, {
        method,
        body: JSON.stringify(editor.region),
      });
      setToast("Region saved.");
      setEditor(null);
      await loadAll();
    });
  }

  async function testRegionUrls() {
    if (!editor) return;
    await run("test-region", async () => {
      const result = await api<{ results: Record<string, EndpointResult> }>(
        `/api/admin/genesys/regions/${editor.region.id}/test`,
        { method: "POST", body: JSON.stringify(editor.region) },
      );
      setEditor({ ...editor, testResults: result.results });
    });
  }

  async function resetRegion() {
    if (!editor) return;
    if (
      !window.confirm(
        `Reset ${editor.region.name} Genesys endpoints to system defaults?`,
      )
    )
      return;
    await run("reset-region", async () => {
      const result = await api<{ region: GenesysRegion }>(
        `/api/admin/genesys/regions/${editor.region.id}/reset`,
        { method: "POST" },
      );
      const detail = await api<RegionResponse>(
        `/api/admin/genesys/regions/${result.region.id}`,
      );
      setEditor({
        mode: "edit",
        region: detail.region,
        history: detail.history,
      });
      setToast("Region reset to system defaults.");
      await loadAll();
    });
  }

  async function deleteRegion(region: GenesysRegion) {
    if (!window.confirm(`Delete custom region ${region.name}?`)) return;
    await run(`delete-${region.id}`, async () => {
      await api<null>(`/api/admin/genesys/regions/${region.id}`, {
        method: "DELETE",
      });
      setToast("Region deleted.");
      await loadAll();
    });
  }

  return (
    <div className="genesys-workspace">
      <header className="admin-page-head">
        <div>
          <span>GENESYS CONFIGURATION</span>
          <h1>Region Management</h1>
          <p>Manage available Genesys regions and endpoints.</p>
        </div>
      </header>
      {error && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      {toast && <div className="admin-success">{toast}</div>}{" "}
      <section className="regions-view">
        <div className="table-actions">
          <h2>Genesys Cloud Regions</h2>
          <button
            className="primary"
            onClick={() =>
              setEditor({
                mode: "create",
                region: emptyCustomRegion,
                history: [],
              })
            }
          >
            <Plus size={16} />
            Add Custom Region
          </button>
        </div>
        <div className="region-table">
          {regions.map((region) => (
            <article key={region.id} className="region-row">
              <div>
                <strong>{region.name}</strong>
                <span>{region.domain}</span>
              </div>
              <code>{region.id}</code>
              <StatusBadge enabled={region.enabled} />
              <span className={region.modified ? "badge modified" : "badge"}>
                {region.modified ? "Modified" : "Default"}
              </span>
              <div className="row-actions">
                <button
                  className="icon-button"
                  title="Edit"
                  onClick={() => openEditor(region.id)}
                >
                  <Pencil size={17} />
                </button>
                {!region.systemRegion && (
                  <button
                    className="icon-button danger"
                    title="Delete"
                    onClick={() => deleteRegion(region)}
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      {editor && (
        <RegionModal
          editor={editor}
          setEditor={setEditor}
          onSave={saveRegion}
          onTest={testRegionUrls}
          onReset={resetRegion}
          busy={busy}
        />
      )}
    </div>
  );
}
function RegionModal({
  editor,
  setEditor,
  onSave,
  onTest,
  onReset,
  busy,
}: {
  editor: RegionEditor;
  setEditor: (editor: RegionEditor | null) => void;
  onSave: (event: FormEvent) => void;
  onTest: () => void;
  onReset: () => void;
  busy: string;
}) {
  const region = editor.region;
  const setRegion = (next: Partial<GenesysRegion>) =>
    setEditor({ ...editor, region: { ...region, ...next } });

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={onSave}>
        <header>
          <div>
            <span className="eyebrow">
              {editor.mode === "create" ? "Custom Region" : region.id}
            </span>
            <h2>
              {editor.mode === "create"
                ? "Add Genesys Region"
                : "Edit Genesys Region"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => setEditor(null)}
          >
            <X size={18} />
          </button>
        </header>

        <div className="field-grid">
          <label>
            <span>Region Name</span>
            <input
              value={region.name}
              onChange={(event) => setRegion({ name: event.target.value })}
            />
          </label>
          <label>
            <span>Region Code</span>
            <input
              value={region.id}
              disabled={editor.mode === "edit" && region.systemRegion}
              onChange={(event) => setRegion({ id: event.target.value })}
            />
          </label>
          <label>
            <span>Application URL</span>
            <input
              value={region.applicationUrl}
              onChange={(event) =>
                setRegion({ applicationUrl: event.target.value })
              }
            />
          </label>
          <label>
            <span>API Base URL</span>
            <input
              value={region.apiBaseUrl}
              onChange={(event) =>
                setRegion({ apiBaseUrl: event.target.value })
              }
            />
          </label>
          <label>
            <span>OAuth / Login URL</span>
            <input
              value={region.authBaseUrl}
              onChange={(event) =>
                setRegion({ authBaseUrl: event.target.value })
              }
            />
          </label>
          <label className="toggle-row inline">
            <input
              type="checkbox"
              checked={region.enabled}
              onChange={(event) => setRegion({ enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
        </div>

        {editor.mode === "edit" && (
          <section className="defaults-box">
            <SectionTitle title="System Defaults" />
            <ReadOnly
              label="Application"
              value={region.defaultApplicationUrl}
            />
            <ReadOnly label="API" value={region.defaultApiBaseUrl} />
            <ReadOnly label="OAuth" value={region.defaultAuthBaseUrl} />
          </section>
        )}

        {editor.testResults && (
          <section className="test-results">
            {Object.entries(editor.testResults).map(([field, result]) => (
              <StatusRow
                key={field}
                label={field.replace("Base", " ")}
                done={result.reachable}
                detail={result.status ? `HTTP ${result.status}` : result.error}
              />
            ))}
          </section>
        )}

        {editor.history.length > 0 && (
          <details className="history-box">
            <summary>
              <History size={16} />
              View Change History
            </summary>
            {editor.history.slice(0, 8).map((item) => (
              <div
                key={`${item.timestamp}-${Object.keys(item.changes).join("-")}`}
              >
                <Clock3 size={14} />
                <span>{formatDate(item.timestamp)}</span>
                <code>{Object.keys(item.changes).join(", ")}</code>
              </div>
            ))}
          </details>
        )}

        <footer className="button-row right">
          <button
            type="button"
            className="secondary"
            onClick={() => setEditor(null)}
          >
            Cancel
          </button>
          {editor.mode === "edit" && (
            <button
              type="button"
              className="secondary"
              onClick={onTest}
              disabled={Boolean(busy)}
            >
              <RefreshCcw size={16} />
              Test URLs
            </button>
          )}
          {editor.mode === "edit" && region.systemRegion && (
            <button
              type="button"
              className="secondary warning"
              onClick={onReset}
              disabled={Boolean(busy)}
            >
              Reset to Default
            </button>
          )}
          <button className="primary" disabled={Boolean(busy)}>
            <Save size={16} />
            Save Changes
          </button>
        </footer>
      </form>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h2 className="section-title">{title}</h2>;
}

function SummaryItem({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value?: string }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value || ""} readOnly />
    </label>
  );
}

function StatusRow({
  label,
  done,
  detail,
}: {
  label: string;
  done: boolean;
  detail?: string;
}) {
  return (
    <div className="status-row">
      <CheckCircle2 className={done ? "ok" : "muted-icon"} size={18} />
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill ${status.toLowerCase()}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? "badge enabled" : "badge disabled"}>
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
