export type GenesysRegion = {
  id: string;
  name: string;
  domain: string;
  applicationUrl: string;
  apiBaseUrl: string;
  authBaseUrl: string;
  defaultApplicationUrl: string;
  defaultApiBaseUrl: string;
  defaultAuthBaseUrl: string;
  systemRegion: boolean;
  enabled: boolean;
  modified: boolean;
  deprecated?: boolean;
  deprecationMessage?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type GenesysRegionCatalog = {
  version: number;
  regions: GenesysRegion[];
};

export type GenesysConfig = {
  enabled: boolean;
  regionId: string;
  clientId: string;
  clientSecretEncrypted: string;
  contactListId: string;
  contactListName: string;
  phoneColumn: string;
  lastConnectionStatus: "SUCCESS" | "FAILED" | "NOT_TESTED";
  lastConnectionAt: string;
  lastSyncAt: string;
  schemaStatus: "VALID" | "INVALID" | "NOT_TESTED";
};

export type AuditAction =
  | "GENESYS_REGION_CREATED"
  | "GENESYS_REGION_UPDATED"
  | "GENESYS_REGION_RESET"
  | "GENESYS_REGION_ENABLED"
  | "GENESYS_REGION_DISABLED"
  | "GENESYS_REGION_SELECTED";

export type AuditRecord = {
  timestamp: string;
  user: string;
  action: AuditAction;
  details: Record<string, unknown>;
};

export type RegionHistoryRecord = {
  regionId: string;
  regionName: string;
  timestamp: string;
  user: string;
  changes: Record<string, { from: unknown; to: unknown }>;
};

export type EndpointValidationResult = {
  url: string;
  reachable: boolean;
  status?: number;
  error?: string;
};
