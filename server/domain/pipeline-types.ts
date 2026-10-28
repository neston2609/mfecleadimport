export type FieldType = "STRING" | "NUMBER" | "DATE" | "BOOLEAN" | "PHONE";
export type ContactField = { name: string; type: FieldType; required: boolean };
export type Entity = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
export type ContactListConfiguration = Entity & {
  fields: ContactField[];
  contactListId: string;
  regionId: string;
  uuid: string;
  uuidSource: "CONTACT_LIST_ID" | "MANUAL" | "";
  missing: boolean;
};
export type SourceKind = "JDBC" | "WEB" | "CSV" | "JSON";
export type SourceConfig = {
  jdbcUrl?: string;
  driverClass?: string;
  username?: string;
  query?: string;
  table?: string;
  uri?: string;
  method?: "GET" | "POST";
  auth?: "NONE" | "BASIC" | "BEARER" | "API_KEY";
  headerName?: string;
  requestBody?: string;
  resultPath?: string;
  content?: string;
  fileName?: string;
  fileId?: string;
  delimiter?: string;
};
export type SourceIntegration = Entity & {
  kind: SourceKind;
  config: SourceConfig;
  fields: string[];
  secretEncrypted: string;
  secretConfigured?: boolean;
  identityNamespace?: string;
};
export type SourceMapping = Entity & {
  contactListId: string;
  regionId: string;
  sourceId: string;
  keyField: string;
  fields: {
    targetField: string;
    sourceField: string;
    defaultValue: string;
    type?: FieldType;
    required?: boolean;
  }[];
};
export type FilterOperator =
  | "EQ"
  | "NE"
  | "GT"
  | "LT"
  | "GTE"
  | "LTE"
  | "CONTAINS"
  | "DATE_GT_DAYS"
  | "DATE_LT_DAYS";
export type LeadFilter = {
  field: string;
  scope: "TARGET" | "SOURCE";
  operator: FilterOperator;
  value: string;
};
export type LeadDefinition = Entity & {
  mappingId: string;
  match: "ALL" | "ANY";
  filters: LeadFilter[];
};
export type DataRow = Record<string, unknown>;
export type SourceData = {
  fields: string[];
  rows: DataRow[];
  tables?: string[];
  truncated: boolean;
  total: number;
};
export type ImportState = {
  id: string;
  mappingId: string;
  sourceKey: string;
  contactListId: string;
  contactId: string;
  payloadHash: string;
  status: "PENDING" | "SYNCED" | "FAILED" | "UNKNOWN";
  message: string;
  updatedAt: string;
};
export type LeadRow = {
  id: string;
  sourceKey: string;
  data: Record<string, string>;
  source: DataRow;
  status:
    | "ELIGIBLE"
    | "UPDATE_AVAILABLE"
    | "ALREADY_SYNCED"
    | "INVALID"
    | "DNC"
    | "DUPLICATE"
    | "UNKNOWN";
  message: string;
  contactId: string;
};
export type LeadPreview = {
  lead: LeadDefinition;
  mapping: SourceMapping;
  destination: ContactListConfiguration;
  fields: string[];
  rows: LeadRow[];
  total: number;
  sourceTotal: number;
  truncated: boolean;
  revision: string;
  summary: {
    matched: number;
    eligible: number;
    synced: number;
    invalid: number;
  };
};
export type ImportJob = {
  id: string;
  leadId: string;
  leadName: string;
  sourceId?: string;
  contactListId: string;
  scheduleId: string;
  status: "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED" | "INTERRUPTED";
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  results: { id: string; sourceKey: string; status: string; message: string }[];
  createdAt: string;
  finishedAt: string;
};
export type SourceObservation = {
  id: string;
  status: "ACTIVE" | "INACTIVE" | "ERROR";
  checkedAt: string;
  message: string;
};
export type ImportSchedule = Entity & {
  leadId: string;
  contactListId: string;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "MONTH_DAYS";
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  monthDays: number[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string;
  lastStatus: string;
  lastMessage: string;
  lastJobId: string;
};
