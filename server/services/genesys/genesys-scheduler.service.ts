import { buildPreview } from "../../domain/campaign-contact";
import { httpError } from "../../domain/business";
import {
  audit,
  campaigns,
  customers,
  genesysScheduleTasks,
  nextId,
  policies,
  products,
} from "../../domain/store";
import type {
  GenesysScheduleFrequency,
  GenesysScheduleTask,
} from "../../domain/types";
import { bulkSyncPolicies } from "./genesys-sync.service";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_SYNC_BATCH = 100;

export type GenesysScheduleInput = {
  name: string;
  campaignListId: string;
  frequency: GenesysScheduleFrequency;
  time: string;
  date?: string;
  dayOfWeek?: number;
  enabled: boolean;
};

function localClock(date: Date): Date {
  return new Date(date.getTime() + BANGKOK_OFFSET_MS);
}

function fromBangkokParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - BANGKOK_OFFSET_MS);
}

function timeParts(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  return [hour, minute];
}

export function nextGenesysRunAt(
  schedule: Pick<
    GenesysScheduleInput,
    "frequency" | "time" | "date" | "dayOfWeek"
  >,
  after = new Date(),
): string {
  const [hour, minute] = timeParts(schedule.time);
  if (schedule.frequency === "ONCE") {
    if (!schedule.date) return "";
    const [year, month, day] = schedule.date.split("-").map(Number);
    const candidate = fromBangkokParts(year, month - 1, day, hour, minute);
    return candidate.getTime() > after.getTime() ? candidate.toISOString() : "";
  }

  const local = localClock(after);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  let daysAhead = 0;
  if (schedule.frequency === "WEEKLY") {
    daysAhead = ((schedule.dayOfWeek ?? 0) - local.getUTCDay() + 7) % 7;
  }
  let candidate = fromBangkokParts(year, month, day + daysAhead, hour, minute);
  if (candidate.getTime() <= after.getTime()) {
    candidate = fromBangkokParts(
      year,
      month,
      day + (schedule.frequency === "DAILY" ? 1 : daysAhead + 7),
      hour,
      minute,
    );
  }
  return candidate.toISOString();
}

export class GenesysSchedulerService {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly running = new Set<string>();

  async start(): Promise<void> {
    await genesysScheduleTasks.initialize();
    await genesysScheduleTasks.mutate((rows) => {
      const now = new Date();
      for (const task of rows) {
        if (task.lastRunStatus === "RUNNING") {
          task.lastRunStatus = "FAILED";
          task.lastRunMessage = "Interrupted by server restart";
        }
        if (task.enabled && !task.nextRunAt) {
          task.nextRunAt = nextGenesysRunAt(task, now);
          if (!task.nextRunAt && task.frequency === "ONCE")
            task.enabled = false;
        }
      }
    });
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async list(): Promise<GenesysScheduleTask[]> {
    return (await genesysScheduleTasks.all()).sort((a, b) =>
      (a.nextRunAt || "9999").localeCompare(b.nextRunAt || "9999"),
    );
  }

  async create(
    input: GenesysScheduleInput,
    actor: string,
  ): Promise<GenesysScheduleTask> {
    await this.assertCampaign(input.campaignListId);
    const now = new Date();
    const nextRunAt = input.enabled ? nextGenesysRunAt(input, now) : "";
    if (input.enabled && !nextRunAt)
      throw httpError(400, "The one-time schedule must be in the future");
    const task = await genesysScheduleTasks.mutate((rows) => {
      const timestamp = now.toISOString();
      const item: GenesysScheduleTask = {
        schedulerTaskId: nextId("SCHED", rows, "schedulerTaskId"),
        ...input,
        date: input.frequency === "ONCE" ? input.date : undefined,
        dayOfWeek: input.frequency === "WEEKLY" ? input.dayOfWeek : undefined,
        nextRunAt,
        lastRunAt: "",
        lastRunStatus: "NEVER",
        lastRunMessage: "",
        lastRunSummary: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      rows.push(item);
      return item;
    });
    await audit("CREATE_GENESYS_SCHEDULE", actor, task.schedulerTaskId, {
      campaignListId: task.campaignListId,
      frequency: task.frequency,
    });
    return task;
  }

  async update(
    id: string,
    input: GenesysScheduleInput,
    actor: string,
  ): Promise<GenesysScheduleTask> {
    if (this.running.has(id))
      throw httpError(409, "This scheduler task is currently running");
    await this.assertCampaign(input.campaignListId);
    const now = new Date();
    const nextRunAt = input.enabled ? nextGenesysRunAt(input, now) : "";
    if (input.enabled && !nextRunAt)
      throw httpError(400, "The one-time schedule must be in the future");
    const task = await genesysScheduleTasks.mutate((rows) => {
      const item = rows.find((row) => row.schedulerTaskId === id);
      if (!item) throw httpError(404, "Scheduler task not found");
      Object.assign(item, input, {
        date: input.frequency === "ONCE" ? input.date : undefined,
        dayOfWeek: input.frequency === "WEEKLY" ? input.dayOfWeek : undefined,
        nextRunAt,
        updatedAt: now.toISOString(),
      });
      return item;
    });
    await audit("UPDATE_GENESYS_SCHEDULE", actor, id, {
      campaignListId: task.campaignListId,
      enabled: task.enabled,
    });
    return task;
  }

  async delete(id: string, actor: string): Promise<void> {
    if (this.running.has(id))
      throw httpError(409, "This scheduler task is currently running");
    await genesysScheduleTasks.mutate((rows) => {
      const index = rows.findIndex((row) => row.schedulerTaskId === id);
      if (index < 0) throw httpError(404, "Scheduler task not found");
      rows.splice(index, 1);
    }, true);
    await audit("DELETE_GENESYS_SCHEDULE", actor, id);
  }

  async run(id: string, actor: string): Promise<GenesysScheduleTask> {
    if (this.running.has(id))
      throw httpError(409, "This scheduler task is already running");
    const task = await genesysScheduleTasks.findById("schedulerTaskId", id);
    if (!task) throw httpError(404, "Scheduler task not found");
    this.running.add(id);
    const startedAt = new Date();
    await genesysScheduleTasks.mutate((rows) => {
      const current = rows.find((row) => row.schedulerTaskId === id);
      if (current) {
        current.lastRunStatus = "RUNNING";
        current.lastRunMessage = "Synchronization in progress";
        current.lastRunAt = startedAt.toISOString();
        current.updatedAt = startedAt.toISOString();
      }
    });

    try {
      const campaign = await this.assertCampaign(task.campaignListId);
      const [allPolicies, allCustomers, allProducts] = await Promise.all([
        policies.all(),
        customers.all(),
        products.all(),
      ]);
      const preview = buildPreview(
        allPolicies,
        allCustomers,
        allProducts,
        campaign.filters,
      );
      const policyIds = preview.rows
        .filter((row) => row.eligibility === "ELIGIBLE")
        .map((row) => row.policy.policyId);
      let successful = 0;
      let failed = 0;
      for (let index = 0; index < policyIds.length; index += MAX_SYNC_BATCH) {
        const result = await bulkSyncPolicies(
          policyIds.slice(index, index + MAX_SYNC_BATCH),
          `scheduler:${task.name}`,
          task.campaignListId,
        );
        successful += result.successful;
        failed += result.failed;
      }
      const completedAt = new Date();
      const status = failed > 0 ? "PARTIAL" : "SUCCESS";
      const message = policyIds.length
        ? `${successful} of ${policyIds.length} contacts synchronized`
        : "No eligible contacts found";
      const updated = await genesysScheduleTasks.mutate((rows) => {
        const current = rows.find((row) => row.schedulerTaskId === id);
        if (!current) throw httpError(404, "Scheduler task not found");
        current.lastRunStatus = status;
        current.lastRunMessage = message;
        current.lastRunAt = completedAt.toISOString();
        current.lastRunSummary = {
          matched: preview.summary.matched,
          eligible: preview.summary.eligible,
          processed: policyIds.length,
          successful,
          failed,
        };
        this.advance(current, completedAt);
        return current;
      });
      await audit("RUN_GENESYS_SCHEDULE", actor, id, {
        campaignListId: task.campaignListId,
        processed: policyIds.length,
        successful,
        failed,
      });
      return updated;
    } catch (error) {
      const completedAt = new Date();
      const message =
        error instanceof Error ? error.message : "Scheduled sync failed";
      await genesysScheduleTasks.mutate((rows) => {
        const current = rows.find((row) => row.schedulerTaskId === id);
        if (current) {
          current.lastRunStatus = "FAILED";
          current.lastRunMessage = message.slice(0, 500);
          current.lastRunAt = completedAt.toISOString();
          current.lastRunSummary = null;
          this.advance(current, completedAt);
        }
      });
      await audit("GENESYS_SCHEDULE_FAILED", actor, id, {
        error: message.slice(0, 300),
      });
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  private advance(task: GenesysScheduleTask, after: Date): void {
    if (task.frequency === "ONCE") {
      task.enabled = false;
      task.nextRunAt = "";
    } else {
      task.nextRunAt = task.enabled ? nextGenesysRunAt(task, after) : "";
    }
    task.updatedAt = after.toISOString();
  }

  private async assertCampaign(campaignListId: string) {
    const campaign = await campaigns.findById("campaignListId", campaignListId);
    if (!campaign) throw httpError(404, "Source campaign not found");
    return campaign;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = (await genesysScheduleTasks.all()).filter(
        (task) =>
          task.enabled &&
          task.nextRunAt &&
          new Date(task.nextRunAt).getTime() <= now,
      );
      for (const task of due) {
        try {
          await this.run(task.schedulerTaskId, "scheduler");
        } catch (error) {
          console.error(
            `Genesys scheduler task ${task.schedulerTaskId} failed:`,
            error,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export const genesysSchedulerService = new GenesysSchedulerService();
