import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  Check,
  CheckCircle2,
  Clock3,
  CloudUpload,
  Database,
  FileText,
  GitFork,
  Settings,
  Users,
} from "lucide-react";
import type { ImportJob } from "../server/domain/pipeline-types";

type InsightsData = {
  sources: { kind: string }[];
  leads: { id: string }[];
  mappings: { id: string }[];
  jobs: ImportJob[];
};
export function LeadSyncMetrics({
  data,
  eligible,
}: {
  data: InsightsData;
  eligible?: number;
}) {
  const successes = data.jobs.reduce(
    (total, job) => total + job.created + job.updated,
    0,
  );
  const failures = data.jobs.reduce((total, job) => total + job.failed, 0);
  const percent =
    successes + failures
      ? `${((100 * successes) / (successes + failures)).toFixed(1)}%`
      : "—";
  const cards = [
    {
      label: "Active Sources",
      value: data.sources.length,
      icon: Database,
      hint: "Source integrations configured",
      href: "/sources",
    },
    {
      label: "Lead Configurations",
      value: data.leads.length,
      icon: FileText,
      hint: "Reusable lead selections",
      href: "/leads",
    },
    {
      label: "Records Ready",
      value: eligible === undefined ? "—" : eligible.toLocaleString(),
      icon: Users,
      hint:
        eligible === undefined
          ? "Select a lead to preview"
          : "Eligible in current preview",
      href: "#lead-preview",
    },
    {
      label: "Import Success",
      value: percent,
      icon: CheckCircle2,
      hint:
        successes + failures
          ? "From recent import history"
          : "No imports recorded yet",
      href: "#recent-imports",
    },
  ];
  return (
    <div className="ls-metrics">
      {cards.map(({ label, value, icon: Icon, hint, href }) => (
        <a className="ls-metric" key={label} href={href}>
          <span className="ls-metric-icon">
            <Icon size={29} />
          </span>
          <div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>
              {successes + failures && label === "Import Success" ? (
                <Check size={14} />
              ) : null}
              {hint}
            </small>
          </div>
        </a>
      ))}
    </div>
  );
}
export function LeadSyncInsights({
  data,
  contactLists,
}: {
  data: InsightsData;
  contactLists: number;
}) {
  const [days, setDays] = useState(7);
  const dateKey = (date: Date) =>
    date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  const chart = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - 1 - index) * 86400000);
    const key = dateKey(date);
    return {
      date: date.toLocaleDateString("en-GB", {
        timeZone: "Asia/Bangkok",
        day: "numeric",
        month: "short",
      }),
      records: data.jobs
        .filter((job) => dateKey(new Date(job.createdAt)) === key)
        .reduce((total, job) => total + job.created + job.updated, 0),
    };
  });
  return (
    <aside className="ls-insights">
      <section className="ls-insight-card">
        <h2>
          <GitFork size={21} />
          Integration Pipeline
        </h2>
        <div className="ls-pipeline-steps">
          {[
            {
              title: "Data Sources",
              hint: "Multiple sources (DB, API, CSV, JSON)",
              icon: Database,
              ready: data.sources.length > 0,
              href: "/sources",
            },
            {
              title: "Lead Mapping & Filters",
              hint: "Map fields and apply filters",
              icon: Settings,
              ready: data.mappings.length > 0 && data.leads.length > 0,
              href: "/mappings",
            },
            {
              title: "Genesys Cloud",
              hint: contactLists
                ? `${contactLists} contact lists available`
                : "Configure your Genesys connection",
              icon: CloudUpload,
              ready: contactLists > 0,
              href: "/integration",
            },
          ].map(({ title, hint, icon: Icon, ready, href }) => (
            <a className="ls-pipeline-step" href={href} key={title}>
              <span className="ls-step-icon">
                <Icon size={25} />
              </span>
              <div>
                <strong>{title}</strong>
                <small>{hint}</small>
              </div>
              {ready ? (
                <CheckCircle2 className="ls-ready-check" size={18} />
              ) : (
                <span className="ls-step-pending">Pending</span>
              )}
            </a>
          ))}
        </div>
      </section>
      <section className="ls-insight-card" id="recent-imports">
        <h2>
          <Clock3 size={20} />
          Recent Imports<a href="/schedule-import">Schedules</a>
        </h2>
        {data.jobs.length ? (
          <div className="ls-recent-list">
            {data.jobs.slice(0, 3).map((job) => (
              <a href="/manual-import" key={job.id}>
                <CheckCircle2
                  size={20}
                  className={
                    job.status === "SUCCESS"
                      ? "ls-ready-check"
                      : "ls-history-neutral"
                  }
                />
                <div>
                  <strong>{job.leadName}</strong>
                  <small>{job.status.toLowerCase().replaceAll("_", " ")}</small>
                </div>
                <div>
                  <strong>
                    {(job.created + job.updated).toLocaleString()} records
                  </strong>
                  <small>
                    {new Date(job.createdAt).toLocaleDateString("en-GB", {
                      timeZone: "Asia/Bangkok",
                      day: "numeric",
                      month: "short",
                    })}
                  </small>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="ls-history-empty">
            <Clock3 size={24} />
            <strong>Your import history starts here</strong>
            <p>Completed imports and their results will appear here.</p>
          </div>
        )}
      </section>
      <section className="ls-insight-card ls-chart-card">
        <h2>
          <BarChart3 size={20} />
          Daily Imports
          <select
            aria-label="Import chart period"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
          </select>
        </h2>
        <p className="ls-chart-caption">
          Records created or updated · Bangkok time
        </p>
        <div
          className="ls-import-chart"
          role="img"
          aria-label={`${days} day import chart, ${chart.reduce((total, row) => total + row.records, 0)} records imported`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chart}
              margin={{ top: 8, right: 0, left: -28, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--ls-chart-grid)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: "var(--ls-muted)" }}
                tickLine={false}
                axisLine={false}
                interval={days === 7 ? 0 : 2}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10, fill: "var(--ls-muted)" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip cursor={{ fill: "var(--ls-raised)" }} />
              <Bar
                dataKey="records"
                name="Records imported"
                fill="#58a4ff"
                radius={[3, 3, 0, 0]}
                maxBarSize={26}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {!data.jobs.length && (
          <p className="ls-chart-empty">No imports in this period.</p>
        )}
      </section>
    </aside>
  );
}
