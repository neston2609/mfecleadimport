import { DEFAULT_ACTIVE_REGION_ID } from "./default-regions";
import { readJsonFile, writeJsonFile } from "./file-store";
import { GenesysAuditService } from "./audit.service";
import { tokenCacheService } from "./token-cache.service";
import type { GenesysConfig } from "./types";

const CONFIG_FILE = "genesys.json";

const defaultConfig: GenesysConfig = {
  enabled: true,
  regionId: DEFAULT_ACTIVE_REGION_ID,
  clientId: "",
  clientSecretEncrypted: "",
  contactListId: "",
  contactListName: "",
  phoneColumn: "phone",
  lastConnectionStatus: "NOT_TESTED",
  lastConnectionAt: "",
  lastSyncAt: "",
  schemaStatus: "NOT_TESTED",
};

export class GenesysConfigService {
  constructor(private readonly audit = new GenesysAuditService()) {}

  async ensureConfig(): Promise<GenesysConfig> {
    const config = await readJsonFile<GenesysConfig>(
      CONFIG_FILE,
      defaultConfig,
    );
    return { ...defaultConfig, ...config };
  }

  async getConfig(): Promise<GenesysConfig> {
    return this.ensureConfig();
  }

  async updateConfig(
    input: Partial<GenesysConfig>,
    user = "admin",
  ): Promise<GenesysConfig> {
    const current = await this.getConfig();
    const next: GenesysConfig = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      regionId: input.regionId ?? current.regionId,
      clientId: input.clientId ?? current.clientId,
      clientSecretEncrypted:
        input.clientSecretEncrypted === undefined
          ? current.clientSecretEncrypted
          : input.clientSecretEncrypted,
      contactListId: input.contactListId ?? current.contactListId,
      contactListName: input.contactListName ?? current.contactListName,
      phoneColumn: input.phoneColumn ?? current.phoneColumn,
    };

    if (
      next.regionId !== current.regionId ||
      next.clientId !== current.clientId ||
      next.clientSecretEncrypted !== current.clientSecretEncrypted
    ) {
      tokenCacheService.clear();
      next.lastConnectionStatus = "NOT_TESTED";
      next.lastConnectionAt = "";
    }
    if (
      next.regionId !== current.regionId ||
      next.contactListId !== current.contactListId ||
      next.phoneColumn !== current.phoneColumn
    ) {
      next.schemaStatus = "NOT_TESTED";
    }
    if (next.regionId !== current.regionId) {
      await this.audit.append(
        "GENESYS_REGION_SELECTED",
        {
          fromRegionId: current.regionId,
          toRegionId: next.regionId,
        },
        user,
      );
    }

    await writeJsonFile(CONFIG_FILE, next);
    return next;
  }

  async markNotTested(): Promise<void> {
    const current = await this.getConfig();
    tokenCacheService.clear();
    await writeJsonFile(CONFIG_FILE, {
      ...current,
      lastConnectionStatus: "NOT_TESTED",
      lastConnectionAt: "",
      schemaStatus: "NOT_TESTED",
    });
  }

  async markConnection(status: "SUCCESS" | "FAILED"): Promise<GenesysConfig> {
    const current = await this.getConfig();
    const next = {
      ...current,
      lastConnectionStatus: status,
      lastConnectionAt: new Date().toISOString(),
    };
    await writeJsonFile(CONFIG_FILE, next);
    return next;
  }

  async markSchema(status: "VALID" | "INVALID"): Promise<GenesysConfig> {
    const current = await this.getConfig();
    const next = {
      ...current,
      schemaStatus: status,
    };
    await writeJsonFile(CONFIG_FILE, next);
    return next;
  }
}
