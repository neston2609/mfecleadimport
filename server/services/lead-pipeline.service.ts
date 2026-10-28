import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JsonRepository, dataDir } from "../domain/json-repository";
import { httpError } from "../domain/business";
import { audit } from "../domain/store";
import {
  CONTACT_COLUMNS,
  payloadHash,
  type CampaignContact,
} from "../domain/campaign-contact";
import {
  contactTemplates,
  sourceIntegrations,
  sourceMappings,
  leadDefinitions,
  importSchedules,
  importStates,
  importJobs,
} from "../domain/pipeline-store";
import type {
  Entity,
  ContactTemplate,
  SourceIntegration,
  SourceMapping,
  LeadDefinition,
  LeadFilter,
  DataRow,
  LeadPreview,
  ContactField,
  LeadRow,
} from "../domain/pipeline-types";
import { encryptSecret } from "./genesys/secret.service";
import { genesysApiClient } from "./genesys/genesys-api.client";
import { loadSource } from "./source-data.service";

const name = z.string().trim().min(1).max(120);
const fieldName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !["__proto__", "prototype", "constructor"].includes(value) &&
      !/[\x00-\x1f]/.test(value),
    "Invalid field name",
  );
export const templateInput = z
  .object({
    name,
    contactListId: z.string().max(200).default(""),
    fields: z
      .array(
        z.object({
          name: fieldName,
          type: z.enum(["STRING", "NUMBER", "DATE", "BOOLEAN", "PHONE"]),
          required: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
  })
  .refine(
    (value) =>
      new Set(value.fields.map((field) => field.name)).size ===
      value.fields.length,
    "Field names must be unique",
  );
export const sourceInput = z.object({
  id: z.string().uuid().optional(),
  name,
  kind: z.enum(["JDBC", "WEB", "CSV", "JSON"]),
  secret: z.string().max(8000).optional(),
  clearSecret: z.boolean().optional(),
  config: z
    .object({
      jdbcUrl: z.string().max(4000).optional(),
      driverClass: z
        .string()
        .max(250)
        .regex(/^[A-Za-z0-9_.$]*$/)
        .optional(),
      username: z.string().max(200).optional(),
      query: z.string().max(20000).optional(),
      table: z.string().max(500).optional(),
      uri: z.string().max(4000).optional(),
      method: z.enum(["GET", "POST"]).optional(),
      auth: z.enum(["NONE", "BASIC", "BEARER", "API_KEY"]).optional(),
      headerName: z.string().max(100).optional(),
      requestBody: z.string().max(100000).optional(),
      resultPath: z.string().max(500).optional(),
      content: z
        .string()
        .max(5 * 1024 * 1024)
        .optional(),
      fileName: z.string().max(300).optional(),
      fileId: z.string().uuid().optional(),
      delimiter: z.enum([",", ";", "\t", ""]).optional(),
    })
    .strict(),
});
export const mappingInput = z.object({
  name,
  templateId: z.string().uuid(),
  sourceId: z.string().uuid(),
  keyField: fieldName,
  fields: z
    .array(
      z.object({
        targetField: fieldName,
        sourceField: z.string().max(128),
        defaultValue: z.string().max(2000).default(""),
      }),
    )
    .max(200),
});
export const leadInput = z.object({
  name,
  mappingId: z.string().uuid(),
  match: z.enum(["ALL", "ANY"]).default("ALL"),
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
    .max(30)
    .default([]),
});

export async function entity<T extends Entity>(
  repository: JsonRepository<T>,
  id: string,
): Promise<T> {
  const found = await repository.findById("id", id);
  if (!found) throw httpError(404, "Configuration not found");
  return found;
}
export async function saveEntity<T extends Entity>(
  repository: JsonRepository<T>,
  values: Omit<T, keyof Entity> & { name: string },
  id?: string,
): Promise<T> {
  return repository.mutate((rows) => {
    if (
      rows.some(
        (row) =>
          row.id !== id && row.name.toLowerCase() === values.name.toLowerCase(),
      )
    )
      throw httpError(409, "This name is already in use");
    const previous = id ? rows.find((row) => row.id === id) : undefined;
    if (id && !previous) throw httpError(404, "Configuration not found");
    const timestamp = new Date().toISOString();
    const item = {
      ...previous,
      ...values,
      id: id || randomUUID(),
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
    } as T;
    if (previous) rows.splice(rows.indexOf(previous), 1, item);
    else rows.push(item);
    return item;
  });
}

export function publicSource(
  source: SourceIntegration,
  includeContent = false,
) {
  const { secretEncrypted, ...rest } = source;
  const { content, ...config } = rest.config;
  return {
    ...rest,
    config: includeContent ? rest.config : config,
    secretConfigured: Boolean(secretEncrypted),
  };
}
export async function bootstrapPipeline() {
  const [templates, sources, mappings, leads, schedules, jobs] =
    await Promise.all([
      contactTemplates.all(),
      sourceIntegrations.all(),
      sourceMappings.all(),
      leadDefinitions.all(),
      importSchedules.all(),
      importJobs.all(),
    ]);
  return {
    templates,
    sources: sources.map((item) => publicSource(item)),
    mappings,
    leads,
    schedules,
    jobs: jobs.slice(-20).reverse(),
  };
}
export async function draftSource(input: unknown, id?: string) {
  const data = sourceInput.parse(input);
  const previous =
    id || data.id
      ? await entity(sourceIntegrations, id || data.id!)
      : undefined;
  return {
    ...previous,
    id: previous?.id || randomUUID(),
    createdAt: previous?.createdAt || "",
    updatedAt: "",
    name: data.name,
    kind: data.kind,
    config: data.config,
    fields: previous?.fields || [],
    secretEncrypted: data.clearSecret
      ? ""
      : data.secret
        ? encryptSecret(data.secret)
        : previous?.kind === data.kind
          ? previous.secretEncrypted
          : "",
  } satisfies SourceIntegration;
}
export async function previewSource(
  input: unknown,
  id?: string,
  connectOnly = false,
) {
  const source = await draftSource(input, id);
  const data = await loadSource(source, connectOnly);
  return {
    ...data,
    rows: data.rows.slice(0, 100),
    previewCount: Math.min(data.rows.length, 100),
  };
}
export async function saveSource(input: unknown, actor: string, id?: string) {
  const source = await draftSource(input, id);
  const preview = await loadSource(source);
  if (!preview.fields.length)
    throw httpError(
      400,
      "The source has no fields. Preview a non-empty source before saving.",
    );
  const { content, ...config } = source.config;
  if (content !== undefined && ["CSV", "JSON"].includes(source.kind)) {
    const directory = path.join(dataDir, "source-files");
    await mkdir(directory, { recursive: true });
    const fileId = randomUUID();
    const temporary = path.join(directory, `${fileId}.tmp`);
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path.join(directory, `${fileId}.txt`));
    config.fileId = fileId;
  }
  // File IDs must remain stable when first saving the uploaded content.
  const saved = await sourceIntegrations.mutate((rows) => {
    if (
      rows.some(
        (row) =>
          row.id !== source.id &&
          row.name.toLowerCase() === source.name.toLowerCase(),
      )
    )
      throw httpError(409, "This source name is already in use");
    const timestamp = new Date().toISOString();
    const item = {
      ...source,
      config,
      fields: preview.fields,
      createdAt: source.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const index = rows.findIndex((row) => row.id === item.id);
    if (index >= 0) rows[index] = item;
    else rows.push(item);
    return item;
  });
  await audit("SAVE_SOURCE_INTEGRATION", actor, saved.id, { kind: saved.kind });
  return publicSource(saved);
}

export async function saveTemplate(input: unknown, actor: string, id?: string) {
  const saved = await saveEntity(
    contactTemplates,
    templateInput.parse(input),
    id,
  );
  await audit("SAVE_CONTACT_TEMPLATE", actor, saved.id);
  return saved;
}
export async function saveMapping(input: unknown, actor: string, id?: string) {
  const data = mappingInput.parse(input);
  const [template, source] = await Promise.all([
    entity(contactTemplates, data.templateId),
    entity(sourceIntegrations, data.sourceId),
  ]);
  if (!source.fields.includes(data.keyField))
    throw httpError(
      400,
      "Select a source field containing a stable, unique record ID",
    );
  if (
    new Set(data.fields.map((field) => field.targetField)).size !==
    data.fields.length
  )
    throw httpError(400, "Each target field can be mapped only once");
  for (const field of data.fields) {
    if (
      !template.fields.some((target) => target.name === field.targetField) ||
      (field.sourceField && !source.fields.includes(field.sourceField))
    )
      throw httpError(400, "Mapping references an unknown field");
  }
  for (const required of template.fields.filter((field) => field.required))
    if (
      !data.fields.some(
        (field) =>
          field.targetField === required.name &&
          (field.sourceField || field.defaultValue),
      )
    )
      throw httpError(400, `Map the required field ${required.name}`);
  const saved = await saveEntity(sourceMappings, data, id);
  await audit("SAVE_SOURCE_MAPPING", actor, saved.id);
  return saved;
}
export async function saveLead(input: unknown, actor: string, id?: string) {
  const data = leadInput.parse(input);
  const mapping = await entity(sourceMappings, data.mappingId);
  const [template, source] = await Promise.all([
    entity(contactTemplates, mapping.templateId),
    entity(sourceIntegrations, mapping.sourceId),
  ]);
  for (const filter of data.filters) {
    if (
      !(
        filter.scope === "SOURCE"
          ? source.fields
          : template.fields.map((field) => field.name)
      ).includes(filter.field)
    )
      throw httpError(400, "Filter references an unknown field");
    if (
      ["GT", "LT", "GTE", "LTE", "DATE_GT_DAYS", "DATE_LT_DAYS"].includes(
        filter.operator,
      ) &&
      (!filter.value.trim() || !Number.isFinite(Number(filter.value)))
    )
      throw httpError(400, "Numeric and date-offset filters require a number");
  }
  const saved = await saveEntity(leadDefinitions, data, id);
  await audit("SAVE_LEAD_CONFIGURATION", actor, saved.id);
  return saved;
}

export async function deleteConfiguration(
  kind: string,
  id: string,
  actor: string,
) {
  const references =
    kind === "templates"
      ? (await sourceMappings.all()).some((row) => row.templateId === id)
      : kind === "sources"
        ? (await sourceMappings.all()).some((row) => row.sourceId === id)
        : kind === "mappings"
          ? (await leadDefinitions.all()).some((row) => row.mappingId === id)
          : (await importSchedules.all()).some((row) => row.leadId === id);
  if (references)
    throw httpError(
      409,
      "This configuration is in use. Update its dependent configurations first.",
    );
  const repository = (
    {
      templates: contactTemplates,
      sources: sourceIntegrations,
      mappings: sourceMappings,
      leads: leadDefinitions,
    } as Record<string, JsonRepository<Entity>>
  )[kind];
  if (!repository) throw httpError(404, "Unknown configuration type");
  await repository.mutate((rows) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw httpError(404, "Configuration not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_PIPELINE_CONFIGURATION", actor, id, { kind });
}

async function assertGenesysCredentials() {
  const { GenesysConfigService } =
    await import("./genesys/genesys-config.service");
  const config = await new GenesysConfigService().getConfig();
  if (!config.clientId || !config.clientSecretEncrypted)
    throw httpError(
      400,
      "Configure Genesys OAuth credentials under Genesys Configuration first",
    );
}
export async function contactLists() {
  await assertGenesysCredentials();
  const entities: { id: string; name: string }[] = [];
  for (let page = 1; page <= 50; page++) {
    const response = await genesysApiClient.get<{
      entities?: { id: string; name: string }[];
      pageCount?: number;
      nextUri?: string;
    }>(`/api/v2/outbound/contactlists?pageSize=100&pageNumber=${page}`);
    entities.push(...(response.entities || []));
    if (page >= (response.pageCount || 1) && !response.nextUri) break;
    if (!(response.entities || []).length) break;
  }
  return entities;
}
export async function contactList(id: string) {
  await assertGenesysCredentials();
  z.string().uuid().parse(id);
  return genesysApiClient.get<{
    id: string;
    name: string;
    columnNames: string[];
    phoneColumns?: { columnName: string }[];
  }>(`/api/v2/outbound/contactlists/${encodeURIComponent(id)}`);
}
export async function fieldsFromGenesys(
  id: string,
): Promise<{ fields: ContactField[]; contactListId: string; name: string }> {
  const list = await contactList(id);
  const phones = new Set(
    (list.phoneColumns || []).map((column) => column.columnName),
  );
  return {
    name: list.name,
    contactListId: id,
    fields: (list.columnNames || []).map((name) => ({
      name,
      type: phones.has(name) ? "PHONE" : "STRING",
      required: phones.has(name),
    })),
  };
}

export function dayNumber(value: unknown): number {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(text + "T00:00:00Z");
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === text
      ? date.getTime() / 86400000
      : NaN;
  }
  const date = new Date(text);
  if (!text || !Number.isFinite(date.getTime())) return NaN;
  return Math.floor((date.getTime() + 7 * 3600000) / 86400000);
}
export function matchesFilter(
  target: DataRow,
  source: DataRow,
  filter: LeadFilter,
  now = new Date(),
): boolean {
  const value = (filter.scope === "SOURCE" ? source : target)[filter.field];
  const text = value == null ? "" : String(value);
  if (filter.operator === "EQ") return text === filter.value;
  if (filter.operator === "NE") return text !== filter.value;
  if (filter.operator === "CONTAINS")
    return text.toLowerCase().includes(filter.value.toLowerCase());
  let left = text.trim() ? Number(text) : NaN;
  if (filter.operator.startsWith("DATE_"))
    left =
      dayNumber(value) - Math.floor((now.getTime() + 7 * 3600000) / 86400000);
  const right = Number(filter.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (["GT", "DATE_GT_DAYS"].includes(filter.operator)) return left > right;
  if (["LT", "DATE_LT_DAYS"].includes(filter.operator)) return left < right;
  if (filter.operator === "GTE") return left >= right;
  return left <= right;
}
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const contactHash = (data: Record<string, string>) =>
  digest(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
export const stateKey = (
  mappingId: string,
  sourceKey: string,
  listId: string,
) => digest([mappingId, sourceKey, listId]);

function mappedValue(value: unknown, field: ContactField) {
  const text = value == null ? "" : String(value).trim();
  if (text.length > 4000)
    throw new Error(`${field.name} exceeds 4,000 characters`);
  if (!text) {
    if (field.required) throw new Error(`${field.name} is required`);
    return "";
  }
  if (field.type === "NUMBER" && !Number.isFinite(Number(text)))
    throw new Error(`${field.name} must be numeric`);
  if (field.type === "NUMBER") return String(Number(text));
  if (field.type === "DATE" && !Number.isFinite(dayNumber(text)))
    throw new Error(`${field.name} must be a valid date`);
  if (field.type === "BOOLEAN") {
    if (!["true", "false", "1", "0"].includes(text.toLowerCase()))
      throw new Error(`${field.name} must be true/false or 1/0`);
    return ["true", "1"].includes(text.toLowerCase()) ? "true" : "false";
  }
  if (field.type === "PHONE") {
    const phone = text.replace(/[\s().-]/g, "");
    const normalized = /^0[689]\d{8}$/.test(phone)
      ? "+66" + phone.slice(1)
      : phone;
    if (!/^\+?[1-9]\d{7,14}$/.test(normalized))
      throw new Error(`${field.name} is not a valid phone number`);
    return normalized;
  }
  return text;
}

export async function resolveLead(
  id: string,
  listId = "",
  now = new Date(),
): Promise<LeadPreview> {
  const lead = await entity(leadDefinitions, id);
  const mapping = await entity(sourceMappings, lead.mappingId);
  const [template, source, states] = await Promise.all([
    entity(contactTemplates, mapping.templateId),
    entity(sourceIntegrations, mapping.sourceId),
    importStates.all(),
  ]);
  const loaded = await loadSource(source);
  const legacyPolicies =
    source.kind === "LEGACY"
      ? new Map(
          (await (await import("../domain/store")).policies.all()).map(
            (policy) => [policy.policyId, policy],
          ),
        )
      : null;
  const stateMap = new Map(states.map((state) => [state.id, state]));
  const keys = new Set<string>(),
    phones = new Set<string>();
  const rows: LeadRow[] = [];
  for (const raw of loaded.rows) {
    const rawKey = String(raw[mapping.keyField] ?? "").trim();
    const sourceKey = rawKey.slice(0, 256);
    const data: Record<string, string> = Object.create(null);
    let message = "";
    for (const field of template.fields) {
      const configured = mapping.fields.find(
        (item) => item.targetField === field.name,
      );
      const original = configured?.sourceField
        ? raw[configured.sourceField]
        : undefined;
      try {
        data[field.name] = mappedValue(
          original == null || original === ""
            ? configured?.defaultValue
            : original,
          field,
        );
      } catch (error) {
        data[field.name] =
          original == null ? "" : String(original).slice(0, 4000);
        message ||= (error as Error).message;
      }
    }
    const conditions = lead.filters.map((filter) =>
      matchesFilter(data, raw, filter, now),
    );
    if (
      conditions.length &&
      !(lead.match === "ALL"
        ? conditions.every(Boolean)
        : conditions.some(Boolean))
    )
      continue;
    let status: LeadRow["status"] = "ELIGIBLE";
    if (rawKey.length > 256) {
      status = "INVALID";
      message = "Source record key exceeds 256 characters";
    } else if (!sourceKey) {
      status = "INVALID";
      message = "Source record key is empty";
    } else if (keys.has(sourceKey)) {
      status = "DUPLICATE";
      message = "Duplicate source record key";
    } else if (message) status = "INVALID";
    else if (["true", "1"].includes(String(raw.dnc ?? "").toLowerCase())) {
      status = "DNC";
      message = "Source record is marked Do Not Call";
    } else if (source.kind === "LEGACY" && raw.legacyEligible === false) {
      status = "INVALID";
      message = "Excluded by the original campaign eligibility rules";
    }
    const phone = template.fields
      .filter((field) => field.type === "PHONE")
      .map((field) => data[field.name])
      .find(Boolean);
    if (status === "ELIGIBLE" && phone && phones.has(phone)) {
      status = "DUPLICATE";
      message = "Duplicate phone number in this lead";
    }
    if (sourceKey) keys.add(sourceKey);
    if (phone) phones.add(phone);
    const rowId = stateKey(
      source.kind === "LEGACY" ? "legacy-policy" : mapping.id,
      sourceKey,
      listId,
    );
    const legacyPolicy = legacyPolicies?.get(sourceKey);
    const legacyContact =
      legacyPolicy?.genesys.contactListId === listId &&
      legacyPolicy.genesys.contactId
        ? legacyPolicy.genesys
        : undefined;
    const legacyHash = payloadHash(
      Object.fromEntries(
        CONTACT_COLUMNS.map((field) => [field, data[field] || ""]),
      ) as CampaignContact,
    );
    const state =
      stateMap.get(rowId) ||
      (legacyContact
        ? {
            status: legacyContact.syncStatus === "SYNCED" ? "SYNCED" : "FAILED",
            payloadHash:
              legacyContact.lastPayloadHash === legacyHash
                ? contactHash(data)
                : "legacy-outdated",
            contactId: legacyContact.contactId,
            message: "",
          }
        : undefined);
    if (status === "ELIGIBLE" && state) {
      if (["UNKNOWN", "PENDING"].includes(state.status)) {
        status = "UNKNOWN";
        message =
          state.message ||
          "Previous request has an unknown outcome; reconcile in Genesys";
      } else if (
        state.status === "SYNCED" &&
        state.payloadHash === contactHash(data)
      )
        status = "ALREADY_SYNCED";
      else if (state.contactId) status = "UPDATE_AVAILABLE";
    }
    rows.push({
      id: rowId,
      sourceKey,
      data,
      source: raw,
      status,
      message,
      contactId: state?.contactId || "",
    });
  }
  return {
    legacySource: source.kind === "LEGACY",
    lead,
    mapping,
    template,
    fields: template.fields.map((field) => field.name),
    rows,
    total: rows.length,
    sourceTotal: loaded.total,
    truncated: loaded.truncated,
    revision: digest([
      lead,
      mapping,
      template,
      rows.map((row) => [row.sourceKey, row.data]),
    ]),
    summary: {
      matched: rows.length,
      eligible: rows.filter((row) =>
        ["ELIGIBLE", "UPDATE_AVAILABLE"].includes(row.status),
      ).length,
      synced: rows.filter((row) => row.status === "ALREADY_SYNCED").length,
      invalid: rows.filter(
        (row) =>
          !["ELIGIBLE", "UPDATE_AVAILABLE", "ALREADY_SYNCED"].includes(
            row.status,
          ),
      ).length,
    },
  };
}
