import {
  CONTACT_COLUMNS,
  isValidPhone,
  mapCampaignContact,
  payloadHash,
} from "../../domain/campaign-contact";
import {
  httpError,
  upsertAgentCallbackFromGenesysImport,
} from "../../domain/business";
import {
  audit,
  campaigns,
  customers,
  policies,
  products,
} from "../../domain/store";
import type { SyncStatus } from "../../domain/types";
import { GenesysApiError, genesysApiClient } from "./genesys-api.client";
import { GenesysConfigService } from "./genesys-config.service";

type ContactListSchema = {
  id?: string;
  name?: string;
  columnNames?: string[];
  phoneColumns?: { columnName: string; type?: string }[];
};
type GenesysContact = {
  id?: string;
  contactListId?: string;
  callable?: boolean;
  data?: Record<string, string>;
  [key: string]: unknown;
};
export type SchemaResult = {
  valid: boolean;
  contactListId: string;
  contactListName: string;
  mapping: {
    applicationField: string;
    genesysColumn: string;
    status: "OK" | "MISSING" | "CASE_MISMATCH";
  }[];
  unexpectedColumns: string[];
  phoneColumnValid: boolean;
  message: string;
};
const configService = new GenesysConfigService();
const inFlight = new Set<string>();
const clearingLists = new Set<string>();

type SyncOptions = {
  force?: boolean;
  verify?: boolean;
};

export function compareSchema(
  list: ContactListSchema,
  contactListId: string,
  phoneColumn: string,
): SchemaResult {
  const columns = Array.isArray(list.columnNames) ? list.columnNames : [];
  const mapping = CONTACT_COLUMNS.map((field) => {
    const exact = columns.find((name) => name === field);
    const loose = columns.find(
      (name) => name.toLocaleLowerCase() === field.toLocaleLowerCase(),
    );
    return {
      applicationField: field,
      genesysColumn: exact || loose || "",
      status: (exact ? "OK" : loose ? "CASE_MISMATCH" : "MISSING") as
        "OK" | "MISSING" | "CASE_MISMATCH",
    };
  });
  const unexpectedColumns = columns.filter(
    (name) =>
      !CONTACT_COLUMNS.some(
        (field) => field.toLocaleLowerCase() === name.toLocaleLowerCase(),
      ),
  );
  const phoneColumnValid =
    columns.includes(phoneColumn) &&
    Boolean(
      list.phoneColumns?.some((phone) => phone.columnName === phoneColumn),
    );
  const valid =
    mapping.every((item) => item.status === "OK") && phoneColumnValid;
  return {
    valid,
    contactListId,
    contactListName: list.name || "",
    mapping,
    unexpectedColumns,
    phoneColumnValid,
    message: valid
      ? "Contact list schema is ready for synchronization."
      : `Schema mismatch: ${mapping.filter((item) => item.status !== "OK").length} required columns missing or differently cased${phoneColumnValid ? "" : "; phone column not configured as a Genesys phone column"}.`,
  };
}

export async function validateContactListSchema(): Promise<SchemaResult> {
  const config = await configService.getConfig();
  if (!config.enabled) throw httpError(400, "Genesys integration is disabled");
  if (!config.contactListId)
    throw httpError(400, "Select a Genesys Contact List first");
  const list = await genesysApiClient.get<ContactListSchema>(
    `/api/v2/outbound/contactlists/${encodeURIComponent(config.contactListId)}`,
  );
  const result = compareSchema(list, config.contactListId, config.phoneColumn);
  await configService.markSchema(result.valid ? "VALID" : "INVALID");
  return result;
}

function contactPath(listId: string, contactId?: string): string {
  return `/api/v2/outbound/contactlists/${encodeURIComponent(listId)}/contacts${contactId ? `/${encodeURIComponent(contactId)}` : ""}`;
}

function parseCreatedContact(result: unknown): GenesysContact | undefined {
  if (Array.isArray(result)) return result[0] as GenesysContact | undefined;
  if (result && typeof result === "object") {
    const object = result as {
      entities?: GenesysContact[];
      contacts?: GenesysContact[];
    };
    return (
      object.entities?.[0] || object.contacts?.[0] || (result as GenesysContact)
    );
  }
  return undefined;
}

async function verifyContact(
  contactListId: string,
  contactId: string,
): Promise<GenesysContact> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const contact = await genesysApiClient.get<GenesysContact>(
        contactPath(contactListId, contactId),
      );
      if (contact.id === contactId && contact.contactListId === contactListId)
        return contact;
      lastError = new Error(
        "Genesys returned a contact that does not match the configured Contact List.",
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof GenesysApiError) || error.status !== 404)
        throw error;
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not verify the Genesys contact after synchronization.");
}

async function markStatus(
  policyId: string,
  status: SyncStatus,
  error: string | null = null,
): Promise<void> {
  await policies.mutate((rows) => {
    const policy = rows.find((item) => item.policyId === policyId);
    if (policy) {
      policy.genesys.syncStatus = status;
      policy.genesys.lastSyncError = error;
    }
  });
}

export async function syncPolicy(
  policyId: string,
  actor: string,
  knownSchema?: SchemaResult,
  options: SyncOptions = {},
): Promise<{
  policyId: string;
  status: string;
  message: string;
  contactId?: string;
  contactListId?: string;
  contactListName?: string;
  verified?: boolean;
}> {
  if (inFlight.has(policyId))
    throw httpError(409, "This policy is already being synchronized");
  inFlight.add(policyId);
  try {
    const policy = await policies.findById("policyId", policyId);
    if (!policy) throw httpError(404, "Policy not found");
    const [customer, product, config] = await Promise.all([
      customers.findById("customerId", policy.customerId),
      products.findById("productId", policy.productId),
      configService.getConfig(),
    ]);
    if (!customer || !product)
      throw httpError(400, "Policy customer or product is missing");
    if (customer.dnc) {
      await markStatus(
        policyId,
        "SKIPPED_DNC",
        "Customer requested no contact",
      );
      return {
        policyId,
        status: "SKIPPED_DNC",
        message: "Customer is marked DNC",
      };
    }
    if (!isValidPhone(customer.phone)) {
      await markStatus(policyId, "INVALID_PHONE", "Invalid Thai mobile phone");
      return {
        policyId,
        status: "INVALID_PHONE",
        message: "Invalid phone number",
      };
    }
    if (!config.contactListId)
      throw httpError(400, "Select a Genesys Contact List first");
    const contact = mapCampaignContact(policy, customer, product);
    const hash = payloadHash(contact);
    if (
      !options.force &&
      policy.genesys.contactId &&
      policy.genesys.contactListId === config.contactListId &&
      policy.genesys.syncStatus === "SYNCED" &&
      policy.genesys.lastPayloadHash === hash
    ) {
      return {
        policyId,
        status: "ALREADY_SYNCED",
        message: "Already synchronized. No changes detected.",
        contactId: policy.genesys.contactId,
        contactListId: config.contactListId,
        contactListName: config.contactListName,
      };
    }
    const schema = knownSchema || (await validateContactListSchema());
    if (!schema.valid) {
      await markStatus(policyId, "SCHEMA_MISMATCH", schema.message);
      return { policyId, status: "SCHEMA_MISMATCH", message: schema.message };
    }
    await markStatus(policyId, "SYNCING");
    let contactId = policy.genesys.contactId;
    let existingInSameList = Boolean(
      contactId && policy.genesys.contactListId === config.contactListId,
    );
    if (existingInSameList) {
      try {
        const existing = await genesysApiClient.get<GenesysContact>(
          contactPath(config.contactListId, contactId),
        );
        const merged: GenesysContact = {
          ...existing,
          contactListId: config.contactListId,
          callable: true,
          data: { ...(existing.data || {}), ...contact },
        };
        await genesysApiClient.put(
          contactPath(config.contactListId, contactId),
          merged,
        );
      } catch (error) {
        if (!(error instanceof GenesysApiError) || error.status !== 404)
          throw error;
        contactId = "";
        existingInSameList = false;
      }
    }
    if (!existingInSameList) {
      const response = await genesysApiClient.post(
        contactPath(config.contactListId),
        [
          {
            contactListId: config.contactListId,
            callable: true,
            data: contact,
          },
        ],
      );
      contactId = parseCreatedContact(response)?.id || "";
      if (!contactId)
        throw new Error(
          "Genesys created a contact but did not return its ID. Check the contact list before retrying to avoid a duplicate.",
        );
    }
    const verified = options.verify
      ? await verifyContact(config.contactListId, contactId)
      : undefined;
    const contactListName = schema.contactListName || config.contactListName;
    await policies.mutate((rows) => {
      const current = rows.find((item) => item.policyId === policyId);
      if (!current) return;
      current.genesys = {
        contactListId: config.contactListId,
        contactId,
        syncStatus: "SYNCED",
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null,
        lastPayloadHash: hash,
        lastSyncedBy: actor,
      };
    });
    await audit(
      existingInSameList ? "UPDATE_GENESYS_CONTACT" : "CREATE_GENESYS_CONTACT",
      actor,
      policyId,
      {
        contactId,
        contactListId: config.contactListId,
        verified: Boolean(verified),
      },
    );
    return {
      policyId,
      status: "SYNCED",
      message: `${existingInSameList ? "Genesys contact updated" : "Genesys contact created"}${verified ? " and verified" : ""} in ${contactListName || config.contactListId}. Contact ID: ${contactId}`,
      contactId,
      contactListId: config.contactListId,
      contactListName,
      verified: Boolean(verified),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Genesys synchronization failed";
    await markStatus(policyId, "FAILED", message.slice(0, 500));
    await audit("GENESYS_SYNC_FAILED", actor, policyId, {
      error: message.slice(0, 300),
    });
    throw error;
  } finally {
    inFlight.delete(policyId);
  }
}

export async function recallPolicy(
  policyId: string,
  actor: string,
): Promise<{
  policyId: string;
  status: "RECALLED";
  message: string;
  contactId: string;
  contactListId: string;
  contactListName: string;
  verified: true;
}> {
  if (inFlight.has(policyId))
    throw httpError(409, "This policy is already being synchronized");
  inFlight.add(policyId);
  try {
    const policy = await policies.findById("policyId", policyId);
    if (!policy) throw httpError(404, "Policy not found");
    const [customer, config] = await Promise.all([
      customers.findById("customerId", policy.customerId),
      configService.getConfig(),
    ]);
    if (!customer) throw httpError(400, "Policy customer is missing");
    if (!config.enabled)
      throw httpError(400, "Genesys integration is disabled");
    if (customer.dnc) throw httpError(400, "DNC customers cannot be recalled");
    if (policy.renewalStatus === "CANCELLED")
      throw httpError(400, "Cancelled policies cannot be recalled");
    const { contactId, contactListId } = policy.genesys;
    if (!contactId || !contactListId)
      throw httpError(409, "Push this policy to Genesys before using Recall");
    if (contactListId !== config.contactListId)
      throw httpError(
        409,
        "This policy belongs to a previous Genesys Contact List. Push it to the current list before using Recall.",
      );

    let existing: GenesysContact;
    try {
      existing = await genesysApiClient.get<GenesysContact>(
        contactPath(contactListId, contactId),
      );
    } catch (error) {
      if (error instanceof GenesysApiError && error.status === 404)
        throw httpError(
          409,
          "The Genesys contact no longer exists. Push this policy again before using Recall.",
        );
      throw error;
    }

    await genesysApiClient.post(
      `${contactPath(contactListId)}?priority=true&clearSystemData=true&doNotQueue=false`,
      [
        {
          id: contactId,
          contactListId,
          callable: true,
          data: existing.data || {},
        },
      ],
    );
    await verifyContact(contactListId, contactId);
    const contactListName = config.contactListName || contactListId;
    await audit("RECALL_GENESYS_CONTACT", actor, policyId, {
      contactId,
      contactListId,
      priority: true,
      clearSystemData: true,
      doNotQueue: false,
      verified: true,
    });
    return {
      policyId,
      status: "RECALLED",
      message: `Genesys system state cleared and ${policy.policyNumber} queued for recall in ${contactListName}. Contact ID: ${contactId}`,
      contactId,
      contactListId,
      contactListName,
      verified: true,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Genesys recall failed";
    await audit("GENESYS_RECALL_FAILED", actor, policyId, {
      error: message.slice(0, 300),
    });
    throw error;
  } finally {
    inFlight.delete(policyId);
  }
}

export async function bulkSyncPolicies(
  policyIds: string[],
  actor: string,
  campaignListId?: string,
  force = false,
) {
  if (
    !Array.isArray(policyIds) ||
    !policyIds.length ||
    policyIds.length > 100 ||
    policyIds.some((id) => typeof id !== "string")
  )
    throw httpError(400, "Select 1 to 100 policy IDs");
  const unique = [...new Set(policyIds)];
  const schema = await validateContactListSchema();
  if (!schema.valid) throw httpError(400, schema.message);
  const results: Awaited<ReturnType<typeof syncPolicy>>[] = [];
  for (const policyId of unique) {
    try {
      const result = await syncPolicy(policyId, actor, schema, { force });
      if (
        campaignListId &&
        ["SYNCED", "ALREADY_SYNCED"].includes(result.status)
      )
        await upsertAgentCallbackFromGenesysImport(policyId, actor);
      results.push(result);
    } catch (error) {
      results.push({
        policyId,
        status: "FAILED",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  const successful = results.filter((item) =>
    ["SYNCED", "ALREADY_SYNCED"].includes(item.status),
  ).length;
  const failed = results.filter(
    (item) => !["SYNCED", "ALREADY_SYNCED"].includes(item.status),
  ).length;
  if (campaignListId)
    await campaigns.mutate((rows) => {
      const campaign = rows.find(
        (item) => item.campaignListId === campaignListId,
      );
      if (campaign) campaign.lastGenesysSyncAt = new Date().toISOString();
    });
  await audit("BULK_GENESYS_SYNC", actor, campaignListId || "", {
    processed: results.length,
    successful,
    failed,
    force,
  });
  return { processed: results.length, successful, failed, results };
}

export async function clearGenesysContactList(
  contactListId: string,
  actor: string,
): Promise<{
  contactListId: string;
  contactListName: string;
  resetPolicies: number;
  message: string;
}> {
  if (clearingLists.has(contactListId))
    throw httpError(409, "This Genesys Contact List is already being cleared");
  if (inFlight.size)
    throw httpError(
      409,
      "Wait for active Genesys lead imports to finish first",
    );

  clearingLists.add(contactListId);
  try {
    const config = await configService.getConfig();
    if (!config.enabled)
      throw httpError(400, "Genesys integration is disabled");

    const list = await genesysApiClient.get<ContactListSchema>(
      `/api/v2/outbound/contactlists/${encodeURIComponent(contactListId)}`,
    );
    await genesysApiClient.post<void>(
      `/api/v2/outbound/contactlists/${encodeURIComponent(contactListId)}/clear`,
      undefined,
    );

    const resetPolicies = await policies.mutate((rows) => {
      let reset = 0;
      for (const policy of rows) {
        if (policy.genesys.contactListId !== contactListId) continue;
        policy.genesys = {
          contactListId: "",
          contactId: "",
          syncStatus: "NOT_SYNCED",
          lastSyncAt: "",
          lastSyncError: null,
          lastPayloadHash: "",
          lastSyncedBy: "",
        };
        reset++;
      }
      return reset;
    });
    const contactListName = list.name || contactListId;
    await audit("CLEAR_GENESYS_CONTACT_LIST", actor, contactListId, {
      contactListName,
      resetPolicies,
    });
    return {
      contactListId,
      contactListName,
      resetPolicies,
      message: `${contactListName} was cleared. ${resetPolicies} local policy records are ready to import again.`,
    };
  } finally {
    clearingLists.delete(contactListId);
  }
}
