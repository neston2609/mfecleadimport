import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AlertMapping, AlertSyncHistory, AlertValue, ReceivedAlert } from "../domain/alert-types";
import { alertConfigurations, alertMappings, alertSyncHistory, receivedAlerts } from "../domain/alert-store";
import { contactList } from "./lead-pipeline.service";
import { GenesysConfigService } from "./genesys/genesys-config.service";
import { GenesysApiError, genesysApiClient } from "./genesys/genesys-api.client";
import { audit } from "../domain/store";
import { httpError } from "../domain/business";
import { resolveAlertPath } from "./alert-rules.service";

const name = z.string().trim().min(1).max(120);
const mappingSchema = z.object({
  name,
  description: z.string().max(1000).default(""),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(100000).default(100),
  alertConfigId: z.string().uuid(),
  contactListId: z.string().min(1).max(200),
  fields: z.array(z.object({
    target: z.string().min(1).max(128),
    sourceType: z.enum(["ALERT", "ENRICHMENT", "SYSTEM", "STATIC"]),
    source: z.string().max(256).default(""),
    value: z.string().max(2000).default(""),
    required: z.boolean().default(false),
  })).max(200),
  phoneField: z.string().min(1).max(128),
  uniqueField: z.string().max(128).default(""),
  duplicateWindowSeconds: z.number().int().min(0).max(2592000).default(86400),
  duplicateBehavior: z.enum(["SKIP", "MANUAL_REVIEW", "ALLOW_NEW"]).default("SKIP"),
  autoImport: z.boolean().default(false),
}).strict();
export const alertMappingInput = mappingSchema;

export async function saveAlertMapping(input: unknown, actor: string, id?: string) {
  const data = mappingSchema.parse(input);
  const config = await alertConfigurations.findById("id", data.alertConfigId);
  if (!config) throw httpError(404, "Alert Configuration not found");
  const destination = await contactList(data.contactListId);
  const available = new Set(destination.columnNames || []);
  const phoneColumns = new Set((destination.phoneColumns || []).map((item) => item.columnName));
  if (!available.size) throw httpError(409, "Refresh the Genesys Contact List schema before saving");
  if (data.fields.some((field) => !available.has(field.target))) throw httpError(400, "Mapping refers to a Contact List field that no longer exists");
  if (!available.has(data.phoneField)) throw httpError(400, "Phone field is not present in the Contact List schema");
  if (!phoneColumns.has(data.phoneField)) throw httpError(400, "Select a Genesys Contact List phone column for phoneField");
  if (data.uniqueField && (!available.has(data.uniqueField) || !data.fields.some((field) => field.target === data.uniqueField)))
    throw httpError(400, "Unique field must be mapped to a field in the Genesys Contact List schema");
  if (new Set(data.fields.map((field) => field.target)).size !== data.fields.length) throw httpError(400, "Each Genesys target field can be mapped only once");
  const previous = id ? await alertMappings.findById("id", id) : undefined;
  if (id && !previous) throw httpError(404, "Alert Mapping not found");
  if ((await alertMappings.all()).some((item) => item.id !== id && item.name.toLowerCase() === data.name.toLowerCase())) throw httpError(409, "Alert Mapping name is already in use");
  const configService = new GenesysConfigService();
  const genesys = await configService.getConfig();
  const timestamp = new Date().toISOString();
  const saved = await alertMappings.mutate((rows) => {
    const old = rows.find((item) => item.id === id);
    const item: AlertMapping = {
      ...data, contactListName: destination.name, regionId: genesys.regionId,
      id: id || randomUUID(), createdAt: old?.createdAt || timestamp, updatedAt: timestamp,
    };
    if (old) rows.splice(rows.indexOf(old), 1, item); else rows.push(item);
    return item;
  });
  await audit(id ? "UPDATE_ALERT_MAPPING" : "CREATE_ALERT_MAPPING", actor, saved.id, { contactListId: saved.contactListId, autoImport: saved.autoImport });
  return saved;
}

export function normalizeAlertPhone(value: AlertValue, defaultCountry = "TH") {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let phone = String(value).trim().replace(/[\s().-]/g, "");
  if (defaultCountry === "TH" && /^0[689]\d{8}$/.test(phone)) phone = `+66${phone.slice(1)}`;
  else if (defaultCountry === "TH" && /^0[2-9]\d{7,8}$/.test(phone)) phone = `+66${phone.slice(1)}`;
  else if (/^00\d+$/.test(phone)) phone = `+${phone.slice(2)}`;
  else if (/^\d{8,15}$/.test(phone)) phone = `+${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
}

function systemValue(field: string, alert: ReceivedAlert, mapping: AlertMapping): AlertValue | undefined {
  switch (field) {
    case "alert_id": return alert.id;
    case "alert_subject": return alert.subject;
    case "alert_type": return alert.transport;
    case "source_ip": return alert.sourceIp;
    case "received_at": return alert.receivedAt;
    case "alert_configuration": return alert.configName;
    case "correlation_id": return alert.correlationId;
    case "mapping_name": return mapping.name;
    default: return undefined;
  }
}

export function mapAlertContact(alert: ReceivedAlert, mapping: AlertMapping) {
  const result: Record<string, string> = {};
  const errors: string[] = [];
  for (const field of mapping.fields) {
    let value: AlertValue | undefined;
    if (field.sourceType === "STATIC") value = field.value;
    else if (field.sourceType === "SYSTEM") value = systemValue(field.source, alert, mapping);
    else value = resolveAlertPath(field.sourceType === "ALERT" ? alert.originalFields : alert.enrichedFields, field.source);
    if (value === undefined || value === null || value === "") value = field.value || undefined;
    if (value === undefined) {
      if (field.required) errors.push(`Required Contact List field is missing: ${field.target}`);
      continue;
    }
    result[field.target] = typeof value === "string" ? value : JSON.stringify(value);
  }
  const phone = normalizeAlertPhone(result[mapping.phoneField] || "");
  if (!phone) errors.push(`Phone number is missing or invalid for ${mapping.phoneField}`);
  else result[mapping.phoneField] = phone;
  if (mapping.uniqueField && !result[mapping.uniqueField]) errors.push(`Unique identifier is missing for ${mapping.uniqueField}`);
  return { data: result, errors, valid: errors.length === 0 };
}

export async function previewAlertMapping(alertId: string, mappingId: string) {
  const [alert, mapping] = await Promise.all([
    receivedAlerts.findById("id", alertId), alertMappings.findById("id", mappingId),
  ]);
  if (!alert) throw httpError(404, "Alert not found");
  if (!mapping) throw httpError(404, "Alert Mapping not found");
  const config = await alertConfigurations.findById("id", alert.configId);
  if (!config?.enabled || !mapping.enabled || mapping.alertConfigId !== alert.configId) throw httpError(409, "An enabled matching Alert Configuration and mapping are required for preview");
  const destination = await contactList(mapping.contactListId);
  const fields = new Set(destination.columnNames || []);
  const configValid = mapping.fields.every((item) => fields.has(item.target)) && fields.has(mapping.phoneField);
  const mapped = mapAlertContact(alert, mapping);
  const duplicates = await findDuplicate(mapping, mapped.data);
  return {
    alertId, mapping: { id: mapping.id, name: mapping.name },
    contactList: { id: destination.id, name: destination.name },
    originalAlert: alert.originalFields, enrichedAlert: alert.enrichedFields,
    mappedContact: mapped.data, validation: { valid: mapped.valid && configValid, errors: [...mapped.errors, ...(!configValid ? ["Contact List schema changed; refresh and update mapping"] : [])] },
    phone: { field: mapping.phoneField, valid: Boolean(normalizeAlertPhone(mapped.data[mapping.phoneField] || "")), normalized: mapped.data[mapping.phoneField] || "" },
    duplicate: duplicates ? { found: true, alertId: duplicates.id, behavior: mapping.duplicateBehavior } : { found: false },
    readyForSync: mapped.valid && configValid && !duplicates,
  };
}

async function findDuplicate(mapping: AlertMapping, data: Record<string, string>) {
  if (mapping.duplicateBehavior === "ALLOW_NEW" || !mapping.duplicateWindowSeconds) return undefined;
  const dedupeField = mapping.uniqueField || mapping.phoneField;
  const value = data[dedupeField];
  if (!value) return undefined;
  const cutoff = Date.now() - mapping.duplicateWindowSeconds * 1000;
  return (await receivedAlerts.all()).find((item) => item.mappingId === mapping.id && item.id !== "" && new Date(item.receivedAt).getTime() >= cutoff && item.syncStatus === "SYNCED" && item.mappedContact[dedupeField] === value);
}

export async function syncAlert(alertId: string, mappingId: string, actor: string, syncType: "AUTO" | "MANUAL") {
  const [alert, mapping] = await Promise.all([
    receivedAlerts.findById("id", alertId), alertMappings.findById("id", mappingId),
  ]);
  if (!alert) throw httpError(404, "Alert not found");
  const currentConfig = await alertConfigurations.findById("id", alert.configId);
  if (!currentConfig?.enabled) throw httpError(409, "Alert Configuration is disabled; review before sync");
  if (!mapping?.enabled) throw httpError(409, "Alert Mapping is missing or disabled");
  if (alert.configId !== mapping.alertConfigId) throw httpError(400, "Alert Mapping does not apply to this Alert Configuration");
  if (syncType === "AUTO" && !mapping.autoImport) throw httpError(409, "Auto Import is disabled");
  const claim = await receivedAlerts.mutate((rows) => {
    const current = rows.find((item) => item.id === alertId);
    if (!current) throw httpError(404, "Alert not found");
    if (!currentConfig.enabled) throw httpError(409, "Alert Configuration is disabled; review before sync");
    if (current.syncStatus === "UNKNOWN") throw httpError(409, "Contact outcome is unknown. Reconcile in Genesys before retrying to avoid a duplicate");
    if (current.processingStatus === "DUPLICATE" || current.syncStatus === "DUPLICATE") throw httpError(409, "Duplicate alert events cannot be synchronized");
    if (["SYNCING", "SYNCED"].includes(current.syncStatus)) throw httpError(409, "Alert is already syncing or synchronized");
    if (!["AWAITING_MANUAL", "QUEUED", "FAILED"].includes(current.syncStatus) || !["READY_FOR_SYNC", "ENRICHED"].includes(current.processingStatus)) throw httpError(409, "Alert processing and enrichment must finish before synchronization");
    if (syncType === "AUTO" && current.mappingId !== mapping.id) throw httpError(409, "Alert is not queued for the selected Auto Import mapping");
    if (syncType === "MANUAL" && current.mappingId && current.mappingId !== mapping.id) throw httpError(409, "Select the mapping for this alert before manual sync");
    current.syncStatus = "SYNCING";
    current.syncAttempts = (current.syncAttempts ?? current.attempts ?? 0) + 1;
    current.mappingId = mapping.id;
    current.mappingName = mapping.name;
    current.syncInitiatedBy = actor;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  const history: AlertSyncHistory = {
    id: randomUUID(), alertId, correlationId: claim.correlationId,
    alertConfigId: claim.configId, alertConfigName: claim.configName,
    mappingId: mapping.id, mappingName: mapping.name, contactListId: mapping.contactListId,
     contactListName: mapping.contactListName, syncType, startedAt: new Date().toISOString(),
     completedAt: "", status: "SYNCING", genesysContactId: "", attempt: claim.syncAttempts || 1,
    error: "", initiatedBy: actor, payload: {}, responseMetadata: {},
  };
  await alertSyncHistory.mutate((rows) => { rows.push(history); if (rows.length > 100000) rows.splice(0, rows.length - 100000); });
  try {
    const result = mapAlertContact(claim, mapping);
    if (!result.valid) throw httpError(422, result.errors.join("; "));
    await receivedAlerts.mutate((rows) => {
      const current = rows.find((item) => item.id === alertId);
      if (current?.syncStatus === "SYNCING") { current.mappedContact = result.data; current.mappingId = mapping.id; current.mappingName = mapping.name; current.updatedAt = new Date().toISOString(); }
    });
    const duplicate = await findDuplicate(mapping, result.data);
    if (duplicate && mapping.duplicateBehavior === "SKIP") throw httpError(409, "A synchronized alert already has this Contact List unique identifier");
    if (duplicate && mapping.duplicateBehavior === "MANUAL_REVIEW") throw httpError(409, "Duplicate contact needs manual review");
    const destination = await contactList(mapping.contactListId);
    const columns = new Set(destination.columnNames || []);
    if (Object.keys(result.data).some((key) => !columns.has(key))) throw httpError(409, "Mapped Contact List schema changed; refresh the list and mapping");
    const dedupeField = mapping.uniqueField || mapping.phoneField;
    if (mapping.duplicateBehavior !== "ALLOW_NEW" && await findGenesysDuplicate(destination.id, dedupeField, result.data[dedupeField]))
      throw httpError(409, "A Genesys Contact already uses this unique identifier; review the mapping before retrying");
    const config = await new GenesysConfigService().getConfig();
    if (!config.enabled || !config.clientId || !config.clientSecretEncrypted) throw httpError(400, "Genesys integration is disabled or not configured");
    const base = `/api/v2/outbound/contactlists/${encodeURIComponent(destination.id)}/contacts`;
    let contactId = "";
    if (duplicate && mapping.duplicateBehavior === "ALLOW_NEW") {
      contactId = await createGenesysContact(base, result.data);
    } else {
      try {
        contactId = await createGenesysContact(base, result.data);
      } catch (error) {
        // A timed-out POST may have succeeded remotely. Never blindly repeat creation.
        if (error instanceof GenesysApiError && (error.status === 0 || error.status >= 500)) throw Object.assign(new Error("Genesys contact creation outcome is unknown; verify the Contact List before retrying"), { unknown: true });
        throw error;
      }
    }
    const timestamp = new Date().toISOString();
    await receivedAlerts.mutate((rows) => {
      const current = rows.find((item) => item.id === alertId)!;
      current.syncStatus = "SYNCED"; current.mappingId = mapping.id; current.mappingName = mapping.name;
       current.mappedContact = result.data; current.genesysContactId = contactId;
      current.lastError = ""; current.retryAt = ""; current.updatedAt = timestamp;
    });
    await updateHistory(history.id, { status: "SYNCED", genesysContactId: contactId, completedAt: timestamp, payload: {}, responseMetadata: { httpStatus: 200, contactId } });
    await audit("SYNC_ALERT_TO_GENESYS", actor, alertId, { mappingId, contactListId: destination.id, syncType, correlationId: claim.correlationId });
    return { id: alertId, status: "SYNCED", genesysContactId: contactId };
  } catch (error) {
    const reason = (error as Error).message.slice(0, 500);
    const unknown = Boolean((error as Error & { unknown?: boolean }).unknown) || (error instanceof GenesysApiError && error.status === 408);
    const errorStatus = (error as { status?: number }).status;
    const permanent = (error instanceof GenesysApiError || typeof errorStatus === "number") && errorStatus! >= 400 && errorStatus! < 500 && errorStatus !== 429 && errorStatus !== 408;
    const timestamp = new Date().toISOString();
    await receivedAlerts.mutate((rows) => {
      const current = rows.find((item) => item.id === alertId);
      if (!current) return;
      current.syncStatus = unknown ? "UNKNOWN" : "FAILED";
      current.lastError = reason;
      const attempts = current.syncAttempts ?? current.attempts ?? 1;
      current.retryAt = syncType === "AUTO" && !permanent && !unknown && attempts < 5 ? new Date(Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1))).toISOString() : "";
      current.updatedAt = timestamp;
    });
    await updateHistory(history.id, { status: unknown ? "UNKNOWN" : "FAILED", error: reason, completedAt: timestamp, payload: {}, responseMetadata: { retryScheduled: syncType === "AUTO" && !permanent && !unknown } });
    await audit("ALERT_SYNC_FAILED", actor, alertId, { mappingId, syncType, error: reason.slice(0, 200) });
    throw error;
  }
}

async function createGenesysContact(base: string, data: Record<string, string>) {
  const created = await genesysApiClient.request<unknown>("POST", base, [{ data, callable: false }]);
  const result = Array.isArray(created) ? created[0] : (created as { entities?: unknown[]; contacts?: unknown[] })?.entities?.[0] || (created as { contacts?: unknown[] })?.contacts?.[0] || created;
  const id = (result as { id?: string })?.id;
  if (!id) throw Object.assign(new Error("Genesys returned no Contact ID; verify the list before retrying"), { unknown: true });
  return id;
}

async function findGenesysDuplicate(contactListId: string, field: string, value: string | undefined) {
  if (!value) return false;
  const pageSize = 100;
  const base = `/api/v2/outbound/contactlists/${encodeURIComponent(contactListId)}/contacts`;
  let pageCount = 1;
  for (let page = 1; page <= pageCount; page++) {
    const result = await genesysApiClient.get<{ entities?: { data?: Record<string, string> }[]; pageCount?: number; total?: number }>(`${base}?pageSize=${pageSize}&pageNumber=${page}`);
    if (!Array.isArray(result.entities) || !Number.isInteger(result.pageCount) || (result.pageCount as number) < 1)
      throw httpError(409, "Genesys Contact List search could not confirm deduplication; reconcile the Contact List manually");
    pageCount = result.pageCount as number;
    if (pageCount > 50 || (typeof result.total === "number" && result.total > pageSize * 50))
      throw httpError(409, "Genesys Contact List exceeds the safe deduplication scan limit; review it manually");
    if (result.entities.some((item) => item.data?.[field] === value)) return true;
  }
  return false;
}

async function updateHistory(id: string, patch: Partial<AlertSyncHistory>) {
  await alertSyncHistory.mutate((rows) => {
    const row = rows.find((item) => item.id === id);
    if (row) Object.assign(row, patch);
  });
}

export async function syncAlerts(alertIds: string[], mappingId: string, actor: string) {
  if (alertIds.length > 100) throw httpError(413, "Sync at most 100 alerts in one request");
  const outcomes = [];
  for (const id of alertIds) {
    try { outcomes.push(await syncAlert(id, mappingId, actor, "MANUAL")); }
    catch (error) { outcomes.push({ id, status: "FAILED", error: (error as Error).message }); }
  }
  return { results: outcomes, synced: outcomes.filter((item) => item.status === "SYNCED").length, failed: outcomes.filter((item) => item.status !== "SYNCED").length };
}

export async function retryAlertSync(alertId: string, actor: string) {
  const alert = await receivedAlerts.findById("id", alertId);
  if (!alert) throw httpError(404, "Alert not found");
  if (!alert.mappingId) throw httpError(409, "Select an Alert Mapping before retrying");
  if (alert.syncStatus === "UNKNOWN") throw httpError(409, "Contact outcome is unknown. Reconcile in Genesys before retrying to avoid a duplicate");
  return syncAlert(alertId, alert.mappingId, actor, "MANUAL");
}

export async function reconcileAlertSync(alertId: string, outcome: "FOUND" | "NOT_FOUND", contactId: string, actor: string) {
  const alert = await receivedAlerts.findById("id", alertId);
  if (!alert) throw httpError(404, "Alert not found");
  if (alert.syncStatus !== "UNKNOWN") throw httpError(409, "Only unknown Genesys outcomes can be reconciled");
  if (outcome === "FOUND" && !contactId.trim()) throw httpError(400, "Contact ID is required when a Contact was found");
  if (outcome === "FOUND") {
    const mapping = await alertMappings.findById("id", alert.mappingId);
    if (!mapping) throw httpError(409, "Original mapping is unavailable; verify the Contact List manually");
    const destination = await contactList(mapping.contactListId);
    const remote = await genesysApiClient.get<{ id?: string }>(`/api/v2/outbound/contactlists/${encodeURIComponent(destination.id)}/contacts/${encodeURIComponent(contactId.trim())}`);
    if (remote.id !== contactId.trim()) throw httpError(404, "Contact ID was not found in the original Genesys Contact List");
  }
  if (outcome === "NOT_FOUND") {
    const mapping = await alertMappings.findById("id", alert.mappingId);
    if (!mapping) throw httpError(409, "Original mapping is unavailable; choose a mapping before retrying");
    const destination = await contactList(mapping.contactListId);
    const phoneValue = alert.mappedContact[mapping.phoneField] || "";
    const dedupeField = mapping.uniqueField || mapping.phoneField;
    const uniqueValue = mapping.uniqueField ? alert.mappedContact[mapping.uniqueField] : phoneValue;
    if (!uniqueValue && !phoneValue) throw httpError(409, "There is no stable Contact identifier to reconcile; review the Genesys Contact List manually");
    if (uniqueValue && await findGenesysDuplicate(destination.id, dedupeField, uniqueValue)) throw httpError(409, "A possible matching Contact exists; reconcile it manually before retrying");
    if (phoneValue && await findGenesysDuplicate(destination.id, mapping.phoneField, phoneValue)) throw httpError(409, "A possible matching Contact exists; reconcile it manually before retrying");
  }
  const timestamp = new Date().toISOString();
  await receivedAlerts.mutate((rows) => {
    const current = rows.find((item) => item.id === alertId)!;
    if (outcome === "FOUND") {
      current.syncStatus = "SYNCED";
      current.genesysContactId = contactId.trim().slice(0, 200);
      current.lastError = "";
      current.retryAt = "";
    } else {
      current.syncStatus = "AWAITING_MANUAL";
      current.genesysContactId = "";
      current.lastError = "Reconciled: Contact not found in Genesys; manual retry is enabled";
      current.retryAt = "";
    }
    current.updatedAt = timestamp;
  });
  await alertSyncHistory.mutate((rows) => {
    const record = [...rows].reverse().find((item) => item.alertId === alertId && item.status === "UNKNOWN");
    if (record) { record.status = outcome === "FOUND" ? "SYNCED" : "FAILED"; record.genesysContactId = outcome === "FOUND" ? contactId.trim().slice(0, 200) : ""; record.completedAt = timestamp; record.error = `Reconciled by ${actor}: ${outcome === "FOUND" ? "Contact found" : "Contact not found"}`; }
  });
  await audit("RECONCILE_ALERT_SYNC", actor, alertId, { outcome, contactId: outcome === "FOUND" ? contactId.slice(0, 200) : "" });
  return { id: alertId, status: outcome === "FOUND" ? "SYNCED" : "AWAITING_MANUAL" };
}

export async function resolveAlertMapping(alertId: string, mappingId: string, actor: string) {
  const [alert, mapping] = await Promise.all([receivedAlerts.findById("id", alertId), alertMappings.findById("id", mappingId)]);
  if (!alert) throw httpError(404, "Alert not found");
  if (!mapping?.enabled || mapping.alertConfigId !== alert.configId) throw httpError(400, "Choose an enabled mapping for this Alert Configuration");
  if (!alert.configSnapshot?.enabled) throw httpError(409, "Alert Configuration is disabled; review it before continuing");
  await receivedAlerts.mutate((rows) => {
    const item = rows.find((entry) => entry.id === alertId)!;
    if (["SYNCING", "SYNCED", "UNKNOWN"].includes(item.syncStatus)) throw httpError(409, "Cannot change mapping after a Contact sync has started");
    item.mappingId = mapping.id;
    item.mappingName = mapping.name;
    item.mappedContact = {};
    item.syncStatus = "AWAITING_MANUAL";
    item.updatedAt = new Date().toISOString();
  });
  await audit("SELECT_ALERT_MAPPING", actor, alertId, { mappingId });
  return { id: alertId, mappingId, syncStatus: "AWAITING_MANUAL" };
}

export async function recoverAlertAttempts() {
  await receivedAlerts.mutate((rows) => {
    for (const alert of rows) if (alert.syncStatus === "SYNCING") {
      alert.syncStatus = "UNKNOWN";
      alert.lastError = "Interrupted during Genesys sync; reconcile the remote Contact before retrying";
      alert.updatedAt = new Date().toISOString();
    }
  });
}
