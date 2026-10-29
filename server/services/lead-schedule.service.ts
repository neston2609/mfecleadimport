import { z } from "zod";
import {
  importSchedules,
  leadDefinitions,
  sourceIntegrations,
  sourceMappings,
} from "../domain/pipeline-store";
import { configuredContactList } from "./contact-list.service";
import type { ImportSchedule } from "../domain/pipeline-types";
import { httpError } from "../domain/business";
import { entity, saveEntity } from "./lead-pipeline.service";
import {
  startImport,
  awaitImport,
  hasActiveImport,
} from "./lead-import.service";
import { audit } from "../domain/store";

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    leadId: z.string().uuid(),
    contactListId: z.string().min(1).max(200),
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "MONTH_DAYS"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    dayOfWeek: z.number().int().min(0).max(6).default(1),
    dayOfMonth: z.number().int().min(1).max(31).default(1),
    monthDays: z.array(z.number().int().min(1).max(31)).max(31).default([]),
    enabled: z.boolean(),
  })
  .refine(
    (value) => value.frequency !== "MONTH_DAYS" || value.monthDays.length > 0,
    "Choose at least one day of the month",
  );
export function nextLeadRun(
  input: Pick<
    ImportSchedule,
    "frequency" | "time" | "dayOfWeek" | "dayOfMonth" | "monthDays"
  >,
  after = new Date(),
) {
  const local = new Date(after.getTime() + 7 * 3600000);
  const [hour, minute] = input.time.split(":").map(Number);
  for (let ahead = 0; ahead < 400; ahead++) {
    const day = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + ahead,
        hour,
        minute,
      ),
    );
    if (input.frequency === "WEEKLY" && day.getUTCDay() !== input.dayOfWeek)
      continue;
    if (input.frequency === "MONTHLY" && day.getUTCDate() !== input.dayOfMonth)
      continue;
    if (
      input.frequency === "MONTH_DAYS" &&
      !input.monthDays.includes(day.getUTCDate())
    )
      continue;
    const result = new Date(day.getTime() - 7 * 3600000);
    if (result > after) return result.toISOString();
  }
  throw httpError(400, "No future date matches this schedule");
}
const runningSchedules = new Set<string>();
export async function saveSchedule(input: unknown, actor: string, id?: string) {
  if (id && runningSchedules.has(id))
    throw httpError(409, "Schedule is currently running");
  const data = scheduleInput.parse(input);
  const lead = await entity(leadDefinitions, data.leadId);
  const mapping = await entity(sourceMappings, lead.mappingId);
  const source = await entity(sourceIntegrations, mapping.sourceId);
  if (["CSV", "JSON"].includes(source.kind)) {
    const localFile =
      (source.config.fileLocation === "SERVER" ||
        (!source.config.fileLocation && !source.config.fileId)) &&
      source.config.serverPath;
    const remoteFile =
      source.config.fileLocation === "REMOTE" &&
      source.config.host &&
      source.config.remotePath &&
      source.config.transferProtocol;
    if (!localFile && !remoteFile)
      throw httpError(
        400,
        "Schedule Import requires a Local (Server) or Remote file source. Browser-upload files are not supported.",
      );
  }
  if (data.contactListId !== mapping.contactListId)
    throw httpError(
      400,
      "Select the Genesys Contact List configured in this lead's Source Mapping.",
    );
  await configuredContactList(data.contactListId);
  const previous = id ? await entity(importSchedules, id) : undefined;
  const saved = await saveEntity(
    importSchedules,
    {
      ...data,
      monthDays: [...new Set(data.monthDays)].sort((a, b) => a - b),
      nextRunAt: data.enabled ? nextLeadRun(data) : "",
      lastRunAt: previous?.lastRunAt || "",
      lastStatus: previous?.lastStatus || "NEVER",
      lastMessage: previous?.lastMessage || "",
      lastJobId: previous?.lastJobId || "",
    },
    id,
  );
  await audit("SAVE_LEAD_IMPORT_SCHEDULE", actor, saved.id);
  return saved;
}
export async function runSchedule(id: string, actor: string) {
  if (runningSchedules.has(id))
    throw httpError(409, "This schedule is running");
  if (hasActiveImport()) throw httpError(409, "Another import is running");
  const schedule = await entity(importSchedules, id);
  const lead = await entity(leadDefinitions, schedule.leadId);
  const mapping = await entity(sourceMappings, lead.mappingId);
  const source = await entity(sourceIntegrations, mapping.sourceId);
  if (["CSV", "JSON"].includes(source.kind)) {
    const localFile =
      (source.config.fileLocation === "SERVER" ||
        (!source.config.fileLocation && !source.config.fileId)) &&
      source.config.serverPath;
    const remoteFile =
      source.config.fileLocation === "REMOTE" &&
      source.config.host &&
      source.config.remotePath &&
      source.config.transferProtocol;
    if (!localFile && !remoteFile)
      throw httpError(
        400,
        "Scheduled file imports require a configured Local (Server) or Remote source.",
      );
  }
  runningSchedules.add(id);
  try {
    const job = await startImport(
      { leadId: schedule.leadId, contactListId: schedule.contactListId },
      actor,
      id,
    );
    await importSchedules.mutate((rows) => {
      const item = rows.find((row) => row.id === id);
      if (item) {
        item.lastStatus = "RUNNING";
        item.lastJobId = job.id;
        item.lastRunAt = new Date().toISOString();
      }
    });
    const completed = await awaitImport(job.id);
    await importSchedules.mutate((rows) => {
      const item = rows.find((row) => row.id === id);
      if (item) {
        item.lastStatus = completed.status;
        item.lastMessage = completed.message;
        item.nextRunAt = item.enabled ? nextLeadRun(item) : "";
        item.updatedAt = new Date().toISOString();
      }
    });
    return completed;
  } catch (error) {
    await importSchedules.mutate((rows) => {
      const item = rows.find((row) => row.id === id);
      if (item) {
        item.lastStatus = "FAILED";
        item.lastMessage = (error as Error).message.slice(0, 500);
        item.lastRunAt = new Date().toISOString();
        item.nextRunAt = item.enabled ? nextLeadRun(item) : "";
      }
    });
    throw error;
  } finally {
    runningSchedules.delete(id);
  }
}
export async function deleteSchedule(id: string, actor: string) {
  if (runningSchedules.has(id)) throw httpError(409, "Schedule is running");
  await importSchedules.mutate((rows) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw httpError(404, "Schedule not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_LEAD_IMPORT_SCHEDULE", actor, id);
}
let ticking = false;
export async function tickLeadSchedules() {
  if (ticking || hasActiveImport()) return;
  ticking = true;
  try {
    const due = (await importSchedules.all()).filter(
      (item) =>
        item.enabled &&
        item.nextRunAt &&
        new Date(item.nextRunAt).getTime() <= Date.now(),
    );
    for (const item of due) {
      if (hasActiveImport()) break;
      try {
        await runSchedule(item.id, "scheduler");
      } catch {
        /* Status is persisted by runSchedule. */
      }
    }
  } finally {
    ticking = false;
  }
}
export async function startLeadScheduler() {
  await importSchedules.mutate((rows) => {
    for (const item of rows) {
      if (item.lastStatus === "RUNNING") {
        item.lastStatus = "INTERRUPTED";
        item.lastMessage = "Interrupted by server restart";
        item.nextRunAt = item.enabled ? nextLeadRun(item) : "";
      } else if (item.enabled && !item.nextRunAt)
        item.nextRunAt = nextLeadRun(item);
    }
  });
  const timer = setInterval(
    () =>
      void tickLeadSchedules().catch(() =>
        console.error("Lead scheduler tick failed"),
      ),
    30000,
  );
  timer.unref();
  void tickLeadSchedules();
}
