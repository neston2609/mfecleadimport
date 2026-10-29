import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Upload,
  Eye,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Database,
  FileUp,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./lib/api";
import type {
  ContactListConfiguration,
  ContactField,
  SourceIntegration,
  SourceMapping,
  LeadDefinition,
  LeadFilter,
  ImportSchedule,
  ImportJob,
  LeadPreview,
  SourceData,
} from "../server/domain/pipeline-types";
import "./pipeline.css";
import { LeadSyncInsights, LeadSyncMetrics } from "./LeadSyncInsights";
import { SystemStatus } from "./SystemStatus";

const endpoint = "/api/admin/pipeline";
type SourceView = Omit<SourceIntegration, "secretEncrypted"> & {
  secretConfigured: boolean;
};
type Bootstrap = {
  contactLists: ContactListConfiguration[];
  sources: SourceView[];
  mappings: SourceMapping[];
  leads: LeadDefinition[];
  schedules: ImportSchedule[];
  jobs: ImportJob[];
};
const empty: Bootstrap = {
  contactLists: [],
  sources: [],
  mappings: [],
  leads: [],
  schedules: [],
  jobs: [],
};
type Page =
  | "overview"
  | "sources"
  | "mappings"
  | "leads"
  | "manual-import"
  | "schedule-import";
type DraftSource = {
  id?: string;
  name: string;
  kind: SourceIntegration["kind"];
  config: SourceIntegration["config"];
  secret?: string;
  secretConfigured?: boolean;
};
const titles: Record<Page, [string, string]> = {
  overview: [
    "LeadSync Dashboard",
    "Connect your sources, map your data, and deliver leads to Genesys.",
  ],
  sources: [
    "Source Integration",
    "Connect a database or Web Service, or upload a CSV / JSON file.",
  ],
  mappings: [
    "Source Mapping",
    "Connect source fields to a Genesys Contact List and choose a stable record key.",
  ],
  leads: [
    "Lead Configuration",
    "Build reusable lead selections with field values, numbers, and date offsets.",
  ],
  "manual-import": [
    "Manual Lead Import",
    "Preview, validate, and import leads to Genesys Cloud",
  ],
  "schedule-import": [
    "Schedule Import",
    "Run lead imports daily, weekly, monthly, or on selected days of each month.",
  ],
};
const formatDate = (value: string) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        timeZone: "Asia/Bangkok",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const canImport = (status: string) =>
  ["ELIGIBLE", "UPDATE_AVAILABLE"].includes(status);
const FeedbackContext = createContext({
  error: "",
  message: "",
  reset: () => {},
});
function Pill({ value }: { value: string }) {
  return (
    <span className={`pipe-pill ${value.toLowerCase().replaceAll("_", "-")}`}>
      {(
        {
          ELIGIBLE: "Ready to Import",
          UPDATE_AVAILABLE: "Ready to update",
          SYNCED: "Already synced",
          INVALID: "Invalid",
          DNC: "Do not call",
        } as Record<string, string>
      )[value] || value.replaceAll("_", " ")}
    </span>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const feedback = useContext(FeedbackContext);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const selector =
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(selector),
      ).filter((item) => item.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="admin-modal-backdrop">
      <section
        ref={dialogRef}
        className="admin-modal pipe-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="admin-modal-head">
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {feedback.error && (
          <div className="admin-error" role="alert">
            {feedback.error}
          </div>
        )}
        {feedback.message && (
          <div className="admin-success" role="status">
            {feedback.message}
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="pipe-empty">
      <Layers size={30} />
      <p>{children}</p>
    </div>
  );
}
function DataTable({ data }: { data: SourceData | null }) {
  if (!data) return null;
  return (
    <section className="pipe-preview">
      <div className="pipe-preview-head">
        <strong>Data preview</strong>
        <span>
          {data.rows.length} shown · {data.total} rows read ·{" "}
          {data.fields.length} fields
        </span>
      </div>
      {data.truncated && (
        <p className="pipe-warning">
          The source limit was reached. Narrow your SQL query or Web Service
          request before importing.
        </p>
      )}
      <div className="pipe-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              {data.fields.map((field) => (
                <th key={field}>{field}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, index) => (
              <tr key={index}>
                {data.fields.map((field) => (
                  <td key={field} title={String(row[field] ?? "")}>
                    {String(row[field] ?? "").slice(0, 180)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.rows.length && (
          <Empty>
            No data rows returned. Table fields are shown when available.
          </Empty>
        )}
      </div>
    </section>
  );
}
function RecordActions({
  onEdit,
  onDelete,
  onForceDelete,
  onPreview,
}: {
  onEdit?: () => void;
  onDelete: () => void;
  onForceDelete?: () => void;
  onPreview?: () => void;
}) {
  const feedback = useContext(FeedbackContext);
  return (
    <div className="pipe-actions">
      {onPreview && (
        <button
          className="admin-secondary"
          onClick={() => {
            feedback.reset();
            onPreview();
          }}
        >
          Preview
        </button>
      )}
      {onEdit && (
        <button
          className="admin-secondary"
          onClick={() => {
            feedback.reset();
            onEdit();
          }}
        >
          Edit
        </button>
      )}
      <button
        className="pipe-icon danger-link"
        aria-label="Delete configuration"
        onClick={onDelete}
      >
        <Trash2 size={16} />
      </button>
      {onForceDelete && (
        <button className="admin-secondary danger-link" onClick={onForceDelete}>
          Force delete
        </button>
      )}
    </div>
  );
}

export function PipelineWorkspace({ page }: { page: Page }) {
  const [data, setData] = useState<Bootstrap>(empty),
    [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [source, setSource] = useState<DraftSource | null>(null),
    [sourceData, setSourceData] = useState<SourceData | null>(null);
  const [mapping, setMapping] = useState<
    | (Partial<SourceMapping> & {
        name: string;
        contactListId: string;
        sourceId: string;
        keyField: string;
        fields: SourceMapping["fields"];
      })
    | null
  >(null);
  const [lead, setLead] = useState<
    | (Partial<LeadDefinition> & {
        name: string;
        mappingId: string;
        match: "ALL" | "ANY";
        filters: LeadFilter[];
      })
    | null
  >(null);
  const [schedule, setSchedule] = useState<Partial<ImportSchedule> | null>(
    null,
  );
  const [leadPreview, setLeadPreview] = useState<LeadPreview | null>(null);
  async function refresh() {
    const value = await api<Bootstrap>(endpoint + "/bootstrap");
    setData(value);
    setLoading(false);
  }
  useEffect(() => {
    let active = true;
    api<Bootstrap>(endpoint + "/bootstrap")
      .then((value) => {
        if (active) {
          setData(value);
          setLoading(false);
          if (["mappings", "manual-import", "schedule-import"].includes(page)) {
            void api<{ items: ContactListConfiguration[] }>(
              endpoint + "/contact-lists",
            )
              .then((result) => {
                if (active) {
                  setLists(result.items);
                  setData((previous) => ({
                    ...previous,
                    contactLists: result.items,
                  }));
                }
              })
              .catch((reason) => {
                if (active) setError(reason.message);
              });
          }
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [page]);
  useEffect(() => {
    if (page !== "schedule-import" && page !== "overview") return;
    const timer = setInterval(
      () => void refresh().catch(() => undefined),
      10000,
    );
    return () => clearInterval(timer);
  }, [page]);
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action failed");
    } finally {
      setBusy("");
    }
  }
  const loadLists = () =>
    run("contact-lists", async () => {
      const result = await api<{ items: ContactListConfiguration[] }>(
        endpoint + "/contact-lists",
      );
      setLists(result.items);
      setData((previous) => ({ ...previous, contactLists: result.items }));
      if (!result.items.length)
        setMessage(
          "No Genesys Contact Lists found. Check the configured region and OAuth permissions.",
        );
    });
  async function save(kind: string, draft: { id?: string }, close: () => void) {
    await run("save", async () => {
      await api(`${endpoint}/${kind}${draft.id ? "/" + draft.id : ""}`, {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      close();
      await refresh();
      setMessage("Configuration saved.");
    });
  }
  function remove(kind: string, id: string) {
    if (
      !window.confirm(
        "Delete this configuration? Linked configurations must be updated first.",
      )
    )
      return;
    void run("delete", async () => {
      await api(`${endpoint}/${kind}/${id}`, { method: "DELETE" });
      await refresh();
      setMessage("Configuration deleted.");
    });
  }
  function forceDeleteLead(lead: LeadDefinition) {
    const confirmation = window.prompt(
      `Force delete "${lead.name}"? This also deletes schedules linked to this Lead Configuration. Import history, contact identities, and Genesys contacts are preserved. Type the Lead Configuration name to confirm.`,
    );
    if (confirmation !== lead.name) return;
    void run("force-delete", async () => {
      const result = await api<{ removedSchedules: number }>(
        `${endpoint}/leads/${lead.id}?force=true`,
        {
          method: "DELETE",
          body: JSON.stringify({ confirmation }),
        },
      );
      await refresh();
      setMessage(
        `Lead Configuration force deleted. ${result.removedSchedules} linked schedule(s) removed; import history and Genesys contacts were preserved.`,
      );
    });
  }
  function create() {
    setError("");
    setMessage("");
    setSourceData(null);
    if (page === "sources")
      setSource({
        name: "",
        kind: "WEB",
        config: { uri: "", method: "GET", auth: "NONE" },
      });
    if (page === "mappings")
      setMapping({
        name: "",
        contactListId: "",
        sourceId: "",
        keyField: "",
        fields: [],
      });
    if (page === "leads")
      setLead({ name: "", mappingId: "", match: "ALL", filters: [] });
    if (page === "schedule-import")
      setSchedule({
        name: "",
        leadId: "",
        contactListId: "",
        frequency: "DAILY",
        time: "09:00",
        dayOfWeek: 1,
        dayOfMonth: 1,
        monthDays: [],
        enabled: false,
      });
  }
  const [title, description] = titles[page];
  const selectedDestination = data.contactLists.find(
    (item) => item.contactListId === mapping?.contactListId,
  );
  const selectedSource = data.sources.find(
    (item) => item.id === mapping?.sourceId,
  );
  const selectedMapping = data.mappings.find(
    (item) => item.id === lead?.mappingId,
  );
  const filterDestination = data.contactLists.find(
    (item) => item.contactListId === selectedMapping?.contactListId,
  );
  const filterSource = data.sources.find(
    (item) => item.id === selectedMapping?.sourceId,
  );
  function updateSource(values: Partial<SourceIntegration["config"]>) {
    if (source)
      setSource({ ...source, config: { ...source.config, ...values } });
  }
  async function previewDraft(connectOnly = false) {
    if (!source) return;
    await run("source-preview", async () => {
      const result = await api<SourceData>(endpoint + "/sources/preview", {
        method: "POST",
        body: JSON.stringify({ source, connectOnly }),
      });
      setSourceData(result);
      if (connectOnly)
        setMessage(
          `Connected. ${result.tables?.length || 0} tables / views available.`,
        );
    });
  }
  function mappingFor(contactListId: string, sourceId: string) {
    const t = data.contactLists.find(
        (item) => item.contactListId === contactListId,
      ),
      s = data.sources.find((item) => item.id === sourceId);
    return (t?.fields || []).map((field) => ({
      targetField: field.name,
      sourceField: s?.fields.includes(field.name) ? field.name : "",
      defaultValue: "",
    }));
  }
  async function chooseDestination(id: string) {
    if (!mapping) return;
    const row = data.contactLists.find((item) => item.contactListId === id);
    if (!row?.uuid) {
      setError(
        "Configure the Contact List UUID under Genesys Configuration → Contact List Configuration before mapping.",
      );
      return;
    }
    await run("schema", async () => {
      const schema = await api<ContactListConfiguration>(
        endpoint + "/contact-lists/" + encodeURIComponent(id),
      );
      setData((previous) => ({
        ...previous,
        contactLists: previous.contactLists.map((item) =>
          item.contactListId === id ? schema : item,
        ),
      }));
      setMapping({
        ...mapping,
        contactListId: id,
        fields: schema.fields.map((field) => ({
          targetField: field.name,
          sourceField: selectedSource?.fields.includes(field.name)
            ? field.name
            : "",
          defaultValue: "",
          type: field.type,
          required: field.required,
        })),
      });
    });
  }
  const destinationPicker = (
    value: string,
    onChange: (value: string) => void,
    disabled = false,
  ) => (
    <div className="pipe-inline">
      <select
        aria-label="Genesys Contact List"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select Genesys Contact List</option>
        {value && !lists.some((item) => item.id === value) && (
          <option value={value}>{value}</option>
        )}
        {lists.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <button
        className="admin-secondary"
        type="button"
        onClick={() => void loadLists()}
        disabled={Boolean(busy)}
      >
        <RefreshCw size={15} /> Load lists
      </button>
    </div>
  );
  return (
    <FeedbackContext.Provider
      value={{
        error,
        message,
        reset: () => {
          setError("");
          setMessage("");
        },
      }}
    >
      <div className="pipeline-workspace">
        <header className="admin-page-head">
          <div>
            <span>
              {["manual-import", "schedule-import"].includes(page)
                ? "LEAD IMPORTER"
                : page === "overview"
                  ? "YOUR DATA. YOUR OPPORTUNITIES."
                  : "MFEC LEADSYNC"}
            </span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {!["overview", "manual-import"].includes(page) && (
            <button className="admin-primary" onClick={create}>
              <Plus size={17} />{" "}
              {page === "schedule-import"
                ? "New schedule"
                : "Create " +
                  (
                    {
                      sources: "source",
                      mappings: "mapping",
                      leads: "lead",
                    } as Record<string, string>
                  )[page]}
            </button>
          )}
        </header>
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="admin-success" role="status">
            <CheckCircle2 size={16} />
            {message}
          </div>
        )}
        {busy && (
          <div className="pipe-busy">
            <Loader2 size={15} className="spin" />
            {busy === "save"
              ? "Saving configuration…"
              : busy === "run-schedule"
                ? "Import is running. Progress and results are recorded in import history."
                : "Working…"}
          </div>
        )}
        {loading ? (
          <div className="admin-loading">Loading workspace…</div>
        ) : (
          <>
            {page === "overview" && (
              <>
                <SystemStatus />
                <div className="pipe-stat-grid">
                  {[
                    [
                      "Genesys Contact Lists",
                      data.contactLists.length,
                      "contact-lists",
                    ],
                    ["Source integrations", data.sources.length, "sources"],
                    ["Source mappings", data.mappings.length, "mappings"],
                    ["Lead configurations", data.leads.length, "leads"],
                  ].map(([label, value, url]) => (
                    <a
                      className="admin-panel pipe-stat"
                      href={"/" + url}
                      key={String(url)}
                    >
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <ArrowRight size={18} />
                    </a>
                  ))}
                </div>
                <JobHistory jobs={data.jobs} />
              </>
            )}
            {page === "sources" && (
              <section className="admin-panel pipe-record-list">
                {!data.sources.length ? (
                  <Empty>
                    Connect a source to begin. Database credentials and Web
                    Service tokens are encrypted on the server.
                  </Empty>
                ) : (
                  data.sources.map((item) => (
                    <article key={item.id}>
                      <div>
                        <h3>
                          {item.name} <Pill value={item.kind} />
                        </h3>
                        <p>
                          {item.fields.length} fields ·{" "}
                          {item.config.fileName ||
                            item.config.table ||
                            (item.kind === "WEB"
                              ? item.config.uri?.split("?")[0]
                              : item.kind === "JDBC"
                                ? "JDBC connection"
                                : item.kind + " source")}
                        </p>
                        <small className="pipe-muted">
                          Updated {formatDate(item.updatedAt)}
                        </small>
                      </div>
                      <RecordActions
                        onEdit={() => {
                          setSource({ ...item });
                          setSourceData(null);
                        }}
                        onPreview={() =>
                          void run("preview", async () =>
                            setSourceData(
                              await api<SourceData>(
                                `${endpoint}/sources/${item.id}/preview`,
                                { method: "POST", body: "{}" },
                              ),
                            ),
                          )
                        }
                        onDelete={() => remove("sources", item.id)}
                      />
                    </article>
                  ))
                )}
              </section>
            )}
            {page === "sources" && !source && <DataTable data={sourceData} />}
            {page === "mappings" && (
              <section className="admin-panel pipe-record-list">
                {!data.mappings.length ? (
                  <Empty>
                    Save a Genesys Contact List and Source Integration first,
                    then connect their fields.
                  </Empty>
                ) : (
                  data.mappings.map((item) => (
                    <article key={item.id}>
                      <div>
                        <h3>{item.name}</h3>
                        <p>
                          {data.sources.find(
                            (source) => source.id === item.sourceId,
                          )?.name || "Missing source"}{" "}
                          →{" "}
                          {data.contactLists.find(
                            (list) => list.contactListId === item.contactListId,
                          )?.name || "Missing Contact List"}
                        </p>
                        <small>
                          Record key: {item.keyField} ·{" "}
                          {
                            item.fields.filter((field) => field.sourceField)
                              .length
                          }{" "}
                          mapped fields
                        </small>
                      </div>
                      <RecordActions
                        onEdit={() => {
                          setMapping({
                            ...item,
                            fields: item.fields.map((field) => ({ ...field })),
                          });
                          setSourceData(null);
                        }}
                        onDelete={() => remove("mappings", item.id)}
                      />
                    </article>
                  ))
                )}
              </section>
            )}
            {page === "leads" && (
              <section className="admin-panel pipe-record-list">
                {!data.leads.length ? (
                  <Empty>
                    Create a Source Mapping first, then save a named Lead
                    Configuration with the filters you need.
                  </Empty>
                ) : (
                  data.leads.map((item) => (
                    <article key={item.id}>
                      <div>
                        <h3>{item.name}</h3>
                        <p>
                          {data.mappings.find(
                            (mapping) => mapping.id === item.mappingId,
                          )?.name || "Missing mapping"}{" "}
                          · {item.filters.length} filters · Match{" "}
                          {item.match.toLowerCase()}
                        </p>
                        <small className="pipe-muted">
                          Updated {formatDate(item.updatedAt)}
                        </small>
                      </div>
                      <RecordActions
                        onEdit={() =>
                          setLead({
                            ...item,
                            filters: item.filters.map((filter) => ({
                              ...filter,
                            })),
                          })
                        }
                        onPreview={() =>
                          void run("preview", async () =>
                            setLeadPreview(
                              await api<LeadPreview>(
                                `${endpoint}/leads/${item.id}/preview`,
                              ),
                            ),
                          )
                        }
                        onDelete={() => remove("leads", item.id)}
                        onForceDelete={() => forceDeleteLead(item)}
                      />
                    </article>
                  ))
                )}
              </section>
            )}
            {page === "manual-import" && (
              <ManualImporter
                data={data}
                lists={lists}
                loadLists={loadLists}
                onError={setError}
                refresh={refresh}
              />
            )}
            {page === "schedule-import" && (
              <>
                <section className="admin-panel">
                  <p className="pipe-muted">
                    All schedules use Asia/Bangkok (UTC+7). Dates such as the
                    31st are skipped in months without that date.
                  </p>
                  <div className="pipe-table-scroll">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Schedule / Lead</th>
                          <th>Frequency</th>
                          <th>Next run</th>
                          <th>Last result</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.schedules.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <b>{item.name}</b>
                              <small>
                                {
                                  data.leads.find(
                                    (lead) => lead.id === item.leadId,
                                  )?.name
                                }
                              </small>
                              <Pill
                                value={item.enabled ? "ENABLED" : "PAUSED"}
                              />
                            </td>
                            <td>
                              {item.frequency.replaceAll("_", " ")} ·{" "}
                              {item.time}
                              <small>
                                {item.frequency === "WEEKLY"
                                  ? [
                                      "Sunday",
                                      "Monday",
                                      "Tuesday",
                                      "Wednesday",
                                      "Thursday",
                                      "Friday",
                                      "Saturday",
                                    ][item.dayOfWeek]
                                  : item.frequency === "MONTHLY"
                                    ? "Day " + item.dayOfMonth
                                    : item.frequency === "MONTH_DAYS"
                                      ? "Days " + item.monthDays.join(", ")
                                      : "Every day"}
                              </small>
                            </td>
                            <td>{formatDate(item.nextRunAt)}</td>
                            <td>
                              <Pill value={item.lastStatus} />
                              <small title={item.lastMessage}>
                                {item.lastMessage.slice(0, 100) ||
                                  "Not run yet"}
                              </small>
                            </td>
                            <td>
                              <div className="pipe-actions">
                                <button
                                  className="admin-secondary"
                                  onClick={() => setSchedule({ ...item })}
                                >
                                  Edit
                                </button>
                                <button
                                  disabled={
                                    Boolean(busy) ||
                                    item.lastStatus === "RUNNING"
                                  }
                                  className="admin-secondary"
                                  onClick={() =>
                                    void run("toggle", async () => {
                                      await api(
                                        `${endpoint}/schedules/${item.id}`,
                                        {
                                          method: "PUT",
                                          body: JSON.stringify({
                                            ...item,
                                            enabled: !item.enabled,
                                          }),
                                        },
                                      );
                                      await refresh();
                                    })
                                  }
                                >
                                  {item.enabled ? "Pause" : "Enable"}
                                </button>
                                <button
                                  disabled={
                                    Boolean(busy) ||
                                    item.lastStatus === "RUNNING"
                                  }
                                  className="admin-secondary"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        "Run this import now using the latest source data?",
                                      )
                                    )
                                      void run("run-schedule", async () => {
                                        await api(
                                          `${endpoint}/schedules/${item.id}/run`,
                                          { method: "POST", body: "{}" },
                                        );
                                        await refresh();
                                      });
                                  }}
                                >
                                  Run now
                                </button>
                                <button
                                  className="pipe-icon danger-link"
                                  aria-label="Delete schedule"
                                  onClick={() => {
                                    if (window.confirm("Delete this schedule?"))
                                      void run("delete", async () => {
                                        await api(
                                          `${endpoint}/schedules/${item.id}`,
                                          { method: "DELETE" },
                                        );
                                        await refresh();
                                      });
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!data.schedules.length && (
                      <Empty>
                        Create a schedule after saving a Lead Configuration.
                      </Empty>
                    )}
                  </div>
                </section>
                <JobHistory jobs={data.jobs} />
              </>
            )}
          </>
        )}
        {source && (
          <Modal
            title={
              source.id
                ? "Edit Source Integration"
                : "Create Source Integration"
            }
            onClose={() => setSource(null)}
          >
            <div className="pipe-editor">
              <div className="pipe-field-grid">
                <label>
                  Source name
                  <input
                    value={source.name}
                    onChange={(event) =>
                      setSource({ ...source, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Protocol
                  <select
                    value={source.kind}
                    onChange={(event) => {
                      setSource({
                        ...source,
                        kind: event.target.value as DraftSource["kind"],
                        config: {},
                        secret: "",
                        secretConfigured: false,
                      });
                      setSourceData(null);
                    }}
                  >
                    {[
                      ["JDBC", "Database (JDBC)"],
                      ["WEB", "Web Service"],
                      ["CSV", "CSV File"],
                      ["JSON", "JSON File"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {source.kind === "JDBC" && (
                <>
                  <label>
                    JDBC URL
                    <input
                      value={source.config.jdbcUrl || ""}
                      onChange={(event) =>
                        updateSource({ jdbcUrl: event.target.value })
                      }
                      placeholder="jdbc:postgresql://host:5432/database"
                    />
                  </label>
                  <p className="pipe-muted">
                    SQL Server · PostgreSQL · MySQL · Oracle · MariaDB are
                    included. Other JDBC databases work after installing their
                    driver JAR on the server.
                  </p>
                  <div className="pipe-field-grid">
                    <label>
                      Username
                      <input
                        autoComplete="off"
                        value={source.config.username || ""}
                        onChange={(event) =>
                          updateSource({ username: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Password
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={source.secret || ""}
                        placeholder={
                          source.secretConfigured
                            ? "Configured — leave blank to keep"
                            : "Database password"
                        }
                        onChange={(event) =>
                          setSource({ ...source, secret: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Driver class (optional)
                    <input
                      value={source.config.driverClass || ""}
                      onChange={(event) =>
                        updateSource({ driverClass: event.target.value })
                      }
                      placeholder="Auto-detected for JDBC 4 drivers"
                    />
                  </label>
                  <button
                    disabled={Boolean(busy) || !source.name.trim()}
                    className="admin-secondary"
                    onClick={() => void previewDraft(true)}
                  >
                    <Database size={16} /> Connect & list tables
                  </button>
                  <div className="pipe-field-grid">
                    <label>
                      Table / View
                      <select
                        value={source.config.table || ""}
                        onChange={(event) =>
                          updateSource({ table: event.target.value, query: "" })
                        }
                      >
                        <option value="">
                          Choose a table after connecting
                        </option>
                        {source.config.table &&
                          !sourceData?.tables?.includes(
                            source.config.table,
                          ) && (
                            <option value={source.config.table}>
                              {source.config.table}
                            </option>
                          )}
                        {sourceData?.tables?.map((table) => (
                          <option key={table}>{table}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Or use a SQL Query
                      <textarea
                        rows={4}
                        value={source.config.query || ""}
                        onChange={(event) =>
                          updateSource({
                            query: event.target.value,
                            table: event.target.value.trim()
                              ? ""
                              : source.config.table,
                          })
                        }
                        placeholder="SELECT id, name, phone FROM customers"
                      />
                    </label>
                  </div>
                  <p className="pipe-muted">
                    Use a read-only database account. Only a single SELECT query
                    is accepted.
                  </p>
                </>
              )}
              {source.kind === "WEB" && (
                <>
                  <label>
                    URI
                    <input
                      value={source.config.uri || ""}
                      onChange={(event) =>
                        updateSource({ uri: event.target.value })
                      }
                      placeholder="https://api.example.com/customers"
                    />
                  </label>
                  <div className="pipe-field-grid">
                    <label>
                      Method
                      <select
                        value={source.config.method || "GET"}
                        onChange={(event) =>
                          updateSource({
                            method: event.target.value as "GET" | "POST",
                          })
                        }
                      >
                        <option>GET</option>
                        <option>POST</option>
                      </select>
                    </label>
                    <label>
                      Authentication
                      <select
                        value={source.config.auth || "NONE"}
                        onChange={(event) =>
                          updateSource({
                            auth: event.target.value as
                              "NONE" | "BASIC" | "BEARER" | "API_KEY",
                          })
                        }
                      >
                        {["NONE", "BASIC", "BEARER", "API_KEY"].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {source.config.auth === "BASIC" && (
                    <label>
                      Username
                      <input
                        value={source.config.username || ""}
                        onChange={(event) =>
                          updateSource({ username: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {source.config.auth === "API_KEY" && (
                    <label>
                      API key header
                      <input
                        value={source.config.headerName || "X-API-Key"}
                        onChange={(event) =>
                          updateSource({ headerName: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {source.config.auth && source.config.auth !== "NONE" && (
                    <label>
                      {source.config.auth === "BASIC"
                        ? "Password"
                        : "Token / API key"}
                      <input
                        autoComplete="new-password"
                        type="password"
                        value={source.secret || ""}
                        placeholder={
                          source.secretConfigured
                            ? "Configured — leave blank to keep"
                            : ""
                        }
                        onChange={(event) =>
                          setSource({ ...source, secret: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {source.config.method === "POST" && (
                    <label>
                      JSON request body
                      <textarea
                        rows={4}
                        value={source.config.requestBody || ""}
                        onChange={(event) =>
                          updateSource({ requestBody: event.target.value })
                        }
                        placeholder="{}"
                      />
                    </label>
                  )}
                </>
              )}
              {["CSV", "JSON"].includes(source.kind) && (
                <>
                  <label className="pipe-file-drop">
                    <FileUp size={22} />
                    <span>
                      {source.config.fileName ||
                        "Choose a " + source.kind + " file"}
                    </span>
                    <input
                      aria-label="Source file"
                      type="file"
                      accept={
                        source.kind === "CSV"
                          ? ".csv,text/csv"
                          : ".json,application/json"
                      }
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        if (file.size > 5 * 1024 * 1024) {
                          setError("Files must be 5 MB or smaller");
                          return;
                        }
                        void file.text().then((content) => {
                          setSource({
                            ...source,
                            config: {
                              ...source.config,
                              content,
                              fileName: file.name,
                            },
                          });
                          setSourceData(null);
                        });
                      }}
                    />
                  </label>
                  <small className="pipe-muted">
                    UTF-8 · up to 5 MB. Uploaded files remain server-side for
                    future scheduled imports.
                  </small>
                  <details>
                    <summary>Paste or inspect file content</summary>
                    <textarea
                      aria-label="File content"
                      className="pipe-code"
                      rows={7}
                      value={source.config.content || ""}
                      onChange={(event) =>
                        updateSource({ content: event.target.value })
                      }
                      placeholder={
                        source.id
                          ? "A file is stored on the server. Paste or upload content to replace it."
                          : "Paste CSV / JSON content"
                      }
                    />
                  </details>
                  {source.kind === "CSV" && (
                    <label>
                      Delimiter
                      <select
                        value={source.config.delimiter || ""}
                        onChange={(event) =>
                          updateSource({ delimiter: event.target.value })
                        }
                      >
                        <option value="">Auto-detect</option>
                        <option value=",">Comma</option>
                        <option value=";">Semicolon</option>
                        <option value={"\t"}>Tab</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {["WEB", "JSON"].includes(source.kind) && (
                <label>
                  Response data path (optional)
                  <input
                    value={source.config.resultPath || ""}
                    onChange={(event) =>
                      updateSource({ resultPath: event.target.value })
                    }
                    placeholder="e.g. data.customers"
                  />
                  <small>
                    Leave blank for a JSON array, a single object, or common
                    items/data/results wrappers.
                  </small>
                </label>
              )}
              <button
                className="admin-secondary"
                disabled={Boolean(busy) || !source.name.trim()}
                onClick={() => void previewDraft()}
              >
                <RefreshCw size={15} /> Preview data & fields
              </button>
              <DataTable data={sourceData} />
              <div className="pipe-form-actions">
                <button
                  className="admin-secondary"
                  onClick={() => setSource(null)}
                >
                  Cancel
                </button>
                <button
                  className="admin-primary"
                  disabled={Boolean(busy) || !source.name.trim()}
                  onClick={() =>
                    void save("sources", source, () => {
                      setSource(null);
                      setSourceData(null);
                    })
                  }
                >
                  <Save size={16} /> Save Source
                </button>
              </div>
            </div>
          </Modal>
        )}
        {mapping && (
          <Modal
            title={mapping.id ? "Edit Source Mapping" : "Create Source Mapping"}
            onClose={() => setMapping(null)}
          >
            <div className="pipe-editor">
              <label>
                Mapping name
                <input
                  value={mapping.name}
                  onChange={(event) =>
                    setMapping({ ...mapping, name: event.target.value })
                  }
                />
              </label>
              <div className="pipe-field-grid">
                <label>
                  Genesys Contact List
                  <select
                    value={mapping.contactListId}
                    onChange={(event) =>
                      void chooseDestination(event.target.value)
                    }
                  >
                    <option value="">Select Genesys Contact List</option>
                    {data.contactLists.map((item) => (
                      <option
                        key={item.contactListId}
                        value={item.contactListId}
                      >
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Source Integration
                  <select
                    value={mapping.sourceId}
                    onChange={(event) =>
                      setMapping({
                        ...mapping,
                        sourceId: event.target.value,
                        keyField: "",
                        fields: mappingFor(
                          mapping.contactListId,
                          event.target.value,
                        ),
                      })
                    }
                  >
                    <option value="">Select source</option>
                    {data.sources.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.kind}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Unique source record key
                <select
                  value={mapping.keyField}
                  onChange={(event) =>
                    setMapping({ ...mapping, keyField: event.target.value })
                  }
                >
                  <option value="">Choose a stable, unique ID field</option>
                  {selectedSource?.fields.map((field) => (
                    <option key={field}>{field}</option>
                  ))}
                </select>
                <small>
                  This key identifies the same contact across repeated imports
                  and updates. Do not use a row number that changes.
                </small>
              </label>
              <div className="pipe-section-head">
                <h3>Field mapping</h3>
                <button
                  className="admin-secondary"
                  onClick={() =>
                    setMapping({
                      ...mapping,
                      fields: mappingFor(
                        mapping.contactListId,
                        mapping.sourceId,
                      ),
                    })
                  }
                >
                  Auto-match names
                </button>
              </div>
              <div className="pipe-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Genesys field</th>
                      <th>Source field</th>
                      <th>Default value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedDestination?.fields.map((field) => {
                      const current = mapping.fields.find(
                        (item) => item.targetField === field.name,
                      ) || {
                        targetField: field.name,
                        sourceField: "",
                        defaultValue: "",
                      };
                      const update = (values: Partial<typeof current>) =>
                        setMapping({
                          ...mapping,
                          fields: [
                            ...mapping.fields.filter(
                              (item) => item.targetField !== field.name,
                            ),
                            { ...current, ...values },
                          ],
                        });
                      return (
                        <tr key={field.name}>
                          <td>
                            <b>
                              {field.name}
                              {field.required ? " *" : ""}
                            </b>
                            <small>{field.type}</small>
                          </td>
                          <td>
                            <select
                              aria-label={`Source for ${field.name}`}
                              value={current.sourceField}
                              onChange={(event) =>
                                update({ sourceField: event.target.value })
                              }
                            >
                              <option value="">Not mapped / use default</option>
                              {selectedSource?.fields.map((name) => (
                                <option key={name}>{name}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              aria-label={`Default for ${field.name}`}
                              value={current.defaultValue}
                              onChange={(event) =>
                                update({ defaultValue: event.target.value })
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {mapping.sourceId && (
                <button
                  className="admin-secondary"
                  onClick={() =>
                    void run("preview", async () =>
                      setSourceData(
                        await api<SourceData>(
                          `${endpoint}/sources/${mapping.sourceId}/preview`,
                          { method: "POST", body: "{}" },
                        ),
                      ),
                    )
                  }
                >
                  Preview source
                </button>
              )}
              <DataTable data={sourceData} />
              <div className="pipe-form-actions">
                <button
                  className="admin-secondary"
                  onClick={() => setMapping(null)}
                >
                  Cancel
                </button>
                <button
                  className="admin-primary"
                  disabled={
                    Boolean(busy) ||
                    !mapping.name.trim() ||
                    !mapping.contactListId ||
                    !mapping.sourceId ||
                    !mapping.keyField
                  }
                  onClick={() =>
                    void save("mappings", mapping, () => setMapping(null))
                  }
                >
                  <Save size={16} /> Save Mapping
                </button>
              </div>
            </div>
          </Modal>
        )}
        {lead && (
          <Modal
            title={
              lead.id ? "Edit Lead Configuration" : "Create Lead Configuration"
            }
            onClose={() => setLead(null)}
          >
            <div className="pipe-editor">
              <label>
                Lead name
                <input
                  value={lead.name}
                  onChange={(event) =>
                    setLead({ ...lead, name: event.target.value })
                  }
                />
              </label>
              <label>
                Source Mapping
                <select
                  value={lead.mappingId}
                  onChange={(event) =>
                    setLead({
                      ...lead,
                      mappingId: event.target.value,
                      filters: [],
                    })
                  }
                >
                  <option value="">Select mapping</option>
                  {data.mappings.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pipe-section-head">
                <h3>Filters</h3>
                <div className="pipe-actions">
                  <select
                    aria-label="Match filters"
                    value={lead.match}
                    onChange={(event) =>
                      setLead({
                        ...lead,
                        match: event.target.value as "ALL" | "ANY",
                      })
                    }
                  >
                    <option value="ALL">Match all (AND)</option>
                    <option value="ANY">Match any (OR)</option>
                  </select>
                  <button
                    className="admin-secondary"
                    disabled={!lead.mappingId}
                    onClick={() =>
                      setLead({
                        ...lead,
                        filters: [
                          ...lead.filters,
                          {
                            scope: "TARGET",
                            field: filterDestination?.fields[0]?.name || "",
                            operator: "EQ",
                            value: "",
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={15} /> Add filter
                  </button>
                </div>
              </div>
              {!lead.filters.length && (
                <p className="pipe-muted">
                  No filters: include all mapped source records.
                </p>
              )}
              {lead.filters.map((filter, index) => {
                const update = (value: Partial<LeadFilter>) =>
                  setLead({
                    ...lead,
                    filters: lead.filters.map((item, i) =>
                      i === index ? { ...item, ...value } : item,
                    ),
                  });
                return (
                  <div key={index} className="pipe-filter-row">
                    <select
                      aria-label={`Filter ${index + 1} scope`}
                      value={filter.scope}
                      onChange={(event) =>
                        update({
                          scope: event.target.value as "SOURCE" | "TARGET",
                          field:
                            event.target.value === "SOURCE"
                              ? filterSource?.fields[0] || ""
                              : filterDestination?.fields[0]?.name || "",
                        })
                      }
                    >
                      <option value="TARGET">Mapped fields</option>
                      <option value="SOURCE">Source fields</option>
                    </select>
                    <select
                      aria-label={`Filter ${index + 1} field`}
                      value={filter.field}
                      onChange={(event) =>
                        update({ field: event.target.value })
                      }
                    >
                      {(filter.scope === "SOURCE"
                        ? filterSource?.fields
                        : filterDestination?.fields.map((field) => field.name)
                      )?.map((field) => (
                        <option key={field}>{field}</option>
                      ))}
                    </select>
                    <select
                      aria-label={`Filter ${index + 1} operator`}
                      value={filter.operator}
                      onChange={(event) =>
                        update({
                          operator: event.target
                            .value as LeadFilter["operator"],
                        })
                      }
                    >
                      {[
                        ["EQ", "Equals"],
                        ["NE", "Does not equal"],
                        ["GT", "Greater than"],
                        ["LT", "Less than"],
                        ["GTE", "Greater or equal"],
                        ["LTE", "Less or equal"],
                        ["CONTAINS", "Contains"],
                        ["DATE_GT_DAYS", "Date > N days from today"],
                        ["DATE_LT_DAYS", "Date < N days from today"],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`Filter ${index + 1} value`}
                      value={filter.value}
                      onChange={(event) =>
                        update({ value: event.target.value })
                      }
                      type={
                        [
                          "GT",
                          "LT",
                          "GTE",
                          "LTE",
                          "DATE_GT_DAYS",
                          "DATE_LT_DAYS",
                        ].includes(filter.operator)
                          ? "number"
                          : "text"
                      }
                      placeholder={
                        filter.operator.startsWith("DATE_")
                          ? "Days, e.g. 30 or -30"
                          : "Value"
                      }
                    />
                    <button
                      aria-label={`Remove filter ${index + 1}`}
                      className="pipe-icon danger-link"
                      onClick={() =>
                        setLead({
                          ...lead,
                          filters: lead.filters.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                );
              })}
              <p className="pipe-muted">
                Date filters compare calendar days in Asia/Bangkok. Positive
                days are in the future; negative days are in the past. For
                example, Date &lt; -30 means older than 30 days.
              </p>
              <div className="pipe-form-actions">
                <button
                  className="admin-secondary"
                  onClick={() => setLead(null)}
                >
                  Cancel
                </button>
                <button
                  className="admin-primary"
                  disabled={
                    Boolean(busy) || !lead.name.trim() || !lead.mappingId
                  }
                  onClick={() => void save("leads", lead, () => setLead(null))}
                >
                  <Save size={16} /> Save Lead
                </button>
              </div>
            </div>
          </Modal>
        )}
        {schedule && (
          <Modal
            title={
              schedule.id ? "Edit Schedule Import" : "Create Schedule Import"
            }
            onClose={() => setSchedule(null)}
          >
            <div className="pipe-editor">
              <label>
                Schedule name
                <input
                  value={schedule.name || ""}
                  onChange={(event) =>
                    setSchedule({ ...schedule, name: event.target.value })
                  }
                />
              </label>
              <label>
                Lead Configuration
                <select
                  value={schedule.leadId || ""}
                  onChange={(event) =>
                    setSchedule({
                      ...schedule,
                      leadId: event.target.value,
                      contactListId:
                        data.mappings.find(
                          (mapping) =>
                            mapping.id ===
                            data.leads.find(
                              (lead) => lead.id === event.target.value,
                            )?.mappingId,
                        )?.contactListId || "",
                    })
                  }
                >
                  <option value="">Select lead</option>
                  {data.leads.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Genesys Contact List
                {destinationPicker(
                  schedule.contactListId || "",
                  (value) => setSchedule({ ...schedule, contactListId: value }),
                  Boolean(schedule.leadId),
                )}
                <small className="pipe-muted">
                  Destination follows the selected lead's Source Mapping.
                </small>
              </label>
              <div className="pipe-field-grid">
                <label>
                  Frequency
                  <select
                    value={schedule.frequency}
                    onChange={(event) =>
                      setSchedule({
                        ...schedule,
                        frequency: event.target
                          .value as ImportSchedule["frequency"],
                      })
                    }
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                    <option value="MONTH_DAYS">
                      Selected days of every month
                    </option>
                  </select>
                </label>
                <label>
                  Time (Asia/Bangkok)
                  <input
                    type="time"
                    value={schedule.time || "09:00"}
                    onChange={(event) =>
                      setSchedule({ ...schedule, time: event.target.value })
                    }
                  />
                </label>
              </div>
              {schedule.frequency === "WEEKLY" && (
                <label>
                  Day of week
                  <select
                    value={schedule.dayOfWeek}
                    onChange={(event) =>
                      setSchedule({
                        ...schedule,
                        dayOfWeek: Number(event.target.value),
                      })
                    }
                  >
                    {[
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ].map((day, index) => (
                      <option value={index} key={day}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {schedule.frequency === "MONTHLY" && (
                <label>
                  Day of month
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={schedule.dayOfMonth}
                    onChange={(event) =>
                      setSchedule({
                        ...schedule,
                        dayOfMonth: Number(event.target.value),
                      })
                    }
                  />
                </label>
              )}
              {schedule.frequency === "MONTH_DAYS" && (
                <div>
                  <h3>Days of month</h3>
                  <div className="pipe-days">
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(
                      (day) => (
                        <label key={day}>
                          <input
                            type="checkbox"
                            checked={schedule.monthDays?.includes(day) || false}
                            onChange={(event) =>
                              setSchedule({
                                ...schedule,
                                monthDays: event.target.checked
                                  ? [...(schedule.monthDays || []), day]
                                  : (schedule.monthDays || []).filter(
                                      (value) => value !== day,
                                    ),
                              })
                            }
                          />
                          {day}
                        </label>
                      ),
                    )}
                  </div>
                </div>
              )}
              <label className="pipe-checkbox">
                <input
                  type="checkbox"
                  checked={schedule.enabled || false}
                  onChange={(event) =>
                    setSchedule({ ...schedule, enabled: event.target.checked })
                  }
                />{" "}
                Enable automatic import
              </label>
              <p className="pipe-muted">
                Each run fetches current source data and applies the Lead
                Configuration filters again. Unchanged contacts are skipped;
                changed contacts are updated.
              </p>
              <div className="pipe-form-actions">
                <button
                  className="admin-secondary"
                  onClick={() => setSchedule(null)}
                >
                  Cancel
                </button>
                <button
                  className="admin-primary"
                  disabled={
                    Boolean(busy) ||
                    !schedule.name?.trim() ||
                    !schedule.leadId ||
                    !schedule.contactListId
                  }
                  onClick={() =>
                    void save("schedules", schedule, () => setSchedule(null))
                  }
                >
                  <Save size={16} /> Save Schedule
                </button>
              </div>
            </div>
          </Modal>
        )}
        {leadPreview && (
          <Modal
            title={"Lead preview · " + leadPreview.lead.name}
            onClose={() => setLeadPreview(null)}
          >
            <div className="pipe-editor">
              <PreviewStats preview={leadPreview} />
              <DataTable
                data={{
                  fields: leadPreview.fields,
                  rows: leadPreview.rows.slice(0, 100).map((row) => row.data),
                  total: leadPreview.total,
                  truncated: leadPreview.truncated,
                }}
              />
              <a
                className="admin-secondary"
                href={`${endpoint}/leads/${leadPreview.lead.id}/export`}
              >
                Export CSV
              </a>
            </div>
          </Modal>
        )}
      </div>
    </FeedbackContext.Provider>
  );
}

function PreviewStats({ preview }: { preview: LeadPreview }) {
  return (
    <div className="pipe-preview-stats">
      {[
        ["Source rows", preview.sourceTotal],
        ["Matched", preview.summary.matched],
        ["Ready to import", preview.summary.eligible],
        ["Already synced", preview.summary.synced],
        ["Excluded / invalid", preview.summary.invalid],
      ].map(([label, value]) => (
        <div key={String(label)}>
          <b>{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
function JobHistory({ jobs }: { jobs: ImportJob[] }) {
  return (
    <section className="admin-panel">
      <h2>Recent imports</h2>
      <div className="pipe-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Lead Configuration</th>
              <th>Status</th>
              <th>Result</th>
              <th>Started (Bangkok)</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <b>{job.leadName}</b>
                  <small>{job.scheduleId ? "Scheduled" : "Manual"}</small>
                </td>
                <td>
                  <Pill value={job.status} />
                </td>
                <td>
                  {job.message}
                  <small>
                    {job.processed} / {job.total} processed
                  </small>
                </td>
                <td>{formatDate(job.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!jobs.length && (
          <Empty>
            No imports yet. Configure your source and lead selection to get
            started.
          </Empty>
        )}
      </div>
    </section>
  );
}

function ManualImporter({
  data,
  lists,
  loadLists,
  onError,
  refresh,
}: {
  data: Bootstrap;
  lists: { id: string; name: string }[];
  loadLists: () => Promise<void>;
  onError: (error: string) => void;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [allFields, setAllFields] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    ids?: string[];
    reimport?: boolean;
  } | null>(null);
  const activeImport = data.jobs.find((item) => item.status === "RUNNING");
  const [leadId, setLeadId] = useState(activeImport?.leadId || ""),
    [listId, setListId] = useState(activeImport?.contactListId || ""),
    [preview, setPreview] = useState<LeadPreview | null>(null);
  const reimportCount =
    preview?.rows.filter(
      (row) => row.status === "ALREADY_SYNCED" && Boolean(row.contactId),
    ).length || 0;
  const [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [page, setPage] = useState(1);
  const [job, setJob] = useState<ImportJob | null>(activeImport || null),
    [starting, setStarting] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    setSelected([]);
    setPreview(null);
    setPage(1);
    if (!leadId) return;
    const controller = new AbortController();
    setLoading(true);
    api<LeadPreview>(
      `${endpoint}/leads/${leadId}/preview${listId ? "?contactListId=" + listId : ""}`,
      { signal: controller.signal },
    )
      .then((value) => setPreview(value))
      .catch((error) => {
        if (!controller.signal.aborted) onError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [leadId, listId, reload]);
  useEffect(() => {
    if (!job || job.status !== "RUNNING") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api<ImportJob>(`${endpoint}/imports/${job.id}`);
        if (cancelled) return;
        setJob(latest);
        if (latest.status === "RUNNING")
          timer = setTimeout(() => void poll(), 1000);
        else {
          setReload((value) => value + 1);
          void refresh();
        }
      } catch (error) {
        if (!cancelled) {
          onError((error as Error).message);
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status]);
  function selectLead(id: string) {
    setLeadId(id);
    const lead = data.leads.find((item) => item.id === id);
    const mapping = data.mappings.find((item) => item.id === lead?.mappingId);
    if (mapping?.contactListId) {
      setListId(mapping.contactListId);
      return mapping.contactListId;
    }
    return "";
  }
  const active = starting || job?.status === "RUNNING";
  async function start(ids?: string[], confirmed = false, reimport = false) {
    if (!preview || !listId || (reimport && !reimportCount)) return;
    if (!confirmed) {
      setConfirmation({ ids, reimport });
      return;
    }
    setStarting(true);
    onError("");
    try {
      setJob(
        await api<ImportJob>(endpoint + "/imports", {
          method: "POST",
          body: JSON.stringify({
            leadId,
            contactListId: listId,
            recordIds: ids,
            revision: preview.revision,
            reimport,
          }),
        }),
      );
      setSelected([]);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setStarting(false);
    }
  }
  const filteredRows =
    preview?.rows.filter(
      (row) =>
        !search ||
        [row.sourceKey, row.status, ...Object.values(row.data)].some((value) =>
          String(value).toLowerCase().includes(search.toLowerCase()),
        ),
    ) || [];
  const pageRows = filteredRows.slice((page - 1) * 5, page * 5);
  const pageEligible = pageRows.filter((row) => canImport(row.status));
  const preferred =
    preview?.fields.filter((field) =>
      /^(customer_?id|first_?name|last_?name|full_?name|name|phone|mobile|expiry_?date|expiry|expires|amount)$/i.test(
        field,
      ),
    ) || [];
  const visibleFields = allFields
    ? preview?.fields || []
    : (preferred.length ? preferred : preview?.fields || []).slice(0, 5);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / 5));
  return (
    <div className="ls-import-layout">
      <div className="ls-import-main">
        <LeadSyncMetrics data={data} eligible={preview?.summary.eligible} />
        <section className="admin-panel ls-manual-card">
          <div className="ls-manual-card-heading">
            <Upload size={31} />
            <div>
              <h2>Manual Lead Import</h2>
              <p>
                Select lead configuration and preview the data before importing
                to Genesys Cloud
              </p>
            </div>
          </div>
          <div className="pipe-field-grid ls-import-selects">
            <label>
              Lead Configuration <em>*</em>
              <select
                aria-label="Lead Configuration"
                value={leadId}
                disabled={active}
                onChange={(event) => {
                  selectLead(event.target.value);
                  setPreview(null);
                  setSelected([]);
                  setSearch("");
                }}
              >
                <option value="">Select a Lead Configuration</option>
                {data.leads.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Genesys Contact List <em>*</em>
              <select
                aria-label="Genesys Contact List"
                value={listId}
                disabled={active}
                onChange={(event) => {
                  setListId(event.target.value);
                  setPreview(null);
                  setSelected([]);
                  setPage(1);
                }}
              >
                <option value="">Select destination Contact List</option>
                {listId && !lists.some((item) => item.id === listId) && (
                  <option value={listId}>{listId}</option>
                )}
                {lists.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ls-import-actions">
            <button
              className="admin-secondary ls-preview-button"
              disabled={active || !leadId || loading}
              onClick={() => setReload((value) => value + 1)}
            >
              <Eye size={17} />
              Preview Leads
            </button>
            <button
              className="admin-primary"
              disabled={
                active || !listId || !selected.length || preview?.truncated
              }
              onClick={() => void start(selected)}
            >
              <Upload size={17} />
              Import Selected ({selected.length})
            </button>
            <button
              className="admin-secondary ls-outline-primary"
              disabled={
                active ||
                !listId ||
                !preview?.summary.eligible ||
                preview?.truncated
              }
              onClick={() => void start()}
            >
              <Upload size={17} />
              Import All
            </button>
            <button
              className="admin-secondary"
              disabled={
                active || !listId || !reimportCount || preview?.truncated
              }
              onClick={() => void start(undefined, false, true)}
            >
              <RefreshCw size={17} />
              Re-import All Synced ({reimportCount})
            </button>
          </div>
          {job && (
            <section className="admin-panel pipe-import-progress">
              <div className="pipe-section-head">
                <h3>Import progress</h3>
                <Pill value={job.status} />
              </div>
              <progress max={Math.max(1, job.total)} value={job.processed} />
              <p>{job.message}</p>
              <small>
                {job.created} created · {job.updated} updated · {job.skipped}{" "}
                skipped · {job.failed} failed
              </small>
              {job.results.some((result) => result.status === "FAILED") && (
                <details>
                  <summary>Failed records</summary>
                  {job.results
                    .filter((result) => result.status === "FAILED")
                    .map((result, index) => (
                      <p key={index}>
                        <b>{result.sourceKey}</b> — {result.message}
                      </p>
                    ))}
                </details>
              )}
            </section>
          )}

          <div className="ls-preview-heading" id="lead-preview">
            <h3>
              Preview Data{" "}
              <span>({preview?.total.toLocaleString() || 0} records)</span>
            </h3>
            <div className="ls-table-search">
              <Search size={16} />
              <input
                aria-label="Search preview results"
                placeholder="Search in results…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
          {preview?.truncated && (
            <div className="pipe-warning">
              The source limit was reached. Narrow your source query before
              importing.
            </div>
          )}
          {loading ? (
            <div className="admin-loading">
              <Loader2 size={20} className="spin" />
              Loading source data…
            </div>
          ) : !preview ? (
            <Empty>
              {data.leads.length
                ? "Select a Lead Configuration to preview your records."
                : "Configure a Genesys Contact List, source mapping and lead configuration to get started."}
            </Empty>
          ) : (
            <div className="pipe-table-scroll">
              {" "}
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select this page"
                        disabled={active || !pageEligible.length}
                        checked={Boolean(
                          pageEligible.length &&
                          pageEligible.every((row) =>
                            selected.includes(row.id),
                          ),
                        )}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [
                                  ...new Set([
                                    ...selected,
                                    ...pageEligible.map((row) => row.id),
                                  ]),
                                ]
                              : selected.filter(
                                  (id) =>
                                    !pageEligible.some((row) => row.id === id),
                                ),
                          )
                        }
                      />
                    </th>
                    <th>Record key</th>
                    {visibleFields.map((field) => (
                      <th key={field}>{field}</th>
                    ))}
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, index) => (
                    <tr key={row.id + index}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select record ${row.sourceKey}`}
                          disabled={active || !canImport(row.status)}
                          checked={selected.includes(row.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, row.id]
                                : selected.filter((id) => id !== row.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <b>{row.sourceKey || "Empty key"}</b>

                        {row.message && (
                          <small title={row.message}>{row.message}</small>
                        )}
                      </td>
                      {visibleFields.map((field) => (
                        <td key={field} title={row.data[field]}>
                          {row.data[field]?.slice(0, 160)}
                        </td>
                      ))}
                      <td>
                        <Pill value={row.status} />
                      </td>
                      <td>
                        {row.status === "UNKNOWN" ? (
                          <button
                            className="admin-secondary"
                            disabled={active}
                            onClick={() => {
                              const contactId = window.prompt(
                                "After checking this destination in Genesys, enter the existing Contact ID to reconcile this record.",
                              );
                              if (contactId)
                                void api(
                                  `${endpoint}/imports/reconcile/${row.id}`,
                                  {
                                    method: "POST",
                                    body: JSON.stringify({ contactId }),
                                  },
                                )
                                  .then(() => setReload((value) => value + 1))
                                  .catch((error) => onError(error.message));
                            }}
                          >
                            Reconcile
                          </button>
                        ) : (
                          <button
                            className="admin-secondary"
                            disabled={
                              active ||
                              !listId ||
                              (!canImport(row.status) &&
                                !(
                                  row.status === "ALREADY_SYNCED" &&
                                  row.contactId
                                )) ||
                              preview.truncated
                            }
                            onClick={() =>
                              void start(
                                [row.id],
                                false,
                                row.status === "ALREADY_SYNCED",
                              )
                            }
                          >
                            {row.status === "ALREADY_SYNCED"
                              ? "Re-import"
                              : row.status === "UPDATE_AVAILABLE"
                                ? "Update contact"
                                : "Import record"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!pageRows.length && (
                <Empty>
                  {search
                    ? "No records match your search."
                    : "No records match this Lead Configuration."}
                </Empty>
              )}
            </div>
          )}
          <div className="ls-table-footer">
            <span>
              {selected.length} of {preview?.total.toLocaleString() || 0}{" "}
              selected
            </span>
            <div className="ls-table-pages">
              <button
                className="ls-page-arrow"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              {Array.from(
                { length: Math.min(5, pageCount) },
                (_, index) =>
                  Math.max(1, Math.min(page - 2, pageCount - 4)) + index,
              ).map((value) => (
                <button
                  className={page === value ? "active" : ""}
                  key={value}
                  onClick={() => setPage(value)}
                  aria-label={"Page " + value}
                  aria-current={page === value ? "page" : undefined}
                >
                  {value}
                </button>
              ))}
              {pageCount > 5 && <span>… {pageCount}</span>}
              <button
                className="ls-page-arrow"
                aria-label="Next page"
                disabled={page >= pageCount}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
          <details className="ls-import-tools">
            <summary>Data tools & destination options</summary>
            <div className="pipe-actions">
              <button
                className="admin-secondary"
                disabled={active}
                onClick={() => void loadLists()}
              >
                <RefreshCw size={15} />
                Refresh contact lists
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={allFields}
                  onChange={(event) => setAllFields(event.target.checked)}
                />
                Show all fields ({preview?.fields.length || 0})
              </label>
              {preview && (
                <a
                  className="admin-secondary"
                  href={endpoint + "/leads/" + leadId + "/export"}
                >
                  Export CSV
                </a>
              )}{" "}
              <button
                className="admin-secondary danger-link"
                disabled={active || !listId}
                onClick={() => {
                  if (
                    window.prompt(
                      "This removes ALL contacts from the selected Genesys Contact List. Type CLEAR to continue.",
                    ) !== "CLEAR"
                  )
                    return;
                  setStarting(true);
                  void api<{ message: string }>(
                    `${endpoint}/contact-lists/${listId}/clear`,
                    {
                      method: "POST",
                      body: JSON.stringify({ confirmation: "CLEAR" }),
                    },
                  )
                    .then(() => setReload((value) => value + 1))
                    .catch((error) => onError(error.message))
                    .finally(() => setStarting(false));
                }}
              >
                Clear list
              </button>
            </div>
            <p className="pipe-muted">
              The destination applies to this import only. Clearing a list
              requires typing CLEAR.
            </p>
          </details>
        </section>
      </div>
      <LeadSyncInsights data={data} contactLists={lists.length} />
      {confirmation && preview && (
        <Modal
          title="Confirm lead import"
          onClose={() => setConfirmation(null)}
        >
          <div className="ls-confirm-import">
            <Upload size={36} />
            <h3>
              {confirmation.reimport
                ? "Ready to re-import synchronized leads?"
                : "Ready to import your leads?"}
            </h3>
            <p>
              Import{" "}
              <strong>
                {confirmation.ids?.length ??
                  (confirmation.reimport
                    ? reimportCount
                    : preview.summary.eligible)}{" "}
                records
              </strong>{" "}
              from <strong>{preview.lead.name}</strong> into{" "}
              <strong>
                {lists.find((list) => list.id === listId)?.name || listId}
              </strong>
              .
            </p>
            <p>
              {confirmation.reimport
                ? "Only unchanged synchronized records with a known Genesys Contact ID are selected. They will update the existing contacts; no new contacts are created."
                : "Existing contacts are updated and unchanged records are skipped."}
            </p>
            <div className="pipe-form-actions">
              <button
                className="admin-secondary"
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="admin-primary"
                onClick={() => {
                  const ids = confirmation.ids;
                  setConfirmation(null);
                  void start(ids, true, confirmation.reimport);
                }}
              >
                <Upload size={17} />
                {confirmation.reimport ? "Confirm re-import" : "Confirm import"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
