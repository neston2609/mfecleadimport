import {
  DEFAULT_ACTIVE_REGION_ID,
  SYSTEM_GENESYS_REGIONS,
} from "./default-regions";
import { readJsonFile, writeJsonFile } from "./file-store";
import { GenesysAuditService } from "./audit.service";
import { GenesysConfigService } from "./genesys-config.service";

import type {
  EndpointValidationResult,
  GenesysRegion,
  GenesysRegionCatalog,
} from "./types";

const CATALOG_FILE = "genesys-regions.json";
const URL_FIELDS = ["applicationUrl", "apiBaseUrl", "authBaseUrl"] as const;

type UrlField = (typeof URL_FIELDS)[number];

type RegionInput = {
  id?: string;
  name?: string;
  domain?: string;
  applicationUrl?: string;
  apiBaseUrl?: string;
  authBaseUrl?: string;
  enabled?: boolean;
};

export class GenesysRegionService {
  constructor(
    private readonly audit = new GenesysAuditService(),
    private readonly configService = new GenesysConfigService(audit),
  ) {}

  async initialize(): Promise<void> {
    await this.loadCatalog();
    await this.configService.ensureConfig();
  }

  async listRegions(): Promise<GenesysRegion[]> {
    const catalog = await this.loadCatalog();
    return catalog.regions.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async getRegion(regionId: string): Promise<GenesysRegion> {
    const catalog = await this.loadCatalog();
    const region = catalog.regions.find((item) => item.id === regionId);
    if (!region) {
      throw createHttpError(404, "Region not found");
    }
    return region;
  }

  async getActiveRegion(): Promise<GenesysRegion> {
    const config = await this.configService.getConfig();
    try {
      return await this.getRegion(config.regionId);
    } catch {
      return this.getRegion(DEFAULT_ACTIVE_REGION_ID);
    }
  }

  async getHistory(regionId: string) {
    await this.getRegion(regionId);
    return this.audit.historyForRegion(regionId);
  }

  async createCustomRegion(
    input: RegionInput,
    user = "admin",
  ): Promise<GenesysRegion> {
    const catalog = await this.loadCatalog();
    const id = normalizeRegionId(input.id);
    if (!id) {
      throw createHttpError(400, "Region code is required");
    }
    if (catalog.regions.some((region) => region.id === id)) {
      throw createHttpError(409, "Region code already exists");
    }

    const timestamp = new Date().toISOString();
    const urls = validateRegionUrls(input);
    const region: GenesysRegion = {
      id,
      name: requireString(input.name, "Region name"),
      domain: input.domain?.trim() || inferDomain(urls.apiBaseUrl),
      ...urls,
      defaultApplicationUrl: urls.applicationUrl,
      defaultApiBaseUrl: urls.apiBaseUrl,
      defaultAuthBaseUrl: urls.authBaseUrl,
      systemRegion: false,
      enabled: input.enabled ?? true,
      modified: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      updatedBy: user,
    };

    catalog.regions.push(region);
    await this.saveCatalog(catalog);
    await this.audit.append(
      "GENESYS_REGION_CREATED",
      {
        regionId: region.id,
        regionName: region.name,
      },
      user,
    );
    return region;
  }

  async updateRegion(
    regionId: string,
    input: RegionInput,
    user = "admin",
  ): Promise<GenesysRegion> {
    const catalog = await this.loadCatalog();
    const index = catalog.regions.findIndex((region) => region.id === regionId);
    if (index === -1) {
      throw createHttpError(404, "Region not found");
    }

    const current = catalog.regions[index];
    const urls = validateRegionUrls({ ...current, ...input });
    const next: GenesysRegion = {
      ...current,
      name: input.name?.trim() || current.name,
      domain: input.domain?.trim() || current.domain,
      applicationUrl: urls.applicationUrl,
      apiBaseUrl: urls.apiBaseUrl,
      authBaseUrl: urls.authBaseUrl,
      enabled: input.enabled ?? current.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: user,
    };
    next.modified = isModifiedFromDefault(next);

    const changes = collectChanges(current, next, [
      "name",
      "domain",
      "applicationUrl",
      "apiBaseUrl",
      "authBaseUrl",
      "enabled",
    ]);
    catalog.regions[index] = next;
    await this.saveCatalog(catalog);

    if (Object.keys(changes).length > 0) {
      await this.audit.append(
        next.enabled === current.enabled
          ? "GENESYS_REGION_UPDATED"
          : next.enabled
            ? "GENESYS_REGION_ENABLED"
            : "GENESYS_REGION_DISABLED",
        {
          regionId: next.id,
          regionName: next.name,
          changedFields: Object.keys(changes),
        },
        user,
      );
      await this.audit.appendHistory(
        {
          regionId: next.id,
          regionName: next.name,
          changes,
        },
        user,
      );
    }

    const active = await this.getActiveRegion();
    if (
      active.id === next.id &&
      Object.keys(changes).some((field) =>
        URL_FIELDS.includes(field as UrlField),
      )
    ) {
      await this.configService.markNotTested();
    }

    return next;
  }

  async resetRegion(regionId: string, user = "admin"): Promise<GenesysRegion> {
    const catalog = await this.loadCatalog();
    const index = catalog.regions.findIndex((region) => region.id === regionId);
    if (index === -1) {
      throw createHttpError(404, "Region not found");
    }
    const current = catalog.regions[index];
    if (!current.systemRegion) {
      throw createHttpError(400, "Only built-in regions can be reset");
    }

    const next: GenesysRegion = {
      ...current,
      applicationUrl: current.defaultApplicationUrl,
      apiBaseUrl: current.defaultApiBaseUrl,
      authBaseUrl: current.defaultAuthBaseUrl,
      modified: false,
      updatedAt: new Date().toISOString(),
      updatedBy: user,
    };
    const changes = collectChanges(current, next, [
      "applicationUrl",
      "apiBaseUrl",
      "authBaseUrl",
    ]);
    catalog.regions[index] = next;
    await this.saveCatalog(catalog);

    await this.audit.append(
      "GENESYS_REGION_RESET",
      {
        regionId: next.id,
        regionName: next.name,
        changedFields: Object.keys(changes),
      },
      user,
    );
    if (Object.keys(changes).length > 0) {
      await this.audit.appendHistory(
        {
          regionId: next.id,
          regionName: next.name,
          changes,
        },
        user,
      );
    }

    const active = await this.getActiveRegion();
    if (active.id === next.id) {
      await this.configService.markNotTested();
    }
    return next;
  }

  async deleteRegion(regionId: string): Promise<void> {
    const catalog = await this.loadCatalog();
    const config = await this.configService.getConfig();
    const region = catalog.regions.find((item) => item.id === regionId);
    if (!region) {
      throw createHttpError(404, "Region not found");
    }
    if (region.systemRegion) {
      throw createHttpError(400, "Built-in regions cannot be deleted");
    }
    if (config.regionId === regionId) {
      throw createHttpError(
        400,
        "This region is currently selected for the Genesys integration and cannot be deleted.",
      );
    }
    await this.saveCatalog({
      ...catalog,
      regions: catalog.regions.filter((item) => item.id !== regionId),
    });
  }

  async validateEndpoints(
    regionId: string,
  ): Promise<Record<UrlField, EndpointValidationResult>> {
    const region = await this.getRegion(regionId);
    return this.validateEndpointValues(region);
  }

  async validateEndpointValues(
    input: RegionInput,
  ): Promise<Record<UrlField, EndpointValidationResult>> {
    const urls = validateRegionUrls(input);
    const entries = await Promise.all(
      URL_FIELDS.map(
        async (field) => [field, await testEndpoint(urls[field])] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<
      UrlField,
      EndpointValidationResult
    >;
  }

  private async loadCatalog(): Promise<GenesysRegionCatalog> {
    const existing = await readJsonFile<GenesysRegionCatalog | null>(
      CATALOG_FILE,
      null,
    );
    const timestamp = new Date().toISOString();

    if (!existing) {
      const catalog = {
        version: 1,
        regions: SYSTEM_GENESYS_REGIONS.map((region) => ({
          ...region,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      };
      await this.saveCatalog(catalog);
      return catalog;
    }

    const merged = mergeSystemRegions(existing, timestamp);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      await this.saveCatalog(merged);
    }
    return merged;
  }

  private async saveCatalog(catalog: GenesysRegionCatalog): Promise<void> {
    await writeJsonFile(CATALOG_FILE, catalog);
  }
}

function mergeSystemRegions(
  existing: GenesysRegionCatalog,
  timestamp: string,
): GenesysRegionCatalog {
  const byId = new Map(existing.regions.map((region) => [region.id, region]));
  const regions = [...existing.regions];

  for (const systemRegion of SYSTEM_GENESYS_REGIONS) {
    const installed = byId.get(systemRegion.id);
    if (!installed) {
      regions.push({
        ...systemRegion,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      continue;
    }

    Object.assign(installed, {
      defaultApplicationUrl: systemRegion.defaultApplicationUrl,
      defaultApiBaseUrl: systemRegion.defaultApiBaseUrl,
      defaultAuthBaseUrl: systemRegion.defaultAuthBaseUrl,
      systemRegion: true,
    });
    installed.modified = isModifiedFromDefault(installed);
  }

  return { version: Math.max(existing.version ?? 1, 1), regions };
}

function validateRegionUrls(input: RegionInput): Record<UrlField, string> {
  return {
    applicationUrl: normalizeUrl(
      requireString(input.applicationUrl, "Application URL"),
    ),
    apiBaseUrl: normalizeUrl(requireString(input.apiBaseUrl, "API Base URL")),
    authBaseUrl: normalizeUrl(
      requireString(input.authBaseUrl, "OAuth/Login Base URL"),
    ),
  };
}

function normalizeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw createHttpError(400, "Enter a valid URL");
  }

  const blocked = new Set(["javascript:", "file:", "data:", "ftp:"]);
  if (blocked.has(parsed.protocol)) {
    throw createHttpError(400, "This URL scheme is not allowed");
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw createHttpError(400, "Production URLs must use https://");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw createHttpError(400, "URL must use http:// or https://");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeRegionId(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-") ?? ""
  );
}

function requireString(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) {
    throw createHttpError(400, `${label} is required`);
  }
  return text;
}

function inferDomain(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).host.replace(/^api\./, "");
}

function isModifiedFromDefault(region: GenesysRegion): boolean {
  return (
    region.applicationUrl !== region.defaultApplicationUrl ||
    region.apiBaseUrl !== region.defaultApiBaseUrl ||
    region.authBaseUrl !== region.defaultAuthBaseUrl
  );
}

function collectChanges<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: string[],
) {
  return Object.fromEntries(
    fields
      .filter((field) => before[field] !== after[field])
      .map((field) => [field, { from: before[field], to: after[field] }]),
  );
}

async function testEndpoint(url: string): Promise<EndpointValidationResult> {
  try {
    const response = await fetchWithTimeout(url, "HEAD");
    return { url, reachable: response.status < 500, status: response.status };
  } catch (headError) {
    try {
      const response = await fetchWithTimeout(url, "GET");
      return { url, reachable: response.status < 500, status: response.status };
    } catch (error) {
      return {
        url,
        reachable: false,
        error: error instanceof Error ? error.message : String(headError),
      };
    }
  }
}

async function fetchWithTimeout(
  url: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createHttpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

export const genesysRegionService = new GenesysRegionService();
