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
  pipelineRepositories,
  sourceIntegrations,
  importStates,
  sourceMappings,
  leadDefinitions,
  importSchedules,
  sourceObservations,
  contactListConfigurations,
} from "./pipeline-store";
import type {
  ContactListConfiguration,
  LeadDefinition,
  SourceIntegration,
  SourceMapping,
} from "./pipeline-types";
import { audit } from "./store";
const repositories = pipelineRepositories;
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
  return { directory: stamp, files };
}

export async function downloadBackup(stamp: string) {
  if (!/^\d{17}$/.test(stamp)) throw httpError(400, "Invalid backup ID");
  const directory = path.join(backupsDir, stamp);
  const files: Record<string, unknown> = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".json"))
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
  return files;
}

export async function writeBackupManifest(
  stamp: string,
  files: string[],
): Promise<void> {
  await writeFile(
    path.join(backupsDir, stamp, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2)}\n`,
    "utf8",
  );
}

const recordId = z.string().uuid();
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
  for (const name of requiredBackupFiles)
    if (!Object.hasOwn(files, name))
      throw httpError(400, `Backup is missing ${name}`);

  const safeEntries: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(files)) {
    if (/^source-files\//.test(name)) {
      if (!/^source-files\/[a-f0-9-]{36}\.txt$/i.test(name))
        throw httpError(400, `Invalid source backup entry: ${name}`);
      if (typeof value !== "string")
        throw httpError(400, `Invalid source file: ${name}`);
      safeEntries[name] = value;
      continue;
    }
    if (/^[a-z0-9-]+\.json$/i.test(name)) continue;
    if (/^config\/[a-z0-9-]+\.json$/i.test(name)) continue;
    throw httpError(400, `Unsupported backup entry: ${name}`);
  }

  const parsed = Object.fromEntries(
    requiredBackupFiles.map((name) => [
      name,
      backupFileSchemas[name].parse(files[name]),
    ]),
  ) as {
    "genesys-contact-list-configurations.json": ContactListConfiguration[];
    "source-integrations.json": SourceIntegration[];
    "source-mappings.json": SourceMapping[];
    "lead-definitions.json": LeadDefinition[];
    "lead-import-schedules.json": z.infer<typeof scheduleSchema>[];
  };
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
    contactLists: currentContactLists,
  };
  const oldSourceFiles = new Map<string, Buffer | null>();
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
  } catch (error) {
    await sourceIntegrations.replaceAll(previous.sources);
    await sourceMappings.replaceAll(previous.mappings);
    await leadDefinitions.replaceAll(previous.leads);
    await importSchedules.replaceAll(previous.schedules);
    await contactListConfigurations.replaceAll(previous.contactLists);
    await sourceObservations.replaceAll(previous.observations);
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
