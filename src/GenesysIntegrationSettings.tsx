import { useEffect, useState, type FormEvent } from "react";
import { Save, ShieldCheck } from "lucide-react";
import {
  api,
  type ConfigResponse,
  type GenesysConfig,
  type GenesysRegion,
} from "./lib/api";
export function GenesysIntegrationSettings() {
  const [data, setData] = useState<ConfigResponse | null>(null),
    [regions, setRegions] = useState<GenesysRegion[]>([]),
    [draft, setDraft] = useState<
      Partial<GenesysConfig> & { clientSecret?: string }
    >({}),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function load() {
    const [config, all] = await Promise.all([
      api<ConfigResponse>("/api/admin/genesys/config"),
      api<{ regions: GenesysRegion[] }>("/api/admin/genesys/regions"),
    ]);
    setData(config);
    setDraft({ ...config.config, clientSecret: "" });
    setRegions(all.regions);
  }
  useEffect(() => {
    void load().catch((reason) => setError((reason as Error).message));
  }, []);
  const selected = regions.find((region) => region.id === draft.regionId);
  async function run(action: "test" | "save") {
    setBusy(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const changed =
          draft.regionId !== data?.config.regionId ||
          draft.clientId !== data?.config.clientId ||
          Boolean(draft.clientSecret);
        const result = await api<{ ok: boolean; message: string }>(
          "/api/admin/genesys/test-connection",
          {
            method: "POST",
            body: JSON.stringify(
              changed
                ? {
                    regionId: draft.regionId,
                    clientId: draft.clientId,
                    clientSecret: draft.clientSecret,
                  }
                : {},
            ),
          },
        );
        if (!result.ok) throw Error(result.message);
        setMessage(result.message);
      } else {
        await api("/api/admin/genesys/config", {
          method: "PUT",
          body: JSON.stringify({
            enabled: draft.enabled,
            regionId: draft.regionId,
            clientId: draft.clientId,
            clientSecret: draft.clientSecret || undefined,
          }),
        });
        await load();
        setMessage("Genesys configuration saved.");
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="pipeline-workspace">
      <header className="admin-page-head">
        <div>
          <span>GENESYS CONFIGURATION</span>
          <h1>Integration Setting</h1>
          <p>Configure the Genesys region and OAuth credentials.</p>
        </div>
      </header>
      {error && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="admin-success" role="status">
          {message}
        </div>
      )}
      {data ? (
        <form
          className="admin-panel pipe-editor"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={Boolean(draft.enabled)}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            Integration enabled
          </label>
          <label>
            Genesys Region
            <select
              value={draft.regionId}
              onChange={(event) =>
                setDraft({ ...draft, regionId: event.target.value })
              }
            >
              {regions
                .filter((region) => region.enabled)
                .map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.name}
                  </option>
                ))}
            </select>
          </label>
          <dl className="ls-region-values">
            <div>
              <dt>Region Code</dt>
              <dd>{selected?.id || "—"}</dd>
            </div>
            <div>
              <dt>Application</dt>
              <dd>{selected?.applicationUrl || "—"}</dd>
            </div>
            <div>
              <dt>API</dt>
              <dd>{selected?.apiBaseUrl || "—"}</dd>
            </div>
            <div>
              <dt>OAuth</dt>
              <dd>{selected?.authBaseUrl || "—"}</dd>
            </div>
          </dl>
          <h2>OAuth</h2>
          <div className="pipe-field-grid">
            <label>
              Client ID
              <input
                autoComplete="off"
                value={draft.clientId || ""}
                onChange={(event) =>
                  setDraft({ ...draft, clientId: event.target.value })
                }
              />
            </label>
            <label>
              Client Secret
              <input
                type="password"
                autoComplete="new-password"
                placeholder={
                  data.config.secretConfigured
                    ? "Configured — leave blank to keep"
                    : "Enter Client Secret"
                }
                value={draft.clientSecret || ""}
                onChange={(event) =>
                  setDraft({ ...draft, clientSecret: event.target.value })
                }
              />
            </label>
          </div>
          <div className="pipe-form-actions">
            <button
              type="button"
              className="admin-secondary"
              disabled={Boolean(busy)}
              onClick={() => void run("test")}
            >
              <ShieldCheck size={16} />
              {busy === "test" ? "Testing…" : "Test Connection"}
            </button>
            <button className="admin-primary" disabled={Boolean(busy)}>
              <Save size={16} />
              {busy === "save" ? "Saving…" : "Save Configuration"}
            </button>
          </div>
        </form>
      ) : (
        <p className="pipe-muted">Loading configuration…</p>
      )}
    </div>
  );
}
