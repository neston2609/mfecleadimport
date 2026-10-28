import { parse } from "csv-parse/sync";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { dataDir } from "../domain/json-repository";
import { decryptSecret } from "./genesys/secret.service";
import { httpError } from "../domain/business";
import type {
  DataRow,
  SourceData,
  SourceIntegration,
} from "../domain/pipeline-types";

export const MAX_SOURCE_ROWS = 10000;
const MAX_BYTES = 5 * 1024 * 1024;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function flattenRecord(record: DataRow): DataRow {
  const result: DataRow = Object.create(null);
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (depth > 8) throw httpError(400, "Response nesting exceeds 8 levels");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN.has(key)) throw httpError(400, "Unsupported field name");
        walk(item, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
    } else {
      if (Object.hasOwn(result, prefix))
        throw httpError(400, `Duplicate flattened field: ${prefix}`);
      result[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
  };
  walk(record, "", 0);
  return result;
}

export function selectJsonRows(payload: unknown, resultPath = ""): DataRow[] {
  let value = payload;
  if (resultPath)
    for (const part of resultPath.split(".")) {
      if (FORBIDDEN.has(part)) throw httpError(400, "Invalid result path");
      value =
        value && typeof value === "object"
          ? (value as DataRow)[part]
          : undefined;
    }
  if (
    !resultPath &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const object = value as DataRow;
    for (const field of ["items", "data", "results", "records", "entities"])
      if (Array.isArray(object[field])) {
        value = object[field];
        break;
      }
  }
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
      : null;
  if (
    !rows ||
    rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    throw httpError(
      400,
      "Choose a result path containing an object or an array of objects",
    );
  return rows
    .slice(0, MAX_SOURCE_ROWS + 1)
    .map((row) => flattenRecord(row as DataRow));
}

export function parseCsv(
  content: string,
  delimiter?: string,
): DataRow[] & { columns: string[] } {
  if (Buffer.byteLength(content) > MAX_BYTES)
    throw httpError(413, "Files must be 5 MB or smaller");
  const separator =
    delimiter ||
    [",", ";", "\t"]
      .map((value) => {
        try {
          return {
            value,
            count: (
              parse(content, {
                bom: true,
                delimiter: value,
                to: 1,
                skip_empty_lines: true,
              })[0] || []
            ).length,
          };
        } catch {
          return { value, count: 0 };
        }
      })
      .sort((a, b) => b.count - a.count)[0].value;
  let columns: string[] = [];
  try {
    const rows = parse(content, {
      bom: true,
      delimiter: separator,
      skip_empty_lines: true,
      to: MAX_SOURCE_ROWS + 1,
      columns: (headers: string[]) => {
        const fields = headers.map((name) => name.trim());
        if (
          !fields.length ||
          fields.some((name) => !name || FORBIDDEN.has(name)) ||
          new Set(fields).size !== fields.length
        )
          throw new Error("CSV headers must be unique, non-empty field names");
        columns = fields;
        return fields;
      },
      max_record_size: MAX_BYTES,
    }) as DataRow[] & { columns: string[] };
    Object.defineProperty(rows, "columns", { value: columns });
    return rows;
  } catch (error) {
    throw httpError(400, `Invalid CSV: ${(error as Error).message}`);
  }
}

function bounded(
  rows: DataRow[],
  fields?: string[],
  truncated = false,
): SourceData {
  const columns = fields ?? [
    ...new Set(rows.flatMap((row) => Object.keys(row))),
  ];
  if (columns.length > 200)
    throw httpError(400, "Sources may contain at most 200 fields");
  return {
    fields: columns,
    rows: rows.slice(0, MAX_SOURCE_ROWS),
    total: rows.length,
    truncated: truncated || rows.length > MAX_SOURCE_ROWS,
  };
}

export async function webData(source: SourceIntegration): Promise<SourceData> {
  const config = source.config;
  let uri: URL;
  try {
    uri = new URL(config.uri || "");
  } catch {
    throw httpError(400, "Enter a valid Web Service URI");
  }
  if (
    !["https:", "http:"].includes(uri.protocol) ||
    uri.username ||
    uri.password
  )
    throw httpError(400, "Use an HTTP(S) URI without embedded credentials");
  const addresses = await lookup(uri.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  const allowed = (process.env.SOURCE_ALLOWED_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const explicitlyAllowed = allowed.includes(uri.hostname.toLowerCase());
  for (const { address } of addresses) {
    let ip = address.toLowerCase();
    if (ip.includes(":"))
      ip = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, "");
    const mapped = ip.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (mapped) {
      const a = parseInt(mapped[1], 16),
        b = parseInt(mapped[2], 16);
      ip = `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
    } else ip = ip.replace(/^::ffff:/, "");
    if (
      /^(169\.254\.|fe[89ab]|fd00:ec2::254)/i.test(ip) ||
      ip === "100.100.100.200" ||
      ip === "168.63.129.16"
    )
      throw httpError(
        400,
        "Metadata and link-local addresses are not supported",
      );
    if (
      !explicitlyAllowed &&
      (/^(127\.|0\.)/.test(ip) || ip === "::1" || ip === "::")
    )
      throw httpError(
        400,
        "Loopback sources must be explicitly configured in SOURCE_ALLOWED_HOSTS",
      );
  }
  if (!addresses.length)
    throw httpError(400, "Source hostname did not resolve");
  const secret = decryptSecret(source.secretEncrypted);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.auth === "BASIC")
    headers.Authorization = `Basic ${Buffer.from(`${config.username || ""}:${secret}`).toString("base64")}`;
  if (config.auth === "BEARER") headers.Authorization = `Bearer ${secret}`;
  if (config.auth === "API_KEY") {
    const headerName = config.headerName || "X-API-Key";
    if (
      !/^[A-Za-z0-9-]+$/.test(headerName) ||
      /^(host|cookie|content-length|connection)$/i.test(headerName)
    )
      throw httpError(400, "Invalid API key header name");
    headers[headerName] = secret;
  }
  if (config.method === "POST") headers["Content-Type"] = "application/json";
  const payload = await new Promise<string>((resolve, reject) => {
    const client = uri.protocol === "https:" ? https : http;
    const address = addresses[0];
    const request = client.request(
      uri,
      {
        method: config.method || "GET",
        headers,
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
        signal: AbortSignal.timeout(20000),
      },
      (response) => {
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          reject(
            httpError(
              400,
              `Web Service returned HTTP ${response.statusCode}. Use the final URI if it redirects.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy(httpError(413, "Response exceeds 5 MB"));
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(
      config.method === "POST" ? config.requestBody || "{}" : undefined,
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw httpError(400, "Web Service must return JSON");
  }
  return bounded(selectJsonRows(parsed, config.resultPath));
}

export function assertReadQuery(query: string) {
  const sql = query.trim().replace(/;\s*$/, "");
  if (
    !/^select\b/i.test(sql) ||
    /;|--|\/\*|\b(into|outfile|dumpfile|for\s+update)\b/i.test(sql)
  )
    throw httpError(
      400,
      "Use a single read-only SELECT query without comments",
    );
  return sql;
}

let jdbcBusy = false;
export async function jdbcData(
  source: SourceIntegration,
  connectOnly = false,
): Promise<SourceData> {
  if (jdbcBusy)
    throw httpError(
      429,
      "Another database request is running. Wait for it to finish, then preview again.",
    );
  jdbcBusy = true;
  try {
    return await executeJdbc(source, connectOnly);
  } finally {
    jdbcBusy = false;
  }
}
async function executeJdbc(
  source: SourceIntegration,
  connectOnly = false,
): Promise<SourceData> {
  if (!/^jdbc:[a-z][a-z0-9-]*:/i.test(source.config.jdbcUrl || ""))
    throw httpError(
      400,
      "Enter a valid JDBC URL; the corresponding driver must be installed on the server",
    );
  if (/\b(password|user|username)\s*=/i.test(source.config.jdbcUrl || ""))
    throw httpError(
      400,
      "Enter database credentials in Username and Password, not in the JDBC URL",
    );
  if (
    /^jdbc:h2:/i.test(source.config.jdbcUrl || "") &&
    (process.env.JDBC_TEST_H2 !== "true" ||
      !/^jdbc:h2:mem:[a-z0-9_-]+$/i.test(source.config.jdbcUrl || ""))
  )
    throw httpError(400, "H2 is available only for isolated tests");
  if (
    /^jdbc:oracle:/i.test(source.config.jdbcUrl || "") &&
    !/^jdbc:oracle:thin:@/i.test(source.config.jdbcUrl || "")
  )
    throw httpError(
      400,
      "Use jdbc:oracle:thin:@... and separate credential fields",
    );
  if (
    /\b(autoDeserialize|allowLoadLocalInfile|allowUrlInLocalInfile|allowMultiQueries)\s*=\s*true/i.test(
      source.config.jdbcUrl || "",
    )
  )
    throw httpError(400, "Unsafe JDBC connection option");
  const query =
    !connectOnly && source.config.query?.trim()
      ? assertReadQuery(source.config.query)
      : "";
  if (!connectOnly && !query && !source.config.table)
    throw httpError(
      400,
      "Select a database table or enter a SELECT query before previewing or saving",
    );
  const input = {
    url: source.config.jdbcUrl || "",
    driverClass: source.config.driverClass || "",
    username: source.config.username || "",
    password: decryptSecret(source.secretEncrypted),
    query,
    table: source.config.table || "",
    action: connectOnly ? "connect" : "preview",
    limit: String(MAX_SOURCE_ROWS + 1),
  };
  const home = path.resolve(process.env.JDBC_HOME || "server/jdbc");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.env.JAVA_BIN || "java",
      [
        "-Xmx96m",
        "-cp",
        `${home}${path.delimiter}${path.join(home, "drivers", "*")}`,
        "JdbcBridge",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "",
      size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(httpError(504, "Database request exceeded 30 seconds"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill();
        reject(
          httpError(413, "Database response exceeds 5 MB; narrow the query"),
        );
      } else stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        httpError(
          503,
          "JDBC runtime is unavailable. Install Java and run npm run setup:jdbc on the server.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          httpError(
            400,
            "Database connection/query failed. Check the JDBC URL, credentials, permissions and selected table/query.",
          ),
        );
      else resolve(stdout);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(
      Object.entries(input)
        .map(
          ([key, value]) => `${key}=${Buffer.from(value).toString("base64")}`,
        )
        .join("\n"),
    );
  });
  const result = JSON.parse(output) as SourceData;
  return {
    ...bounded(result.rows.map(flattenRecord), result.fields, result.truncated),
    tables: result.tables,
  };
}

export async function loadSource(
  source: SourceIntegration,
  connectOnly = false,
): Promise<SourceData> {
  if (
    ["CSV", "JSON"].includes(source.kind) &&
    source.config.content === undefined
  ) {
    const fileId = source.config.fileId || source.id;
    if (!/^[a-f0-9-]{36}$/i.test(fileId))
      throw httpError(400, "Upload a file first");
    try {
      source = {
        ...source,
        config: {
          ...source.config,
          content: await readFile(
            path.join(dataDir, "source-files", `${fileId}.txt`),
            "utf8",
          ),
        },
      };
    } catch {
      throw httpError(400, "Upload a CSV or JSON file first");
    }
  }
  if (source.kind === "JDBC") return jdbcData(source, connectOnly);
  if (source.kind === "WEB") return webData(source);
  if (source.kind === "CSV") {
    const rows = parseCsv(source.config.content || "", source.config.delimiter);
    return bounded(rows, rows.columns);
  }
  if (source.kind === "JSON") {
    if (Buffer.byteLength(source.config.content || "") > MAX_BYTES)
      throw httpError(413, "Files must be 5 MB or smaller");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.config.content || "");
    } catch {
      throw httpError(400, "Invalid JSON file");
    }
    return bounded(selectJsonRows(parsed, source.config.resultPath));
  }
  const [{ campaigns, policies, customers, products }, { buildPreview }] =
    await Promise.all([
      import("../domain/store"),
      import("../domain/campaign-contact"),
    ]);
  const campaign = await campaigns.findById(
    "campaignListId",
    source.config.campaignListId || "",
  );
  if (!campaign) throw httpError(404, "Legacy source campaign not found");
  const preview = buildPreview(
    await policies.all(),
    await customers.all(),
    await products.all(),
    campaign.filters,
  );
  return bounded(
    preview.rows.map((row) => ({
      ...row.contact,
      policyId: row.policy.policyId,
      dnc: row.customer.dnc,
      legacyEligible: [
        "ELIGIBLE",
        "ALREADY_SYNCED",
        "RELOAD_AVAILABLE",
      ].includes(row.eligibility),
    })),
  );
}
