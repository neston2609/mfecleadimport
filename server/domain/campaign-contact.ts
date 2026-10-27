import { createHash } from "node:crypto";
import type { CampaignFilters, Customer, Policy, Product } from "./types";

export const CONTACT_COLUMNS = [
  "customerId",
  "policyId",
  "policyNumber",
  "firstName",
  "lastName",
  "phone",
  "productName",
  "vehicleType",
  "vehicleBrand",
  "vehicleModel",
  "licensePlate",
  "insurerName",
  "premium",
  "effectiveDate",
  "expiryDate",
  "daysUntilExpiry",
  "renewalStatus",
  "preferredChannel",
  "digitalSent",
  "voiceCalled",
  "customerIntent",
  "callbackDateTime",
  "dnc",
] as const;

export type CampaignContact = Record<(typeof CONTACT_COLUMNS)[number], string>;

export function normalizeThaiPhone(value: string): string {
  const phone = value.trim().replace(/[\s().-]/g, "");
  if (/^\+66[689]\d{8}$/.test(phone)) return phone;
  if (/^0[689]\d{8}$/.test(phone)) return `+66${phone.slice(1)}`;
  throw new Error("Enter a valid Thai mobile phone number");
}

export function isValidPhone(phone: string): boolean {
  try {
    normalizeThaiPhone(phone);
    return true;
  } catch {
    return false;
  }
}

export function daysUntilExpiry(expiryDate: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (name: string) =>
    Number(parts.find((part) => part.type === name)?.value);
  const today = Date.UTC(get("year"), get("month") - 1, get("day"));
  const [year, month, day] = expiryDate.split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - today) / 86400000);
}

export function mapCampaignContact(
  policy: Policy,
  customer: Customer,
  product: Product,
  now?: Date,
): CampaignContact {
  const phone = isValidPhone(customer.phone)
    ? normalizeThaiPhone(customer.phone)
    : customer.phone;
  return {
    customerId: customer.customerId,
    policyId: policy.policyId,
    policyNumber: policy.policyNumber,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone,
    productName: product.productName,
    vehicleType: policy.vehicle.vehicleType,
    vehicleBrand: policy.vehicle.brand,
    vehicleModel: policy.vehicle.model,
    licensePlate: policy.vehicle.licensePlate,
    insurerName: policy.insurerName,
    premium: String(policy.premium),
    effectiveDate: policy.effectiveDate,
    expiryDate: policy.expiryDate,
    daysUntilExpiry: String(daysUntilExpiry(policy.expiryDate, now)),
    renewalStatus: policy.renewalStatus,
    preferredChannel: policy.preferredChannel,
    digitalSent: String(policy.digitalSent),
    voiceCalled: String(policy.voiceCalled),
    customerIntent: policy.customerIntent || "",
    callbackDateTime: policy.callbackDateTime || "",
    dnc: String(customer.dnc),
  };
}

export function payloadHash(contact: CampaignContact): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(contact)).digest("hex")}`;
}

export function matchesCampaign(
  policy: Policy,
  customer: Customer,
  product: Product,
  filters: CampaignFilters,
  now?: Date,
): boolean {
  const days = daysUntilExpiry(policy.expiryDate, now);
  if (filters.excludeDnc !== false && customer.dnc) return false;
  if (filters.productId && policy.productId !== filters.productId) return false;
  if (
    filters.insuranceClass &&
    product.insuranceClass !== filters.insuranceClass
  )
    return false;
  if (filters.vehicleType && policy.vehicle.vehicleType !== filters.vehicleType)
    return false;
  if (
    filters.vehicleBrand &&
    policy.vehicle.brand.toLocaleLowerCase() !==
      filters.vehicleBrand.toLocaleLowerCase()
  )
    return false;
  if (filters.insurerName && policy.insurerName !== filters.insurerName)
    return false;
  if (filters.expiryFrom && policy.expiryDate < filters.expiryFrom)
    return false;
  if (filters.expiryTo && policy.expiryDate > filters.expiryTo) return false;
  if (filters.daysFrom !== undefined && days < filters.daysFrom) return false;
  if (filters.daysTo !== undefined && days > filters.daysTo) return false;
  if (filters.renewalStatus && policy.renewalStatus !== filters.renewalStatus)
    return false;
  if (
    filters.preferredChannel &&
    policy.preferredChannel !== filters.preferredChannel
  )
    return false;
  if (
    filters.digitalSent !== undefined &&
    policy.digitalSent !== filters.digitalSent
  )
    return false;
  if (
    filters.voiceCalled !== undefined &&
    policy.voiceCalled !== filters.voiceCalled
  )
    return false;
  if (
    filters.customerIntent &&
    policy.customerIntent !== filters.customerIntent
  )
    return false;
  if (filters.premiumFrom !== undefined && policy.premium < filters.premiumFrom)
    return false;
  if (filters.premiumTo !== undefined && policy.premium > filters.premiumTo)
    return false;
  if (filters.province && customer.province !== filters.province) return false;
  if (
    filters.genesysStatus &&
    policy.genesys.syncStatus !== filters.genesysStatus
  )
    return false;
  return true;
}

export interface CampaignPreviewRow {
  contact: CampaignContact;
  policy: Policy;
  customer: Customer;
  product: Product;
  eligibility:
    | "ELIGIBLE"
    | "DNC"
    | "INVALID_PHONE"
    | "DUPLICATE_PHONE"
    | "ALREADY_SYNCED"
    | "RELOAD_AVAILABLE";
}

export function buildPreview(
  allPolicies: Policy[],
  allCustomers: Customer[],
  allProducts: Product[],
  filters: CampaignFilters = {},
  selectedIds?: string[],
  contactListId?: string,
): { rows: CampaignPreviewRow[]; summary: Record<string, number> } {
  const customerById = new Map(
    allCustomers.map((item) => [item.customerId, item]),
  );
  const productById = new Map(
    allProducts.map((item) => [item.productId, item]),
  );
  const seenPhones = new Set<string>();
  const rows: CampaignPreviewRow[] = [];
  for (const policy of allPolicies) {
    if (selectedIds && !selectedIds.includes(policy.policyId)) continue;
    const customer = customerById.get(policy.customerId);
    const product = productById.get(policy.productId);
    if (!customer || !product) continue;
    if (
      !matchesCampaign(policy, customer, product, {
        ...filters,
        excludeDnc: false,
      })
    )
      continue;
    const contact = mapCampaignContact(policy, customer, product);
    let eligibility: CampaignPreviewRow["eligibility"] = "ELIGIBLE";
    if (customer.dnc) eligibility = "DNC";
    else if (!isValidPhone(contact.phone)) eligibility = "INVALID_PHONE";
    else if (seenPhones.has(contact.phone)) eligibility = "DUPLICATE_PHONE";
    else if (
      policy.genesys.contactId &&
      (!contactListId || policy.genesys.contactListId === contactListId)
    ) {
      eligibility =
        policy.genesys.syncStatus === "SYNCED" &&
        policy.genesys.lastPayloadHash === payloadHash(contact)
          ? "ALREADY_SYNCED"
          : "RELOAD_AVAILABLE";
    }
    if (eligibility !== "DNC" && eligibility !== "INVALID_PHONE")
      seenPhones.add(contact.phone);
    rows.push({ contact, policy, customer, product, eligibility });
  }
  const summary = {
    matched: rows.length,
    dncExcluded: rows.filter((row) => row.eligibility === "DNC").length,
    invalidPhone: rows.filter((row) => row.eligibility === "INVALID_PHONE")
      .length,
    duplicatePhone: rows.filter((row) => row.eligibility === "DUPLICATE_PHONE")
      .length,
    alreadySynced: rows.filter((row) => row.eligibility === "ALREADY_SYNCED")
      .length,
    reloadAvailable: rows.filter(
      (row) => row.eligibility === "RELOAD_AVAILABLE",
    ).length,
    eligible: rows.filter((row) => row.eligibility === "ELIGIBLE").length,
  };
  return { rows, summary };
}

function csvValue(value: string, column: string): string {
  const safe =
    column === "phone" && /^\+66\d+$/.test(value)
      ? value
      : /^[=+@\-\t\r]/.test(value)
        ? `'${value}`
        : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function generateGenesysCsv(contacts: CampaignContact[]): Buffer {
  const lines = [
    CONTACT_COLUMNS.join(","),
    ...contacts.map((contact) =>
      CONTACT_COLUMNS.map((column) => csvValue(contact[column], column)).join(
        ",",
      ),
    ),
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}
