import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dataDir, backupsDir } from "./json-repository";
import {
  sourceIntegrations,
  importStates,
  sourceMappings,
  leadDefinitions,
  importSchedules,
  importJobs,
  sourceObservations,
  contactListConfigurations,
} from "./pipeline-store";
import type {
  ContactListConfiguration,
  LeadDefinition,
  SourceIntegration,
  SourceMapping,
} from "./pipeline-types";
import { audit, readAuditLog, replaceAuditLog } from "./store";
import { alertRepositories, alertUploadDir } from "./alert-store";
import type {
  AlertConfiguration,
  AlertDatasource,
  AlertEnrichmentRule,
  AlertMapping,
  AlertSyncHistory,
  AlertTestSession,
  ReceivedAlert,
  SnmpListenerConfiguration,
} from "./alert-types";
export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
export async function createBackup(): Promise<{
  directory: string;
  files: string[];
}> {
  await importStates.flush();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 17);
  const directory = path.join(backupsDir, stamp);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(path.join(dataDir, name), path.join(directory, name));
    files.push(name);
  }
  const configDir = path.join(dataDir, "config");
  await mkdir(path.join(directory, "config"), { recursive: true });
  for (const name of await readdir(configDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(
      path.join(configDir, name),
      path.join(directory, "config", name),
    );
    files.push(`config/${name}`);
  }
  const sourceFiles = path.join(dataDir, "source-files");
  await mkdir(sourceFiles, { recursive: true });
  await mkdir(path.join(directory, "source-files"), { recursive: true });
  const referencedFiles = new Set(
    (await sourceIntegrations.all())
      .filter(
        (source) =>
          ["CSV", "JSON"].includes(source.kind) &&
          (source.config.fileLocation ||
            (source.config.fileId ? "UPLOAD" : "SERVER")) === "UPLOAD",
      )
      .map((source) => (source.config.fileId || source.id) + ".txt"),
  );
  for (const name of await readdir(sourceFiles)) {
    if (!/^[a-f0-9-]{36}\.txt$/i.test(name)) continue;
    if (!referencedFiles.has(name)) continue;
    await copyFile(
      path.join(sourceFiles, name),
      path.join(directory, "source-files", name),
    );
    files.push(`source-files/${name}`);
  }
  const alertFiles = path.join(dataDir, "alert-datasources");
  try { await readdir(alertFiles); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    await mkdir(path.join(directory, "alert-datasources"), { recursive: true });
    const referencedAlertFiles = new Set(
      (await (await import("./alert-store")).alertDatasources.all())
        .filter((source) => source.kind === "FILE" && source.storedFile)
        .map((source) => source.storedFile),
    );
    for (const name of await readdir(alertFiles)) {
      if (!/^[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(name) || !referencedAlertFiles.has(name)) continue;
      await copyFile(alertFilePath(alertFiles, name), alertFilePath(path.join(directory, "alert-datasources"), name));
      files.push(`alert-datasources/${name}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { directory: stamp, files };
}

function alertFilePath(directory: string, name: string) {
  return path.join(directory, name);
}

function redactBackupValue(value: unknown, key = "", sensitive = new Set<string>()): unknown {
  if (/(?:password|secret|token|citizen.?id|national.?id|phone|mobile|email)/i.test(key)) {
    const text = String(value ?? "");
    return text.length <= 4 ? "•".repeat(text.length) : `${"•".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
  }
  if (sensitive.has(key)) {
    const text = String(value ?? "");
    return text.length <= 4 ? "•".repeat(text.length) : `${"•".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
  }
  if (Array.isArray(value)) return value.map((item) => redactBackupValue(item, "", sensitive));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactBackupValue(item, name, sensitive)]));
  return value;
}

export async function downloadBackup(stamp: string) {
  if (!/^\d{17}$/.test(stamp)) throw httpError(400, "Invalid backup ID");
  const directory = path.join(backupsDir, stamp);
  const files: Record<string, unknown> = {};
  try { files["manifest.json"] = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const name of await readdir(directory)) {
    if (name.endsWith(".json") && name !== "manifest.json")
      files[name] = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      );
  }
  if (Array.isArray(files["source-integrations.json"])) {
    files["source-integrations.json"] = (
      files["source-integrations.json"] as Record<string, unknown>[]
    ).map(({ secretEncrypted, ...source }) => ({
      ...source,
      secretConfigured: false,
    }));
  }
  try {
    for (const name of await readdir(path.join(directory, "source-files"))) {
      if (/^[a-f0-9-]{36}\.txt$/i.test(name))
        files[`source-files/${name}`] = await readFile(
          path.join(directory, "source-files", name),
          "utf8",
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configDir = path.join(directory, "config");
  for (const name of await readdir(configDir)) {
    if (name.endsWith(".json")) {
      const value = JSON.parse(
        await readFile(path.join(configDir, name), "utf8"),
      ) as Record<string, unknown>;
      if (name === "genesys.json") {
        delete value.clientId;
        delete value.clientSecretEncrypted;
      }
      files[`config/${name}`] = value;
    }
  }
  const secretFreeConfiguration = (value: Record<string, unknown>) => {
    const api = value.api && typeof value.api === "object" ? value.api as Record<string, unknown> : {};
    const { tokenEncrypted, hmacSecretEncrypted, ...publicApi } = api;
    return { ...value, api: { ...publicApi, tokenConfigured: Boolean(tokenEncrypted), hmacSecretConfigured: Boolean(hmacSecretEncrypted) } };
  };
  if (Array.isArray(files["alert-configurations.json"]))
    files["alert-configurations.json"] = (files["alert-configurations.json"] as Record<string, unknown>[]).map((item) => ({ ...secretFreeConfiguration(item), enabled: false }));
  if (Array.isArray(files["received-alerts.json"]))
    files["received-alerts.json"] = (files["received-alerts.json"] as Record<string, unknown>[]).map((item) => {
      const snapshot = item.configSnapshot && typeof item.configSnapshot === "object" ? item.configSnapshot as Record<string, unknown> : null;
       const sensitiveFields = new Set<string>();
       if (Array.isArray(snapshot?.fields)) for (const field of snapshot.fields as Record<string, unknown>[]) {
         if (field.sensitive !== true) continue;
         for (const name of [field.name, field.source, String(field.source || "").split(".").at(-1)]) if (name) sensitiveFields.add(String(name));
       }
      return {
        ...item,
        configSnapshot: snapshot ? { ...secretFreeConfiguration(snapshot), enabled: false } : null,
        raw: redactBackupValue(item.raw, "", sensitiveFields),
        originalFields: redactBackupValue(item.originalFields, "", sensitiveFields),
        enrichedFields: redactBackupValue(item.enrichedFields, "", sensitiveFields),
        mappedContact: redactBackupValue(item.mappedContact, "", sensitiveFields),
      };
    });
  if (Array.isArray(files["alert-sync-history.json"]))
    files["alert-sync-history.json"] = (files["alert-sync-history.json"] as Record<string, unknown>[]).map((item) => {
      const alert = (files["received-alerts.json"] as Record<string, unknown>[] | undefined)?.find((row) => row.id === item.alertId);
      const snapshot = alert?.configSnapshot && typeof alert.configSnapshot === "object" ? alert.configSnapshot as Record<string, unknown> : null;
      const sensitive = new Set(Array.isArray(snapshot?.fields) ? (snapshot!.fields as Record<string, unknown>[]).filter((field) => field.sensitive).map((field) => String(field.name)) : []);
      return { ...item, payload: redactBackupValue(item.payload, "", sensitive), responseMetadata: redactBackupValue(item.responseMetadata, "", sensitive) };
    });
  if (Array.isArray(files["lead-import-jobs.json"]))
    files["lead-import-jobs.json"] = (files["lead-import-jobs.json"] as Record<string, unknown>[]).map((item) => ({ ...item, results: redactBackupValue(item.results), message: redactBackupValue(item.message) }));
  if (Array.isArray(files["alert-mappings.json"]))
    files["alert-mappings.json"] = (files["alert-mappings.json"] as Record<string, unknown>[]).map((item) => ({ ...item, autoImport: false }));
  if (Array.isArray(files["snmp-listener-configuration.json"]))
    files["snmp-listener-configuration.json"] = (files["snmp-listener-configuration.json"] as Record<string, unknown>[]).map((item) => {
      const communities = Array.isArray(item.communities) ? item.communities as Record<string, unknown>[] : [];
      const users = Array.isArray(item.users) ? item.users as Record<string, unknown>[] : [];
      return {
        ...item,
        enabled: false,
        communities: communities.map(({ secretEncrypted, ...community }) => ({ ...community, secretConfigured: Boolean(secretEncrypted) })),
        users: users.map(({ authKeyEncrypted, privKeyEncrypted, ...user }) => ({ ...user, authKeyConfigured: Boolean(authKeyEncrypted), privKeyConfigured: Boolean(privKeyEncrypted) })),
      };
    });
  if (Array.isArray(files["alert-datasources.json"]))
    files["alert-datasources.json"] = (files["alert-datasources.json"] as Record<string, unknown>[]).map((item) => ({ ...item, enabled: false }));
  if (Array.isArray(files["alert-enrichment-rules.json"]))
    files["alert-enrichment-rules.json"] = (files["alert-enrichment-rules.json"] as Record<string, unknown>[]).map((item) => ({ ...item, enabled: false }));
  // Test-session bearer secrets are intentionally not portable across backups.
  if (Array.isArray(files["alert-test-sessions.json"])) files["alert-test-sessions.json"] = [];
  try {
    for (const name of await readdir(path.join(directory, "alert-datasources"))) {
      if (/^[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(name))
        files[`alert-datasources/${name}`] = (await readFile(path.join(directory, "alert-datasources", name))).toString("base64");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

export async function writeBackupManifest(
  stamp: string,
  files: string[],
): Promise<void> {
  const directory = path.join(backupsDir, stamp);
  if (!files.includes("manifest.json")) files.push("manifest.json");
  const contents = JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2);
  await writeFile(
    path.join(directory, "manifest.json"),
    `${contents}\n`,
    "utf8",
  );
  for (const file of files) {
    if (file === "manifest.json") continue;
    try { await readFile(path.join(directory, file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Backup manifest lists missing file: ${file}`);
    }
  }
}

const recordId = z.string().uuid();
const alertEntity = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
});
const alertValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(100000), z.number().finite(), z.boolean(), z.null(),
  z.array(alertValueSchema).max(1000),
  z.record(z.string().max(256), alertValueSchema),
]));
const alertFieldName = z.string().trim().min(1).max(128).refine((value) => !["__proto__", "prototype", "constructor"].includes(value) && !/[\x00-\x1f]/.test(value));
const alertConditionSchema = z.object({ field: z.string().min(1).max(256), operator: z.enum(["EQ", "NE", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "IN_LIST", "REGEX", "EXISTS", "NOT_EXISTS"]), value: z.string().max(2000).optional() }).strict();
const alertGroupSchema = z.object({ match: z.enum(["ALL", "ANY"]), conditions: z.array(alertConditionSchema).max(30) }).strict();
const alertConfigSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), description: z.string().max(1000), type: z.enum(["SNMP", "API"]), enabled: z.boolean(), priority: z.number().int().min(0).max(100000), defaultSubject: z.string().min(1).max(300),
  match: alertGroupSchema, subjectRules: z.array(z.object({ match: alertGroupSchema, subject: z.string().min(1).max(300) }).strict()).max(50),
  fields: z.array(z.object({ name: alertFieldName, source: z.string().min(1).max(256), type: z.enum(["STRING", "NUMBER", "DATE", "BOOLEAN", "PHONE"]), required: z.boolean(), defaultValue: z.string().max(2000), description: z.string().max(500), sensitive: z.boolean().optional(), extract: z.object({ mode: z.enum(["FULL", "REGEX", "BETWEEN"]), expression: z.string().max(200), after: z.string().max(100), group: z.number().int().min(0).max(10) }).optional() }).strict()).max(200),
  duplicateField: z.string().max(256), duplicateWindowSeconds: z.number().int().min(0).max(2592000), allowedSources: z.array(z.string().max(128)).max(200),
  api: z.object({ auth: z.enum(["BEARER", "API_KEY", "HMAC"]), tokenEncrypted: z.string().max(2048).optional(), hmacSecretEncrypted: z.string().max(2048).optional(), tokenConfigured: z.boolean().optional(), hmacSecretConfigured: z.boolean().optional(), maxBodyBytes: z.number().int().min(1024).max(5 * 1024 * 1024) }).strict(),
  createdAt: z.string().max(100), updatedAt: z.string().max(100),
}).strict();
const alertBackupSchemas: Record<string, z.ZodType> = {
  "alert-configurations.json": z.array(alertConfigSchema.extend({ api: alertConfigSchema.shape.api.extend({ tokenConfigured: z.boolean().optional(), hmacSecretConfigured: z.boolean().optional() }) })).max(10000),
  "alert-datasources.json": z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), description: z.string().max(1000), kind: z.enum(["FILE", "DATABASE", "QUERY"]), enabled: z.boolean(), fileName: z.string().max(255), storedFile: z.string().max(64), fileId: z.string().uuid().or(z.literal("")), worksheet: z.string().max(128), sourceId: z.string().uuid(), query: z.string().max(20000), keyColumn: z.string().max(128), columns: z.array(z.string().max(128)).max(500), updatedBy: z.string().max(200), health: z.enum(["UNKNOWN", "AVAILABLE", "ERROR"]), healthCheckedAt: z.string().max(100), healthMessage: z.string().max(500), createdAt: z.string().max(100), updatedAt: z.string().max(100) }).strict()).max(10000),
  "alert-enrichment-rules.json": z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), description: z.string().max(1000), enabled: z.boolean(), priority: z.number().int().min(0).max(100000), alertConfigId: z.string().uuid(), datasourceId: z.string().uuid(), lookup: z.array(z.object({ alertField: z.string().min(1).max(128), column: z.string().min(1).max(128) }).strict()).min(1).max(20), outputs: z.array(z.object({ name: alertFieldName, kind: z.enum(["COLUMN", "CONCAT", "STATIC", "UPPER", "LOWER", "TRIM"]), columns: z.array(z.string().max(128)).max(20), value: z.string().max(2000), required: z.boolean(), defaultValue: z.string().max(2000), overwrite: z.boolean() }).strict()).min(1).max(100), notFound: z.enum(["KEEP", "DEFAULT", "FAIL"]), onError: z.enum(["SKIP", "FAIL"]), createdAt: z.string().max(100), updatedAt: z.string().max(100) }).strict()).max(10000),
  "alert-mappings.json": z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), description: z.string().max(1000), enabled: z.boolean(), priority: z.number().int().min(0).max(100000), alertConfigId: z.string().uuid(), contactListId: z.string().min(1).max(200), contactListName: z.string().max(300), regionId: z.string().max(100), fields: z.array(z.object({ target: alertFieldName, sourceType: z.enum(["ALERT", "ENRICHMENT", "SYSTEM", "STATIC"]), source: z.string().max(256), value: z.string().max(2000), required: z.boolean() }).strict()).max(200), phoneField: alertFieldName, uniqueField: z.string().max(128), duplicateWindowSeconds: z.number().int().min(0).max(2592000), duplicateBehavior: z.enum(["SKIP", "MANUAL_REVIEW", "ALLOW_NEW"]), autoImport: z.boolean(), createdAt: z.string().max(100), updatedAt: z.string().max(100) }).strict()).max(10000),
  "received-alerts.json": z.array(z.object({ id: z.string().uuid(), correlationId: z.string().uuid(), transport: z.enum(["SNMP", "API"]), receivedAt: z.string().max(100), sourceIp: z.string().max(128), sourcePort: z.number().int().min(0).max(65535), configId: z.string().uuid().or(z.literal("")), configName: z.string().max(120), configSnapshot: alertConfigSchema.extend({ api: alertConfigSchema.shape.api.extend({ tokenConfigured: z.boolean().optional(), hmacSecretConfigured: z.boolean().optional() }) }).nullable(), subject: z.string().max(300), matchResult: z.string().max(500), raw: alertValueSchema, originalFields: z.record(z.string().max(256), alertValueSchema), enrichedFields: z.record(z.string().max(256), alertValueSchema), enrichmentStatus: z.enum(["NOT_STARTED", "SUCCESS", "PARTIAL", "FAILED"]), processingStatus: z.enum(["RECEIVED", "PROCESSING", "ENRICHED", "READY_FOR_SYNC", "FAILED", "DUPLICATE", "REJECTED", "UNMATCHED"]), syncStatus: z.enum(["QUEUED", "AWAITING_MANUAL", "SYNCING", "SYNCED", "FAILED", "UNKNOWN", "DUPLICATE", "BLOCKED"]), mappingId: z.string().uuid().or(z.literal("")), mappingName: z.string().max(120), mappedContact: z.record(z.string().max(128), z.string().max(10000)), duplicateOf: z.string().uuid().or(z.literal("")), eventKey: z.string().max(128), attempts: z.number().int().min(0).max(100000), processingAttempts: z.number().int().min(0).max(100000).optional(), syncAttempts: z.number().int().min(0).max(100000).optional(), retryAt: z.string().max(100), lastError: z.string().max(1000), genesysContactId: z.string().max(200), syncInitiatedBy: z.string().max(200), updatedAt: z.string().max(100) }).strict()).max(100000),
  "alert-sync-history.json": z.array(z.object({ id: z.string().uuid(), alertId: z.string().uuid(), correlationId: z.string().uuid(), alertConfigId: z.string().uuid().or(z.literal("")), alertConfigName: z.string().max(120), mappingId: z.string().uuid().or(z.literal("")), mappingName: z.string().max(120), contactListId: z.string().max(200), contactListName: z.string().max(300), syncType: z.enum(["AUTO", "MANUAL"]), startedAt: z.string().max(100), completedAt: z.string().max(100), status: z.enum(["QUEUED", "AWAITING_MANUAL", "SYNCING", "SYNCED", "FAILED", "UNKNOWN", "DUPLICATE", "BLOCKED"]), genesysContactId: z.string().max(200), attempt: z.number().int().min(0).max(100000), error: z.string().max(1000), initiatedBy: z.string().max(200), payload: z.record(z.string().max(128), z.string().max(10000)), responseMetadata: z.record(z.string().max(128), alertValueSchema) }).strict()).max(100000),
  "alert-test-sessions.json": z.array(z.object({ id: z.string().uuid(), alertConfigId: z.string().uuid(), transport: z.enum(["SNMP", "API"]), tokenHash: z.string().max(128), sourceIp: z.string().max(128), createdAt: z.string().max(100), expiresAt: z.string().max(100), capture: z.object({ receivedAt: z.string().max(100), sourceIp: z.string().max(128), raw: alertValueSchema, fields: z.record(z.string().max(256), alertValueSchema) }).nullable() }).strict()).max(10000),
  "snmp-listener-configuration.json": z.array(z.object({ id: z.literal("singleton"), enabled: z.boolean(), bindAddress: z.string().max(64), port: z.number().int().min(1).max(65535), allowedSources: z.array(z.string().max(128)).max(200), maxMessageBytes: z.number().int().min(484).max(65507), logLevel: z.enum(["ERROR", "INFO", "DEBUG"]), versions: z.array(z.enum(["v1", "v2c", "v3"])).max(3), communities: z.array(z.object({ name: z.string().min(1).max(128), secretEncrypted: z.string().max(2048).optional(), secretConfigured: z.boolean().optional(), versions: z.array(z.enum(["v1", "v2c"])).min(1).max(2) }).strict()).max(50), users: z.array(z.object({ username: z.string().min(1).max(128), level: z.enum(["noAuthNoPriv", "authNoPriv", "authPriv"]), authProtocol: z.enum(["md5", "sha", "sha224", "sha256", "sha384", "sha512"]), authKeyEncrypted: z.string().max(2048).optional(), authKeyConfigured: z.boolean().optional(), privProtocol: z.enum(["des", "aes", "aes256"]), privKeyEncrypted: z.string().max(2048).optional(), privKeyConfigured: z.boolean().optional() }).strict()).max(50), updatedAt: z.string().max(100) }).strict()).max(1),
};
const optionalBackupSchemas: Record<string, z.ZodType> = {
  "manifest.json": z.object({ createdAt: z.string().max(100), files: z.array(z.string().max(256)).max(1000) }).strict(),
  "audit-log.json": z.array(z.object({ id: z.string().max(100), action: z.string().max(200), actor: z.string().max(200), target: z.string().max(300), detail: z.record(z.string().max(128), z.unknown()), timestamp: z.string().max(100) }).strict()).max(5000),
  "lead-import-states.json": z.array(z.object({ id: z.string().max(1000), mappingId: recordId, sourceKey: z.string().max(1000), contactListId: z.string().max(200), contactId: z.string().max(200), payloadHash: z.string().max(256), status: z.enum(["PENDING", "SYNCED", "FAILED", "UNKNOWN"]), message: z.string().max(2000), updatedAt: z.string().max(100) }).strict()).max(1000000),
  "lead-import-jobs.json": z.array(z.object({ id: recordId, leadId: recordId, leadName: z.string().max(120), reimport: z.boolean().optional(), sourceId: recordId.optional(), contactListId: z.string().max(200), scheduleId: z.string().max(100), status: z.enum(["RUNNING", "SUCCESS", "PARTIAL", "FAILED", "INTERRUPTED"]), total: z.number().int().min(0), processed: z.number().int().min(0), created: z.number().int().min(0), updated: z.number().int().min(0), skipped: z.number().int().min(0), failed: z.number().int().min(0), message: z.string().max(2000), results: z.array(z.object({ id: z.string().max(100), sourceKey: z.string().max(1000), status: z.string().max(100), message: z.string().max(2000) }).strict()).max(100000), createdAt: z.string().max(100), finishedAt: z.string().max(100) }).strict()).max(100000),
  "source-observations.json": z.array(z.object({ id: recordId, status: z.enum(["ACTIVE", "INACTIVE", "ERROR"]), checkedAt: z.string().max(100), message: z.string().max(1000) }).strict()).max(100000),
};
const fieldName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !["__proto__", "prototype", "constructor"].includes(value) &&
      !/[\x00-\x1f]/.test(value),
  );
const sourceSchema = z.object({
  id: recordId,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["JDBC", "WEB", "CSV", "JSON"]),
  config: z
    .object({
      jdbcUrl: z.string().max(4000).optional(),
      driverClass: z.string().max(250).optional(),
      username: z.string().max(200).optional(),
      query: z.string().max(20000).optional(),
      queryParameters: z.record(z.string(), z.string().max(2000)).optional(),
      table: z.string().max(500).optional(),
      uri: z.string().max(4000).optional(),
      method: z.enum(["GET", "POST"]).optional(),
      auth: z.enum(["NONE", "BASIC", "BEARER", "API_KEY"]).optional(),
      headerName: z.string().max(100).optional(),
      requestBody: z.string().max(100000).optional(),
      resultPath: z.string().max(500).optional(),
      fileName: z.string().max(300).optional(),
      fileId: recordId.optional(),
      delimiter: z.enum([",", ";", "\t", ""]).optional(),
      fileLocation: z.enum(["SERVER", "REMOTE"]).optional(),
      serverPath: z.string().max(2000).optional(),
      transferProtocol: z.enum(["SCP", "SFTP", "FTP", "FTPS"]).optional(),
      host: z.string().max(253).optional(),
      sshHostKeyFingerprint: z.string().max(128).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      remotePath: z.string().max(2000).optional(),
      authMethod: z.enum(["PASSWORD", "KEY"]).optional(),
      keyFileName: z.string().max(255).optional(),
      allowInsecureFtp: z.boolean().optional(),
    })
    .strict(),
  fields: z.array(fieldName).max(200),
  identityNamespace: z.string().max(300).optional(),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
});
const mappingSchema = z.object({
  id: recordId,
  name: z.string().trim().min(1).max(120),
  contactListId: z.string().trim().min(1).max(200),
  regionId: z.string().max(100),
  sourceId: recordId,
  keyField: fieldName,
  fields: z
    .array(
      z.object({
        targetField: fieldName,
        sourceField: z.string().max(128),
        defaultValue: z.string().max(2000),
        type: z
          .enum(["STRING", "NUMBER", "DATE", "BOOLEAN", "PHONE"])
          .optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(200),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
});
const leadSchema = z.object({
  id: recordId,
  name: z.string().trim().min(1).max(120),
  mappingId: recordId,
  match: z.enum(["ALL", "ANY"]),
  filters: z
    .array(
      z.object({
        field: fieldName,
        scope: z.enum(["TARGET", "SOURCE"]),
        operator: z.enum([
          "EQ",
          "NE",
          "GT",
          "LT",
          "GTE",
          "LTE",
          "CONTAINS",
          "DATE_GT_DAYS",
          "DATE_LT_DAYS",
        ]),
        value: z.string().max(2000),
      }),
    )
    .max(30),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
});
const scheduleSchema = z.object({
  id: recordId,
  name: z.string().trim().min(1).max(120),
  leadId: recordId,
  contactListId: z.string().trim().min(1).max(200),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "MONTH_DAYS"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(31),
  monthDays: z.array(z.number().int().min(1).max(31)).max(31),
  enabled: z.boolean(),
  nextRunAt: z.string().max(100),
  lastRunAt: z.string().max(100),
  lastStatus: z.string().max(100),
  lastMessage: z.string().max(1000),
  lastJobId: z.string().max(100),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
});
const backupFileSchemas: Record<string, z.ZodType> = {
  "genesys-contact-list-configurations.json": z.array(
    z.object({
      id: z.string().max(300),
      contactListId: z.string().min(1).max(200),
      name: z.string().min(1).max(300),
      regionId: z.string().max(100),
      uuid: z.string().max(200),
      uuidSource: z.enum(["CONTACT_LIST_ID", "MANUAL", ""]),
      missing: z.boolean(),
      fields: z.array(
        z.object({
          name: fieldName,
          type: z.enum(["STRING", "NUMBER", "DATE", "BOOLEAN", "PHONE"]),
          required: z.boolean(),
        }),
      ),
      createdAt: z.string().max(100),
      updatedAt: z.string().max(100),
    }),
  ),
  "source-integrations.json": z.array(sourceSchema),
  "source-mappings.json": z.array(mappingSchema),
  "lead-definitions.json": z.array(leadSchema),
  "lead-import-schedules.json": z.array(scheduleSchema),
  "lead-import-jobs.json": z.array(z.object({ id: recordId, leadId: recordId, leadName: z.string().max(120), reimport: z.boolean().optional(), sourceId: recordId.optional(), contactListId: z.string().max(200), scheduleId: z.string().max(100), status: z.enum(["RUNNING", "SUCCESS", "PARTIAL", "FAILED", "INTERRUPTED"]), total: z.number().int().min(0), processed: z.number().int().min(0), created: z.number().int().min(0), updated: z.number().int().min(0), skipped: z.number().int().min(0), failed: z.number().int().min(0), message: z.string().max(2000), results: z.array(z.object({ id: z.string().max(100), sourceKey: z.string().max(1000), status: z.string().max(100), message: z.string().max(2000) }).strict()).max(100000), createdAt: z.string().max(100), finishedAt: z.string().max(100) }).strict()).max(100000),
  "source-observations.json": z.array(z.object({ id: recordId, status: z.enum(["ACTIVE", "INACTIVE", "ERROR"]), checkedAt: z.string().max(100), message: z.string().max(1000) }).strict()).max(100000),
};
const requiredBackupFiles = Object.keys(backupFileSchemas);

export async function restoreConfigurationBackup(
  input: unknown,
  actor: string,
): Promise<{ restored: string[]; safetyBackup: string }> {
  const request = z
    .object({
      confirmation: z.literal("RESTORE"),
      files: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(input);
  const files = request.files;
  const optionalFiles = new Set(["lead-import-jobs.json", "source-observations.json"]);
  for (const name of requiredBackupFiles)
    if (!optionalFiles.has(name) && !Object.hasOwn(files, name))
      throw httpError(400, `Backup is missing ${name}`);
  if (Object.hasOwn(files, "manifest.json")) {
    const manifest = optionalBackupSchemas["manifest.json"].parse(files["manifest.json"]) as { files: string[] };
    if (manifest.files.some((entry) => !Object.hasOwn(files, entry))) throw httpError(400, "Backup manifest references a missing file");
  }

  const safeEntries: Record<string, unknown> = {};
  const alertFileEntries = new Set<string>();
  for (const [name, value] of Object.entries(files)) {
    if (name === "manifest.json") {
      const manifest = optionalBackupSchemas["manifest.json"].parse(value) as { createdAt: string; files: string[] };
      if (manifest.files.some((entry) => !Object.hasOwn(files, entry))) throw httpError(400, "Backup manifest references a missing file");
      continue;
    }
    if (/^alert-datasources\//.test(name)) {
      if (!/^alert-datasources\/[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(name))
        throw httpError(400, `Invalid alert datasource backup entry: ${name}`);
      if (typeof value !== "string" || value.length > 12 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        throw httpError(400, `Invalid alert datasource file: ${name}`);
      alertFileEntries.add(name);
      safeEntries[name] = Buffer.from(value, "base64");
      continue;
    }
    if (/^source-files\//.test(name)) {
      if (!/^source-files\/[a-f0-9-]{36}\.txt$/i.test(name))
        throw httpError(400, `Invalid source backup entry: ${name}`);
      if (typeof value !== "string")
        throw httpError(400, `Invalid source file: ${name}`);
      safeEntries[name] = value;
      continue;
    }
    if (/^[a-z0-9-]+\.json$/i.test(name)) {
      if (!Object.hasOwn(backupFileSchemas, name) && !Object.hasOwn(alertBackupSchemas, name) && !Object.hasOwn(optionalBackupSchemas, name))
        throw httpError(400, `Unsupported backup entry: ${name}`);
      if (Object.hasOwn(optionalBackupSchemas, name)) optionalBackupSchemas[name].parse(value);
      continue;
    }
    if (/^config\/[a-z0-9-]+\.json$/i.test(name)) continue;
    throw httpError(400, `Unsupported backup entry: ${name}`);
  }
  if (Object.hasOwn(files, "manifest.json")) {
    const manifest = optionalBackupSchemas["manifest.json"].parse(files["manifest.json"]) as { files: string[] };
    const missingRequired = requiredBackupFiles.filter((name) => !optionalFiles.has(name) && !manifest.files.includes(name));
    if (missingRequired.length) throw httpError(400, `Backup manifest is incomplete: ${missingRequired.join(", ")}`);
  }

  const parsed = Object.fromEntries(
    requiredBackupFiles.filter((name) => Object.hasOwn(files, name)).map((name) => [
      name,
      backupFileSchemas[name].parse(files[name]),
    ]),
  ) as {
    "genesys-contact-list-configurations.json": ContactListConfiguration[];
    "source-integrations.json": SourceIntegration[];
    "source-mappings.json": SourceMapping[];
    "lead-definitions.json": LeadDefinition[];
    "lead-import-schedules.json": z.infer<typeof scheduleSchema>[];
    "lead-import-jobs.json"?: Awaited<ReturnType<typeof importJobs.all>>;
    "source-observations.json"?: Awaited<ReturnType<typeof sourceObservations.all>>;
  };
  const alertRows = Object.fromEntries(
    Object.entries(alertBackupSchemas).map(([file, schema]) => [file, schema.parse(files[file] ?? [])]),
  );
  const optionalRows = Object.fromEntries(Object.entries(optionalBackupSchemas).filter(([file]) => Object.hasOwn(files, file)).map(([file, schema]) => [file, schema.parse(files[file])]));
  if (optionalRows["manifest.json"]) {
    const manifest = optionalRows["manifest.json"] as { createdAt: string; files: string[] };
    if (manifest.files.some((entry) => !Object.hasOwn(files, entry))) throw httpError(400, "Backup manifest references a missing file");
  }
  const auditRows = optionalRows["audit-log.json"] as { id: string; detail: Record<string, unknown> }[] | undefined;
  if (auditRows) {
    optionalRows["audit-log.json"] = auditRows.filter((item) => {
      const serialized = JSON.stringify(item);
      return !/(?:secretEncrypted|tokenEncrypted|hmacSecretEncrypted|authKeyEncrypted|privKeyEncrypted)/i.test(serialized);
    });
  }
  const alertConfigIds = new Set((alertRows["alert-configurations.json"] as { id: string }[]).map((item) => item.id));
  const alertDatasourceIds = new Set((alertRows["alert-datasources.json"] as { id: string }[]).map((item) => item.id));
  for (const datasource of alertRows["alert-datasources.json"] as { id: string; kind: string; storedFile: string }[]) {
    if (datasource.kind === "FILE" && (!/^[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(datasource.storedFile) || !alertFileEntries.has(`alert-datasources/${datasource.storedFile}`)))
      throw httpError(400, "Backup is missing an alert enrichment datasource file");
  }
  for (const rule of alertRows["alert-enrichment-rules.json"] as { alertConfigId: string; datasourceId: string }[])
    if (!alertConfigIds.has(rule.alertConfigId) || !alertDatasourceIds.has(rule.datasourceId)) throw httpError(400, "Alert enrichment rule references a missing configuration or datasource");
  for (const mapping of alertRows["alert-mappings.json"] as { alertConfigId: string }[])
    if (!alertConfigIds.has(mapping.alertConfigId)) throw httpError(400, "Alert mapping references a missing Alert Configuration");
  const restoredAlerts = alertRows["received-alerts.json"] as ReceivedAlert[];
  const restoredMappingIds = new Set((alertRows["alert-mappings.json"] as AlertMapping[]).map((item) => item.id));
  for (const alert of restoredAlerts) {
    alert.processingAttempts ??= alert.attempts || 0;
    alert.syncAttempts ??= alert.attempts || 0;
    if (alert.configId && !alertConfigIds.has(alert.configId)) throw httpError(400, "Received alert references a missing Alert Configuration");
    if (alert.mappingId && !restoredMappingIds.has(alert.mappingId)) throw httpError(400, "Received alert references a missing Alert Mapping");
    if (alert.configSnapshot && alert.configSnapshot.id !== alert.configId) throw httpError(400, "Received alert configuration snapshot does not match its configuration ID");
    if (alert.processingStatus === "PROCESSING") alert.processingStatus = "RECEIVED";
    if (alert.syncStatus === "SYNCING") {
      alert.syncStatus = "UNKNOWN";
      alert.lastError = "Restored while a Contact creation was in progress. Reconcile in Genesys before retrying.";
    }
    if (alert.processingStatus === "RECEIVED") alert.syncStatus = "BLOCKED";
  }
  const restoredConfigs = alertRows["alert-configurations.json"] as AlertConfiguration[];
  for (const config of restoredConfigs) {
    config.enabled = false;
    if (config.type === "API" && !config.api.tokenEncrypted && !config.api.hmacSecretEncrypted) config.enabled = false;
  }
  for (const alert of restoredAlerts) {
    if (alert.configSnapshot) {
      const config = restoredConfigs.find((item) => item.id === alert.configId);
      if (config) alert.configSnapshot = config;
    }
  }
  for (const mapping of alertRows["alert-mappings.json"] as AlertMapping[]) mapping.autoImport = false;
  for (const datasource of alertRows["alert-datasources.json"] as AlertDatasource[]) datasource.enabled = false;
  for (const rule of alertRows["alert-enrichment-rules.json"] as AlertEnrichmentRule[]) rule.enabled = false;
  const snmpConfigs = alertRows["snmp-listener-configuration.json"] as SnmpListenerConfiguration[];
  for (const config of snmpConfigs) {
    config.enabled = false;
    if (config.communities.some((item) => !item.secretEncrypted) || config.users.some((item) => item.level !== "noAuthNoPriv" && !item.authKeyEncrypted)) config.enabled = false;
  }
  alertRows["alert-test-sessions.json"] = [];
  for (const [file, rows] of Object.entries(optionalRows)) {
    if (file === "lead-import-states.json") continue;
    if (file === "audit-log.json") continue;
    safeEntries[file] = rows;
  }
  const sources = parsed["source-integrations.json"];
  const mappings = parsed["source-mappings.json"];
  const leads = parsed["lead-definitions.json"];
  const schedules = parsed["lead-import-schedules.json"];
  assertUnique(sources, "source");
  assertUnique(mappings, "mapping");
  assertUnique(leads, "Lead Configuration");
  assertUnique(schedules, "schedule");
  const sourceIds = new Set(sources.map((item) => item.id));
  const mappingIds = new Set(mappings.map((item) => item.id));
  const currentContactLists = await contactListConfigurations.all();
  const backupContactLists = parsed["genesys-contact-list-configurations.json"];
  const backupListById = new Map(
    backupContactLists.map((item) => [
      `${item.regionId}:${item.contactListId}`,
      item,
    ]),
  );
  const currentListById = new Map(
    currentContactLists.map((item) => [
      `${item.regionId}:${item.contactListId}`,
      item,
    ]),
  );
  const contactListIds = new Set(
    currentContactLists
      .filter((item) => item.uuid && !item.missing)
      .map((item) => `${item.regionId}:${item.contactListId}`),
  );
  for (const source of sources) {
    if (
      ["CSV", "JSON"].includes(source.kind) &&
      (source.config.fileLocation ||
        (source.config.fileId ? "UPLOAD" : "SERVER")) === "UPLOAD"
    ) {
      const fileId = source.config.fileId || source.id;
      if (!Object.hasOwn(safeEntries, `source-files/${fileId}.txt`))
        throw httpError(
          400,
          `Backup is missing the source file for ${source.name}`,
        );
      if (typeof safeEntries[`source-files/${fileId}.txt`] !== "string")
        throw httpError(400, `Invalid source file for ${source.name}`);
      if (
        Buffer.byteLength(
          safeEntries[`source-files/${fileId}.txt`] as string,
          "utf8",
        ) >
        5 * 1024 * 1024
      )
        throw httpError(413, `Source file ${source.name} exceeds 5 MB`);
    }
  }
  for (const mapping of mappings) {
    const backupRegion = backupContactLists.find(
      (item) => item.contactListId === mapping.contactListId,
    )?.regionId;
    const mappingRegion = mapping.regionId || backupRegion || "";
    const listKey = `${mappingRegion}:${mapping.contactListId}`;
    if (!sourceIds.has(mapping.sourceId))
      throw httpError(
        400,
        `Mapping ${mapping.name} references a missing source`,
      );
    if (!contactListIds.has(listKey))
      throw httpError(
        400,
        `Mapping ${mapping.name} references a Contact List not configured in this Genesys connection. Refresh Contact Lists before restoring.`,
      );
    const source = sources.find((item) => item.id === mapping.sourceId)!;
    const backupList = backupListById.get(listKey);
    const currentList = currentListById.get(listKey);
    if (!backupList || !currentList)
      throw httpError(
        400,
        `Mapping ${mapping.name} references a Contact List in another or unavailable region`,
      );
    if (!source.fields.includes(mapping.keyField))
      throw httpError(400, `Mapping ${mapping.name} has an invalid record key`);
    if (
      mapping.fields.some(
        (field) =>
          !source.fields.includes(field.sourceField) && field.sourceField,
      )
    )
      throw httpError(
        400,
        `Mapping ${mapping.name} references a missing source field`,
      );
    const destinationFieldNames = new Set(
      currentList.fields.map((field) => field.name),
    );
    if (
      mapping.fields.some(
        (field) =>
          !destinationFieldNames.has(field.targetField) && field.targetField,
      )
    )
      throw httpError(
        400,
        `Mapping ${mapping.name} references a missing destination field`,
      );
  }
  for (const lead of leads)
    if (!mappingIds.has(lead.mappingId))
      throw httpError(
        400,
        `Lead Configuration ${lead.name} references a missing mapping`,
      );
  for (const schedule of schedules) {
    const lead = leads.find((item) => item.id === schedule.leadId);
    const mapping = lead && mappings.find((item) => item.id === lead.mappingId);
    if (!mapping || mapping.contactListId !== schedule.contactListId)
      throw httpError(
        400,
        `Schedule ${schedule.name} has an invalid destination`,
      );
  }
  const safety = await createBackup();
  await writeBackupManifest(safety.directory, safety.files);
  const currentSources = await sourceIntegrations.all();
  const localSecrets = new Map(
    currentSources.map((source) => [source.id, source.secretEncrypted]),
  );
  const restoredSources = sources.map((source) => ({
    ...source,
    secretEncrypted: localSecrets.get(source.id) || "",
  }));
  const restoredSchedules = schedules.map((schedule) => ({
    ...schedule,
    enabled: false,
    nextRunAt: "",
    lastRunAt: "",
    lastStatus: "NEVER",
    lastMessage: "Restored disabled. Review before enabling.",
    lastJobId: "",
  }));
  const previous = {
    sources: currentSources,
    mappings: await sourceMappings.all(),
    leads: await leadDefinitions.all(),
    schedules: await importSchedules.all(),
    observations: await sourceObservations.all(),
    jobs: await importJobs.all(),
    contactLists: currentContactLists,
    alerts: await Promise.all(alertRepositories.map((repository) => repository.all())),
    audit: await readAuditLog(),
    importStates: await importStates.all(),
  };
  const oldSourceFiles = new Map<string, Buffer | null>();
  const oldAlertFiles = new Map<string, Buffer | null>();
  for (const source of restoredSources) {
    if (
      !["CSV", "JSON"].includes(source.kind) ||
      (source.config.fileLocation ||
        (source.config.fileId ? "UPLOAD" : "SERVER")) !== "UPLOAD"
    )
      continue;
    const fileId = source.config.fileId || source.id;
    const filePath = path.join(dataDir, "source-files", `${fileId}.txt`);
    try {
      oldSourceFiles.set(filePath, await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      oldSourceFiles.set(filePath, null);
    }
  }
  for (const entry of alertFileEntries) {
    const fileName = path.basename(entry);
    const filePath = path.join(alertUploadDir, fileName);
    try { oldAlertFiles.set(filePath, await readFile(filePath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; oldAlertFiles.set(filePath, null); }
  }
  const localLists = new Map(
    currentContactLists.map((item) => [
      `${item.regionId}:${item.contactListId}`,
      item,
    ]),
  );
  const restoredContactLists = new Map(
    currentContactLists.map((item) => [
      `${item.regionId}:${item.contactListId}`,
      item,
    ]),
  );
  for (const item of backupContactLists) {
    const local = localLists.get(`${item.regionId}:${item.contactListId}`);
    restoredContactLists.set(
      `${item.regionId}:${item.contactListId}`,
      local
        ? {
            ...item,
            ...local,
            fields: local.fields.length ? local.fields : item.fields,
            uuid: local.uuid || item.uuid,
            uuidSource: local.uuid ? local.uuidSource : item.uuidSource,
            missing: local.missing,
          }
        : { ...item, missing: true },
    );
  }
  try {
    for (const source of restoredSources) {
      if (
        ["CSV", "JSON"].includes(source.kind) &&
        (source.config.fileLocation ||
          (source.config.fileId ? "UPLOAD" : "SERVER")) === "UPLOAD"
      ) {
        const fileId = source.config.fileId || source.id;
        const directory = path.join(dataDir, "source-files");
        await mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `${fileId}.${randomUUID()}.tmp`);
        await writeFile(
          temporary,
          safeEntries[`source-files/${fileId}.txt`] as string,
          {
            mode: 0o600,
          },
        );
        await rename(temporary, path.join(directory, `${fileId}.txt`));
      }
    }
    await sourceIntegrations.replaceAll(restoredSources);
    await sourceMappings.replaceAll(mappings);
    await leadDefinitions.replaceAll(leads);
    await importSchedules.replaceAll(restoredSchedules);
    await contactListConfigurations.replaceAll([
      ...restoredContactLists.values(),
    ]);
    await sourceObservations.replaceAll([]);
    for (const [index, repository] of alertRepositories.entries())
      await repository.replaceAll(alertRows[repository.fileName] as never[]);
    if (optionalRows["audit-log.json"]) await replaceAuditLog(optionalRows["audit-log.json"] as Awaited<ReturnType<typeof readAuditLog>>);
    if (optionalRows["lead-import-states.json"]) {
      const importedStates = optionalRows["lead-import-states.json"] as Awaited<ReturnType<typeof importStates.all>>;
      await importStates.mutate((rows) => rows.splice(0, rows.length, ...importedStates));
    }
    if (optionalRows["lead-import-jobs.json"]) await importJobs.replaceAll(optionalRows["lead-import-jobs.json"] as Awaited<ReturnType<typeof importJobs.all>>);
    if (optionalRows["source-observations.json"]) await sourceObservations.replaceAll(optionalRows["source-observations.json"] as Awaited<ReturnType<typeof sourceObservations.all>>);
    await mkdir(alertUploadDir, { recursive: true });
    for (const file of alertFileEntries) {
      const fileName = path.basename(file);
      const bytes = safeEntries[file] as Buffer;
      const temporary = path.join(alertUploadDir, `${fileName}.${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path.join(alertUploadDir, fileName));
    }
  } catch (error) {
    await sourceIntegrations.replaceAll(previous.sources);
    await sourceMappings.replaceAll(previous.mappings);
    await leadDefinitions.replaceAll(previous.leads);
    await importSchedules.replaceAll(previous.schedules);
    await contactListConfigurations.replaceAll(previous.contactLists);
    await sourceObservations.replaceAll(previous.observations);
    for (const [index, repository] of alertRepositories.entries())
      await repository.replaceAll(previous.alerts[index] as never[]);
    await replaceAuditLog(previous.audit as Awaited<ReturnType<typeof readAuditLog>>);
    await importJobs.replaceAll(previous.jobs);
    await importStates.mutate((rows) => rows.splice(0, rows.length, ...previous.importStates));
    for (const [filePath, contents] of oldSourceFiles) {
      if (contents === null) {
        try {
          await unlink(filePath);
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT")
            throw rollbackError;
        }
      } else {
        await writeFile(filePath, contents, { mode: 0o600 });
      }
    }
    for (const [filePath, contents] of oldAlertFiles) {
      if (contents === null) {
        try { await unlink(filePath); }
        catch (rollbackError) { if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") throw rollbackError; }
      } else await writeFile(filePath, contents, { mode: 0o600 });
    }
    throw error;
  }
  await audit("RESTORE_CONFIGURATION_BACKUP", actor, safety.directory, {
    sources: sources.length,
    mappings: mappings.length,
    leads: leads.length,
    schedules: schedules.length,
  });
  return {
    restored: [
      "Sources",
      "Source Mappings",
      "Lead Configurations",
      "Schedules (disabled)",
      "Contact List Configuration (unavailable lists marked for refresh)",
      "Alert to Lead configurations, alerts and history",
    ],
    safetyBackup: safety.directory,
  };
}

function assertUnique<T extends { id: string; name: string }>(
  rows: T[],
  label: string,
) {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw httpError(400, `Duplicate ${label} ID`);
    const name = row.name.toLocaleLowerCase();
    if (names.has(name))
      throw httpError(400, `Duplicate ${label} name: ${row.name}`);
    ids.add(row.id);
    names.add(name);
  }
}
