import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { alertDatasources, alertEnrichmentRules, alertUploadDir } from "../domain/alert-store";
import type { AlertDatasource, AlertEnrichmentRule, AlertValue, ReceivedAlert } from "../domain/alert-types";
import { sourceIntegrations } from "../domain/pipeline-store";
import { loadSource, assertReadQuery } from "./source-data.service";
import { audit } from "../domain/store";
import { httpError } from "../domain/business";
import { resolveAlertPath } from "./alert-rules.service";

const name = z.string().trim().min(1).max(120);
const datasourceSchema = z.object({
  name,
  description: z.string().max(1000).default(""),
  kind: z.enum(["FILE", "DATABASE", "QUERY"]),
  enabled: z.boolean().default(false),
  fileName: z.string().max(255).default(""),
  storedFile: z.string().max(64).default(""),
  fileId: z.string().uuid().optional().or(z.literal("")),
  worksheet: z.string().max(128).default(""),
  sourceId: z.string().uuid().default("00000000-0000-4000-8000-000000000000"),
  query: z.string().max(20000).default(""),
  keyColumn: z.string().max(128).default(""),
  columns: z.array(z.string().max(128)).optional(),
  health: z.enum(["UNKNOWN", "AVAILABLE", "ERROR"]).optional(),
  healthCheckedAt: z.string().max(100).optional(),
  healthMessage: z.string().max(500).optional(),
}).strict();
const ruleSchema = z.object({
  name,
  description: z.string().max(1000).default(""),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(100000).default(100),
  alertConfigId: z.string().uuid(),
  datasourceId: z.string().uuid(),
  lookup: z.array(z.object({ alertField: z.string().min(1).max(128), column: z.string().min(1).max(128) })).min(1).max(20),
  outputs: z.array(z.object({
    name: z.string().min(1).max(128),
    kind: z.enum(["COLUMN", "CONCAT", "STATIC", "UPPER", "LOWER", "TRIM"]),
    columns: z.array(z.string().max(128)).max(20).default([]),
    value: z.string().max(2000).default(""),
    required: z.boolean().default(false),
    defaultValue: z.string().max(2000).default(""),
    overwrite: z.boolean().default(false),
  })).min(1).max(100),
  notFound: z.enum(["KEEP", "DEFAULT", "FAIL"]).default("KEEP"),
  onError: z.enum(["SKIP", "FAIL"]).default("FAIL"),
}).strict();

function normalizeColumn(value: unknown): AlertValue {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function csvRows(content: string) {
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw httpError(413, "Enrichment file exceeds 5 MB");
  const rows = parse(content, { bom: true, skip_empty_lines: true, columns: (headers: string[]) => {
    const values = headers.map((item) => item.trim());
    if (!values.length || values.some((item) => !item) || new Set(values).size !== values.length || values.some((item) => ["__proto__", "prototype", "constructor"].includes(item)))
      throw new Error("CSV headers must be unique and non-empty");
    return values;
  }, max_record_size: 1024 * 1024 }) as Record<string, unknown>[];
  if (rows.length > 10000) throw httpError(413, "Enrichment file may contain at most 10,000 rows");
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeColumn(value)])));
}

function xlsxRows(buffer: Buffer, worksheetName = "") {
  if (buffer.byteLength > 5 * 1024 * 1024) throw httpError(413, "Enrichment file exceeds 5 MB");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer, { filter: (entry) => ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"].includes(entry.name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name) });
  } catch { throw httpError(400, "Invalid XLSX workbook"); }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false, maxNestedTags: 20 });
  const workbookXml = entries["xl/workbook.xml"];
  if (!workbookXml) throw httpError(400, "XLSX workbook is missing workbook metadata");
  const workbook = parser.parse(Buffer.from(workbookXml).toString("utf8"));
  const rawSheets = workbook?.workbook?.sheets?.sheet;
  const sheets = Array.isArray(rawSheets) ? rawSheets : rawSheets ? [rawSheets] : [];
  if (!sheets.length) throw httpError(400, "XLSX workbook has no worksheets");
  const selected = sheets.find((sheet: Record<string, unknown>) => !worksheetName || sheet["@_name"] === worksheetName) as Record<string, string> | undefined;
  if (!selected) throw httpError(400, "Selected XLSX worksheet does not exist");
  const rels = entries["xl/_rels/workbook.xml.rels"] ? parser.parse(Buffer.from(entries["xl/_rels/workbook.xml.rels"]).toString("utf8")) : {};
  const rawRels = rels?.Relationships?.Relationship;
  const relations = Array.isArray(rawRels) ? rawRels : rawRels ? [rawRels] : [];
  const relation = relations.find((item: Record<string, string>) => item["@_Id"] === selected["@_r:id"]);
  const target = String(relation?.["@_Target"] || "worksheets/sheet1.xml").replace(/^\//, "").replace(/^xl\//, "");
  if (target.includes("..") || target.includes("\\")) throw httpError(400, "Invalid XLSX worksheet path");
  const sheetXml = entries[`xl/${target}`];
  if (!sheetXml) throw httpError(400, "XLSX worksheet is missing");
  const sharedRaw = entries["xl/sharedStrings.xml"] ? parser.parse(Buffer.from(entries["xl/sharedStrings.xml"]).toString("utf8"))?.sst?.si : [];
  const shared = (Array.isArray(sharedRaw) ? sharedRaw : sharedRaw ? [sharedRaw] : []).map((item: Record<string, unknown>) => {
    const value = item.t;
    if (typeof value === "string") return value;
    const texts = value && typeof value === "object" ? (value as Record<string, unknown>).r : null;
    const fragments = Array.isArray(texts) ? texts : texts ? [texts] : [];
    return fragments.map((fragment) => String((fragment as Record<string, unknown>).t ?? "")).join("");
  });
  const parsed = parser.parse(Buffer.from(sheetXml).toString("utf8"));
  const rawRows = parsed?.worksheet?.sheetData?.row;
  const rows = (Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : []).slice(0, 10002);
  if (!rows.length) throw httpError(400, "Selected worksheet is empty");
  const columnIndex = (reference: string) => {
    const letters = reference.replace(/[0-9]/g, "");
    let result = 0;
    for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
    return result - 1;
  };
  const cellValue = (cell: Record<string, unknown>) => {
    const value = cell.v;
    if (cell["@_t"] === "s") return shared[Number(value)] ?? "";
    if (cell["@_t"] === "inlineStr") {
      const inline = cell.is as Record<string, unknown> | undefined;
      return String(inline?.t ?? "");
    }
    return value ?? "";
  };
  const firstCells = rows[0].c;
  const headerCells = Array.isArray(firstCells) ? firstCells : firstCells ? [firstCells] : [];
  const maxColumn = Math.max(0, ...headerCells.map((cell: Record<string, unknown>) => columnIndex(String(cell["@_r"] || "A1"))));
  const headers = Array.from({ length: maxColumn + 1 }, (_, index) => {
    const cell = headerCells.find((item: Record<string, unknown>) => columnIndex(String(item["@_r"] || "A1")) === index) as Record<string, unknown> | undefined;
    return String(cell ? cellValue(cell) : "").trim();
  });
  if (!headers.length || headers.some((value) => !value) || new Set(headers).size !== headers.length || headers.some((value) => ["__proto__", "prototype", "constructor"].includes(value)))
    throw httpError(400, "XLSX header row must have unique, non-empty column names");
  return rows.slice(1).map((row: Record<string, unknown>) => {
    const cellsRaw = row.c;
    const cells = Array.isArray(cellsRaw) ? cellsRaw : cellsRaw ? [cellsRaw] : [];
    const values: Record<string, AlertValue> = Object.create(null);
    for (const cell of cells as Record<string, unknown>[]) {
      const index = columnIndex(String(cell["@_r"] || "A1"));
      if (headers[index]) values[headers[index]] = normalizeColumn(cellValue(cell));
    }
    return values;
  }).filter((row: Record<string, AlertValue>) => Object.values(row).some((value) => value !== "" && value !== null));
}

async function datasourceRows(datasource: AlertDatasource, parameters?: Record<string, AlertValue>, allowDisabledPreview = false) {
  if (!datasource.enabled && !allowDisabledPreview) throw httpError(409, "Enrichment datasource is disabled");
  if (datasource.kind === "FILE") {
    if (!/^[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(datasource.storedFile) || !datasource.fileId || !datasource.storedFile.startsWith(datasource.fileId))
      throw httpError(400, "Enrichment datasource file reference is invalid");
    const filePath = path.join(alertUploadDir, datasource.storedFile);
    const buffer = await readFile(filePath);
    return datasource.fileName.toLowerCase().endsWith(".csv")
      ? csvRows(buffer.toString("utf8"))
      : xlsxRows(buffer, datasource.worksheet);
  }
  const source = await sourceIntegrations.findById("id", datasource.sourceId);
  if (!source) throw httpError(404, "Linked source integration is unavailable");
  const config = { ...source.config };
    if (datasource.kind === "QUERY") {
      config.query = assertReadQuery(datasource.query);
      const names = [...new Set([...datasource.query.matchAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))];
      config.queryParameters = Object.fromEntries(names.map((name) => [name, String(parameters?.[name] ?? "")]));
  }
  const result = await loadSource({ ...source, config }, false, false);
  return result.rows as Record<string, AlertValue>[];
}

export function publicDatasource(item: AlertDatasource) {
  return { ...item, storedFile: item.kind === "FILE" ? item.storedFile : "" };
}

export async function saveAlertDatasource(input: unknown, actor: string, id?: string) {
  const data = datasourceSchema.parse(input);
  const previous = id ? await alertDatasources.findById("id", id) : undefined;
  if (id && !previous) throw httpError(404, "Enrichment datasource not found");
  if ((await alertDatasources.all()).some((item) => item.id !== id && item.name.toLowerCase() === data.name.toLowerCase()))
    throw httpError(409, "Datasource name is already in use");
  let columns = previous?.columns || [];
  if (data.kind === "FILE") {
    const fileId = data.fileId || previous?.fileId || "";
    const storedFile = data.storedFile || previous?.storedFile || "";
    if (!fileId || !/^[a-f0-9-]{36}\.(?:csv|xlsx)$/i.test(storedFile) || !storedFile.startsWith(fileId)) throw httpError(400, "Upload an enrichment file before saving");
    const filePath = path.join(alertUploadDir, storedFile);
    const buffer = await readFile(filePath);
    const rows = data.fileName.toLowerCase().endsWith(".csv") ? csvRows(buffer.toString("utf8")) : xlsxRows(buffer, data.worksheet);
    columns = Object.keys(rows[0] || {});
    if (!columns.length) throw httpError(400, "Enrichment datasource file has no columns");
    if (data.keyColumn && !columns.includes(data.keyColumn)) throw httpError(400, "Lookup key column is not present in the file");
  } else {
    const source = await sourceIntegrations.findById("id", data.sourceId);
    if (!source) throw httpError(404, "Select an existing Source Integration");
    const query = data.kind === "QUERY" ? assertReadQuery(data.query) : "";
    if (data.kind === "QUERY" && !query) throw httpError(400, "Enter a read-only SELECT query");
    const names = query ? [...new Set([...query.matchAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))] : [];
    const queryParameters = Object.fromEntries(names.map((key) => [key, ""]));
    const result = await loadSource({ ...source, config: { ...source.config, ...(query ? { query, queryParameters } : {}) } }, data.kind === "DATABASE", false);
    columns = result.fields;
    if (data.keyColumn && !columns.includes(data.keyColumn)) throw httpError(400, "Lookup key column is not present in the datasource");
  }
  const timestamp = new Date().toISOString();
  const saved = await alertDatasources.mutate((rows) => {
    const old = rows.find((item) => item.id === id);
    const result: AlertDatasource = {
      ...data, id: id || randomUUID(), fileId: data.fileId || old?.fileId || "", storedFile: data.storedFile || old?.storedFile || "",
      columns, updatedBy: actor, health: "AVAILABLE", healthCheckedAt: timestamp,
      healthMessage: "Datasource verified successfully", createdAt: old?.createdAt || timestamp, updatedAt: timestamp,
    };
    if (old) rows.splice(rows.indexOf(old), 1, result); else rows.push(result);
    return result;
  });
  await audit(id ? "UPDATE_ALERT_DATASOURCE" : "CREATE_ALERT_DATASOURCE", actor, saved.id, { kind: saved.kind });
  return publicDatasource(saved);
}

export async function uploadAlertDatasource(input: unknown) {
  const schema = z.object({ fileName: z.string().trim().min(1).max(255), content: z.string().min(1).max(7 * 1024 * 1024), worksheet: z.string().max(128).optional() }).strict();
  const data = schema.parse(input);
  const isCsv = data.fileName.toLowerCase().endsWith(".csv");
  const isXlsx = data.fileName.toLowerCase().endsWith(".xlsx");
  if (!isCsv && !isXlsx) throw httpError(400, "Choose a CSV or XLSX file");
  const buffer = Buffer.from(data.content, "base64");
  if (buffer.byteLength > 5 * 1024 * 1024) throw httpError(413, "Enrichment files must be 5 MB or smaller");
  const rows = isCsv ? csvRows(buffer.toString("utf8")) : xlsxRows(buffer, data.worksheet);
  const columns = Object.keys(rows[0] || {});
  if (!columns.length) throw httpError(400, "File has no header or data rows");
  const id = randomUUID();
  await mkdir(alertUploadDir, { recursive: true });
  const storedFile = `${id}${isCsv ? ".csv" : ".xlsx"}`;
  const filePath = path.join(alertUploadDir, storedFile);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
  return { id, fileName: data.fileName, worksheet: data.worksheet || "", fileId: id, storedFile, columns, preview: rows.slice(0, 10) };
}

export async function previewAlertDatasource(id: string, queryParameters?: Record<string, AlertValue>) {
  const datasource = await alertDatasources.findById("id", id);
  if (!datasource) throw httpError(404, "Enrichment datasource not found");
  const rows = await datasourceRows(datasource, queryParameters, true);
  await alertDatasources.mutate((items) => {
    const current = items.find((item) => item.id === id);
    if (current) {
      current.health = "AVAILABLE"; current.healthCheckedAt = new Date().toISOString();
      current.healthMessage = "Datasource preview succeeded";
    }
  });
  return { columns: datasource.columns, total: rows.length, rows: rows.slice(0, 100) };
}

export async function saveEnrichmentRule(input: unknown, actor: string, id?: string) {
  const data = ruleSchema.parse(input);
  const [previous, datasource] = await Promise.all([
    id ? alertEnrichmentRules.findById("id", id) : undefined,
    alertDatasources.findById("id", data.datasourceId),
  ]);
  if (id && !previous) throw httpError(404, "Enrichment rule not found");
  if (!datasource) throw httpError(404, "Enrichment datasource not found");
  if (data.outputs.some((item) => item.columns.some((column) => !datasource.columns.includes(column))))
    throw httpError(400, "An output field refers to a missing datasource column");
  if (new Set(data.outputs.map((item) => item.name)).size !== data.outputs.length)
    throw httpError(400, "Enrichment output field names must be unique");
  const timestamp = new Date().toISOString();
  const saved = await alertEnrichmentRules.mutate((rows) => {
    if (rows.some((item) => item.id !== id && item.name.toLowerCase() === data.name.toLowerCase())) throw httpError(409, "Enrichment rule name is already in use");
    const old = rows.find((item) => item.id === id);
    const result: AlertEnrichmentRule = { ...data, id: id || randomUUID(), createdAt: old?.createdAt || timestamp, updatedAt: timestamp };
    if (old) rows.splice(rows.indexOf(old), 1, result); else rows.push(result);
    return result;
  });
  await audit(id ? "UPDATE_ALERT_ENRICHMENT_RULE" : "CREATE_ALERT_ENRICHMENT_RULE", actor, saved.id, { alertConfigId: saved.alertConfigId, datasourceId: saved.datasourceId });
  return saved;
}

function outputValue(output: AlertEnrichmentRule["outputs"][number], row: Record<string, AlertValue>): AlertValue {
  if (output.kind === "STATIC") return output.value;
  const values = output.columns.map((column) => row[column]);
  let value: AlertValue = output.kind === "CONCAT" ? values.map((item) => item ?? "").join(output.value) : values[0] ?? null;
  if (typeof value !== "string") value = value === null ? "" : String(value);
  if (output.kind === "UPPER") value = value.toUpperCase();
  if (output.kind === "LOWER") value = value.toLowerCase();
  if (output.kind === "TRIM") value = value.trim();
  return value || output.defaultValue || null;
}

export async function enrichAlertFields(alert: Pick<ReceivedAlert, "configId" | "originalFields">, overrides?: Map<string, AlertDatasource>) {
  const rules = (await alertEnrichmentRules.all()).filter((item) => item.enabled && item.alertConfigId === alert.configId).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const enriched = { ...alert.originalFields };
  const lookups = new Map<string, Record<string, AlertValue> | null>();
  const errors: string[] = [];
  for (const rule of rules) {
    const datasource = overrides?.get(rule.datasourceId) || await alertDatasources.findById("id", rule.datasourceId);
    if (!datasource) { errors.push(`Datasource unavailable for rule ${rule.name}`); if (rule.onError === "FAIL") throw httpError(424, `Datasource unavailable for rule ${rule.name}`); continue; }
    const values = rule.lookup.map(({ alertField }) => resolveAlertPath(enriched, alertField));
    if (values.some((value) => value === undefined || value === null || value === "")) {
      for (const output of rule.outputs) if (output.defaultValue && (output.overwrite || enriched[output.name] === undefined)) enriched[output.name] = output.defaultValue;
      continue;
    }
    const params = Object.fromEntries(rule.lookup.map(({ alertField }, index) => [alertField, values[index]!]));
    const cacheKey = `${datasource.id}:${JSON.stringify(params)}`;
    let row = lookups.get(cacheKey);
    if (row === undefined) {
      try {
        const rows = await datasourceRows(datasource, params);
        row = rows.find((item) => rule.lookup.every(({ column }, index) => String(item[column] ?? "") === String(values[index] ?? ""))) || null;
        lookups.set(cacheKey, row);
      } catch (error) {
        errors.push((error as Error).message.slice(0, 300));
        if (rule.onError === "FAIL") throw error;
        continue;
      }
    }
    if (!row) {
      errors.push(`No datasource row matched rule ${rule.name}`);
      if (rule.notFound === "FAIL") throw httpError(404, `No enrichment record matched rule ${rule.name}`);
      for (const output of rule.outputs) if (rule.notFound === "DEFAULT" && (output.overwrite || enriched[output.name] === undefined)) enriched[output.name] = output.defaultValue || null;
      continue;
    }
    for (const output of rule.outputs) {
      if (!output.overwrite && Object.hasOwn(enriched, output.name)) continue;
      const value = outputValue(output, row);
      if (output.required && (value === null || value === "")) throw httpError(422, `Required enrichment field is missing: ${output.name}`);
      enriched[output.name] = value;
    }
  }
  return { fields: enriched, status: errors.length ? "PARTIAL" as const : "SUCCESS" as const, errors };
}

export async function previewEnrichment(id: string, sample: Record<string, AlertValue>) {
  const alert = await (await import("../domain/alert-store")).receivedAlerts.findById("id", id);
  const configId = alert?.configId;
  if (!configId) throw httpError(404, "Sample Alert not found");
  return enrichAlertFields({ configId, originalFields: alert.originalFields });
}

export const alertEnrichmentUtils = { csvRows, xlsxRows, datasourceRows };
