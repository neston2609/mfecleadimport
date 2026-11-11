import type { Entity, FieldType } from "./pipeline-types";

export type AlertTransport = "SNMP" | "API";
export type AlertValue = string | number | boolean | null | AlertValue[] | {
  [key: string]: AlertValue;
};
export type AlertCondition = {
  field: string;
  operator:
    | "EQ"
    | "NE"
    | "CONTAINS"
    | "STARTS_WITH"
    | "ENDS_WITH"
    | "IN_LIST"
    | "REGEX"
    | "EXISTS"
    | "NOT_EXISTS";
  value?: string;
};
export type AlertConditionGroup = {
  match: "ALL" | "ANY";
  conditions: AlertCondition[];
};
export type AlertFieldDefinition = {
  name: string;
  source: string;
  type: FieldType;
  required: boolean;
  defaultValue: string;
  description: string;
  sensitive?: boolean;
  extract?: {
    mode: "FULL" | "REGEX" | "BETWEEN";
    expression: string;
    after: string;
    group: number;
  };
};
export type AlertConfiguration = Entity & {
  type: AlertTransport;
  description: string;
  enabled: boolean;
  priority: number;
  defaultSubject: string;
  match: AlertConditionGroup;
  subjectRules: { match: AlertConditionGroup; subject: string }[];
  fields: AlertFieldDefinition[];
  duplicateField: string;
  duplicateWindowSeconds: number;
  allowedSources: string[];
  api: {
    auth: "BEARER" | "API_KEY" | "HMAC";
    tokenEncrypted: string;
    hmacSecretEncrypted: string;
    maxBodyBytes: number;
  };
};

export type SnmpCommunity = {
  name: string;
  secretEncrypted: string;
  versions: ("v1" | "v2c")[];
};
export type SnmpV3User = {
  username: string;
  level: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  authProtocol: "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
  authKeyEncrypted: string;
  privProtocol: "des" | "aes" | "aes256";
  privKeyEncrypted: string;
};
export type SnmpListenerConfiguration = {
  id: "singleton";
  enabled: boolean;
  bindAddress: string;
  port: number;
  allowedSources: string[];
  maxMessageBytes: number;
  logLevel: "ERROR" | "INFO" | "DEBUG";
  versions: ("v1" | "v2c" | "v3")[];
  communities: SnmpCommunity[];
  users: SnmpV3User[];
  updatedAt: string;
};
export type SnmpListenerMetrics = {
  status: "RUNNING" | "STOPPED" | "ERROR";
  lastReceivedAt: string;
  receivedCount: number;
  errorCount: number;
  lastError: string;
  startedAt: string;
};

export type AlertDatasource = Entity & {
  description: string;
  kind: "FILE" | "DATABASE" | "QUERY";
  enabled: boolean;
  fileName: string;
  storedFile: string;
  fileId: string;
  worksheet: string;
  sourceId: string;
  query: string;
  keyColumn: string;
  columns: string[];
  updatedBy: string;
  health: "UNKNOWN" | "AVAILABLE" | "ERROR";
  healthCheckedAt: string;
  healthMessage: string;
};
export type AlertEnrichmentRule = Entity & {
  description: string;
  enabled: boolean;
  priority: number;
  alertConfigId: string;
  datasourceId: string;
  lookup: { alertField: string; column: string }[];
  outputs: {
    name: string;
    kind: "COLUMN" | "CONCAT" | "STATIC" | "UPPER" | "LOWER" | "TRIM";
    columns: string[];
    value: string;
    required: boolean;
    defaultValue: string;
    overwrite: boolean;
  }[];
  notFound: "KEEP" | "DEFAULT" | "FAIL";
  onError: "SKIP" | "FAIL";
};
export type AlertMapping = Entity & {
  description: string;
  enabled: boolean;
  priority: number;
  alertConfigId: string;
  contactListId: string;
  contactListName: string;
  regionId: string;
  fields: {
    target: string;
    sourceType: "ALERT" | "ENRICHMENT" | "SYSTEM" | "STATIC";
    source: string;
    value: string;
    required: boolean;
  }[];
  phoneField: string;
  uniqueField: string;
  duplicateWindowSeconds: number;
  duplicateBehavior: "SKIP" | "MANUAL_REVIEW" | "ALLOW_NEW";
  autoImport: boolean;
};
export type AlertSyncStatus =
  | "QUEUED"
  | "AWAITING_MANUAL"
  | "SYNCING"
  | "SYNCED"
  | "FAILED"
  | "UNKNOWN"
  | "DUPLICATE"
  | "BLOCKED";
export type ReceivedAlert = {
  id: string;
  correlationId: string;
  transport: AlertTransport;
  receivedAt: string;
  sourceIp: string;
  sourcePort: number;
  configId: string;
  configName: string;
  configSnapshot: AlertConfiguration | null;
  subject: string;
  matchResult: string;
  raw: AlertValue;
  originalFields: Record<string, AlertValue>;
  enrichedFields: Record<string, AlertValue>;
  enrichmentStatus: "NOT_STARTED" | "SUCCESS" | "PARTIAL" | "FAILED";
  processingStatus:
    | "RECEIVED"
    | "PROCESSING"
    | "ENRICHED"
    | "READY_FOR_SYNC"
    | "FAILED"
    | "DUPLICATE"
    | "REJECTED"
    | "UNMATCHED";
  syncStatus: AlertSyncStatus;
  mappingId: string;
  mappingName: string;
  mappedContact: Record<string, string>;
  duplicateOf: string;
  eventKey: string;
  attempts: number;
  processingAttempts?: number;
  syncAttempts?: number;
  retryAt: string;
  lastError: string;
  genesysContactId: string;
  syncInitiatedBy: string;
  updatedAt: string;
};
export type AlertSyncHistory = {
  id: string;
  alertId: string;
  correlationId: string;
  alertConfigId: string;
  alertConfigName: string;
  mappingId: string;
  mappingName: string;
  contactListId: string;
  contactListName: string;
  syncType: "AUTO" | "MANUAL";
  startedAt: string;
  completedAt: string;
  status: AlertSyncStatus;
  genesysContactId: string;
  attempt: number;
  error: string;
  initiatedBy: string;
  payload: Record<string, string>;
  responseMetadata: Record<string, AlertValue>;
};
export type AlertTestSession = {
  id: string;
  alertConfigId: string;
  transport: AlertTransport;
  tokenHash: string;
  sourceIp: string;
  createdAt: string;
  expiresAt: string;
  capture: { receivedAt: string; sourceIp: string; raw: AlertValue; fields: Record<string, AlertValue> } | null;
};
