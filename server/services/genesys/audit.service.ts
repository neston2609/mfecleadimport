import { readJsonFile, writeJsonFile } from "./file-store";
import type { AuditAction, AuditRecord, RegionHistoryRecord } from "./types";

const AUDIT_FILE = "genesys-audit-log.json";
const HISTORY_FILE = "genesys-region-history.json";

export class GenesysAuditService {
  async append(
    action: AuditAction,
    details: Record<string, unknown>,
    user = "admin",
  ): Promise<void> {
    const audit = await readJsonFile<AuditRecord[]>(AUDIT_FILE, []);
    audit.push({
      timestamp: new Date().toISOString(),
      user,
      action,
      details,
    });
    await writeJsonFile(AUDIT_FILE, audit.slice(-1000));
  }

  async appendHistory(
    record: Omit<RegionHistoryRecord, "timestamp" | "user">,
    user = "admin",
  ): Promise<void> {
    const history = await readJsonFile<RegionHistoryRecord[]>(HISTORY_FILE, []);
    history.push({
      ...record,
      timestamp: new Date().toISOString(),
      user,
    });
    await writeJsonFile(HISTORY_FILE, history.slice(-1000));
  }

  async historyForRegion(regionId: string): Promise<RegionHistoryRecord[]> {
    const history = await readJsonFile<RegionHistoryRecord[]>(HISTORY_FILE, []);
    return history.filter((record) => record.regionId === regionId).reverse();
  }
}
