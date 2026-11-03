import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/require-admin";
import { audit } from "../domain/store";
import {
  alertConfigurations,
  alertDatasources,
  alertEnrichmentRules,
  alertMappings,
  alertSyncHistory,
  alertTestSessions,
  receivedAlerts,
  snmpListenerConfiguration,
} from "../domain/alert-store";
import type { AlertConfiguration, AlertValue, SnmpListenerConfiguration } from "../domain/alert-types";
import { encryptSecret, decryptSecret } from "../services/genesys/secret.service";
import { httpError } from "../domain/business";
import {
  acceptAlert,
  alertConfigurationDependencies,
  alertConfigurationInput,
  createAlertFields,
  evaluateAlertGroup,
  publicAlertConfiguration,
  redactAlertFields,
  regexIsSafe,
  renderAlertSubject,
  resolveAlertPath,
  saveAlertConfiguration,
} from "../services/alert-rules.service";
import {
  previewAlertDatasource,
  previewEnrichment,
  publicDatasource,
  saveAlertDatasource,
  saveEnrichmentRule,
  uploadAlertDatasource,
  enrichAlertFields,
} from "../services/alert-enrichment.service";
import {
  alertMappingInput,
  mapAlertContact,
  normalizeAlertPhone,
  previewAlertMapping,
  retryAlertSync,
  reconcileAlertSync,
  saveAlertMapping,
  syncAlert,
  syncAlerts,
  resolveAlertMapping,
} from "../services/alert-mapping.service";
import {
  alertWorkerStatus,
  retryAlertProcessing,
} from "../services/alert-processing.service";
import {
  ipAllowed,
  restartSnmpListener,
  snmpListenerStatus,
  startSnmpListener,
  stopSnmpListener,
  validIpOrCidr,
} from "../services/snmp-listener.service";
import { contactLists } from "../services/lead-pipeline.service";

export const alertRouter = Router();
alertRouter.use(requireAdmin);

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Alert ingest rate limit exceeded" },
});
const testLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Alert test rate limit exceeded" },
});

function idParam(value: string) {
  if (!z.string().uuid().safeParse(value).success) throw httpError(400, "Invalid record ID");
  return value;
}
function actor(request: { user?: { name: string } }) { return request.user?.name || "admin"; }
function pageOptions(query: Record<string, unknown>) {
  const parsed = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), search: z.string().max(200).optional() }).parse(query);
  return parsed;
}
function page<T>(items: T[], options: { page: number; pageSize: number }) {
  return { items: items.slice((options.page - 1) * options.pageSize, options.page * options.pageSize), total: items.length, page: options.page, pageSize: options.pageSize };
}
function sanitizeValue(value: unknown, depth = 0): AlertValue {
  if (depth > 8) throw httpError(400, "Alert payload nesting exceeds 8 levels");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw httpError(413, "Alert payload array is too large");
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") throw httpError(400, "Alert payload must contain JSON values only");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1000) throw httpError(413, "Alert payload contains too many fields");
  const result: Record<string, AlertValue> = Object.create(null);
  for (const [key, item] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 256) throw httpError(400, "Alert payload contains an invalid field name");
    result[key] = sanitizeValue(item, depth + 1);
  }
  return result;
}
function clientIp(request: { ip?: string; socket?: { remoteAddress?: string } }) {
  return request.ip || request.socket?.remoteAddress || "";
}
function safeEqual(left: string, right: string) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}
function authenticateIngest(config: AlertConfiguration, request: {
  get(name: string): string | undefined;
  rawBody?: Buffer;
  body?: unknown;
}) {
  const raw = request.rawBody || Buffer.from(JSON.stringify(request.body ?? {}));
  const api = config.api;
  if (raw.byteLength > api.maxBodyBytes) throw httpError(413, "Alert payload exceeds this endpoint's configured size limit");
  if (api.auth === "BEARER") {
    const expected = decryptSecret(api.tokenEncrypted);
    const actual = request.get("Authorization") || "";
    if (!expected || !safeEqual(actual, `Bearer ${expected}`)) throw httpError(401, "Invalid alert endpoint credential");
  } else if (api.auth === "API_KEY") {
    const expected = decryptSecret(api.tokenEncrypted);
    if (!expected || !safeEqual(request.get("X-API-Key") || "", expected)) throw httpError(401, "Invalid alert endpoint credential");
  } else {
    const timestamp = request.get("X-Alert-Timestamp") || "";
    const signature = (request.get("X-Alert-Signature") || "").replace(/^sha256=/i, "");
    const epoch = Number(timestamp);
    const timeMs = timestamp.length <= 10 ? epoch * 1000 : epoch;
    if (!Number.isFinite(timeMs) || Math.abs(Date.now() - timeMs) > 5 * 60_000) throw httpError(401, "Alert signature timestamp is invalid or expired");
    const secret = decryptSecret(api.hmacSecretEncrypted);
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
    if (!secret || !/^[a-f0-9]{64}$/i.test(signature) || !safeEqual(signature.toLowerCase(), expected)) throw httpError(401, "Invalid alert signature");
  }
}
function filterSearch<T extends Record<string, unknown>>(items: T[], search?: string) {
  if (!search?.trim()) return items;
  const term = search.trim().toLocaleLowerCase();
  return items.filter((item) => Object.values(item).some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(term)));
}
function publicSyncHistory(item: import("../domain/alert-types").AlertSyncHistory, config?: AlertConfiguration | null) {
  const { payload, responseMetadata, error, ...summary } = item;
  return {
    ...summary,
    payload: redactAlertFields(payload, config),
    responseMetadata: redactAlertFields(responseMetadata, config),
    error: error.replace(/(?:Bearer\s+|token[=: ]+)[^\s,;]+/gi, "[redacted]"),
  };
}
function publicTestSession(item: import("../domain/alert-types").AlertTestSession, config?: AlertConfiguration | null) {
  const { tokenHash: _hash, ...safe } = item;
  const capture = item.capture ? {
    ...item.capture,
    raw: redactAlertFields(typeof item.capture.raw === "object" && item.capture.raw && !Array.isArray(item.capture.raw) ? item.capture.raw as Record<string, AlertValue> : { value: item.capture.raw }, config),
    fields: redactAlertFields(item.capture.fields, config),
  } : null;
  return { ...safe, capture };
}
function publicAlert(item: import("../domain/alert-types").ReceivedAlert) {
  const config = item.configSnapshot;
  const { configSnapshot: _snapshot, raw, originalFields, enrichedFields, mappedContact, lastError, ...summary } = item;
  return {
    ...summary,
    raw: redactAlertFields(typeof raw === "object" && raw && !Array.isArray(raw) ? raw as Record<string, AlertValue> : { value: raw }, config),
    originalFields: redactAlertFields(originalFields, config),
    enrichedFields: redactAlertFields(enrichedFields, config),
    mappedContact: redactAlertFields(mappedContact as Record<string, AlertValue>, config),
    lastError: lastError.replace(/(?:Bearer\s+|token[=: ]+)[^\s,;]+/gi, "[redacted]"),
  };
}

alertRouter.get("/inbox/:id", async (request, response, next) => {
  try {
    const alert = await receivedAlerts.findById("id", idParam(request.params.id));
    if (!alert) throw httpError(404, "Alert not found");
  const history = (await alertSyncHistory.all()).filter((item) => item.alertId === alert.id).map((item) => publicSyncHistory(item, alert.configSnapshot));
    response.json({ ...publicAlert(alert), syncHistory: history });
  } catch (error) { next(error); }
});

// Dashboard and runtime health
alertRouter.get("/dashboard", async (_request, response) => {
  const [alerts, configurations, mappings, history, datasources] = await Promise.all([
    receivedAlerts.all(), alertConfigurations.all(), alertMappings.all(), alertSyncHistory.all(), alertDatasources.all(),
  ]);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = alerts.filter((item) => new Date(item.receivedAt).getTime() >= dayAgo);
  response.json({
    counts: {
      received24h: recent.length,
      pending: alerts.filter((item) => ["RECEIVED", "PROCESSING", "ENRICHED"].includes(item.processingStatus)).length,
      awaitingManual: alerts.filter((item) => item.syncStatus === "AWAITING_MANUAL").length,
      queued: alerts.filter((item) => item.syncStatus === "QUEUED").length,
      synced24h: recent.filter((item) => item.syncStatus === "SYNCED").length,
      failed: alerts.filter((item) => ["FAILED", "UNKNOWN", "BLOCKED"].includes(item.syncStatus) || item.processingStatus === "FAILED").length,
      duplicates: alerts.filter((item) => item.syncStatus === "DUPLICATE").length,
      unmatched: alerts.filter((item) => item.processingStatus === "UNMATCHED").length,
      enabledConfigurations: configurations.filter((item) => item.enabled).length,
      enabledMappings: mappings.filter((item) => item.enabled).length,
      enabledDatasources: datasources.filter((item) => item.enabled).length,
    },
    snmp: snmpListenerStatus(), worker: alertWorkerStatus(),
    recentAlerts: recent.slice(-10).reverse().map(publicAlert),
    recentSyncHistory: history.slice(-10).reverse().map((item) => publicSyncHistory(item, alerts.find((alert) => alert.id === item.alertId)?.configSnapshot)),
  });
});

// Shared SNMP listener. Secrets are write-only and redacted from responses.
alertRouter.get("/snmp", async (_request, response) => {
  const config = await snmpListenerConfiguration.findById("id", "singleton");
  if (!config) throw httpError(500, "SNMP listener configuration unavailable");
  response.json({ configuration: {
    ...config,
    communities: config.communities.map(({ secretEncrypted, ...item }) => ({ ...item, secretConfigured: Boolean(secretEncrypted) })),
    users: config.users.map(({ authKeyEncrypted, privKeyEncrypted, ...item }) => ({ ...item, authKeyConfigured: Boolean(authKeyEncrypted), privKeyConfigured: Boolean(privKeyEncrypted) })),
  }, status: snmpListenerStatus() });
});
const snmpInputSchema = z.object({
  enabled: z.boolean(), bindAddress: z.string().min(1).max(64), port: z.number().int().min(1).max(65535),
  allowedSources: z.array(z.string().max(128)).max(200), maxMessageBytes: z.number().int().min(484).max(65507),
  logLevel: z.enum(["ERROR", "INFO", "DEBUG"]), versions: z.array(z.enum(["v1", "v2c", "v3"])).max(3),
  communities: z.array(z.object({ name: z.string().trim().min(1).max(128), secret: z.string().max(500).optional(), versions: z.array(z.enum(["v1", "v2c"])).min(1).max(2) }).strict()).max(50),
  users: z.array(z.object({ username: z.string().trim().min(1).max(128), level: z.enum(["noAuthNoPriv", "authNoPriv", "authPriv"]), authProtocol: z.enum(["md5", "sha", "sha224", "sha256", "sha384", "sha512"]), authKey: z.string().max(500).optional(), privProtocol: z.enum(["des", "aes", "aes256"]), privKey: z.string().max(500).optional() }).strict()).max(50),
}).strict();
alertRouter.put("/snmp", async (request, response) => {
  const data = snmpInputSchema.parse(request.body);
  if (!validIpOrCidr(data.bindAddress) || data.bindAddress.includes("/")) throw httpError(400, "Bind address must be an IPv4 or IPv6 address");
  if (data.allowedSources.some((value) => !validIpOrCidr(value))) throw httpError(400, "Invalid SNMP source IP/CIDR allowlist");
  if (new Set(data.versions).size !== data.versions.length || new Set(data.communities.map((item) => item.name)).size !== data.communities.length || new Set(data.users.map((item) => item.username)).size !== data.users.length) throw httpError(400, "SNMP versions, community names and users must be unique");
  const old = await snmpListenerConfiguration.findById("id", "singleton");
  const communities = data.communities.map((item) => {
    const previous = old?.communities.find((current) => current.name === item.name);
    const secret = item.secret || (previous ? decryptSecret(previous.secretEncrypted) : "");
    if (!secret) throw httpError(400, `Community secret is required for ${item.name}`);
    return { name: item.name, versions: item.versions, secretEncrypted: encryptSecret(secret) };
  });
  const users = data.users.map((item) => {
    const previous = old?.users.find((current) => current.username === item.username);
    const authKey = item.authKey || (previous?.authKeyEncrypted ? decryptSecret(previous.authKeyEncrypted) : "");
    const privKey = item.privKey || (previous?.privKeyEncrypted ? decryptSecret(previous.privKeyEncrypted) : "");
    if (item.level !== "noAuthNoPriv" && (!authKey || authKey.length < 8)) throw httpError(400, `SNMPv3 auth key for ${item.username} must be at least 8 characters`);
    if (item.level === "authPriv" && (!privKey || privKey.length < 8)) throw httpError(400, `SNMPv3 privacy key for ${item.username} must be at least 8 characters`);
    if (item.level !== "authPriv" && item.privKey) throw httpError(400, "Privacy keys are only valid with authPriv");
    return { username: item.username, level: item.level, authProtocol: item.authProtocol, privProtocol: item.privProtocol, authKeyEncrypted: item.level === "noAuthNoPriv" ? "" : encryptSecret(authKey), privKeyEncrypted: item.level === "authPriv" ? encryptSecret(privKey) : "" };
  });
  const configuration: SnmpListenerConfiguration = { id: "singleton", enabled: data.enabled, bindAddress: data.bindAddress, port: data.port, allowedSources: data.allowedSources, maxMessageBytes: data.maxMessageBytes, logLevel: data.logLevel, versions: data.versions, communities, users, updatedAt: new Date().toISOString() };
  await snmpListenerConfiguration.replaceAll([configuration]);
  try {
    const status = await restartSnmpListener();
    await audit("UPDATE_SNMP_LISTENER_CONFIGURATION", actor(request), "singleton", { enabled: configuration.enabled, port: configuration.port, versions: configuration.versions, communities: communities.length, users: users.length });
    response.json({ saved: true, status });
  } catch (error) {
    response.status((error as { status?: number }).status || 503).json({ saved: true, message: (error as Error).message, status: snmpListenerStatus() });
  }
});
alertRouter.post("/snmp/start", async (_request, response) => response.json(await startSnmpListener()));
alertRouter.post("/snmp/stop", async (_request, response) => response.json(await stopSnmpListener()));
alertRouter.post("/snmp/restart", async (_request, response) => response.json(await restartSnmpListener()));

// Alert configurations and isolated rule/test previews
alertRouter.get("/configurations", async (_request, response) => response.json((await alertConfigurations.all()).map(publicAlertConfiguration)));
alertRouter.post("/configurations", async (request, response) => response.status(201).json(await saveAlertConfiguration(request.body, actor(request))));
alertRouter.put("/configurations/:id", async (request, response) => response.json(await saveAlertConfiguration(request.body, actor(request), idParam(request.params.id))));
alertRouter.get("/configurations/:id/dependencies", async (request, response) => response.json(await alertConfigurationDependencies(idParam(request.params.id))));
alertRouter.delete("/configurations/:id", async (request, response) => {
  const id = idParam(request.params.id);
  const dependencies = await alertConfigurationDependencies(id);
  if (dependencies.enrichmentRules || dependencies.mappings) throw httpError(409, "Remove dependent enrichment rules and mappings before deleting this configuration");
  await alertConfigurations.mutate((rows) => { const index = rows.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, "Alert Configuration not found"); rows.splice(index, 1); });
  await audit("DELETE_ALERT_CONFIGURATION", actor(request), id, { retainedAlerts: dependencies.retainedAlerts });
  response.status(204).end();
});
alertRouter.post("/configurations/:id/preview", async (request, response) => {
  const config = await alertConfigurations.findById("id", idParam(request.params.id));
  if (!config) throw httpError(404, "Alert Configuration not found");
  const body = z.object({ payload: z.record(z.string(), z.unknown()) }).strict().parse(request.body);
  const payload = sanitizeValue(body.payload) as Record<string, AlertValue>;
  const matched = evaluateAlertGroup(payload, config.match);
  const fields = createAlertFields(config, payload);
  response.json({ matched, subject: renderAlertSubject(config, { ...payload, ...fields }), fields: redactAlertFields(fields, config), requiredMissing: config.fields.filter((item) => item.required && (fields[item.name] === null || fields[item.name] === "")).map((item) => item.name), routePriority: config.priority, productionSync: false });
});

alertRouter.get("/configurations/:id/test-sessions", async (request, response) => {
  const id = idParam(request.params.id);
  const config = await alertConfigurations.findById("id", id);
  const sessions = (await alertTestSessions.all()).filter((item) => item.alertConfigId === id).map((item) => publicTestSession(item, config));
  response.json(sessions);
});
alertRouter.post("/configurations/:id/test-sessions", async (request, response) => {
  const id = idParam(request.params.id);
  const config = await alertConfigurations.findById("id", id);
  if (!config) throw httpError(404, "Alert Configuration not found");
  if (config.type === "SNMP" && config.enabled) throw httpError(409, "Disable this SNMP Alert Configuration before opening an isolated test session");
  const token = randomUUID() + randomUUID();
  const now = Date.now();
  const session = { id: randomUUID(), alertConfigId: id, transport: config.type, tokenHash: createHash("sha256").update(token).digest("hex"), sourceIp: clientIp(request), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), capture: null };
  await alertTestSessions.mutate((rows) => { rows.push(session); });
  await audit("CREATE_ALERT_TEST_SESSION", actor(request), session.id, { configId: id, transport: config.type });
  response.setHeader("Cache-Control", "no-store");
  response.status(201).json({ id: session.id, token, transport: session.transport, expiresAt: session.expiresAt, ingestPath: `/api/v1/alerts/ingest/${id}/test/${session.id}` });
});
alertRouter.get("/test-sessions/:sessionId", async (request, response) => {
  const session = await alertTestSessions.findById("id", idParam(request.params.sessionId));
  if (!session) throw httpError(404, "Test session not found");
  const config = await alertConfigurations.findById("id", session.alertConfigId);
  response.json({ ...publicTestSession(session, config), preview: session.capture ? publicTestSession(session, config).capture : null, productionSync: false });
});
alertRouter.delete("/test-sessions/:sessionId", async (request, response) => {
  const id = idParam(request.params.sessionId);
  await alertTestSessions.mutate((rows) => { const index = rows.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, "Test session not found"); rows.splice(index, 1); });
  await audit("CLOSE_ALERT_TEST_SESSION", actor(request), id);
  response.status(204).end();
});

// Datasources and enrichment rules
alertRouter.get("/datasources", async (_request, response) => response.json((await alertDatasources.all()).map(publicDatasource)));
alertRouter.post("/datasources/upload", async (request, response) => response.status(201).json(await uploadAlertDatasource(request.body)));
alertRouter.post("/datasources", async (request, response) => response.status(201).json(await saveAlertDatasource(request.body, actor(request))));
alertRouter.put("/datasources/:id", async (request, response) => response.json(await saveAlertDatasource(request.body, actor(request), idParam(request.params.id))));
alertRouter.post("/datasources/:id/preview", async (request, response) => response.json(await previewAlertDatasource(idParam(request.params.id), request.body?.parameters)));
alertRouter.get("/datasources/:id/preview", async (request, response) => response.json(await previewAlertDatasource(idParam(request.params.id))));
alertRouter.delete("/datasources/:id", async (request, response) => {
  const id = idParam(request.params.id);
  if ((await alertEnrichmentRules.all()).some((item) => item.datasourceId === id)) throw httpError(409, "Datasource is used by an enrichment rule");
  await alertDatasources.mutate((rows) => { const index = rows.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, "Datasource not found"); rows.splice(index, 1); });
  await audit("DELETE_ALERT_DATASOURCE", actor(request), id);
  response.status(204).end();
});
alertRouter.get("/enrichment-rules", async (_request, response) => response.json(await alertEnrichmentRules.all()));
alertRouter.post("/enrichment-rules", async (request, response) => response.status(201).json(await saveEnrichmentRule(request.body, actor(request))));
alertRouter.put("/enrichment-rules/:id", async (request, response) => response.json(await saveEnrichmentRule(request.body, actor(request), idParam(request.params.id))));
alertRouter.delete("/enrichment-rules/:id", async (request, response) => {
  const id = idParam(request.params.id);
  await alertEnrichmentRules.mutate((rows) => { const index = rows.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, "Enrichment rule not found"); rows.splice(index, 1); });
  await audit("DELETE_ALERT_ENRICHMENT_RULE", actor(request), id);
  response.status(204).end();
});
alertRouter.post("/alerts/:id/enrichment-preview", async (request, response) => {
  const alert = await receivedAlerts.findById("id", idParam(request.params.id));
  if (!alert) throw httpError(404, "Alert not found");
  const result = await enrichAlertFields(alert);
  response.json({ ...result, fields: redactAlertFields(result.fields, alert.configSnapshot), productionSync: false });
});

// Alert-to-Genesys mappings
alertRouter.get("/mappings", async (_request, response) => response.json(await alertMappings.all()));
alertRouter.get("/contact-lists", async (_request, response) => response.json((await contactLists()).map((item) => ({ id: item.contactListId, name: item.name, regionId: item.regionId }))));
alertRouter.post("/mappings", async (request, response) => response.status(201).json(await saveAlertMapping(request.body, actor(request))));
alertRouter.put("/mappings/:id", async (request, response) => response.json(await saveAlertMapping(request.body, actor(request), idParam(request.params.id))));
alertRouter.delete("/mappings/:id", async (request, response) => {
  const id = idParam(request.params.id);
  if ((await receivedAlerts.all()).some((item) => item.mappingId === id && ["SYNCING", "QUEUED"].includes(item.syncStatus))) throw httpError(409, "Mapping has queued or active syncs");
  await alertMappings.mutate((rows) => { const index = rows.findIndex((item) => item.id === id); if (index < 0) throw httpError(404, "Mapping not found"); rows.splice(index, 1); });
  await audit("DELETE_ALERT_MAPPING", actor(request), id);
  response.status(204).end();
});

// Inbox, sync, retry and auditable history
alertRouter.get("/inbox/:id", async (request, response, next) => {
  try {
    const alert = await receivedAlerts.findById("id", idParam(request.params.id));
    if (!alert) throw httpError(404, "Alert not found");
    const history = (await alertSyncHistory.all()).filter((item) => item.alertId === alert.id).map((item) => publicSyncHistory(item, alert.configSnapshot));
    response.json({ ...publicAlert(alert), syncHistory: history });
  } catch (error) { next(error); }
});
alertRouter.get("/inbox", async (request, response) => {
  const options = pageOptions(request.query as Record<string, unknown>);
  const filter = z.object({ transport: z.enum(["SNMP", "API"]).optional(), processingStatus: z.string().max(40).optional(), syncStatus: z.string().max(40).optional(), configId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(request.query);
  let items = await receivedAlerts.all();
  if (filter.transport) items = items.filter((item) => item.transport === filter.transport);
  if (filter.processingStatus) items = items.filter((item) => item.processingStatus === filter.processingStatus);
  if (filter.syncStatus) items = items.filter((item) => item.syncStatus === filter.syncStatus);
  if (filter.configId) items = items.filter((item) => item.configId === filter.configId);
  if (filter.from) items = items.filter((item) => item.receivedAt >= filter.from!);
  if (filter.to) items = items.filter((item) => item.receivedAt <= filter.to!);
  const searched = filterSearch(items as unknown as Record<string, unknown>[], options.search) as unknown as typeof items;
  const result = page(searched.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), options);
  response.json({ ...result, items: result.items.map(publicAlert) });
});
alertRouter.post("/inbox/:id/mapping-preview", async (request, response) => {
  const data = z.object({ mappingId: z.string().uuid() }).strict().parse(request.body);
  const result = await previewAlertMapping(idParam(request.params.id), data.mappingId);
  const alert = await receivedAlerts.findById("id", idParam(request.params.id));
  response.json({ ...result, originalAlert: redactAlertFields(result.originalAlert, alert?.configSnapshot), enrichedAlert: redactAlertFields(result.enrichedAlert, alert?.configSnapshot), mappedContact: redactAlertFields(result.mappedContact as Record<string, AlertValue>, alert?.configSnapshot), productionSync: false });
});
alertRouter.post("/inbox/:id/sync", async (request, response) => {
  const data = z.object({ mappingId: z.string().uuid(), confirm: z.literal(true) }).strict().parse(request.body);
  response.status(202).json(await syncAlert(idParam(request.params.id), data.mappingId, actor(request), "MANUAL"));
});
alertRouter.post("/inbox/sync-bulk", async (request, response) => {
  const data = z.object({ alertIds: z.array(z.string().uuid()).min(1).max(100), mappingId: z.string().uuid(), confirm: z.literal(true) }).strict().parse(request.body);
  response.status(202).json(await syncAlerts(data.alertIds, data.mappingId, actor(request)));
});
alertRouter.post("/inbox/:id/retry", async (request, response) => response.status(202).json(await retryAlertSync(idParam(request.params.id), actor(request))));
alertRouter.post("/inbox/:id/reconcile", async (request, response) => {
  const data = z.object({ outcome: z.enum(["FOUND", "NOT_FOUND"]), contactId: z.string().max(200).default("") }).strict().parse(request.body);
  response.json(await reconcileAlertSync(idParam(request.params.id), data.outcome, data.contactId, actor(request)));
});
alertRouter.post("/inbox/:id/retry-processing", async (request, response) => response.status(202).json(await retryAlertProcessing(idParam(request.params.id), actor(request))));
alertRouter.post("/inbox/:id/select-mapping", async (request, response) => {
  const id = idParam(request.params.id);
  const { mappingId } = z.object({ mappingId: z.string().uuid() }).strict().parse(request.body);
  await resolveAlertMapping(id, mappingId, actor(request));
  const alert = await receivedAlerts.findById("id", id);
  response.json(publicAlert(alert!));
});

alertRouter.get("/sync-history", async (request, response) => {
  const options = pageOptions(request.query as Record<string, unknown>);
  const status = typeof request.query.status === "string" ? request.query.status : "";
  const syncType = typeof request.query.syncType === "string" ? request.query.syncType : "";
  let items = (await alertSyncHistory.all()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (status) items = items.filter((item) => item.status === status);
  if (syncType) items = items.filter((item) => item.syncType === syncType);
  items = filterSearch(items as unknown as Record<string, unknown>[], options.search) as unknown as typeof items;
  const alerts = await receivedAlerts.all();
  const sanitized = items.map((item) => publicSyncHistory(item, alerts.find((alert) => alert.id === item.alertId)?.configSnapshot));
  response.json(page(sanitized, options));
});
alertRouter.get("/sync-history/export", async (request, response) => {
  const records = (await alertSyncHistory.all()).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10000);
  const alerts = await receivedAlerts.all();
  const headers = ["startedAt", "completedAt", "correlationId", "alertId", "alertConfigName", "mappingName", "contactListId", "syncType", "status", "genesysContactId", "attempt", "error", "initiatedBy"];
  const quote = (value: unknown) => `"${String(value ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`;
  const csv = [headers.map(quote).join(","), ...records.map((row) => {
    const safe = publicSyncHistory(row, alerts.find((alert) => alert.id === row.alertId)?.configSnapshot);
    return headers.map((key) => quote((safe as unknown as Record<string, unknown>)[key])).join(",");
  })].join("\r\n");
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", 'attachment; filename="alert-sync-history.csv"');
  response.send(`\uFEFF${csv}`);
});

export const alertIngestRouter = Router();
alertIngestRouter.use(ingestLimiter);
alertIngestRouter.post("/:configId", async (request, response) => {
  const configId = Array.isArray(request.params.configId) ? request.params.configId[0] : request.params.configId;
  const config = await alertConfigurations.findById("id", idParam(configId));
  if (!config || !config.enabled || config.type !== "API") throw httpError(404, "Alert endpoint not found or disabled");
  authenticateIngest(config, request);
  const sourceIp = clientIp(request);
  if (!ipAllowed(sourceIp, config.allowedSources)) throw httpError(403, "Alert source address is not allowed");
  const fields = sanitizeValue(request.body) as Record<string, AlertValue>;
  const result = await acceptAlert({ transport: "API", sourceIp, sourcePort: request.socket.remotePort || 0, raw: fields, fields, configId: config.id });
  if (!result.matched) throw httpError(422, "Payload does not match this Alert Configuration");
  response.status(202).json(result);
});
alertIngestRouter.post("/:configId/test/:sessionId", testLimiter, async (request, response) => {
  const configId = Array.isArray(request.params.configId) ? request.params.configId[0] : request.params.configId;
  const sessionId = Array.isArray(request.params.sessionId) ? request.params.sessionId[0] : request.params.sessionId;
  const config = await alertConfigurations.findById("id", idParam(configId));
  const session = await alertTestSessions.findById("id", idParam(sessionId));
  if (!config || !session || session.alertConfigId !== config.id || session.transport !== "API" || new Date(session.expiresAt).getTime() <= Date.now()) throw httpError(404, "Alert test endpoint expired or unavailable");
  if (config.type !== "API") throw httpError(404, "API test endpoint is unavailable for this configuration");
  const token = (request.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(createHash("sha256").update(token).digest("hex"), session.tokenHash)) throw httpError(401, "Invalid alert test-session credential");
  const sourceIp = clientIp(request);
  if (session.sourceIp !== sourceIp && !ipAllowed(sourceIp, config.allowedSources)) throw httpError(403, "Test source address is not allowed");
  const raw = (request as typeof request & { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(request.body ?? {}));
  if (raw.byteLength > config.api.maxBodyBytes) throw httpError(413, "Alert payload exceeds this endpoint's configured size limit");
  const fields = sanitizeValue(request.body) as Record<string, AlertValue>;
  await acceptAlert({ transport: "API", sourceIp, sourcePort: request.socket.remotePort || 0, raw: fields, fields, configId: config.id, testSessionId: session.id });
  response.setHeader("Cache-Control", "no-store");
  response.status(202).json({ accepted: true, test: true, productionSync: false, sessionId: session.id });
});
