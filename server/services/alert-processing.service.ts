import { alertConfigurations, alertEnrichmentRules, alertMappings, receivedAlerts } from "../domain/alert-store";
import type { AlertValue, ReceivedAlert } from "../domain/alert-types";
import { enrichAlertFields } from "./alert-enrichment.service";
import { syncAlert } from "./alert-mapping.service";
import { audit } from "../domain/store";
import { httpError } from "../domain/business";

const inFlight = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let lastTickAt = "";
let processedCount = 0;
let failureCount = 0;

function eligibleMappings(alert: ReceivedAlert) {
  return alertMappings.all().then((mappings) => mappings
    .filter((item) => item.enabled && item.alertConfigId === alert.configId)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
}

async function processReceived(id: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const claimed = await receivedAlerts.mutate((rows) => {
      const alert = rows.find((item) => item.id === id);
      if (!alert || alert.processingStatus !== "RECEIVED") return null;
      alert.processingStatus = "PROCESSING";
      alert.updatedAt = new Date().toISOString();
      return alert;
    });
    if (!claimed) return;
    try {
      if (!claimed.configId) {
        await receivedAlerts.mutate((rows) => {
          const current = rows.find((item) => item.id === id);
          if (current) { current.processingStatus = "UNMATCHED"; current.syncStatus = "BLOCKED"; }
        });
        return;
      }
      const activeConfig = await alertConfigurations.findById("id", claimed.configId);
      if (!activeConfig?.enabled) {
        await receivedAlerts.mutate((rows) => {
          const current = rows.find((item) => item.id === id);
          if (current) { current.processingStatus = "ENRICHED"; current.syncStatus = "BLOCKED"; current.lastError = "Alert Configuration is disabled; review before sync"; }
        });
        return;
      }
      const enriched = await enrichAlertFields(claimed);
      if (!activeConfig?.enabled) {
        await receivedAlerts.mutate((rows) => {
          const current = rows.find((item) => item.id === id);
        if (current) { current.processingStatus = "ENRICHED"; current.syncStatus = "BLOCKED"; current.lastError = "Alert Configuration is disabled; review before sync"; current.enrichedFields = enriched.fields; current.enrichmentStatus = enriched.status; }
        });
        return;
      }
       const mappings = await eligibleMappings(claimed);
       const mapping = claimed.mappingId
         ? mappings.find((item) => item.id === claimed.mappingId) || mappings[0]
         : mappings[0];
      await receivedAlerts.mutate((rows) => {
         const current = rows.find((item) => item.id === id);
         if (!current) return;
         const wasDuplicate = current.processingStatus === "DUPLICATE" || current.syncStatus === "DUPLICATE";
         current.enrichedFields = enriched.fields;
         current.enrichmentStatus = enriched.status;
         current.processingStatus = "ENRICHED";
         current.updatedAt = new Date().toISOString();
          if (mapping && !wasDuplicate) {
            current.mappingId = mapping.id;
            current.mappingName = mapping.name;
            current.mappedContact = {};
            current.processingStatus = "READY_FOR_SYNC";
            current.syncStatus = mapping.autoImport && activeConfig.enabled ? "QUEUED" : "AWAITING_MANUAL";
          } else if (wasDuplicate) {
            current.processingStatus = "DUPLICATE";
            current.syncStatus = "DUPLICATE";
        } else {
          current.syncStatus = "AWAITING_MANUAL";
        }
      });
      await audit("PROCESS_ALERT", "alert-worker", claimed.id, {
        configId: claimed.configId,
        mappingId: mapping?.id || "",
        enrichmentStatus: enriched.status,
        correlationId: claimed.correlationId,
      });
      processedCount++;
    } catch (error) {
      const reason = (error as Error).message.slice(0, 500);
      await receivedAlerts.mutate((rows) => {
        const current = rows.find((item) => item.id === id);
        if (!current) return;
        current.processingStatus = "FAILED";
        current.syncStatus = "BLOCKED";
        current.lastError = reason;
        current.processingAttempts = (current.processingAttempts ?? current.attempts ?? 0) + 1;
        current.retryAt = current.processingAttempts < 5 ? new Date(Date.now() + Math.min(3600000, 15000 * 2 ** (current.processingAttempts - 1))).toISOString() : "";
        current.updatedAt = new Date().toISOString();
      });
      await audit("ALERT_PROCESSING_FAILED", "alert-worker", id, { error: reason, correlationId: claimed.correlationId });
      failureCount++;
    }
  } finally {
    inFlight.delete(id);
  }
}

async function processQueued(id: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const alert = await receivedAlerts.findById("id", id);
    if (!alert || alert.syncStatus !== "QUEUED" || !alert.mappingId) return;
    const mapping = await alertMappings.findById("id", alert.mappingId);
    const config = await alertConfigurations.findById("id", alert.configId);
    if (!mapping?.autoImport || !config?.enabled || !mapping.enabled) {
      await receivedAlerts.mutate((rows) => {
        const item = rows.find((row) => row.id === id);
        if (item) item.syncStatus = "AWAITING_MANUAL";
      });
      return;
    }
    try {
      await syncAlert(id, mapping.id, "auto-import", "AUTO");
    } catch (error) {
      if ((error as { status?: number }).status !== 409) failureCount++;
    }
  } finally {
    inFlight.delete(id);
  }
}

async function processRetries() {
  const due = (await receivedAlerts.all()).filter((item) => item.retryAt && new Date(item.retryAt).getTime() <= Date.now() && (item.syncStatus === "FAILED" && item.mappingId || item.processingStatus === "FAILED")).slice(0, 10);
  for (const item of due) {
    const [mapping, config] = item.syncStatus === "FAILED" ? await Promise.all([alertMappings.findById("id", item.mappingId), alertConfigurations.findById("id", item.configId)]) : [undefined, undefined];
    await receivedAlerts.mutate((rows) => {
      const current = rows.find((row) => row.id === item.id);
      if (current?.retryAt && new Date(current.retryAt).getTime() <= Date.now()) {
        if (current.processingStatus === "FAILED" && (current.processingAttempts ?? current.attempts ?? 0) < 5) { current.processingStatus = "RECEIVED"; current.syncStatus = "BLOCKED"; }
        else if (current.syncStatus === "FAILED" && (current.syncAttempts ?? current.attempts ?? 0) < 5 && mapping?.autoImport && mapping.enabled && config?.enabled && mapping.alertConfigId === current.configId) current.syncStatus = "QUEUED";
        current.retryAt = "";
      }
    });
  }
}

export function recoverAlertProcessingAttempts() {
  return receivedAlerts.mutate((rows) => {
    for (const alert of rows) {
      if (alert.processingStatus === "PROCESSING") {
        alert.processingStatus = "RECEIVED";
        alert.syncStatus = "BLOCKED";
      }
      alert.processingAttempts ??= alert.attempts || 0;
      alert.syncAttempts ??= alert.attempts || 0;
      alert.retryAt ||= "";
      alert.updatedAt = new Date().toISOString();
    }
  });
}

export async function tickAlertWorker() {
  if (ticking) return;
  ticking = true;
  lastTickAt = new Date().toISOString();
  try {
    const all = await receivedAlerts.all();
    const pending = all.filter((item) => item.processingStatus === "RECEIVED").slice(0, 4);
    const queued = all.filter((item) => item.syncStatus === "QUEUED" && item.mappingId).slice(0, Math.max(0, 4 - pending.length));
    await processRetries();
    await Promise.all([
      ...pending.map((item) => processReceived(item.id)),
      ...queued.map((item) => processQueued(item.id)),
    ]);
  } finally {
    ticking = false;
  }
}

export async function startAlertWorker() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tickAlertWorker().catch((error) => {
    failureCount++;
    console.error("Alert worker tick failed", (error as Error).name);
  }), 1000);
  timer.unref();
  await tickAlertWorker();
}

export function alertWorkerStatus() {
  return receivedAlerts.all().then((items) => ({ status: timer ? "RUNNING" : "STOPPED", lastTickAt, inFlight: inFlight.size, processedCount, failureCount, pending: items.filter((item) => item.processingStatus === "RECEIVED" || item.syncStatus === "QUEUED").length }));
}

export async function retryAlertProcessing(id: string, actor: string) {
  const alert = await receivedAlerts.findById("id", id);
  if (!alert) throw httpError(404, "Alert not found");
  if (alert.processingStatus !== "FAILED") throw httpError(409, "Only processing-failed alerts can be retried");
  await receivedAlerts.mutate((rows) => {
    const current = rows.find((item) => item.id === id)!;
    current.processingStatus = "RECEIVED"; current.syncStatus = "BLOCKED";
    current.processingAttempts = 0; current.lastError = ""; current.retryAt = ""; current.updatedAt = new Date().toISOString();
  });
  await audit("RETRY_ALERT_PROCESSING", actor, id);
  return { accepted: true, id };
}

export async function reprocessAlert(id: string) {
  await processReceived(id);
}
