import {
  CircleAlert,
  CheckCircle2,
  CloudUpload,
  Database,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type GenesysConfig } from "./lib/api";

type Campaign = {
  campaignListId: string;
  name: string;
  description: string;
  recordCount: number;
  updatedAt: string;
  lastGenesysSyncAt: string;
};

type PreviewRow = {
  contact: {
    firstName: string;
    lastName: string;
    phone: string;
    policyNumber: string;
    productName: string;
    expiryDate: string;
    daysUntilExpiry: string;
    renewalStatus: string;
  };
  policy: { policyId: string };
  eligibility: string;
};

type ContactPreview = {
  rows: PreviewRow[];
  summary: {
    matched: number;
    eligible: number;
    dncExcluded: number;
    invalidPhone: number;
    duplicatePhone: number;
    alreadySynced: number;
    reloadAvailable: number;
  };
};

type SyncResult = { policyId: string; status: string; message: string };

type ContactList = {
  id: string;
  name: string;
  columnNames?: string[];
  phoneColumns?: { columnName: string; type?: string }[];
};

const dateTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Never";

export function GenesysImportLeads({ config }: { config: GenesysConfig }) {
  const [activeConfig, setActiveConfig] = useState(config);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [contactLists, setContactLists] = useState<ContactList[]>([]);
  const [targetListId, setTargetListId] = useState(config.contactListId);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ContactPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "preview" | "load" | "reload">("");
  const [listBusy, setListBusy] = useState<"" | "lists" | "select" | "clear">(
    "",
  );
  const [reloadingPolicyId, setReloadingPolicyId] = useState("");
  const [clearConfirmation, setClearConfirmation] = useState("");
  const [clearTarget, setClearTarget] = useState<ContactList | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [failed, setFailed] = useState<SyncResult[]>([]);

  const selected = campaigns.find(
    (campaign) => campaign.campaignListId === selectedId,
  );
  const previewRows = useMemo(
    () =>
      preview?.rows.filter((row) =>
        ["ELIGIBLE", "ALREADY_SYNCED", "RELOAD_AVAILABLE"].includes(
          row.eligibility,
        ),
      ) ?? [],
    [preview],
  );
  const readyRows = useMemo(
    () => previewRows.filter((row) => row.eligibility === "ELIGIBLE"),
    [previewRows],
  );
  const reloadRows = useMemo(
    () =>
      previewRows.filter((row) =>
        ["ALREADY_SYNCED", "RELOAD_AVAILABLE"].includes(row.eligibility),
      ),
    [previewRows],
  );
  const selectedList =
    contactLists.find((list) => list.id === targetListId) ||
    (targetListId === activeConfig.contactListId && targetListId
      ? { id: targetListId, name: activeConfig.contactListName || targetListId }
      : null);
  const integrationReady =
    activeConfig.enabled &&
    Boolean(activeConfig.contactListId) &&
    activeConfig.schemaStatus === "VALID";

  useEffect(() => {
    setActiveConfig(config);
    setTargetListId(config.contactListId);
  }, [config]);

  async function loadCampaigns(silent = false) {
    if (!silent) setLoading(true);
    try {
      const result = await api<{ items: Campaign[] }>("/api/admin/campaigns");
      setCampaigns(result.items);
      setSelectedId((current) =>
        result.items.some((item) => item.campaignListId === current)
          ? current
          : result.items[0]?.campaignListId || "",
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load campaigns",
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadCampaigns();
    if (config.enabled && config.clientId && config.secretConfigured)
      void loadContactLists(true);
  }, []);

  async function loadContactLists(silent = false) {
    setListBusy("lists");
    if (!silent) {
      setError("");
      setMessage("");
    }
    try {
      const result = await api<{ entities?: ContactList[] }>(
        "/api/admin/genesys/load-contact-lists",
        { method: "POST", body: JSON.stringify({}) },
      );
      const lists = result.entities ?? [];
      setContactLists(lists);
      setTargetListId((current) =>
        lists.some((list) => list.id === current)
          ? current
          : lists.some((list) => list.id === activeConfig.contactListId)
            ? activeConfig.contactListId
            : lists[0]?.id || activeConfig.contactListId,
      );
    } catch (reason) {
      if (!silent)
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load Genesys Contact Lists",
        );
    } finally {
      setListBusy("");
    }
  }

  async function selectContactList() {
    if (!targetListId) return;
    setListBusy("select");
    setError("");
    setMessage("");
    try {
      const result = await api<{
        ok: boolean;
        config: GenesysConfig;
        message: string;
      }>(
        `/api/admin/genesys/contact-lists/${encodeURIComponent(targetListId)}/select`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setActiveConfig(result.config);
      if (selectedId) await previewCampaign(selectedId, true);
      if (result.ok) setMessage(result.message);
      else setError(result.message);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to select the Contact List",
      );
    } finally {
      setListBusy("");
    }
  }

  async function clearContactList() {
    if (!clearTarget || clearConfirmation !== "CLEAR") return;
    setListBusy("clear");
    setError("");
    setMessage("");
    try {
      const result = await api<{
        message: string;
        resetPolicies: number;
      }>(
        `/api/admin/genesys/contact-lists/${encodeURIComponent(clearTarget.id)}/clear`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: clearConfirmation }),
        },
      );
      setMessage(result.message);
      setClearTarget(null);
      setClearConfirmation("");
      if (selectedId) await previewCampaign(selectedId, true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to clear the Contact List",
      );
    } finally {
      setListBusy("");
    }
  }

  function chooseCampaign(id: string) {
    setSelectedId(id);
    setPreview(null);
    setMessage("");
    setError("");
    setFailed([]);
    setReloadingPolicyId("");
  }

  async function previewCampaign(id = selectedId, keepMessage = false) {
    if (!id) {
      setError("Select a source campaign first.");
      return;
    }
    setBusy("preview");
    setSelectedId(id);
    setError("");
    if (!keepMessage) setMessage("");
    setFailed([]);
    setReloadingPolicyId("");
    try {
      const result = await api<ContactPreview>(
        `/api/admin/campaigns/${encodeURIComponent(id)}/preview`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setPreview(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preview failed");
    } finally {
      setBusy("");
    }
  }

  async function loadLeads() {
    if (!selected || !readyRows.length || !integrationReady) return;
    if (
      !window.confirm(
        `Load ${readyRows.length} leads from ${selected.name} into ${activeConfig.contactListName || activeConfig.contactListId}?`,
      )
    )
      return;

    setBusy("load");
    setError("");
    setMessage("");
    setFailed([]);
    setProgress({ processed: 0, total: readyRows.length });
    const results: SyncResult[] = [];
    try {
      const policyIds = readyRows.map((row) => row.policy.policyId);
      for (let index = 0; index < policyIds.length; index += 5) {
        const batch = policyIds.slice(index, index + 5);
        const response = await api<{ results: SyncResult[] }>(
          "/api/admin/genesys/sync/bulk",
          {
            method: "POST",
            body: JSON.stringify({
              policyIds: batch,
              campaignListId: selected.campaignListId,
              force: false,
            }),
          },
        );
        results.push(...response.results);
        setProgress({ processed: results.length, total: policyIds.length });
      }

      const failures = results.filter(
        (result) => !["SYNCED", "ALREADY_SYNCED"].includes(result.status),
      );
      const completed = results.length - failures.length;
      setFailed(failures);
      setMessage(
        `Load completed: ${completed} successful, ${failures.length} failed.`,
      );
      const refreshed = await api<ContactPreview>(
        `/api/admin/campaigns/${encodeURIComponent(selected.campaignListId)}/preview`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setPreview(refreshed);
      await loadCampaigns(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Lead import failed");
    } finally {
      setBusy("");
      setProgress({ processed: 0, total: 0 });
    }
  }

  async function reloadContacts(rows: PreviewRow[]) {
    if (!selected || !rows.length || !integrationReady) return;
    const single = rows.length === 1 ? rows[0] : null;
    const prompt = single
      ? `Reload ${single.contact.policyNumber} with the latest customer and policy data in ${activeConfig.contactListName || activeConfig.contactListId}?`
      : `Reload ${rows.length} synchronized contacts from ${selected.name} with the latest customer and policy data?`;
    if (!window.confirm(prompt)) return;

    setBusy("reload");
    setReloadingPolicyId(single?.policy.policyId || "");
    setError("");
    setMessage("");
    setFailed([]);
    setProgress({ processed: 0, total: rows.length });
    const results: SyncResult[] = [];
    try {
      const policyIds = rows.map((row) => row.policy.policyId);
      for (let index = 0; index < policyIds.length; index += 5) {
        const batch = policyIds.slice(index, index + 5);
        const response = await api<{ results: SyncResult[] }>(
          "/api/admin/genesys/sync/bulk",
          {
            method: "POST",
            body: JSON.stringify({
              policyIds: batch,
              campaignListId: selected.campaignListId,
              force: true,
            }),
          },
        );
        results.push(...response.results);
        setProgress({ processed: results.length, total: policyIds.length });
      }

      const failures = results.filter(
        (result) => !["SYNCED", "ALREADY_SYNCED"].includes(result.status),
      );
      const completed = results.length - failures.length;
      setFailed(failures);
      setMessage(
        `Reload completed: ${completed} successful, ${failures.length} failed.`,
      );
      const refreshed = await api<ContactPreview>(
        `/api/admin/campaigns/${encodeURIComponent(selected.campaignListId)}/preview`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setPreview(refreshed);
      await loadCampaigns(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Contact reload failed",
      );
    } finally {
      setBusy("");
      setReloadingPolicyId("");
      setProgress({ processed: 0, total: 0 });
    }
  }

  if (loading)
    return (
      <div className="lead-import-loading">
        <Loader2 className="spin" /> Loading campaigns...
      </div>
    );

  return (
    <div className="lead-import-view">
      {error && (
        <div className="alert error" role="alert">
          <X size={16} /> {error}
        </div>
      )}
      {message && (
        <div className="alert success" role="status">
          <CheckCircle2 size={16} /> {message}
        </div>
      )}

      <section className="settings-panel lead-destination-panel">
        <div className="lead-panel-head">
          <div>
            <h2>Genesys destination</h2>
            <p className="muted">
              Select the Contact List used for lead loading and re-imports.
            </p>
          </div>
          <button
            className="secondary"
            onClick={() => loadContactLists()}
            disabled={Boolean(listBusy) || Boolean(busy)}
          >
            {listBusy === "lists" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <RefreshCcw size={16} />
            )}
            Refresh Lists
          </button>
        </div>
        <div className="lead-destination-controls">
          <label>
            <span>Genesys Contact List</span>
            <select
              value={targetListId}
              onChange={(event) => setTargetListId(event.target.value)}
              disabled={Boolean(listBusy) || Boolean(busy)}
            >
              <option value="">Select a Contact List</option>
              {activeConfig.contactListId &&
                !contactLists.some(
                  (list) => list.id === activeConfig.contactListId,
                ) && (
                  <option value={activeConfig.contactListId}>
                    {activeConfig.contactListName || activeConfig.contactListId}
                  </option>
                )}
              {contactLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                  {list.id === activeConfig.contactListId ? " (Active)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="lead-destination-detail">
            <Database size={18} />
            <div>
              <span>Active destination</span>
              <strong>
                {activeConfig.contactListName || "Not configured"}
              </strong>
              <small>{activeConfig.contactListId || "No list selected"}</small>
            </div>
          </div>
          <div className="lead-destination-actions">
            <button
              className="primary"
              onClick={selectContactList}
              disabled={
                !targetListId ||
                Boolean(listBusy) ||
                Boolean(busy) ||
                (targetListId === activeConfig.contactListId &&
                  activeConfig.schemaStatus === "VALID")
              }
            >
              {listBusy === "select" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              {targetListId === activeConfig.contactListId
                ? "Validate Destination"
                : "Use as Destination"}
            </button>
            <button
              className="admin-danger"
              onClick={() => {
                if (!selectedList) return;
                setClearTarget(selectedList);
                setClearConfirmation("");
              }}
              disabled={!selectedList || Boolean(listBusy) || Boolean(busy)}
            >
              <Trash2 size={16} /> Clear Selected List
            </button>
          </div>
        </div>
      </section>

      <section className="summary-band lead-import-summary">
        <div>
          <span>Destination list</span>
          <strong>{activeConfig.contactListName || "Not configured"}</strong>
        </div>
        <div>
          <span>Campaigns</span>
          <strong>{campaigns.length}</strong>
        </div>
        <div>
          <span>Selected campaign</span>
          <strong>{selected?.name || "-"}</strong>
        </div>
        <div>
          <span>Ready to load</span>
          <strong>{preview?.summary.eligible ?? "-"}</strong>
        </div>
        <div>
          <span>Integration</span>
          <strong>
            {integrationReady ? "Ready" : "Configuration required"}
          </strong>
        </div>
      </section>

      {!integrationReady && (
        <div className="lead-import-readiness">
          Configure and enable the integration, select a Contact List, and
          validate its schema before loading leads.
          <a href="/">Open Integration</a>
        </div>
      )}

      <section className="settings-panel lead-campaign-panel">
        <div className="lead-panel-head">
          <div>
            <h2>Source campaigns</h2>
            <p className="muted">
              Preview the eligible contacts in a saved insurance campaign.
            </p>
          </div>
          <button
            className="secondary"
            onClick={() => loadCampaigns()}
            disabled={Boolean(busy)}
          >
            <RefreshCcw size={16} /> Refresh
          </button>
        </div>
        {campaigns.length ? (
          <div className="lead-table-wrap">
            <table className="lead-campaign-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Eligible leads</th>
                  <th>Last loaded</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr
                    key={campaign.campaignListId}
                    className={
                      selectedId === campaign.campaignListId ? "active" : ""
                    }
                  >
                    <td>
                      <strong>{campaign.name}</strong>
                      <small>
                        {campaign.description || campaign.campaignListId}
                      </small>
                    </td>
                    <td>{campaign.recordCount}</td>
                    <td>{dateTime(campaign.lastGenesysSyncAt)}</td>
                    <td>{dateTime(campaign.updatedAt)}</td>
                    <td>
                      <button
                        className="secondary lead-preview-button"
                        onClick={() => {
                          chooseCampaign(campaign.campaignListId);
                          void previewCampaign(campaign.campaignListId);
                        }}
                        disabled={Boolean(busy)}
                      >
                        {busy === "preview" &&
                        selectedId === campaign.campaignListId ? (
                          <Loader2 className="spin" size={16} />
                        ) : (
                          <Search size={16} />
                        )}
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="lead-import-empty">
            <Users size={25} />
            <strong>No campaigns available</strong>
            <span>Create a campaign in Insurance Management first.</span>
            <a className="secondary" href="/campaigns">
              Open Campaigns
            </a>
          </div>
        )}
      </section>

      {preview && selected && (
        <section className="settings-panel lead-preview-panel">
          <div className="lead-panel-head">
            <div>
              <h2>Preview contacts</h2>
              <p className="muted">{selected.name}</p>
            </div>
            <div className="lead-preview-actions">
              <button
                className="secondary"
                onClick={() => reloadContacts(reloadRows)}
                disabled={
                  Boolean(busy) || !reloadRows.length || !integrationReady
                }
              >
                {busy === "reload" && !reloadingPolicyId ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <RefreshCcw size={16} />
                )}
                Reload Contacts ({reloadRows.length})
              </button>
              <button
                className="primary"
                onClick={loadLeads}
                disabled={
                  Boolean(busy) || !readyRows.length || !integrationReady
                }
              >
                {busy === "load" ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <CloudUpload size={16} />
                )}
                Load Lead ({readyRows.length})
              </button>
            </div>
          </div>

          <div className="review-counts lead-preview-counts">
            <div>
              <span>Matched</span>
              <strong>{preview.summary.matched}</strong>
            </div>
            <div>
              <span>Ready</span>
              <strong>{preview.summary.eligible}</strong>
            </div>
            <div>
              <span>DNC excluded</span>
              <strong>{preview.summary.dncExcluded}</strong>
            </div>
            <div>
              <span>Invalid phone</span>
              <strong>{preview.summary.invalidPhone}</strong>
            </div>
            <div>
              <span>Duplicate phone</span>
              <strong>{preview.summary.duplicatePhone}</strong>
            </div>
            <div>
              <span>Already synced</span>
              <strong>{preview.summary.alreadySynced}</strong>
            </div>
            <div>
              <span>Reload available</span>
              <strong>{preview.summary.reloadAvailable}</strong>
            </div>
          </div>

          {progress.total > 0 && (
            <div className="lead-load-progress">
              <div>
                <span>
                  {busy === "reload" ? "Reloading contacts" : "Loading leads"}
                </span>
                <strong>
                  {progress.processed} / {progress.total}
                </strong>
              </div>
              <progress value={progress.processed} max={progress.total} />
            </div>
          )}

          {failed.length > 0 && (
            <div className="lead-failures">
              <strong>Failed records</strong>
              {failed.map((result) => (
                <span key={result.policyId}>
                  {result.policyId}: {result.message}
                </span>
              ))}
            </div>
          )}

          {previewRows.length ? (
            <div className="lead-table-wrap lead-contact-table-wrap">
              <table className="lead-contact-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Phone</th>
                    <th>Policy number</th>
                    <th>Product</th>
                    <th>Expiry date</th>
                    <th>Days left</th>
                    <th>Renewal status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr
                      key={row.policy.policyId}
                      className={
                        ["ALREADY_SYNCED", "RELOAD_AVAILABLE"].includes(
                          row.eligibility,
                        )
                          ? "lead-row-synced"
                          : ""
                      }
                    >
                      <td>
                        {row.contact.firstName} {row.contact.lastName}
                      </td>
                      <td>{row.contact.phone}</td>
                      <td>{row.contact.policyNumber}</td>
                      <td>{row.contact.productName}</td>
                      <td>{row.contact.expiryDate}</td>
                      <td>{row.contact.daysUntilExpiry}</td>
                      <td>
                        <span className="lead-status">
                          {row.contact.renewalStatus.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>
                        {["ALREADY_SYNCED", "RELOAD_AVAILABLE"].includes(
                          row.eligibility,
                        ) ? (
                          <button
                            className="secondary lead-reload-button"
                            onClick={() => reloadContacts([row])}
                            disabled={Boolean(busy) || !integrationReady}
                          >
                            {busy === "reload" &&
                            reloadingPolicyId === row.policy.policyId ? (
                              <Loader2 className="spin" size={14} />
                            ) : (
                              <RefreshCcw size={14} />
                            )}
                            Reload Contact
                          </button>
                        ) : (
                          <span className="lead-status lead-status-ready">
                            Ready
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="lead-import-empty compact">
              <CheckCircle2 size={25} />
              <strong>No contacts are waiting to load</strong>
              <span>
                Matched contacts are excluded when they are DNC, invalid, or
                duplicated.
              </span>
            </div>
          )}
        </section>
      )}

      {clearTarget && (
        <div className="admin-modal-backdrop" role="presentation">
          <div
            className="admin-modal clear-contact-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-contact-title"
          >
            <div className="admin-modal-head">
              <h2 id="clear-contact-title">Clear Genesys Contact List</h2>
              <button
                className="icon-button"
                onClick={() => setClearTarget(null)}
                aria-label="Close"
                disabled={listBusy === "clear"}
              >
                <X size={20} />
              </button>
            </div>
            <div className="clear-contact-body">
              <div className="clear-contact-warning">
                <CircleAlert size={22} />
                <div>
                  <strong>
                    This action permanently removes every contact.
                  </strong>
                  <p>
                    Genesys will also cancel outstanding recalls and
                    rule-scheduled callbacks for non-preview campaigns using
                    this list.
                  </p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Contact List</dt>
                  <dd>{clearTarget.name}</dd>
                </div>
                <div>
                  <dt>List ID</dt>
                  <dd>{clearTarget.id}</dd>
                </div>
              </dl>
              <label className="clear-contact-confirmation">
                <span>
                  Type <strong>CLEAR</strong> to confirm
                </span>
                <input
                  value={clearConfirmation}
                  onChange={(event) =>
                    setClearConfirmation(event.target.value.toUpperCase())
                  }
                  autoFocus
                  autoComplete="off"
                />
              </label>
              <div className="clear-contact-actions">
                <button
                  className="secondary"
                  onClick={() => setClearTarget(null)}
                  disabled={listBusy === "clear"}
                >
                  Cancel
                </button>
                <button
                  className="admin-danger"
                  onClick={clearContactList}
                  disabled={
                    clearConfirmation !== "CLEAR" || listBusy === "clear"
                  }
                >
                  {listBusy === "clear" ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  Clear All Contacts
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
