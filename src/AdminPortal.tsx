import {
  ArrowDownToLine,
  Home,
  Link2,
  Network,
  MapPin,
  CalendarDays,
  SlidersHorizontal,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  Clock3,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  DatabaseBackup,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  ListPlus,
  LogOut,
  Menu,
  PhoneCall,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { api } from "./lib/api";

import { THAI_PROVINCES } from "./lib/thai-provinces";

import type {
  CampaignFilters,
  CampaignList,
  Customer,
  Inquiry,
  Policy,
  Product,
} from "../server/domain/types";

import { App as GenesysSettings } from "./App";
import { PipelineWorkspace } from "./PipelineWorkspace";
import { Footer } from "./Footer";
import { LeadSyncLogin as Login } from "./LeadSyncLogin";
import { LeadSyncHeader } from "./LeadSyncChrome";

type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

type PolicyRow = Policy & {
  daysUntilExpiry: number;
  customer?: Customer;
  product?: Product;
};

type SyncResult = { policyId: string; status: string; message: string };

type RenewalResult = {
  policyId: string;
  policyNumber: string;
  effectiveDate: string;
  expiryDate: string;
  renewalStatus: string;
  alreadyRenewed: boolean;
};

type Portal = "genesys";

async function syncInBatches(
  policyIds: string[],
  campaignListId: string | undefined,
  onProgress: (processed: number, total: number) => void,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (let index = 0; index < policyIds.length; index += 5) {
    const batch = policyIds.slice(index, index + 5);
    const response = await api<{ results: SyncResult[] }>(
      `${base}/genesys/sync/bulk`,
      {
        method: "POST",
        body: JSON.stringify({ policyIds: batch, campaignListId }),
      },
    );
    results.push(...response.results);
    onProgress(results.length, policyIds.length);
  }
  return results;
}

const base = "/api/admin";

const numberFormat = new Intl.NumberFormat("en-US");

const money = (value: number) => `฿${numberFormat.format(value)}`;

const dateText = (value?: string | null) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

const channels = ["VOICE", "SMS", "EMAIL", "LINE", "DIGITAL"];

const statuses = [
  "NOT_STARTED",
  "CONTACT_PENDING",
  "CONTACTED",
  "INTERESTED",
  "CALLBACK_REQUESTED",
  "NOT_INTERESTED",
  "RENEWED",
  "EXPIRED",
  "CANCELLED",
];

const statusLabels: Record<string, string> = {
  NOT_STARTED: "Not started",
  CONTACT_PENDING: "Contact pending",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  CALLBACK_REQUESTED: "Callback requested",
  NOT_INTERESTED: "Not interested",
  RENEWED: "Renewed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  NOT_SYNCED: "Not synced",
  SYNCED: "Synced",
  OUTDATED: "Outdated",
  FAILED: "Failed",
  SKIPPED_DNC: "DNC",
  INVALID_PHONE: "Invalid phone",
  SCHEMA_MISMATCH: "Schema mismatch",
  NEW: "New",
  CLOSED: "Closed",
  CONVERTED: "Completed",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
  RENEWAL_INTERESTED: "Renewal interested",
  PREMIUM_INQUIRY: "Premium inquiry",
  DISCOUNT_NEGOTIATION: "Discount negotiation",
  COVERAGE_INQUIRY: "Coverage inquiry",
  PLAN_COMPARISON: "Plan comparison",
  PAYMENT_INQUIRY: "Payment inquiry",
  POLICY_CHANGE: "Policy change",
  COMPLAINT: "Complaint",
  CALLBACK_REQUEST: "Callback request",
  OTHER: "Other",
};

const navigationGroups = [
  {
    label: "",
    items: [
      { key: "overview", label: "Dashboard", icon: Home },
      { key: "templates", label: "Contact List Templates", icon: FileText },
    ],
  },
  {
    label: "Source Configuration",
    items: [
      { key: "sources", label: "Source Integration", icon: Link2 },
      { key: "mappings", label: "Source Mapping", icon: Network },
    ],
  },
  {
    label: "",
    items: [{ key: "leads", label: "Lead Configuration", icon: Settings }],
  },
  {
    label: "Genesys Configuration",
    items: [
      {
        key: "integration",
        label: "Integration Settings",
        icon: SlidersHorizontal,
      },
      { key: "regions", label: "Region Management", icon: MapPin },
    ],
  },
  {
    label: "Lead Importer",
    items: [
      { key: "manual-import", label: "Manual Import", icon: CloudUpload },
      { key: "schedule-import", label: "Schedule Import", icon: CalendarDays },
    ],
  },
  {
    label: "",
    items: [{ key: "settings", label: "System settings", icon: Settings }],
  },
];
const legacyNavigation = [
  { key: "campaigns", label: "Legacy campaigns" },
  { key: "customers", label: "Legacy customers" },
  { key: "products", label: "Legacy products" },
  { key: "policies", label: "Legacy policies" },
  { key: "legacy-scheduler", label: "Legacy one-time schedules" },
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
  const requestedSection = window.location.pathname.split("/")[1] || "overview";
  const section =
    (
      {
        "import-leads": "manual-import",
        scheduler: "schedule-import",
        "genesys-configuration": "integration",
      } as Record<string, string>
    )[requestedSection] || requestedSection;
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = [
    ...navigationGroups.flatMap((group) => group.items),
    ...legacyNavigation,
  ];
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
        <button
          className="ls-nav-close"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        >
          <X size={21} />
        </button>
        <nav aria-label="Main navigation">
          {navigationGroups.map((group, index) =>
            group.label ? (
              <details className="ls-nav-section" key={index} open>
                <summary>
                  {group.label === "Source Configuration" ? (
                    <DatabaseBackup size={19} />
                  ) : group.label === "Lead Importer" ? (
                    <Search size={19} />
                  ) : (
                    <Network size={19} />
                  )}
                  <span>{group.label}</span>
                  <ChevronDown size={15} />
                </summary>
                <div className="ls-nav-children">
                  {group.items.map(({ key, label, icon: Icon }) => (
                    <a
                      key={key}
                      className={section === key ? "active" : ""}
                      aria-current={section === key ? "page" : undefined}
                      href={"/" + key}
                    >
                      <Icon size={19} />
                      {label}
                    </a>
                  ))}
                </div>
              </details>
            ) : (
              <div className="ls-nav-section" key={index}>
                {group.items.map(({ key, label, icon: Icon }) => (
                  <a
                    key={key}
                    className={section === key ? "active" : ""}
                    aria-current={section === key ? "page" : undefined}
                    href={key === "overview" ? "/" : "/" + key}
                  >
                    <Icon size={19} />
                    {label}
                  </a>
                ))}
              </div>
            ),
          )}
          <details className="pipe-legacy-nav">
            <summary>Legacy sources</summary>
            {legacyNavigation.map(({ key, label }) => (
              <a
                key={key}
                href={"/" + key}
                className={section === key ? "active" : ""}
              >
                {label}
              </a>
            ))}
          </details>
        </nav>
        <div className="sidebar-bottom">
          <button onClick={logout}>
            <LogOut size={17} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="admin-main">
        <div className="ls-page-breadcrumb">
          <a href="/">Home</a>
          <ChevronRight size={12} />
          {["manual-import", "schedule-import"].includes(section) && (
            <>
              <span>Lead Importer</span>
              <ChevronRight size={12} />
            </>
          )}
          <span>
            {navigation.find((item) => item.key === section)?.label || "Page"}
          </span>
        </div>
        <main className="admin-content">
          {[
            "overview",
            "templates",
            "sources",
            "mappings",
            "leads",
            "manual-import",
            "schedule-import",
          ].includes(section) ? (
            <PipelineWorkspace
              key={section}
              page={
                section as
                  | "overview"
                  | "templates"
                  | "sources"
                  | "mappings"
                  | "leads"
                  | "manual-import"
                  | "schedule-import"
              }
            />
          ) : ["integration", "regions", "legacy-scheduler"].includes(
              section,
            ) ? (
            <GenesysSettings
              tab={
                (section === "legacy-scheduler" ? "scheduler" : section) as
                  "integration" | "regions" | "scheduler"
              }
            />
          ) : section === "dashboard" ? (
            <Dashboard />
          ) : section === "customers" ? (
            <Customers />
          ) : section === "products" ? (
            <Products />
          ) : section === "policies" ? (
            <Policies />
          ) : section === "campaigns" ? (
            <Campaigns />
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

function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="admin-page-head">
      <div>
        {eyebrow && <span>{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="admin-page-action">{action}</div>}
    </div>
  );
}

function Badge({ value }: { value: string }) {
  return (
    <span
      className={`admin-badge ${value.toLowerCase().replace(/[^a-z]/g, "-")}`}
    >
      {statusLabels[value] || value}
    </span>
  );
}

function Empty({ text = "No records found" }: { text?: string }) {
  return <div className="admin-empty">{text}</div>;
}

function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="admin-error" role="alert">
      {error}
    </div>
  ) : null;
}

function Pager({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="admin-pager">
      <span>
        {total
          ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`
          : "0"}{" "}
        of {total} records
      </span>
      <div>
        <button
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="admin-modal-backdrop" onMouseDown={onClose}>
      <div
        className="admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="admin-modal-head">
          <h2>{title}</h2>
          <button aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useList<T>(url: string) {
  const [data, setData] = useState<Page<T>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, refresh] = useState(0);
  useEffect(() => {
    setLoading(true);
    api<Page<T>>(url)
      .then(setData)
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [url, version]);
  return { data, error, loading, refresh: () => refresh((v) => v + 1) };
}

function usePolicyRenewalEvents(onRenewal: () => void) {
  const callback = useRef(onRenewal);
  callback.current = onRenewal;
  useEffect(() => {
    const events = new EventSource(`${base}/policies/renewal-events`);
    const onEvent = () => callback.current();
    events.addEventListener("policy-renewed", onEvent);
    return () => events.close();
  }, []);
}

function Dashboard() {
  const [data, setData] = useState<{
    kpis: Record<string, number>;
    charts: Record<string, { label: string; value: number }[]>;
  } | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api<typeof data>(`${base}/dashboard`)
      .then(setData)
      .catch((reason) => setError(reason.message));
  useEffect(() => {
    void load();
  }, []);
  usePolicyRenewalEvents(() => {
    void load();
  });
  const kpis = data?.kpis;
  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="Business overview"
        description="Customers, policies, and renewal activity"
      />
      <ErrorNotice error={error} />
      {!data ? (
        <div className="admin-loading">Loading...</div>
      ) : (
        <>
          <div className="kpi-grid">
            {[
              ["Total customers", kpis?.totalCustomers, "customers"],
              ["Active policies", kpis?.activePolicies, "policies"],
              ["Total premium", money(kpis?.totalPremium || 0), "policies"],
              ["Expiring in 30 days", kpis?.expiring30, "renewals"],
              ["Contact pending", kpis?.contactPending, "renewals"],
              ["Callback requested", kpis?.callbackRequested, "callbacks"],
              ["Renewed", kpis?.renewed, "renewals"],
              ["New inquiries", kpis?.newInquiries, "inquiries"],
            ].map(([label, value, link]) => (
              <a className="kpi-tile" key={String(label)} href={`/${link}`}>
                <span>{label}</span>
                <strong>
                  {typeof value === "number"
                    ? numberFormat.format(value)
                    : value}
                </strong>
                <ArrowRight size={16} />
              </a>
            ))}
          </div>
          <div className="dashboard-row">
            <div className="admin-panel">
              <div className="panel-head">
                <h2>Policies nearing expiry</h2>
                <a href="/renewals">
                  View records <ArrowRight size={15} />
                </a>
              </div>
              <div className="expiry-bars">
                {[
                  ["7 days", kpis?.expiring7],
                  ["30 days", kpis?.expiring30],
                  ["60 days", kpis?.expiring60],
                  ["90 days", kpis?.expiring90],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <span>{label}</span>
                    <div>
                      <i
                        style={{
                          width: `${Math.max(3, (Number(value) / Math.max(1, kpis?.expiring90 || 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <b>{value}</b>
                  </div>
                ))}
              </div>
            </div>
            <div className="admin-panel">
              <div className="panel-head">
                <h2>Renewal status</h2>
              </div>
              <div className="dashboard-status-list">
                {data.charts.byRenewal.map((item) => (
                  <div key={item.label}>
                    <Badge value={item.label} />
                    <b>{item.value}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="dashboard-row">
            <div className="admin-panel">
              <div className="panel-head">
                <h2>Policies by product</h2>
              </div>
              <div className="mini-bars">
                {data.charts.byProduct.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <div>
                      <i
                        style={{
                          width: `${(item.value / Math.max(...data.charts.byProduct.map((v) => v.value), 1)) * 100}%`,
                        }}
                      />
                    </div>
                    <b>{item.value}</b>
                  </div>
                ))}
              </div>
            </div>
            <div className="admin-panel">
              <div className="panel-head">
                <h2>Genesys Sync</h2>
                <a href="/">
                  Configure integration <ArrowRight size={15} />
                </a>
              </div>
              <div className="dashboard-status-list">
                {data.charts.byGenesys.map((item) => (
                  <div key={item.label}>
                    <Badge value={item.label} />
                    <b>{item.value}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const blankCustomer = (): Customer => ({
  customerId: "",
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  preferredChannel: "VOICE",
  province: "",
  dnc: false,
  createdAt: "",
  updatedAt: "",
});

function Customers() {
  const id = window.location.pathname.split("/")[2];
  if (id) return <Customer360 id={id} />;
  return <CustomerList />;
}

function CustomerList() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState("");
  const [dnc, setDnc] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [error, setError] = useState("");
  const url = `${base}/customers?search=${encodeURIComponent(search)}&channel=${channel}&dnc=${dnc}&page=${page}`;
  const { data, loading, refresh } = useList<Customer>(url);
  async function remove(item: Customer) {
    if (!window.confirm(`Delete customer ${item.firstName} ${item.lastName}?`))
      return;
    try {
      await api(`${base}/customers/${item.customerId}`, { method: "DELETE" });
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="Records"
        title="Customers"
        description="Search and manage policyholders"
        action={
          <button
            className="admin-primary"
            onClick={() => setEditing(blankCustomer())}
          >
            <Plus size={17} /> Add customer
          </button>
        }
      />
      <ErrorNotice error={error} />
      <div className="admin-toolbar">
        <div className="admin-search">
          <Search size={17} />
          <input
            placeholder="Name, phone, or customer ID"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All channels</option>
          {channels.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <select
          value={dnc}
          onChange={(event) => {
            setDnc(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All</option>
          <option value="true">DNC</option>
          <option value="false">Contactable</option>
        </select>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Full name</th>
              <th>Phone</th>
              <th>Province</th>
              <th>Channel</th>
              <th>DNC</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.customerId}>
                <td>
                  <a
                    href={`/customers/${item.customerId}`}
                    className="table-link"
                  >
                    {item.customerId}
                  </a>
                </td>
                <td>
                  <b>
                    {item.firstName} {item.lastName}
                  </b>
                </td>
                <td>{item.phone}</td>
                <td>{item.province || "—"}</td>
                <td>{item.preferredChannel}</td>
                <td>{item.dnc ? <Badge value="SKIPPED_DNC" /> : "—"}</td>
                <td className="row-actions">
                  <button aria-label="Edit" onClick={() => setEditing(item)}>
                    Edit
                  </button>
                  <button
                    className="danger-link"
                    aria-label="Delete"
                    onClick={() => remove(item)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.items.length && !loading && <Empty />}
        <Pager
          page={page}
          pageSize={20}
          total={data.total}
          onChange={setPage}
        />
      </div>
      {editing && (
        <CustomerForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

function CustomerForm({
  item,
  onClose,
  onSaved,
}: {
  item: Customer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(item);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        `${base}/customers${item.customerId ? `/${item.customerId}` : ""}`,
        {
          method: item.customerId ? "PUT" : "POST",
          body: JSON.stringify(form),
        },
      );
      onSaved();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item.customerId ? `Edit ${item.customerId}` : "Add customer"}
      onClose={onClose}
    >
      <form className="admin-form" onSubmit={save}>
        <div className="admin-form-grid">
          <label>
            First name
            <input
              required
              value={form.firstName}
              onChange={(event) =>
                setForm({ ...form, firstName: event.target.value })
              }
            />
          </label>
          <label>
            Last name
            <input
              required
              value={form.lastName}
              onChange={(event) =>
                setForm({ ...form, lastName: event.target.value })
              }
            />
          </label>
          <label>
            Phone
            <input
              required
              type="tel"
              value={form.phone}
              onChange={(event) =>
                setForm({ ...form, phone: event.target.value })
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
            />
          </label>
          <label>
            Province
            <select
              required={!item.customerId}
              value={form.province}
              onChange={(event) =>
                setForm({ ...form, province: event.target.value })
              }
            >
              <option value="">Select province</option>
              {form.province &&
                !THAI_PROVINCES.some(
                  (province) => province === form.province,
                ) && <option value={form.province}>{form.province}</option>}
              {THAI_PROVINCES.map((province) => (
                <option key={province} value={province}>
                  {province}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preferred channel
            <select
              value={form.preferredChannel}
              onChange={(event) =>
                setForm({
                  ...form,
                  preferredChannel: event.target
                    .value as Customer["preferredChannel"],
                })
              }
            >
              {channels.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={form.dnc}
            onChange={(event) =>
              setForm({ ...form, dnc: event.target.checked })
            }
          />{" "}
          Do not contact (DNC)
        </label>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="admin-primary" disabled={busy}>
            <Save size={16} /> Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Customer360({ id }: { id: string }) {
  const [data, setData] = useState<{
    customer: Customer;
    policies: PolicyRow[];
    inquiries: Inquiry[];
  } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const load = () =>
    api<typeof data>(`${base}/customers/${id}/360`)
      .then(setData)
      .catch((reason) => setError(reason.message));
  useEffect(() => {
    void load();
  }, [id]);
  return (
    <>
      <a className="admin-back" href="/customers">
        <ArrowLeft size={16} /> Back to customers
      </a>
      <PageHead
        eyebrow="Customer 360"
        title={
          data ? `${data.customer.firstName} ${data.customer.lastName}` : id
        }
        description={id}
        action={
          data && (
            <button
              className="admin-secondary"
              onClick={() => setEditing(true)}
            >
              Edit customer
            </button>
          )
        }
      />
      <ErrorNotice error={error} />
      {data && (
        <>
          <div className="admin-panel customer-profile">
            <div>
              <small>Phone</small>
              <b>{data.customer.phone}</b>
            </div>
            <div>
              <small>Email</small>
              <b>{data.customer.email || "—"}</b>
            </div>
            <div>
              <small>Province</small>
              <b>{data.customer.province || "—"}</b>
            </div>
            <div>
              <small>Channel</small>
              <b>{data.customer.preferredChannel}</b>
            </div>
            <div>
              <small>Contact preference</small>
              <b>
                {data.customer.dnc ? (
                  <Badge value="SKIPPED_DNC" />
                ) : (
                  "Contactable"
                )}
              </b>
            </div>
          </div>
          <div className="admin-panel">
            <div className="panel-head">
              <h2>Policies ({data.policies.length})</h2>
              <a href="/policies">View all</a>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Policy number</th>
                    <th>Products</th>
                    <th>Registration</th>
                    <th>Expiry date</th>
                    <th>Premium</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policies.map((item) => (
                    <tr key={item.policyId}>
                      <td>
                        <a
                          className="table-link"
                          href={`/policies/${item.policyId}`}
                        >
                          {item.policyNumber}
                        </a>
                      </td>
                      <td>{item.product?.productName}</td>
                      <td>{item.vehicle.licensePlate}</td>
                      <td>{dateText(item.expiryDate)}</td>
                      <td>{money(item.premium)}</td>
                      <td>
                        <Badge value={item.renewalStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.policies.length && <Empty />}
            </div>
          </div>
          <div className="admin-panel">
            <div className="panel-head">
              <h2>Callback requests ({data.inquiries.length})</h2>
            </div>
            {data.inquiries.length ? (
              data.inquiries.map((item) => (
                <div className="activity-row" key={item.inquiryId}>
                  {item.inquiryId}
                  <Badge value={item.status} />
                  <span>{dateText(item.createdAt)}</span>
                </div>
              ))
            ) : (
              <Empty />
            )}
          </div>
          {editing && (
            <CustomerForm
              item={data.customer}
              onClose={() => setEditing(false)}
              onSaved={load}
            />
          )}
        </>
      )}
    </>
  );
}

const blankCoverage = () => ({
  thirdPartyProperty: true,
  thirdPartyInjury: true,
  ownVehicleCollision: true,
  vehicleTheft: true,
  fire: true,
  flood: false,
  personalAccident: true,
  medicalExpense: true,
  driverBail: true,
});

const coverageLabels: Record<string, string> = {
  thirdPartyProperty: "Third-party property",
  thirdPartyInjury: "Third-party injury",
  ownVehicleCollision: "Vehicle collision",
  vehicleTheft: "Vehicle theft",
  fire: "Fire",
  flood: "Flood",
  personalAccident: "Personal accident",
  medicalExpense: "Medical expenses",
  driverBail: "Driver bail",
};

function blankProduct(): Product {
  return {
    productId: "",
    productCode: "",
    slug: "",
    productName: "",
    productType: "MOTOR",
    vehicleType: "CAR",
    insuranceClass: "1",
    shortDescription: "",
    description: "",
    insurerName: "MFEC Demo Insurance",
    startingPremium: 0,
    coverage: blankCoverage(),
    coverageLimits: {},
    features: [],
    terms: [],
    eligibleVehicleTypes: ["Private passenger car"],
    minVehicleAge: 0,
    maxVehicleAge: 20,
    active: true,
    featured: false,
    displayOrder: 99,
    createdAt: "",
    updatedAt: "",
  };
}

function Products() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [active, setActive] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [error, setError] = useState("");
  const { data, refresh } = useList<Product>(
    `${base}/products?search=${encodeURIComponent(search)}&active=${active}&page=${page}`,
  );
  async function remove(item: Product) {
    if (!window.confirm(`Delete product ${item.productName}?`)) return;
    try {
      await api(`${base}/products/${item.productId}`, { method: "DELETE" });
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="Records"
        title="Products and plans"
        description="Manage plans shown on the website and used in policies"
        action={
          <button
            className="admin-primary"
            onClick={() => setEditing(blankProduct())}
          >
            <Plus size={17} /> Add product
          </button>
        }
      />
      <ErrorNotice error={error} />
      <div className="admin-toolbar">
        <div className="admin-search">
          <Search size={17} />
          <input
            placeholder="Product name or ID"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          value={active}
          onChange={(event) => {
            setActive(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="true">Published</option>
          <option value="false">Unpublished</option>
        </select>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Product ID</th>
              <th>Plan name</th>
              <th>Vehicle type</th>
              <th>Class</th>
              <th>Starting premium</th>
              <th>Published</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.productId}>
                <td className="mono">{item.productCode}</td>
                <td>
                  <b>{item.productName}</b>
                  <small>{item.shortDescription}</small>
                </td>
                <td>{item.vehicleType}</td>
                <td>{item.insuranceClass}</td>
                <td>{money(item.startingPremium)}</td>
                <td>
                  {item.active ? (
                    <span className="dot-live">Active</span>
                  ) : (
                    "Inactive"
                  )}
                </td>
                <td className="row-actions">
                  <button onClick={() => setEditing(item)}>Edit</button>
                  <button className="danger-link" onClick={() => remove(item)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.items.length && <Empty />}
        <Pager
          page={page}
          pageSize={20}
          total={data.total}
          onChange={setPage}
        />
      </div>
      {editing && (
        <ProductForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

function ProductForm({
  item,
  onClose,
  onSaved,
}: {
  item: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(item);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        `${base}/products${item.productId ? `/${item.productId}` : ""}`,
        { method: item.productId ? "PUT" : "POST", body: JSON.stringify(form) },
      );
      onSaved();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item.productId ? `Edit ${item.productName}` : "Add product"}
      onClose={onClose}
    >
      <form className="admin-form" onSubmit={save}>
        <div className="admin-form-grid">
          <label>
            Product ID
            <input
              required
              value={form.productCode}
              onChange={(event) =>
                setForm({ ...form, productCode: event.target.value })
              }
            />
          </label>
          <label>
            Slug (URL)
            <input
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={form.slug}
              onChange={(event) =>
                setForm({ ...form, slug: event.target.value })
              }
            />
          </label>
          <label className="wide">
            Plan name
            <input
              required
              value={form.productName}
              onChange={(event) =>
                setForm({ ...form, productName: event.target.value })
              }
            />
          </label>
          <label>
            Product category
            <input
              required
              value={form.productType}
              onChange={(event) =>
                setForm({ ...form, productType: event.target.value })
              }
            />
          </label>
          <label>
            Vehicle type
            <select
              value={form.vehicleType}
              onChange={(event) =>
                setForm({
                  ...form,
                  vehicleType: event.target.value as Product["vehicleType"],
                })
              }
            >
              <option value="CAR">Car</option>
              <option value="MOTORCYCLE">Motorcycle</option>
              <option value="ADDON">Add-on coverage</option>
            </select>
          </label>
          <label>
            Insurance class
            <input
              required
              value={form.insuranceClass}
              onChange={(event) =>
                setForm({ ...form, insuranceClass: event.target.value })
              }
            />
          </label>
          <label>
            Insurer
            <input
              required
              value={form.insurerName}
              onChange={(event) =>
                setForm({ ...form, insurerName: event.target.value })
              }
            />
          </label>
          <label>
            Starting premium
            <input
              required
              type="number"
              min="0"
              value={form.startingPremium}
              onChange={(event) =>
                setForm({
                  ...form,
                  startingPremium: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Display order
            <input
              type="number"
              value={form.displayOrder}
              onChange={(event) =>
                setForm({ ...form, displayOrder: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Minimum vehicle age
            <input
              type="number"
              min="0"
              value={form.minVehicleAge}
              onChange={(event) =>
                setForm({ ...form, minVehicleAge: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Maximum vehicle age
            <input
              type="number"
              min="0"
              value={form.maxVehicleAge}
              onChange={(event) =>
                setForm({ ...form, maxVehicleAge: Number(event.target.value) })
              }
            />
          </label>
          <label className="wide">
            Short description
            <input
              required
              value={form.shortDescription}
              onChange={(event) =>
                setForm({ ...form, shortDescription: event.target.value })
              }
            />
          </label>
          <label className="wide">
            Details
            <textarea
              required
              rows={3}
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
            />
          </label>
          <label className="wide">
            Highlights (one per line)
            <textarea
              rows={3}
              value={form.features.join("\n")}
              onChange={(event) =>
                setForm({
                  ...form,
                  features: event.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
          <label className="wide">
            Conditions (one per line)
            <textarea
              rows={3}
              value={form.terms.join("\n")}
              onChange={(event) =>
                setForm({
                  ...form,
                  terms: event.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
          <label className="wide">
            Eligible vehicle types (one per line)
            <textarea
              rows={2}
              value={form.eligibleVehicleTypes.join("\n")}
              onChange={(event) =>
                setForm({
                  ...form,
                  eligibleVehicleTypes: event.target.value
                    .split("\n")
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
        <div className="form-section-label">Coverage</div>
        <div className="checkbox-grid">
          {Object.entries(coverageLabels).map(([key, label]) => (
            <label key={key} className="admin-check">
              <input
                type="checkbox"
                checked={form.coverage[key as keyof Product["coverage"]]}
                onChange={(event) =>
                  setForm({
                    ...form,
                    coverage: { ...form.coverage, [key]: event.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="form-section-label">Coverage limits</div>
        <div className="admin-form-grid">
          {Object.entries(coverageLabels)
            .filter(([key]) => form.coverage[key as keyof Product["coverage"]])
            .map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={form.coverageLimits[key] || ""}
                  placeholder="e.g. up to THB 1,000,000"
                  onChange={(event) =>
                    setForm({
                      ...form,
                      coverageLimits: {
                        ...form.coverageLimits,
                        [key]: event.target.value,
                      },
                    })
                  }
                />
              </label>
            ))}
        </div>
        <div className="checkbox-grid">
          <label className="admin-check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) =>
                setForm({ ...form, active: event.target.checked })
              }
            />
            Publish on website
          </label>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={form.featured}
              onChange={(event) =>
                setForm({ ...form, featured: event.target.checked })
              }
            />
            Featured plan
          </label>
        </div>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="admin-primary" disabled={busy}>
            <Save size={16} /> Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function blankPolicy(): Policy {
  return {
    policyId: "",
    policyNumber: "",
    customerId: "",
    productId: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
    effectiveDate: new Date().toISOString().slice(0, 10),
    expiryDate: new Date(Date.now() + 365 * 86400000)
      .toISOString()
      .slice(0, 10),
    premium: 0,
    sumInsured: 0,
    insurerName: "MFEC Demo Insurance",
    vehicle: {
      vehicleType: "CAR",
      brand: "",
      model: "",
      year: new Date().getFullYear(),
      licensePlate: "",
      province: "",
    },
    coverageSnapshot: blankCoverage(),
    renewalStatus: "NOT_STARTED",
    preferredChannel: "VOICE",
    digitalSent: false,
    voiceCalled: false,
    customerIntent: "UNKNOWN",
    callbackDateTime: null,
    genesys: {
      contactListId: "",
      contactId: "",
      syncStatus: "NOT_SYNCED",
      lastSyncAt: "",
      lastSyncError: null,
      lastPayloadHash: "",
      lastSyncedBy: "",
    },
    createdAt: "",
    updatedAt: "",
  };
}

function Policies({ renewal = false }: { renewal?: boolean }) {
  const id = window.location.pathname.split("/")[2];
  if (id && !renewal) return <PolicyDetail id={id} />;
  return <PolicyList renewal={renewal} />;
}

function PolicyList({ renewal }: { renewal: boolean }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState(renewal ? "90" : "");
  const [channel, setChannel] = useState("");
  const [genesysStatus, setGenesysStatus] = useState("");
  const [excludeDnc, setExcludeDnc] = useState(renewal);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [renewingId, setRenewingId] = useState("");
  const [result, setResult] = useState("");
  const [progress, setProgress] = useState("");
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const { data, refresh } = useList<PolicyRow>(
    `${base}/${renewal ? "renewals" : "policies"}?search=${encodeURIComponent(search)}&renewalStatus=${status}&channel=${channel}&genesysStatus=${genesysStatus}&excludeDnc=${excludeDnc}&${days ? `daysTo=${days}&` : ""}page=${page}`,
  );
  usePolicyRenewalEvents(refresh);
  async function renew(item: PolicyRow) {
    if (
      !window.confirm(
        `Renew ${item.policyNumber} for one year from its current expiry date?`,
      )
    )
      return;
    setRenewingId(item.policyId);
    setError("");
    setResult("");
    try {
      const updated = await api<RenewalResult>(
        `${base}/policies/${item.policyId}/renew`,
        { method: "POST" },
      );
      setResult(
        updated.alreadyRenewed
          ? `${updated.policyNumber} was already renewed. Expiry: ${dateText(updated.expiryDate)}.`
          : `${updated.policyNumber} renewed through ${dateText(updated.expiryDate)}.`,
      );
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRenewingId("");
    }
  }
  async function remove(item: Policy) {
    if (!window.confirm(`Delete policy ${item.policyNumber}?`)) return;
    try {
      await api(`${base}/policies/${item.policyId}`, { method: "DELETE" });
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  async function bulkSync(ids = selected) {
    if (!window.confirm(`Sync ${ids.length} policies to Genesys?`)) return;
    setSyncing(true);
    setResult("");
    setError("");
    setFailedIds([]);
    setProgress(`Syncing 0 / ${ids.length}`);
    try {
      const output = await syncInBatches(ids, undefined, (processed, total) =>
        setProgress(`Syncing ${processed} / ${total}`),
      );
      const successful = output.filter((item) =>
        ["SYNCED", "ALREADY_SYNCED"].includes(item.status),
      ).length;
      const failed = output.filter(
        (item) => !["SYNCED", "ALREADY_SYNCED"].includes(item.status),
      );
      setResult(
        `Processed ${output.length} · Completed ${successful} · Failed ${failed.length}`,
      );
      setFailedIds(failed.map((item) => item.policyId));
      setSelected([]);
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSyncing(false);
      setProgress("");
    }
  }
  async function singleSync(item: PolicyRow) {
    if (!window.confirm(`Send policy ${item.policyNumber} to Genesys?`)) return;
    setSyncing(true);
    setError("");
    setResult("");
    try {
      const output = await api<{ message: string }>(
        `${base}/genesys/sync/policies/${item.policyId}`,
        { method: "POST" },
      );
      setResult(output.message);
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  async function recall(item: PolicyRow) {
    if (
      !window.confirm(
        `Clear Genesys call history and queue ${item.policyNumber} for recall?`,
      )
    )
      return;
    setSyncing(true);
    setError("");
    setResult("");
    try {
      const output = await api<{ message: string }>(
        `${base}/genesys/sync/policies/${item.policyId}/recall`,
        { method: "POST" },
      );
      setResult(output.message);
      refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  return (
    <>
      <PageHead
        eyebrow={renewal ? "Renewal work" : "Records"}
        title={renewal ? "Renewal tracking" : "Policies"}
        description={
          renewal
            ? "Track upcoming expiries and customer contact status"
            : "Manage policies and insured vehicles"
        }
        action={
          !renewal && (
            <button
              className="admin-primary"
              onClick={() => setEditing(blankPolicy())}
            >
              <Plus size={17} /> Add policy
            </button>
          )
        }
      />
      <ErrorNotice error={error} />
      {result && <div className="admin-success">{result}</div>}
      {progress && <div className="admin-progress">{progress}</div>}
      {failedIds.length > 0 && (
        <div className="admin-error">
          Failed records: {failedIds.join(", ")}{" "}
          <button
            className="admin-secondary"
            disabled={syncing}
            onClick={() => bulkSync(failedIds)}
          >
            Retry
          </button>
        </div>
      )}
      <div className="admin-toolbar">
        <div className="admin-search">
          <Search size={17} />
          <input
            placeholder="Policy number, name, phone, or registration"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {statuses.map((item) => (
            <option key={item} value={item}>
              {statusLabels[item]}
            </option>
          ))}
        </select>
        <select
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
            setPage(1);
          }}
        >
          <option value="">Any expiry date</option>
          <option value="7">Within 7 days</option>
          <option value="30">Within 30 days</option>
          <option value="60">Within 60 days</option>
          <option value="90">Within 90 days</option>
        </select>
        {renewal && (
          <>
            <select
              aria-label="Channel"
              value={channel}
              onChange={(event) => {
                setChannel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All channels</option>
              {channels.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Genesys status"
              value={genesysStatus}
              onChange={(event) => {
                setGenesysStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All Genesys statuses</option>
              {["NOT_SYNCED", "SYNCED", "OUTDATED", "FAILED"].map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </select>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={excludeDnc}
                onChange={(event) => {
                  setExcludeDnc(event.target.checked);
                  setPage(1);
                }}
              />{" "}
              Exclude DNC
            </label>
          </>
        )}
        {renewal && (
          <button
            className="admin-secondary"
            disabled={!selected.length || syncing}
            onClick={() => bulkSync()}
          >
            <CloudUpload size={16} /> Sync selected ({selected.length})
          </button>
        )}
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {renewal && (
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={
                      data.items.length > 0 &&
                      data.items.every((item) =>
                        selected.includes(item.policyId),
                      )
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? data.items.map((item) => item.policyId)
                          : [],
                      )
                    }
                  />
                </th>
              )}
              <th>Policy number</th>
              <th>Customers</th>
              <th>Products / Vehicle</th>
              <th>Expired</th>
              <th>Days left</th>
              <th>Status</th>
              {renewal && (
                <>
                  <th>Channel</th>
                  <th>DNC</th>
                </>
              )}
              <th>Genesys</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.policyId}>
                {renewal && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.includes(item.policyId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, item.policyId]
                            : current.filter((id) => id !== item.policyId),
                        )
                      }
                    />
                  </td>
                )}
                <td>
                  <a className="table-link" href={`/policies/${item.policyId}`}>
                    {item.policyNumber}
                  </a>
                </td>
                <td>
                  {item.customer ? (
                    <a
                      href={`/customers/${item.customerId}`}
                      className="table-link"
                    >
                      {item.customer.firstName} {item.customer.lastName}
                    </a>
                  ) : (
                    item.customerId
                  )}
                  <small>{item.customer?.phone}</small>
                </td>
                <td>
                  {item.product?.productName || item.productId}
                  <small>
                    {item.vehicle.brand} {item.vehicle.model} ·{" "}
                    {item.vehicle.licensePlate}
                  </small>
                </td>
                <td>{dateText(item.expiryDate)}</td>
                <td className={item.daysUntilExpiry <= 7 ? "urgent" : ""}>
                  {item.daysUntilExpiry < 0
                    ? `${-item.daysUntilExpiry} days overdue`
                    : `${item.daysUntilExpiry} days`}
                </td>
                <td>
                  <Badge value={item.renewalStatus} />
                </td>
                {renewal && (
                  <>
                    <td>{item.preferredChannel}</td>
                    <td>
                      {item.customer?.dnc ? <Badge value="SKIPPED_DNC" /> : "—"}
                    </td>
                  </>
                )}
                <td>
                  <Badge value={item.genesys.syncStatus} />
                </td>
                <td className="row-actions">
                  <button onClick={() => setEditing(item)}>Edit</button>
                  <button
                    disabled={
                      Boolean(renewingId) || item.renewalStatus === "CANCELLED"
                    }
                    title={
                      item.renewalStatus === "CANCELLED"
                        ? "Cancelled policies cannot be renewed"
                        : "Renew policy for one year"
                    }
                    onClick={() => renew(item)}
                  >
                    <RefreshCw size={14} /> Renew
                  </button>
                  {renewal && (
                    <>
                      <button
                        disabled={syncing || item.customer?.dnc}
                        onClick={() => singleSync(item)}
                      >
                        <CloudUpload size={14} />
                        {item.genesys.syncStatus === "OUTDATED"
                          ? "Update Genesys"
                          : "Push"}
                      </button>
                      <button
                        disabled={
                          syncing ||
                          item.customer?.dnc ||
                          item.renewalStatus === "CANCELLED" ||
                          !item.genesys.contactId ||
                          item.genesys.syncStatus !== "SYNCED"
                        }
                        title={
                          item.customer?.dnc
                            ? "DNC customers cannot be recalled"
                            : item.renewalStatus === "CANCELLED"
                              ? "Cancelled policies cannot be recalled"
                              : !item.genesys.contactId ||
                                  item.genesys.syncStatus !== "SYNCED"
                                ? "Push this policy to Genesys first"
                                : "Clear Genesys call history and queue this contact for recall"
                        }
                        onClick={() => recall(item)}
                      >
                        <PhoneCall size={14} /> Recall
                      </button>
                    </>
                  )}
                  {!renewal && (
                    <button
                      className="danger-link"
                      onClick={() => remove(item)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.items.length && <Empty />}
        <Pager
          page={page}
          pageSize={20}
          total={data.total}
          onChange={setPage}
        />
      </div>
      {editing && (
        <PolicyForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

function PolicyForm({
  item,
  onClose,
  onSaved,
}: {
  item: Policy;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(item);
  const [meta, setMeta] = useState<{
    customers: Customer[];
    products: Product[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ customers: Customer[]; products: Product[] }>(`${base}/meta`)
      .then(setMeta)
      .catch((reason) => setError(reason.message));
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`${base}/policies${item.policyId ? `/${item.policyId}` : ""}`, {
        method: item.policyId ? "PUT" : "POST",
        body: JSON.stringify(form),
      });
      onSaved();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const vehicle = (field: keyof Policy["vehicle"], value: string | number) =>
    setForm({ ...form, vehicle: { ...form.vehicle, [field]: value } });
  return (
    <Modal
      title={item.policyId ? `Edit ${item.policyNumber}` : "Add policy"}
      onClose={onClose}
    >
      <form className="admin-form" onSubmit={save}>
        <div className="form-section-label">Policy information</div>
        <div className="admin-form-grid">
          <label>
            Customers
            <select
              required
              value={form.customerId}
              onChange={(event) =>
                setForm({ ...form, customerId: event.target.value })
              }
            >
              <option value="">Select customer</option>
              {meta?.customers.map((value) => (
                <option key={value.customerId} value={value.customerId}>
                  {value.customerId} · {value.firstName} {value.lastName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Products
            <select
              required
              value={form.productId}
              onChange={(event) =>
                setForm({ ...form, productId: event.target.value })
              }
            >
              <option value="">Select product</option>
              {meta?.products.map((value) => (
                <option key={value.productId} value={value.productId}>
                  {value.productName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Purchase date
            <input
              required
              type="date"
              value={form.purchaseDate}
              onChange={(event) =>
                setForm({ ...form, purchaseDate: event.target.value })
              }
            />
          </label>
          <label>
            Coverage start date
            <input
              required
              type="date"
              value={form.effectiveDate}
              onChange={(event) =>
                setForm({ ...form, effectiveDate: event.target.value })
              }
            />
          </label>
          <label>
            Expiry date
            <input
              required
              type="date"
              value={form.expiryDate}
              onChange={(event) =>
                setForm({ ...form, expiryDate: event.target.value })
              }
            />
          </label>
          <label>
            Insurer
            <input
              required
              value={form.insurerName}
              onChange={(event) =>
                setForm({ ...form, insurerName: event.target.value })
              }
            />
          </label>
          <label>
            Premium
            <input
              required
              type="number"
              min="0"
              value={form.premium}
              onChange={(event) =>
                setForm({ ...form, premium: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Sum insured
            <input
              required
              type="number"
              min="0"
              value={form.sumInsured}
              onChange={(event) =>
                setForm({ ...form, sumInsured: Number(event.target.value) })
              }
            />
          </label>
        </div>
        <div className="form-section-label">Vehicle information</div>
        <div className="admin-form-grid">
          <label>
            Vehicle type
            <select
              value={form.vehicle.vehicleType}
              onChange={(event) => vehicle("vehicleType", event.target.value)}
            >
              <option value="CAR">Car</option>
              <option value="MOTORCYCLE">Motorcycle</option>
              <option value="ADDON">Other</option>
            </select>
          </label>
          <label>
            Brand
            <input
              required
              value={form.vehicle.brand}
              onChange={(event) => vehicle("brand", event.target.value)}
            />
          </label>
          <label>
            Model
            <input
              required
              value={form.vehicle.model}
              onChange={(event) => vehicle("model", event.target.value)}
            />
          </label>
          <label>
            Vehicle year
            <input
              required
              type="number"
              min="1950"
              max="2100"
              value={form.vehicle.year}
              onChange={(event) => vehicle("year", Number(event.target.value))}
            />
          </label>
          <label>
            Registration
            <input
              required
              value={form.vehicle.licensePlate}
              onChange={(event) => vehicle("licensePlate", event.target.value)}
            />
          </label>
          <label>
            Province
            <input
              required
              value={form.vehicle.province}
              onChange={(event) => vehicle("province", event.target.value)}
            />
          </label>
        </div>
        <div className="form-section-label">Renewal follow-up</div>
        <div className="admin-form-grid">
          <label>
            Status
            <select
              value={form.renewalStatus}
              onChange={(event) =>
                setForm({
                  ...form,
                  renewalStatus: event.target.value as Policy["renewalStatus"],
                })
              }
            >
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preferred channel
            <select
              value={form.preferredChannel}
              onChange={(event) =>
                setForm({
                  ...form,
                  preferredChannel: event.target
                    .value as Policy["preferredChannel"],
                })
              }
            >
              {channels.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Customer interest
            <select
              value={form.customerIntent}
              onChange={(event) =>
                setForm({ ...form, customerIntent: event.target.value })
              }
            >
              {[
                "UNKNOWN",
                "INTERESTED",
                "NOT_INTERESTED",
                "CALLBACK",
                "RENEWED",
                "WRONG_NUMBER",
                "NO_ANSWER",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Callback date and time
            <input
              type="datetime-local"
              value={form.callbackDateTime?.slice(0, 16) || ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  callbackDateTime: event.target.value
                    ? new Date(event.target.value).toISOString()
                    : null,
                })
              }
            />
          </label>
        </div>
        <div className="checkbox-grid">
          <label className="admin-check">
            <input
              type="checkbox"
              checked={form.digitalSent}
              onChange={(event) =>
                setForm({ ...form, digitalSent: event.target.checked })
              }
            />{" "}
            Digital sent
          </label>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={form.voiceCalled}
              onChange={(event) =>
                setForm({ ...form, voiceCalled: event.target.checked })
              }
            />{" "}
            Called
          </label>
        </div>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="admin-primary" disabled={busy}>
            <Save size={16} /> Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PolicyDetail({ id }: { id: string }) {
  const [policy, setPolicy] = useState<PolicyRow | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<PolicyRow>(`${base}/policies/${id}`)
      .then(setPolicy)
      .catch((reason) => setError(reason.message));
  useEffect(() => {
    void load();
  }, [id]);
  usePolicyRenewalEvents(() => {
    void load();
  });
  async function renew() {
    if (
      !policy ||
      !window.confirm(
        `Renew ${policy.policyNumber} for one year from its current expiry date?`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await api<RenewalResult>(`${base}/policies/${id}/renew`, {
        method: "POST",
      });
      setMessage(
        updated.alreadyRenewed
          ? `Already renewed. Expiry: ${dateText(updated.expiryDate)}.`
          : `Renewed through ${dateText(updated.expiryDate)}.`,
      );
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (!policy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ message: string }>(
        `${base}/genesys/sync/policies/${id}`,
        { method: "POST" },
      );
      setMessage(result.message || "Sync completed");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function viewPayload() {
    try {
      setPayload(
        await api<Record<string, unknown>>(
          `${base}/genesys/sync/policies/${id}/payload`,
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <>
      <a className="admin-back" href="/policies">
        <ArrowLeft size={16} /> Back to policies
      </a>
      <PageHead
        eyebrow="Policy details"
        title={policy?.policyNumber || id}
        description={
          policy
            ? `${policy.customer?.firstName || ""} ${policy.customer?.lastName || ""} · ${policy.vehicle.licensePlate}`
            : ""
        }
        action={
          policy && (
            <>
              <button
                className="admin-secondary"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button className="admin-secondary" onClick={viewPayload}>
                View Genesys payload
              </button>
              <button
                className="admin-secondary"
                disabled={busy || policy.renewalStatus === "CANCELLED"}
                title={
                  policy.renewalStatus === "CANCELLED"
                    ? "Cancelled policies cannot be renewed"
                    : "Renew policy for one year"
                }
                onClick={renew}
              >
                <RefreshCw size={16} /> Renew policy
              </button>
              <button className="admin-primary" disabled={busy} onClick={sync}>
                <CloudUpload size={16} />
                {policy.genesys.syncStatus === "OUTDATED"
                  ? "Update Genesys"
                  : "Push to Genesys"}
              </button>
            </>
          )
        }
      />
      <ErrorNotice error={error} />
      {message && <div className="admin-success">{message}</div>}
      {payload && (
        <Modal title="Genesys Payload" onClose={() => setPayload(null)}>
          <pre className="payload-preview">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </Modal>
      )}
      {policy && (
        <div className="detail-admin-grid">
          <div className="admin-panel">
            <h2>Policy information</h2>
            <div className="info-grid">
              {[
                [
                  "Customers",
                  policy.customer
                    ? `${policy.customer.firstName} ${policy.customer.lastName}`
                    : policy.customerId,
                ],
                ["Products", policy.product?.productName || policy.productId],
                ["Vehicle", `${policy.vehicle.brand} ${policy.vehicle.model}`],
                ["Registration", policy.vehicle.licensePlate],
                ["Start date", dateText(policy.effectiveDate)],
                ["Expiry date", dateText(policy.expiryDate)],
                ["Days remaining", `${policy.daysUntilExpiry} days`],
                ["Premium", money(policy.premium)],
                ["Sum insured", money(policy.sumInsured)],
                ["Channel", policy.preferredChannel],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="admin-panel">
            <h2>Status</h2>
            <div className="status-stack">
              <div>
                Renewal <Badge value={policy.renewalStatus} />
              </div>
              <div>
                Genesys <Badge value={policy.genesys.syncStatus} />
              </div>
              <div>
                Called <b>{policy.voiceCalled ? "Yes" : "No"}</b>
              </div>
              <div>
                Digital sent <b>{policy.digitalSent ? "Yes" : "No"}</b>
              </div>
              <div>
                Last sync{" "}
                <b>
                  {policy.genesys.lastSyncAt
                    ? dateText(policy.genesys.lastSyncAt)
                    : "—"}
                </b>
              </div>
              {policy.genesys.lastSyncError && (
                <p className="admin-error">{policy.genesys.lastSyncError}</p>
              )}
            </div>
          </div>
        </div>
      )}
      {editing && policy && (
        <PolicyForm
          item={policy}
          onClose={() => setEditing(false)}
          onSaved={load}
        />
      )}
    </>
  );
}

type Preview = {
  rows: {
    contact: Record<string, string>;
    policy: Policy;
    customer: Customer;
    eligibility: string;
  }[];
  summary: Record<string, number>;
};

const blankFilters: CampaignFilters = { excludeDnc: true };

function Campaigns() {
  const [campaigns, setCampaigns] = useState<CampaignList[]>([]);
  const [meta, setMeta] = useState<{ products: Product[] } | null>(null);
  const [selected, setSelected] = useState<CampaignList | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [filters, setFilters] = useState<CampaignFilters>(blankFilters);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [failedResults, setFailedResults] = useState<SyncResult[]>([]);
  const load = () =>
    api<{ items: CampaignList[] }>(`${base}/campaigns`)
      .then((value) => setCampaigns(value.items))
      .catch((reason) => setError(reason.message));
  useEffect(() => {
    void load();
    api<{ products: Product[] }>(`${base}/meta`)
      .then(setMeta)
      .catch(() => undefined);
  }, []);
  function select(item: CampaignList | null) {
    setSelected(item);
    setName(item?.name || "");
    setDescription(item?.description || "");
    setFilters(item?.filters || blankFilters);
    setPreview(null);
    setSelectedIds([]);
    setError("");
    setMessage("");
  }
  function filter<K extends keyof CampaignFilters>(
    key: K,
    value: CampaignFilters[K],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPreview(null);
  }
  async function showPreview() {
    setBusy(true);
    setError("");
    try {
      const result = await api<Preview>(`${base}/campaigns/preview`, {
        method: "POST",
        body: JSON.stringify({ filters }),
      });
      setPreview(result);
      setSelectedIds(
        result.rows
          .filter((row) => row.eligibility === "ELIGIBLE")
          .map((row) => row.policy.policyId),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!name.trim()) {
      setError("Enter a campaign name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const item = await api<CampaignList>(
        `${base}/campaigns${selected ? `/${selected.campaignListId}` : ""}`,
        {
          method: selected ? "PUT" : "POST",
          body: JSON.stringify({ name, description, filters }),
        },
      );
      setSelected(item);
      setMessage("Campaign saved");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!selected || !window.confirm(`Delete campaign ${selected.name}?`))
      return;
    try {
      await api(`${base}/campaigns/${selected.campaignListId}`, {
        method: "DELETE",
      });
      select(null);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  async function exportCsv() {
    if (!selected) {
      setError("Save the campaign before exporting");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${base}/campaigns/${selected.campaignListId}/export`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedIds }),
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).message || "Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] || "genesys-contacts.csv";
      link.click();
      URL.revokeObjectURL(url);
      setMessage("CSV downloaded");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync(ids = selectedIds) {
    if (
      !ids.length ||
      !window.confirm(`Sync ${ids.length} records to Genesys?`)
    )
      return;
    setBusy(true);
    setProgress(`Syncing 0 / ${ids.length}`);
    setError("");
    setFailedResults([]);
    try {
      const result = await syncInBatches(
        ids,
        selected?.campaignListId,
        (processed, total) => setProgress(`Syncing ${processed} / ${total}`),
      );
      const successful = result.filter((item) =>
        ["SYNCED", "ALREADY_SYNCED"].includes(item.status),
      ).length;
      const failed = result.filter(
        (item) => !["SYNCED", "ALREADY_SYNCED"].includes(item.status),
      );
      setFailedResults(failed);
      setMessage(
        `Processed ${result.length} · Completed ${successful} · Failed ${failed.length}`,
      );
      await showPreview();
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  return (
    <>
      <PageHead
        eyebrow="Renewal & Campaign"
        title="Customer campaigns"
        description="Segment customers, check eligibility, and sync contacts to Genesys"
        action={
          <button className="admin-primary" onClick={() => select(null)}>
            <Plus size={17} /> Create campaign
          </button>
        }
      />
      <ErrorNotice error={error} />
      {message && <div className="admin-success">{message}</div>}
      {progress && <div className="admin-progress">{progress}</div>}
      {failedResults.length > 0 && (
        <div className="admin-error">
          <b>Failed records</b>
          {failedResults.map((item) => (
            <div key={item.policyId}>
              {item.policyId}: {item.message}
            </div>
          ))}
          <button
            className="admin-secondary"
            disabled={busy}
            onClick={() => sync(failedResults.map((item) => item.policyId))}
          >
            Retry
          </button>
        </div>
      )}
      <div className="campaign-layout">
        <aside className="campaign-list">
          <h2>Campaign lists</h2>
          {campaigns.map((item) => (
            <button
              key={item.campaignListId}
              className={
                selected?.campaignListId === item.campaignListId ? "active" : ""
              }
              onClick={() => select(item)}
            >
              <b>{item.name}</b>
              <small>
                {item.recordCount} records · {dateText(item.updatedAt)}
              </small>
            </button>
          ))}
          {!campaigns.length && <Empty />}
        </aside>
        <div className="campaign-editor">
          <div className="admin-panel">
            <div className="panel-head">
              <h2>{selected ? "Edit campaign" : "New campaign"}</h2>
              {selected && (
                <button className="danger-link" onClick={remove}>
                  <Trash2 size={15} /> Delete
                </button>
              )}
            </div>
            <div className="admin-form-grid">
              <label className="wide">
                Campaign name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Policies expiring in 30 days"
                />
              </label>
              <label className="wide">
                Details
                <textarea
                  rows={2}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>
            <div className="form-section-label">Filters</div>
            <div className="admin-form-grid">
              <label>
                Products
                <select
                  value={filters.productId || ""}
                  onChange={(event) =>
                    filter("productId", event.target.value || undefined)
                  }
                >
                  <option value="">All products</option>
                  {meta?.products.map((item) => (
                    <option key={item.productId} value={item.productId}>
                      {item.productName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Vehicle type
                <select
                  value={filters.vehicleType || ""}
                  onChange={(event) =>
                    filter("vehicleType", event.target.value || undefined)
                  }
                >
                  <option value="">All</option>
                  <option value="CAR">Car</option>
                  <option value="MOTORCYCLE">Motorcycle</option>
                </select>
              </label>
              <label>
                Insurance class
                <select
                  value={filters.insuranceClass || ""}
                  onChange={(event) =>
                    filter("insuranceClass", event.target.value || undefined)
                  }
                >
                  <option value="">All classes</option>
                  {[
                    ...new Set(
                      meta?.products.map((item) => item.insuranceClass) || [],
                    ),
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Vehicle brand
                <input
                  value={filters.vehicleBrand || ""}
                  onChange={(event) =>
                    filter("vehicleBrand", event.target.value || undefined)
                  }
                />
              </label>
              <label>
                Insurer
                <input
                  value={filters.insurerName || ""}
                  onChange={(event) =>
                    filter("insurerName", event.target.value || undefined)
                  }
                />
              </label>
              <label>
                StatusRenewals
                <select
                  value={filters.renewalStatus || ""}
                  onChange={(event) =>
                    filter("renewalStatus", event.target.value || undefined)
                  }
                >
                  <option value="">All statuses</option>
                  {statuses.map((item) => (
                    <option key={item} value={item}>
                      {statusLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Channel
                <select
                  value={filters.preferredChannel || ""}
                  onChange={(event) =>
                    filter("preferredChannel", event.target.value || undefined)
                  }
                >
                  <option value="">All channels</option>
                  {channels.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Expiry date from
                <input
                  type="date"
                  value={filters.expiryFrom || ""}
                  onChange={(event) =>
                    filter("expiryFrom", event.target.value || undefined)
                  }
                />
              </label>
              <label>
                To date
                <input
                  type="date"
                  value={filters.expiryTo || ""}
                  onChange={(event) =>
                    filter("expiryTo", event.target.value || undefined)
                  }
                />
              </label>
              <label>
                Days until expiry from
                <input
                  type="number"
                  value={filters.daysFrom ?? ""}
                  onChange={(event) =>
                    filter(
                      "daysFrom",
                      event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    )
                  }
                />
              </label>
              <label>
                to
                <input
                  type="number"
                  value={filters.daysTo ?? ""}
                  onChange={(event) =>
                    filter(
                      "daysTo",
                      event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    )
                  }
                />
              </label>
              <label>
                Minimum premium
                <input
                  type="number"
                  value={filters.premiumFrom ?? ""}
                  onChange={(event) =>
                    filter(
                      "premiumFrom",
                      event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    )
                  }
                />
              </label>
              <label>
                Maximum premium
                <input
                  type="number"
                  value={filters.premiumTo ?? ""}
                  onChange={(event) =>
                    filter(
                      "premiumTo",
                      event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    )
                  }
                />
              </label>
              <label>
                Province
                <input
                  value={filters.province || ""}
                  onChange={(event) =>
                    filter("province", event.target.value || undefined)
                  }
                />
              </label>
              <label>
                Genesys status
                <select
                  value={filters.genesysStatus || ""}
                  onChange={(event) =>
                    filter("genesysStatus", event.target.value || undefined)
                  }
                >
                  <option value="">All statuses</option>
                  {["NOT_SYNCED", "SYNCED", "OUTDATED", "FAILED"].map(
                    (item) => (
                      <option key={item}>{item}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Digital sent
                <select
                  value={
                    filters.digitalSent === undefined
                      ? ""
                      : String(filters.digitalSent)
                  }
                  onChange={(event) =>
                    filter(
                      "digitalSent",
                      event.target.value === ""
                        ? undefined
                        : event.target.value === "true",
                    )
                  }
                >
                  <option value="">All</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label>
                Called
                <select
                  value={
                    filters.voiceCalled === undefined
                      ? ""
                      : String(filters.voiceCalled)
                  }
                  onChange={(event) =>
                    filter(
                      "voiceCalled",
                      event.target.value === ""
                        ? undefined
                        : event.target.value === "true",
                    )
                  }
                >
                  <option value="">All</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label>
                Customer interest
                <select
                  value={filters.customerIntent || ""}
                  onChange={(event) =>
                    filter("customerIntent", event.target.value || undefined)
                  }
                >
                  <option value="">All</option>
                  {[
                    "UNKNOWN",
                    "INTERESTED",
                    "NOT_INTERESTED",
                    "CALLBACK",
                    "RENEWED",
                    "WRONG_NUMBER",
                    "NO_ANSWER",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={filters.excludeDnc !== false}
                onChange={(event) => filter("excludeDnc", event.target.checked)}
              />{" "}
              Exclude DNC customers
            </label>
            <div className="form-actions">
              <button
                className="admin-secondary"
                disabled={busy}
                onClick={showPreview}
              >
                <Search size={16} /> Preview
              </button>
              <button className="admin-primary" disabled={busy} onClick={save}>
                <Save size={16} /> Save campaign
              </button>
            </div>
          </div>
          {preview && (
            <div className="admin-panel campaign-preview">
              <div className="panel-head">
                <h2>Contact preview</h2>
                <span>{selectedIds.length} selected</span>
              </div>
              <div className="preview-stats">
                {[
                  ["Matched", preview.summary.matched],
                  ["Eligible", preview.summary.eligible],
                  ["DNC", preview.summary.dncExcluded],
                  ["Invalid phone", preview.summary.invalidPhone],
                  ["Duplicate phone", preview.summary.duplicatePhone],
                  ["Synced", preview.summary.alreadySynced],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <b>{value}</b>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Customers</th>
                      <th>Policy number</th>
                      <th>Phone</th>
                      <th>Expiry date</th>
                      <th>Eligibility</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.policy.policyId}>
                        <td>
                          <input
                            type="checkbox"
                            disabled={row.eligibility !== "ELIGIBLE"}
                            checked={selectedIds.includes(row.policy.policyId)}
                            onChange={(event) =>
                              setSelectedIds((current) =>
                                event.target.checked
                                  ? [...current, row.policy.policyId]
                                  : current.filter(
                                      (id) => id !== row.policy.policyId,
                                    ),
                              )
                            }
                          />
                        </td>
                        <td>
                          {row.customer.firstName} {row.customer.lastName}
                        </td>
                        <td>{row.policy.policyNumber}</td>
                        <td>{row.contact.phone}</td>
                        <td>{dateText(row.policy.expiryDate)}</td>
                        <td>
                          <Badge value={row.eligibility} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button
                  className="admin-secondary"
                  disabled={!selectedIds.length || busy || !selected}
                  onClick={exportCsv}
                >
                  <ArrowDownToLine size={16} /> Export CSV
                </button>
                <button
                  className="admin-primary"
                  disabled={!selectedIds.length || busy}
                  onClick={() => sync()}
                >
                  <CloudUpload size={16} /> Sync to Genesys
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SystemSettings() {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [backup, setBackup] = useState<{
    directory: string;
    files: string[];
    downloadUrl: string;
  } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  async function makeBackup() {
    setBusy(true);
    setError("");
    try {
      const result = await api<typeof backup>(`${base}/settings/backup`, {
        method: "POST",
      });
      setBackup(result);
      setMessage("Backup created");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (
      confirm !== "RESET" ||
      !window.confirm("Reset demo data? A backup will be created first.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`${base}/settings/reset-demo`, {
        method: "POST",
        body: JSON.stringify({ confirmation: "RESET" }),
      });
      setMessage("Demo data reset");
      setConfirm("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead
        eyebrow="System"
        title="System settings"
        description="Manage the administrator account and demo data"
      />
      <ErrorNotice error={error} />
      {message && <div className="admin-success">{message}</div>}
      <div className="settings-grid">
        <PasswordSettings />
        <section className="admin-panel">
          <DatabaseBackup size={28} />
          <h2>Backup data</h2>
          <p>
            Create a JSON backup of customers, policies, campaigns, and
            configuration.
          </p>
          <button
            className="admin-primary"
            disabled={busy}
            onClick={makeBackup}
          >
            <DatabaseBackup size={16} /> Create backup
          </button>
          {backup && (
            <div className="backup-result">
              <b>{backup.directory}</b>
              <small>{backup.files.length} files</small>
              <a href={backup.downloadUrl}>
                <ArrowDownToLine size={16} /> Download JSON
              </a>
            </div>
          )}
        </section>
        <section className="admin-panel">
          <RefreshCw size={28} />
          <h2>Reset demo data</h2>
          <p>
            The system backs up current data before restoring the original demo
            records. Genesys settings will be preserved
          </p>
          <label>
            Type RESET to confirm
            <input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          <button
            className="admin-danger"
            disabled={confirm !== "RESET" || busy}
            onClick={reset}
          >
            <Trash2 size={16} /> Reset data
          </button>
        </section>
      </div>
    </>
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
function GlobalSearch() {
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{
    customers: Customer[];
    policies: Policy[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (search.trim().length >= 2)
        api<{ customers: Customer[]; policies: Policy[] }>(
          base + "/search?q=" + encodeURIComponent(search),
        )
          .then((value) => {
            if (active) setResult(value);
          })
          .catch(() => {
            if (active) setResult(null);
          });
      else setResult(null);
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);
  return (
    <div className="admin-global-search">
      <Search size={17} />
      <input
        aria-label="Search"
        placeholder="Search customers, policies, registration plates"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {result && (
        <div className="search-popover">
          <b>Customers</b>
          {result.customers.map((item) => (
            <a key={item.customerId} href={"/customers/" + item.customerId}>
              {item.firstName} {item.lastName}
              <small>{item.customerId}</small>
            </a>
          ))}
          <b>Policies</b>
          {result.policies.map((item) => (
            <a key={item.policyId} href={"/policies/" + item.policyId}>
              {item.policyNumber}
              <small>{item.vehicle.licensePlate}</small>
            </a>
          ))}
          {!result.customers.length && !result.policies.length && (
            <span>No records found</span>
          )}
        </div>
      )}
    </div>
  );
}
