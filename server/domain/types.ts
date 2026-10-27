export const CHANNELS = ["VOICE", "SMS", "EMAIL", "LINE", "DIGITAL"] as const;
export const RENEWAL_STATUSES = [
  "NOT_STARTED",
  "CONTACT_PENDING",
  "CONTACTED",
  "INTERESTED",
  "CALLBACK_REQUESTED",
  "NOT_INTERESTED",
  "RENEWED",
  "EXPIRED",
  "CANCELLED",
] as const;
export const INTENTS = [
  "UNKNOWN",
  "INTERESTED",
  "NOT_INTERESTED",
  "CALLBACK",
  "RENEWED",
  "WRONG_NUMBER",
  "NO_ANSWER",
] as const;
export const SYNC_STATUSES = [
  "NOT_SYNCED",
  "PENDING",
  "SYNCING",
  "SYNCED",
  "OUTDATED",
  "FAILED",
  "SKIPPED_DNC",
  "INVALID_PHONE",
  "SCHEMA_MISMATCH",
] as const;
export type Channel = (typeof CHANNELS)[number];
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export interface Customer {
  customerId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  preferredChannel: Channel;
  province: string;
  dnc: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Coverage = Record<
  | "thirdPartyProperty"
  | "thirdPartyInjury"
  | "ownVehicleCollision"
  | "vehicleTheft"
  | "fire"
  | "flood"
  | "personalAccident"
  | "medicalExpense"
  | "driverBail",
  boolean
>;

export interface Product {
  productId: string;
  productCode: string;
  slug: string;
  productName: string;
  productType: string;
  vehicleType: "CAR" | "MOTORCYCLE" | "ADDON";
  insuranceClass: string;
  shortDescription: string;
  description: string;
  insurerName: string;
  startingPremium: number;
  coverage: Coverage;
  coverageLimits: Record<string, string>;
  features: string[];
  terms: string[];
  eligibleVehicleTypes: string[];
  minVehicleAge: number;
  maxVehicleAge: number;
  active: boolean;
  featured: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Policy {
  policyId: string;
  policyNumber: string;
  customerId: string;
  productId: string;
  purchaseDate: string;
  effectiveDate: string;
  expiryDate: string;
  lastRenewedAt?: string;
  premium: number;
  sumInsured: number;
  insurerName: string;
  vehicle: {
    vehicleType: string;
    brand: string;
    model: string;
    year: number;
    licensePlate: string;
    province: string;
  };
  coverageSnapshot: Coverage;
  renewalStatus: RenewalStatus;
  preferredChannel: Channel;
  digitalSent: boolean;
  voiceCalled: boolean;
  customerIntent: string;
  callbackDateTime: string | null;
  genesys: {
    contactListId: string;
    contactId: string;
    syncStatus: SyncStatus;
    lastSyncAt: string;
    lastSyncError: string | null;
    lastPayloadHash: string;
    lastSyncedBy: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Inquiry {
  inquiryId: string;
  firstName: string;
  lastName: string;
  phone: string;
  productId: string;
  preferredChannel: Channel;
  preferredContactTime: string;
  consent: boolean;
  status: "NEW" | "CONTACTED" | "CONVERTED" | "CLOSED";
  createdAt: string;
  updatedAt: string;
}

export interface CampaignFilters {
  productId?: string;
  insuranceClass?: string;
  vehicleType?: string;
  vehicleBrand?: string;
  insurerName?: string;
  expiryFrom?: string;
  expiryTo?: string;
  daysFrom?: number;
  daysTo?: number;
  renewalStatus?: string;
  preferredChannel?: string;
  digitalSent?: boolean;
  voiceCalled?: boolean;
  customerIntent?: string;
  premiumFrom?: number;
  premiumTo?: number;
  province?: string;
  genesysStatus?: string;
  excludeDnc?: boolean;
}

export interface CampaignList {
  campaignListId: string;
  name: string;
  description: string;
  filters: CampaignFilters;
  createdAt: string;
  updatedAt: string;
  recordCount: number;
  lastExportedAt: string;
  lastGenesysSyncAt: string;
}

export type GenesysScheduleFrequency = "ONCE" | "DAILY" | "WEEKLY";
export type GenesysScheduleRunStatus =
  "NEVER" | "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";

export const AGENT_CALLBACK_STATUSES = [
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
] as const;
export const AGENT_CALLBACK_PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;
export const AGENT_CALLBACK_INTENTS = [
  "RENEWAL_INTERESTED",
  "PREMIUM_INQUIRY",
  "DISCOUNT_NEGOTIATION",
  "COVERAGE_INQUIRY",
  "PLAN_COMPARISON",
  "PAYMENT_INQUIRY",
  "POLICY_CHANGE",
  "COMPLAINT",
  "CALLBACK_REQUEST",
  "OTHER",
] as const;
export type AgentCallbackStatus = (typeof AGENT_CALLBACK_STATUSES)[number];
export type AgentCallbackPriority = (typeof AGENT_CALLBACK_PRIORITIES)[number];
export type AgentCallbackIntent = (typeof AGENT_CALLBACK_INTENTS)[number];

export interface AgentCallback {
  callbackId: string;
  customerId: string;
  policyId: string;
  scheduledAt: string;
  status: AgentCallbackStatus;
  priority: AgentCallbackPriority;
  intent: AgentCallbackIntent;
  assignedAgent: string;
  agentName: string;
  notes: string;
  outcomeNotes: string;
  completedAt: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenesysScheduleTask {
  schedulerTaskId: string;
  name: string;
  campaignListId: string;
  frequency: GenesysScheduleFrequency;
  time: string;
  date?: string;
  dayOfWeek?: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: GenesysScheduleRunStatus;
  lastRunMessage: string;
  lastRunSummary: {
    matched: number;
    eligible: number;
    processed: number;
    successful: number;
    failed: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  id: string;
  action: string;
  actor: string;
  target: string;
  detail: Record<string, unknown>;
  timestamp: string;
}
