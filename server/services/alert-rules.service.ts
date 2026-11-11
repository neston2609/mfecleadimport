import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { httpError } from "../domain/business";
import { audit } from "../domain/store";
import type {
  AlertCondition,
  AlertConditionGroup,
  AlertConfiguration,
  AlertFieldDefinition,
  AlertValue,
  ReceivedAlert,
} from "../domain/alert-types";
import {
  alertConfigurations,
  alertTestSessions,
  receivedAlerts,
} from "../domain/alert-store";
import { encryptSecret } from "./genesys/secret.service";
import { decryptSecret } from "./genesys/secret.service";
import { isIP } from "node:net";

const name = z.string().trim().min(1).max(120);
const safeField = z.string().trim().min(1).max(128).refine(
  (value) => !["__proto__", "prototype", "constructor"].includes(value) && !/[\x00-\x1f]/.test(value),
  "Invalid field name",
);
const condition = z.object({
  field: z.string().trim().min(1).max(256),
  operator: z.enum([
    "EQ", "NE", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "IN_LIST", "REGEX", "EXISTS", "NOT_EXISTS",
  ]),
  value: z.string().max(2000).optional(),
}).superRefine((value, context) => {
  if (value.operator === "REGEX" && !regexIsSafe(value.value || ""))
    context.addIssue({ code: "custom", message: "Regex is invalid or too complex for safe evaluation", path: ["value"] });
});
const group = z.object({
  match: z.enum(["ALL", "ANY"]).default("ALL"),
  conditions: z.array(condition).max(30).default([]),
});
const field = z.object({
  name: safeField,
  source: z.string().trim().min(1).max(256),
  type: z.enum(["STRING", "NUMBER", "DATE", "BOOLEAN", "PHONE"]),
  required: z.boolean().default(false),
  defaultValue: z.string().max(2000).default(""),
  description: z.string().max(500).default(""),
  sensitive: z.boolean().optional(),
  extract: z.object({
    mode: z.enum(["FULL", "REGEX", "BETWEEN"]).default("FULL"),
    expression: z.string().max(200).default(""),
    after: z.string().max(100).default(""),
    group: z.number().int().min(0).max(10).default(1),
  }).optional(),
});
const inputSchema = z.object({
  name,
  description: z.string().max(1000).default(""),
  type: z.enum(["SNMP", "API"]),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(100000).default(100),
  defaultSubject: z.string().trim().min(1).max(300).default("Alert notification"),
  match: group.default({ match: "ALL", conditions: [] }),
  subjectRules: z.array(z.object({ match: group, subject: z.string().trim().min(1).max(300) })).max(50).default([]),
  fields: z.array(field).max(200).default([]),
  duplicateField: z.string().max(256).default(""),
  duplicateWindowSeconds: z.number().int().min(0).max(2592000).default(86400),
  allowedSources: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
  api: z.object({
    auth: z.enum(["BEARER", "API_KEY", "HMAC"]).default("BEARER"),
    token: z.string().max(500).optional(),
    hmacSecret: z.string().max(500).optional(),
    maxBodyBytes: z.number().int().min(1024).max(5 * 1024 * 1024).default(1024 * 1024),
  }).default({ auth: "BEARER", maxBodyBytes: 1024 * 1024 }),
}).strict();

export const alertConfigurationInput = inputSchema;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveAlertPath(fields: Record<string, AlertValue>, field: string): AlertValue | undefined {
  if (Object.hasOwn(fields, field)) return fields[field];
  let result: AlertValue | undefined = fields;
  for (const part of field.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(part)) return undefined;
    if (Array.isArray(result) && /^(?:0|[1-9]\d*)$/.test(part)) result = result[Number(part)];
    else result = result && typeof result === "object" && !Array.isArray(result) ? result[part] : undefined;
  }
  return result;
}

export function evaluateAlertCondition(fields: Record<string, AlertValue>, test: AlertCondition) {
  const value = resolveAlertPath(fields, test.field);
  const exists = value !== undefined && value !== null;
  const actual = Array.isArray(value) ? value.map(String).join(",") : value === undefined ? "" : String(value);
  const expected = test.value ?? "";
  switch (test.operator) {
    case "EXISTS": return exists;
    case "NOT_EXISTS": return !exists;
    case "EQ": return exists && actual === expected;
    case "NE": return !exists || actual !== expected;
    case "CONTAINS": return exists && actual.includes(expected);
    case "STARTS_WITH": return exists && actual.startsWith(expected);
    case "ENDS_WITH": return exists && actual.endsWith(expected);
    case "IN_LIST": return exists && expected.split(",").map((item) => item.trim()).includes(actual);
    case "REGEX":
      if (expected.length > 200) return false;
      try { return exists && new RegExp(`^(?:${expected})$`, "i").test(actual); }
      catch { return false; }
  }
}

export function evaluateAlertGroup(fields: Record<string, AlertValue>, conditionGroup: AlertConditionGroup) {
  if (!conditionGroup.conditions.length) return true;
  const results = conditionGroup.conditions.map((item) => evaluateAlertCondition(fields, item));
  return conditionGroup.match === "ALL" ? results.every(Boolean) : results.some(Boolean);
}

export function createAlertFields(config: AlertConfiguration, raw: Record<string, AlertValue>) {
  const result: Record<string, AlertValue> = Object.create(null);
  for (const definition of config.fields) {
    const value = resolveAlertPath(raw, definition.source);
    const extracted = extractAlertField(value, definition.extract);
    const selected = extracted === undefined || extracted === null || extracted === "" ? definition.defaultValue || null : extracted;
    result[definition.name] = selected === null ? null : coerceAlertValue(selected, definition.type);
  }
  return result;
}

export function extractAlertField(value: AlertValue | undefined, extraction?: AlertFieldDefinition["extract"]): AlertValue | undefined {
  if (value === undefined || value === null || !extraction || extraction.mode === "FULL") return value;
  const text = typeof value === "string" ? value : String(value);
  if (extraction.mode === "REGEX") {
    if (!extraction.expression || !regexIsSafe(extraction.expression)) return null;
    try { return new RegExp(extraction.expression).exec(text)?.[extraction.group] ?? null; }
    catch { return null; }
  }
  if (!extraction.expression || !extraction.after) return null;
  const start = text.indexOf(extraction.expression);
  if (start < 0) return null;
  const contentStart = start + extraction.expression.length;
  const end = text.indexOf(extraction.after, contentStart);
  return end < 0 ? null : text.slice(contentStart, end);
}

export function coerceAlertValue(value: AlertValue, type: string): AlertValue {
  const text = typeof value === "string" ? value : String(value);
  if (type === "NUMBER") {
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "BOOLEAN") {
    if (/^(true|1|yes)$/i.test(text)) return true;
    if (/^(false|0|no)$/i.test(text)) return false;
    return null;
  }
  if (type === "DATE") {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return text;
}

export function redactAlertFields(fields: Record<string, AlertValue>, config?: AlertConfiguration | null) {
  const sensitive = new Set(config?.fields.filter((item) => item.sensitive).map((item) => item.name) ?? []);
  for (const field of config?.fields || []) if (field.sensitive) sensitive.add(field.source.split(".").at(-1) || field.source);
  const sensitiveSources = new Set(config?.fields.filter((item) => item.sensitive).map((item) => item.source) ?? []);
  for (const source of sensitiveSources) sensitive.add(source);
  const redact = (value: AlertValue, key: string): AlertValue => {
    if (sensitive.has(key) || /(?:password|secret|token|citizen.?id|national.?id|phone|mobile|email)/i.test(key)) return maskValue(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, ""));
    if (value && typeof value === "object") {
      const oid = typeof value.oid === "string" ? `oid:${value.oid}` : "";
      const oidSensitive = sensitiveSources.has(oid);
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, oidSensitive && name === "value" ? maskValue(item) : redact(item, name)]));
    }
    return value;
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value, key)]));
}

function maskValue(value: AlertValue): AlertValue {
  if (typeof value !== "string") return value === null ? null : "••••••";
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

export function publicAlertConfiguration(config: AlertConfiguration) {
  const { tokenEncrypted, hmacSecretEncrypted, ...api } = config.api;
  return { ...config, api: { ...api, tokenConfigured: Boolean(tokenEncrypted), hmacSecretConfigured: Boolean(hmacSecretEncrypted) } };
}

export async function saveAlertConfiguration(input: unknown, actor: string, id?: string) {
  const data = inputSchema.parse(input);
  if (data.allowedSources.some((entry) => {
    const [address, mask] = entry.split("/");
    const version = isIP(address);
    return !version || entry.split("/").length > 2 || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)));
  })) throw httpError(400, "Allowed source entries must be valid IP addresses or CIDRs");
  if (new Set(data.fields.map((item) => item.name)).size !== data.fields.length)
    throw httpError(400, "Alert field names must be unique");
  for (const rule of data.subjectRules)
    if (rule.subject.includes("{{") && /{{\s*[^}\s]+\s*}}/.test(rule.subject) === false)
      throw httpError(400, "Subject template contains an invalid placeholder");
  const previous = id ? await alertConfigurations.findById("id", id) : undefined;
  if (id && !previous) throw httpError(404, "Alert Configuration not found");
  if ((await alertConfigurations.all()).some((item) => item.id !== id && item.name.toLowerCase() === data.name.toLowerCase()))
    throw httpError(409, "This Alert Configuration name is already in use");
  const tokenConfigured = Boolean(data.api.token || previous?.api.tokenEncrypted);
  const hmacConfigured = Boolean(data.api.hmacSecret || previous?.api.hmacSecretEncrypted);
  if (data.type === "API" && data.enabled && (data.api.auth === "HMAC" ? !hmacConfigured : !tokenConfigured))
    throw httpError(400, "Configure the authentication credential required by this API endpoint before enabling it");
  const timestamp = new Date().toISOString();
  const saved = await alertConfigurations.mutate((rows) => {
    const old = rows.find((item) => item.id === id);
    if (id && !old) throw httpError(404, "Alert Configuration not found");
    const item: AlertConfiguration = {
      id: id || randomUUID(),
      name: data.name,
      description: data.description,
      type: data.type,
      enabled: data.enabled,
      priority: data.priority,
      defaultSubject: data.defaultSubject,
      match: data.match,
      subjectRules: data.subjectRules,
      fields: data.fields,
      duplicateField: data.duplicateField,
      duplicateWindowSeconds: data.duplicateWindowSeconds,
      allowedSources: data.allowedSources,
      api: {
        auth: data.api.auth,
        tokenEncrypted: data.api.token ? encryptSecret(data.api.token) : old?.api.tokenEncrypted || "",
        hmacSecretEncrypted: data.api.hmacSecret ? encryptSecret(data.api.hmacSecret) : old?.api.hmacSecretEncrypted || "",
        maxBodyBytes: data.api.maxBodyBytes,
      },
      createdAt: old?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    if (old) rows.splice(rows.indexOf(old), 1, item);
    else rows.push(item);
    return item;
  });
  await audit(id ? "UPDATE_ALERT_CONFIGURATION" : "CREATE_ALERT_CONFIGURATION", actor, saved.id, { type: saved.type, enabled: saved.enabled });
  return publicAlertConfiguration(saved);
}

export function renderAlertSubject(config: AlertConfiguration, fields: Record<string, AlertValue>) {
  const rule = config.subjectRules.find((item) => evaluateAlertGroup(fields, item.match));
  const template = rule?.subject || config.defaultSubject;
  return template.replace(/{{\s*([A-Za-z0-9_.:-]{1,256})\s*}}/g, (_placeholder, key: string) => {
    const value = resolveAlertPath(fields, key);
    return value === undefined || value === null ? "" : String(value).slice(0, 300);
  }).slice(0, 300);
}

export async function routeAlert(transport: "SNMP" | "API", fields: Record<string, AlertValue>, configId?: string) {
  const candidates = (await alertConfigurations.all())
    .filter((item) => item.enabled && item.type === transport && evaluateAlertGroup(fields, item.match))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return configId ? candidates.find((item) => item.id === configId) : candidates[0];
}

export function makeAlertEventKey(config: AlertConfiguration, fields: Record<string, AlertValue>, payload: AlertValue) {
  const identity = config.duplicateField ? resolveAlertPath(fields, config.duplicateField) : undefined;
  const stable = (value: AlertValue): AlertValue => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["received_at", "raw_pdu", "source_port", "request_id"].includes(key.toLowerCase())).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
  };
  const material = identity === undefined || identity === null || identity === ""
    ? `${config.id}:${JSON.stringify(stable(fields))}:${JSON.stringify(stable(payload))}`
    : `${config.id}:${config.duplicateField}:${String(identity)}`;
  return createHash("sha256").update(material).digest("hex");
}

export function isAlertEventDuplicate(config: AlertConfiguration, eventKey: string, receivedAt: string, rows: ReceivedAlert[]) {
  const windowMs = config.duplicateWindowSeconds * 1000;
  if (!windowMs) return undefined;
  const timestamp = new Date(receivedAt).getTime();
  return [...rows].reverse().find((item) => {
    const age = timestamp - new Date(item.receivedAt).getTime();
    const activeProcessing = ["RECEIVED", "PROCESSING", "ENRICHED", "READY_FOR_SYNC"].includes(item.processingStatus);
    return item.configId === config.id && item.eventKey === eventKey && age >= 0 && age <= windowMs && !["REJECTED", "DUPLICATE"].includes(item.processingStatus) && !["FAILED", "UNKNOWN"].includes(item.syncStatus) && (item.syncStatus !== "BLOCKED" || activeProcessing);
  });
}

export async function acceptAlert(input: {
  transport: "SNMP" | "API";
  sourceIp: string;
  sourcePort: number;
  raw: AlertValue;
  fields: Record<string, AlertValue>;
  testSessionId?: string;
  configId?: string;
}) {
  if (input.testSessionId) {
    const config = await alertConfigurations.findById("id", input.configId || "");
    if (!config || config.type !== input.transport) throw httpError(404, "Alert test configuration is unavailable");
    const fields = createAlertFields(config, input.fields);
    await alertTestSessions.mutate((sessions) => {
      const session = sessions.find((item) => item.id === input.testSessionId);
      if (!session || session.alertConfigId !== config.id || session.transport !== input.transport || new Date(session.expiresAt).getTime() <= Date.now()) return;
      const raw = typeof input.raw === "object" && input.raw && !Array.isArray(input.raw) ? input.raw : { value: input.raw };
      session.capture = { receivedAt: new Date().toISOString(), sourceIp: input.sourceIp, raw: redactAlertFields(raw as Record<string, AlertValue>, config), fields: redactAlertFields(fields, config) };
    });
    return { accepted: true, test: true };
  }
  const config = await routeAlert(input.transport, input.fields, input.configId);
  const timestamp = new Date().toISOString();
  if (!config) {
    const unmatched: ReceivedAlert = {
      id: randomUUID(), correlationId: randomUUID(), transport: input.transport,
      receivedAt: timestamp, sourceIp: input.sourceIp, sourcePort: input.sourcePort,
      configId: "", configName: "", configSnapshot: null, subject: "Unmatched alert",
      matchResult: "No enabled configuration matched", raw: input.raw,
      originalFields: input.fields, enrichedFields: input.fields,
      enrichmentStatus: "NOT_STARTED", processingStatus: "UNMATCHED", syncStatus: "BLOCKED",
      mappingId: "", mappingName: "", mappedContact: {}, duplicateOf: "", eventKey: "",
      attempts: 0, processingAttempts: 0, syncAttempts: 0, retryAt: "", lastError: "", genesysContactId: "", syncInitiatedBy: "",
      updatedAt: timestamp,
    };
    await appendAlert(unmatched);
    return { accepted: true, matched: false, id: unmatched.id };
  }
  const originalFields = createAlertFields(config, input.fields);
  for (const item of config.fields) {
    const value = originalFields[item.name];
    if (item.required && (value === undefined || value === null || value === "") && !item.defaultValue)
      throw httpError(422, `Required alert field is missing: ${item.name}`);
  }
  const eventKey = makeAlertEventKey(config, originalFields, input.raw);
  const duplicateWindow = config.duplicateWindowSeconds * 1000;
  const alert: ReceivedAlert = {
    id: randomUUID(), correlationId: randomUUID(), transport: input.transport,
    receivedAt: timestamp, sourceIp: input.sourceIp, sourcePort: input.sourcePort,
    configId: config.id, configName: config.name, configSnapshot: config,
    subject: renderAlertSubject(config, { ...input.fields, ...originalFields }),
    matchResult: "Matched by priority and condition rules", raw: input.raw,
    originalFields, enrichedFields: originalFields,
    enrichmentStatus: "NOT_STARTED", processingStatus: "RECEIVED",
    syncStatus: "BLOCKED", mappingId: "", mappingName: "",
    mappedContact: {}, duplicateOf: "", eventKey,
    attempts: 0, processingAttempts: 0, syncAttempts: 0, retryAt: "", lastError: "", genesysContactId: "", syncInitiatedBy: "",
    updatedAt: timestamp,
  };
  const duplicateOf = await appendAlert(alert, duplicateWindow, config);
  return { accepted: true, id: alert.id, matched: true, duplicate: Boolean(duplicateOf), ...(duplicateOf ? { duplicateOf } : {}) };
}

async function appendAlert(alert: ReceivedAlert, duplicateWindowMs = 0, config?: AlertConfiguration) {
  return receivedAlerts.mutate((rows) => {
    const duplicate = config ? isAlertEventDuplicate(config, alert.eventKey, alert.receivedAt, rows) : duplicateWindowMs > 0 ? [...rows].reverse().find((item) => item.eventKey === alert.eventKey && item.configId === alert.configId && Date.now() - new Date(item.receivedAt).getTime() <= duplicateWindowMs && item.processingStatus !== "REJECTED" && !["FAILED", "UNKNOWN", "BLOCKED"].includes(item.syncStatus)) : undefined;
    if (duplicate) {
      alert.processingStatus = "DUPLICATE";
      alert.syncStatus = "DUPLICATE";
      alert.duplicateOf = duplicate.id;
    }
    rows.push(alert);
    if (rows.length > 100000) rows.splice(0, rows.length - 100000);
    return duplicate?.id || "";
  });
}

export async function alertConfigurationDependencies(id: string) {
  const [rules, mappings, alerts] = await Promise.all([
    (await import("../domain/alert-store")).alertEnrichmentRules.all(),
    (await import("../domain/alert-store")).alertMappings.all(),
    receivedAlerts.all(),
  ]);
  return {
    enrichmentRules: rules.filter((item) => item.alertConfigId === id).length,
    mappings: mappings.filter((item) => item.alertConfigId === id).length,
    retainedAlerts: alerts.filter((item) => item.configId === id).length,
  };
}

export function revealAlertApiCredential(config: AlertConfiguration) {
  return config.api.tokenEncrypted ? decryptSecret(config.api.tokenEncrypted) : "";
}

export function regexIsSafe(value: string) {
  if (value.length > 200 || /\(\?<([=!])|\\[1-9]/.test(value) || /\([^)]*[+*{][^)]*\)[+*{]/.test(value) || /(?:\.\*|\.\+){2,}/.test(value) || /\[[^\]]*\][+*{][^\]]*[+*{]/.test(value)) return false;
  try { new RegExp(value); return true; } catch { return false; }
}
