import { useEffect, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  Search,
  Settings,
  X,
} from "lucide-react";
import { api } from "./lib/api";
import type { ImportJob } from "../server/domain/pipeline-types";

const pages = [
  ["Dashboard", "/"],
  ["Contact List Templates", "/templates"],
  ["Source Integration", "/sources"],
  ["Source Mapping", "/mappings"],
  ["Lead Configuration", "/leads"],
  ["Region Management", "/regions"],
  ["Integration Settings", "/integration"],
  ["Manual Import", "/manual-import"],
  ["Schedule Import", "/schedule-import"],
  ["System settings", "/settings"],
];
export function LeadSyncHeader({
  username,
  onMenu,
  onLogout,
}: {
  username: string;
  onMenu: () => void;
  onLogout: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [panel, setPanel] = useState("");
  const [connection, setConnection] = useState("Checking");
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [records, setRecords] = useState<{ label: string; url: string }[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void api<{
        config?: { lastConnectionStatus?: string };
        lastConnectionStatus?: string;
      }>("/api/admin/genesys/config")
        .then((value) => {
          if (active) {
            const status = (
              value.config?.lastConnectionStatus ||
              value.lastConnectionStatus ||
              ""
            ).toUpperCase();
            setConnection(
              ["CONNECTED", "SUCCESS", "OK"].includes(status)
                ? "Connected"
                : status === "FAILED"
                  ? "Check connection"
                  : "Not tested",
            );
          }
        })
        .catch(() => {
          if (active) setConnection("Unavailable");
        });
      void api<{
        jobs: ImportJob[];
        sources: { name: string }[];
        leads: { name: string }[];
        templates: { name: string }[];
      }>("/api/admin/pipeline/bootstrap")
        .then((value) => {
          if (active) {
            setJobs(value.jobs);
            setRecords([
              ...value.sources.map((item) => ({
                label: item.name,
                url: "/sources",
              })),
              ...value.leads.map((item) => ({
                label: item.name,
                url: "/leads",
              })),
              ...value.templates.map((item) => ({
                label: item.name,
                url: "/templates",
              })),
            ]);
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!panel) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel("");
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [panel]);
  const results = [...pages.map(([label, url]) => ({ label, url })), ...records]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);
  return (
    <header className="ls-topbar">
      <button
        className="ls-menu-toggle"
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <Menu size={22} />
      </button>
      <a className="ls-wordmark" href="/" aria-label="MFEC LeadSync dashboard">
        <img src="/images/leadsync-wordmark.png" alt="MFEC LeadSync" />
      </a>
      <div className="ls-global-search">
        <Search size={18} />
        <input
          aria-label="Search workspace"
          placeholder="Search anything…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {query && (
          <button aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={15} />
          </button>
        )}
        {focused && query && (
          <div className="ls-search-results">
            {results.length ? (
              results.map((item, index) => (
                <a href={item.url} key={item.url + index}>
                  {item.label}
                  <ChevronRight size={14} />
                </a>
              ))
            ) : (
              <p>No matching pages or configurations.</p>
            )}
          </div>
        )}
      </div>
      <a
        href="/integration"
        className={`ls-connection ${connection === "Connected" ? "connected" : ""}`}
      >
        <span className="ls-status-dot" />
        <b>Genesys Cloud</b>
        <small>{connection}</small>
      </a>
      <div className="ls-header-action">
        <button
          className="ls-notification"
          aria-label="Recent import notifications"
          aria-expanded={panel === "notifications"}
          onClick={() =>
            setPanel(panel === "notifications" ? "" : "notifications")
          }
        >
          <Bell size={22} />
          {jobs.some(
            (job) => job.status === "FAILED" || job.status === "PARTIAL",
          ) && <span />}
        </button>
        {panel === "notifications" && (
          <div className="ls-header-popover">
            <h3>Recent imports</h3>
            {!jobs.length ? (
              <p>No import activity yet.</p>
            ) : (
              jobs.slice(0, 4).map((job) => (
                <a href="/manual-import" key={job.id}>
                  <strong>{job.leadName}</strong>
                  <small>
                    {job.status} · {job.processed} records
                  </small>
                </a>
              ))
            )}
            <a href="/schedule-import">
              View schedules
              <ChevronRight size={14} />
            </a>
          </div>
        )}
      </div>
      <div className="ls-header-action">
        <button
          className="ls-user-menu"
          aria-label="Account menu"
          aria-expanded={panel === "account"}
          onClick={() => setPanel(panel === "account" ? "" : "account")}
        >
          <span>{username.slice(0, 2).toUpperCase()}</span>
          <b>{username}</b>
          <ChevronDown size={15} />
        </button>
        {panel === "account" && (
          <div className="ls-header-popover ls-account-popover">
            <a href="/settings">
              <Settings size={16} />
              System settings
            </a>
            <button onClick={() => void onLogout()}>
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
