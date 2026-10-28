import { useEffect, useState, useRef } from "react";
import { RefreshCw, Save, Pencil, X, CheckCircle2 } from "lucide-react";
import { api } from "./lib/api";
import type { ContactListConfiguration as ContactList } from "../server/domain/pipeline-types";
export function ContactListConfiguration() {
  const [items, setItems] = useState<ContactList[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [draft, setDraft] = useState<{
      id: string;
      uuid: string;
      expectedUuid: string;
    } | null>(null),
    [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setConfirm(false);
      if (event.key === "Tab") {
        const buttons = Array.from(
          node?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ||
            [],
        );
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [confirm, busy]);
  async function load() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setItems(
        (
          await api<{ items: ContactList[] }>(
            "/api/admin/pipeline/contact-lists",
          )
        ).items,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void api<{ contactLists: ContactList[] }>("/api/admin/pipeline/bootstrap")
      .then((value) => setItems(value.contactLists))
      .then(() => load())
      .catch((reason) => setError((reason as Error).message));
  }, []);
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const row = await api<ContactList>(
        "/api/admin/pipeline/contact-lists/" +
          encodeURIComponent(draft.id) +
          "/uuid",
        {
          method: "PUT",
          body: JSON.stringify({ ...draft, confirmation: true }),
        },
      );
      setItems((previous) =>
        previous.map((item) =>
          item.contactListId === row.contactListId ? row : item,
        ),
      );
      setDraft(null);
      setConfirm(false);
      setMessage("UUID verified against Genesys and saved.");
    } catch (reason) {
      setError((reason as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pipeline-workspace">
      <header className="admin-page-head">
        <div>
          <span>GENESYS CONFIGURATION</span>
          <h1>Contact List Configuration</h1>
          <p>
            Retrieve Genesys Contact Lists and verify the UUID used for contact
            synchronization.
          </p>
        </div>
        <button
          className="admin-primary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {busy ? "Loading…" : "Refresh Contact Lists"}
        </button>
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
      <section className="admin-panel">
        <p className="pipe-muted">
          Genesys Outbound uses the Contact List ID in its Web Service URL. When
          that ID is a valid UUID, it is saved automatically as the UUID.
          Existing UUID values are never replaced by a refresh.
        </p>
        <div className="pipe-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Contact List Name</th>
                <th>Contact List ID</th>
                <th>UUID</th>
                <th>Configuration Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>
                    <code>{item.contactListId}</code>
                  </td>
                  <td>
                    {draft?.id === item.contactListId ? (
                      <input
                        aria-label={"UUID for " + item.name}
                        value={draft.uuid}
                        onChange={(event) =>
                          setDraft({ ...draft, uuid: event.target.value })
                        }
                      />
                    ) : (
                      <code>{item.uuid || "Not configured"}</code>
                    )}
                  </td>
                  <td>
                    <span
                      className={`ls-system-pill ${item.missing ? "error" : item.uuid ? "normal" : "warning"}`}
                    >
                      {item.missing
                        ? "Unavailable"
                        : item.uuid
                          ? "Configured"
                          : "UUID required"}
                    </span>
                    <small>
                      {item.uuidSource === "CONTACT_LIST_ID"
                        ? "From Genesys Contact List ID"
                        : item.uuidSource === "MANUAL"
                          ? "Manually verified"
                          : "Configure before creating a mapping"}
                    </small>
                  </td>
                  <td>
                    {draft?.id === item.contactListId ? (
                      <div className="pipe-actions">
                        <button
                          className="admin-primary"
                          disabled={busy || !draft.uuid.trim()}
                          onClick={() => setConfirm(true)}
                        >
                          <Save size={15} />
                          Save
                        </button>
                        <button
                          className="admin-secondary"
                          aria-label="Cancel UUID edit"
                          onClick={() => setDraft(null)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="admin-secondary"
                        disabled={busy}
                        onClick={() => {
                          setError("");
                          setMessage("");
                          setDraft({
                            id: item.contactListId,
                            uuid: item.uuid,
                            expectedUuid: item.uuid,
                          });
                        }}
                      >
                        <Pencil size={15} />
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && !busy && (
            <div className="pipe-empty">
              <p>
                No Contact Lists available. Check Integration Setting and
                refresh.
              </p>
            </div>
          )}
        </div>
      </section>
      {confirm && draft && (
        <div className="admin-modal-backdrop">
          <section
            ref={dialog}
            className="admin-modal ls-uuid-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm UUID change"
          >
            <header className="admin-modal-head">
              <h2>Confirm UUID change</h2>
              <button
                aria-label="Close UUID confirmation"
                onClick={() => setConfirm(false)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="pipe-editor">
              <p>
                This UUID controls the Genesys destination used by existing
                mappings and schedules. Verify this value before saving.
              </p>
              <code>{draft.uuid}</code>
              <p>Previous UUID: {draft.expectedUuid || "Not configured"}</p>
              <div className="pipe-form-actions">
                <button
                  className="admin-secondary"
                  onClick={() => setConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="admin-primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Confirm and save UUID
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
