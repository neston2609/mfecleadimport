import { useEffect, useState, useRef } from "react";
import { RefreshCw, Cloud, Database, Clock3 } from "lucide-react";
import { api } from "./lib/api";
type Status = {
  checkedAt: string;
  integration: { status: string; checkedAt: string | null; message: string };
  sources: {
    id: string;
    name: string;
    kind: string;
    status: string;
    checkedAt: string | null;
    message: string;
    lastSyncStatus: string | null;
    lastSyncTime: string | null;
    lastSyncMessage: string;
  }[];
};
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })
    : "Not available";
export function StatusPill({ value }: { value: string | null }) {
  const label = value ? value.replaceAll("_", " ").toLowerCase() : "Not run";
  return (
    <span
      className={`ls-system-pill ${value && ["CONNECTED", "ACTIVE", "SUCCESS"].includes(value) ? "normal" : value && ["ERROR", "FAILED"].includes(value) ? "error" : "warning"}`}
    >
      {label}
    </span>
  );
}
export function SystemStatus() {
  const [data, setData] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);
  async function refresh(live = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      setData(
        await api<Status>(
          "/api/admin/pipeline/status" + (live ? "/refresh" : ""),
          live ? { method: "POST", body: "{}" } : undefined,
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="admin-panel ls-system-status">
      <div className="pipe-section-head">
        <div>
          <h2>System Status</h2>
          <p className="pipe-muted">
            Connection checks and actual import activity · Bangkok time
          </p>
        </div>
        <button
          className="admin-secondary"
          disabled={busy}
          onClick={() => void refresh(true)}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {busy ? "Checking…" : "Refresh status"}
        </button>
      </div>
      {error && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      {data ? (
        <>
          <div className="ls-system-connection">
            <Cloud size={24} />
            <div>
              <strong>Integration Connection</strong>
              <small>{data.integration.message}</small>
            </div>
            <StatusPill value={data.integration.status} />
            <span className="pipe-muted">
              Last checked: {time(data.integration.checkedAt)}
            </span>
          </div>
          <div className="pipe-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Datasource</th>
                  <th>Datasource Status</th>
                  <th>Last Sync Status</th>
                  <th>Last Sync Time</th>
                  <th>Last Connection Check</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong>{source.name}</strong>
                      <small>{source.kind}</small>
                    </td>
                    <td>
                      <StatusPill value={source.status} />
                      <small>{source.message}</small>
                    </td>
                    <td>
                      <StatusPill value={source.lastSyncStatus} />
                      <small>{source.lastSyncMessage}</small>
                    </td>
                    <td>{time(source.lastSyncTime)}</td>
                    <td>{time(source.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.sources.length && (
              <div className="pipe-empty">
                <Database size={25} />
                <p>
                  No datasources configured. Add a Source Integration to start.
                </p>
              </div>
            )}
          </div>
          <p className="pipe-muted">
            <Clock3 size={13} /> Status values come from real connection checks
            and import history. Not checked / Not run means no result has been
            recorded.
          </p>
        </>
      ) : (
        <p className="pipe-muted">
          {busy
            ? "Loading system status…"
            : "Status is not available. Refresh to retry."}
        </p>
      )}
    </section>
  );
}
