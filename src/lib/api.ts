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

export type GenesysConfig = {
  enabled: boolean;
  regionId: string;
  clientId: string;
  contactListId: string;
  contactListName: string;
  phoneColumn: string;
  lastConnectionStatus: "SUCCESS" | "FAILED" | "NOT_TESTED";
  lastConnectionAt: string;
  lastSyncAt: string;
  schemaStatus: "VALID" | "INVALID" | "NOT_TESTED";
  secretConfigured: boolean;
};

export type RegionHistoryRecord = {
  regionId: string;
  regionName: string;
  timestamp: string;
  user: string;
  changes: Record<string, { from: unknown; to: unknown }>;
};

export type ConfigResponse = {
  config: GenesysConfig;
  activeRegion: GenesysRegion;
  enabledRegions: GenesysRegion[];
};

export type RegionResponse = {
  region: GenesysRegion;
  history: RegionHistoryRecord[];
};

export type EndpointResult = {
  url: string;
  reachable: boolean;
  status?: number;
  error?: string;
};

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(body?.message || "Request failed");
  }
  return body as T;
}
