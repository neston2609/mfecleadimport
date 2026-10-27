import { z } from "zod";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  daysUntilExpiry,
  isValidPhone,
  mapCampaignContact,
  normalizeThaiPhone,
  payloadHash,
} from "./campaign-contact";
import { publishPolicyRenewal } from "./policy-renewal-events";
import { nextRenewalPeriod } from "./renewal-date";
import { backupsDir, dataDir } from "./json-repository";
import {
  seedAgentCallbacks,
  seedCampaignLists,
  seedCustomers,
  seedInquiries,
  seedPolicies,
  seedProducts,
  emptyGenesys,
} from "./seed";
import {
  agentCallbacks,
  audit,
  auditLog,
  campaigns,
  customers,
  genesysScheduleTasks,
  inquiries,
  nextId,
  policies,
  products,
} from "./store";
import {
  AGENT_CALLBACK_INTENTS,
  AGENT_CALLBACK_PRIORITIES,
  AGENT_CALLBACK_STATUSES,
  CHANNELS,
  RENEWAL_STATUSES,
  type AgentCallback,
  type Customer,
  type Policy,
  type Product,
} from "./types";

export function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const date = z.iso.date();
const channel = z.enum(CHANNELS);
const phone = z
  .string()
  .refine(isValidPhone, "Enter a valid Thai mobile phone number")
  .transform(normalizeThaiPhone);
const customerInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone,
  email: z.email().or(z.literal("")),
  preferredChannel: channel,
  province: z.string().trim().max(80),
  dnc: z.boolean(),
});
const coverage = z.object({
  thirdPartyProperty: z.boolean(),
  thirdPartyInjury: z.boolean(),
  ownVehicleCollision: z.boolean(),
  vehicleTheft: z.boolean(),
  fire: z.boolean(),
  flood: z.boolean(),
  personalAccident: z.boolean(),
  medicalExpense: z.boolean(),
  driverBail: z.boolean(),
});
const productInput = z.object({
  productCode: z.string().trim().min(1).max(40),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  productName: z.string().trim().min(1).max(120),
  productType: z.string().trim().min(1),
  vehicleType: z.enum(["CAR", "MOTORCYCLE", "ADDON"]),
  insuranceClass: z.string().trim().min(1),
  shortDescription: z.string().trim().min(1),
  description: z.string().trim().min(1),
  insurerName: z.string().trim().min(1),
  startingPremium: z.number().nonnegative(),
  coverage,
  coverageLimits: z.record(z.string(), z.string()),
  features: z.array(z.string()),
  terms: z.array(z.string()),
  eligibleVehicleTypes: z.array(z.string()),
  minVehicleAge: z.number().int().nonnegative(),
  maxVehicleAge: z.number().int().nonnegative(),
  active: z.boolean(),
  featured: z.boolean(),
  displayOrder: z.number().int(),
});
const vehicle = z.object({
  vehicleType: z.string().min(1),
  brand: z.string().trim().min(1),
  model: z.string().trim().min(1),
  year: z.number().int().min(1950).max(2100),
  licensePlate: z.string().trim().min(1),
  province: z.string().trim().min(1),
});
const policyInput = z.object({
  customerId: z.string().min(1),
  productId: z.string().min(1),
  purchaseDate: date,
  effectiveDate: date,
  expiryDate: date,
  premium: z.number().nonnegative(),
  sumInsured: z.number().nonnegative(),
  insurerName: z.string().trim().min(1),
  vehicle,
  renewalStatus: z.enum(RENEWAL_STATUSES),
  preferredChannel: channel,
  digitalSent: z.boolean(),
  voiceCalled: z.boolean(),
  customerIntent: z.string().max(80),
  callbackDateTime: z.string().datetime().nullable(),
});
const inquiryInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone,
  productId: z.string().min(1),
  preferredChannel: channel,
  preferredContactTime: z.string().trim().min(1).max(120),
  consent: z.literal(true),
});
const agentCallbackInput = z.object({
  policyId: z.string().trim().min(1).max(80),
  scheduledAt: z.string().datetime(),
  priority: z.enum(AGENT_CALLBACK_PRIORITIES),
  intent: z.enum(AGENT_CALLBACK_INTENTS).default("CALLBACK_REQUEST"),
  assignedAgent: z.string().trim().max(120),
  agentName: z.string().trim().max(120).default(""),
  notes: z.string().trim().max(1000),
});
const agentCallbackUpdate = z.object({
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(AGENT_CALLBACK_STATUSES).optional(),
  priority: z.enum(AGENT_CALLBACK_PRIORITIES).optional(),
  intent: z.enum(AGENT_CALLBACK_INTENTS).optional(),
  assignedAgent: z.string().trim().max(120).optional(),
  agentName: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  outcomeNotes: z.string().trim().max(2000).optional(),
});
const publicAgentCallbackInput = z
  .object({
    policyNumber: z.string().trim().min(1).max(80),
    scheduledAt: z.string().datetime({ offset: true }),
    intent: z.enum(AGENT_CALLBACK_INTENTS),
    priority: z.enum(AGENT_CALLBACK_PRIORITIES).default("NORMAL"),
    assignedAgent: z.string().trim().max(120).default(""),
    notes: z.string().trim().max(1000).default(""),
  })
  .strict();
const publicAgentCallbackStatusInput = z
  .object({
    customerId: z.string().trim().min(1).max(80),
    policyId: z.string().trim().min(1).max(80),
    detail: z.string().trim().max(2000),
    status: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toUpperCase() : value,
      z.enum(AGENT_CALLBACK_STATUSES),
    ),
    agentName: z.string().trim().max(120).optional(),
  })
  .strict();

export async function createCustomer(
  input: unknown,
  actor: string,
): Promise<Customer> {
  const data = customerInput.parse(input);
  const item = await customers.mutate((rows) => {
    const timestamp = new Date().toISOString();
    const customer: Customer = {
      ...data,
      customerId: nextId("CUST", rows, "customerId"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(customer);
    return customer;
  });
  await audit("CREATE_CUSTOMER", actor, item.customerId);
  return item;
}

export async function updateCustomer(
  id: string,
  input: unknown,
  actor: string,
): Promise<Customer> {
  const data = customerInput.partial().parse(input);
  const item = await customers.mutate((rows) => {
    const index = rows.findIndex((row) => row.customerId === id);
    if (index < 0) throw httpError(404, "Customer not found");
    rows[index] = {
      ...rows[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    return rows[index];
  });
  await refreshOutdated(id);
  await audit("UPDATE_CUSTOMER", actor, id, { fields: Object.keys(data) });
  return item;
}

export async function deleteCustomer(id: string, actor: string): Promise<void> {
  const related = (await policies.all()).filter(
    (row) => row.customerId === id,
  ).length;
  if (related)
    throw httpError(
      409,
      `Customer cannot be deleted because ${related} policies are associated with this customer.`,
    );
  await customers.mutate((rows) => {
    const index = rows.findIndex((row) => row.customerId === id);
    if (index < 0) throw httpError(404, "Customer not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_CUSTOMER", actor, id);
}

export async function createProduct(
  input: unknown,
  actor: string,
): Promise<Product> {
  const data = productInput.parse(input);
  const item = await products.mutate((rows) => {
    if (
      rows.some(
        (row) => row.slug === data.slug || row.productCode === data.productCode,
      )
    )
      throw httpError(409, "Product slug or code already exists");
    const timestamp = new Date().toISOString();
    const product: Product = {
      ...data,
      productId: nextId("PROD", rows, "productId"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(product);
    return product;
  });
  await audit("CREATE_PRODUCT", actor, item.productId);
  return item;
}

export async function updateProduct(
  id: string,
  input: unknown,
  actor: string,
): Promise<Product> {
  const data = productInput.partial().parse(input);
  const item = await products.mutate((rows) => {
    const index = rows.findIndex((row) => row.productId === id);
    if (index < 0) throw httpError(404, "Product not found");
    if (
      rows.some(
        (row) =>
          row.productId !== id &&
          (row.slug === data.slug || row.productCode === data.productCode),
      )
    )
      throw httpError(409, "Product slug or code already exists");
    rows[index] = {
      ...rows[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    return rows[index];
  });
  await refreshOutdated(undefined, id);
  await audit("UPDATE_PRODUCT", actor, id, { fields: Object.keys(data) });
  return item;
}

export async function deleteProduct(id: string, actor: string): Promise<void> {
  const related = (await policies.all()).filter(
    (row) => row.productId === id,
  ).length;
  if (related)
    throw httpError(
      409,
      `Product is referenced by ${related} policies. Deactivate it instead.`,
    );
  const inquiryCount = (await inquiries.all()).filter(
    (row) => row.productId === id,
  ).length;
  if (inquiryCount)
    throw httpError(
      409,
      `Product is referenced by ${inquiryCount} inquiries. Deactivate it instead.`,
    );
  await products.mutate((rows) => {
    const index = rows.findIndex((row) => row.productId === id);
    if (index < 0) throw httpError(404, "Product not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_PRODUCT", actor, id);
}

export async function createPolicy(
  input: unknown,
  actor: string,
): Promise<Policy> {
  const data = policyInput.parse(input);
  const customer = await customers.findById("customerId", data.customerId);
  const product = await products.findById("productId", data.productId);
  if (!customer || !product)
    throw httpError(400, "Customer and product must exist");
  if (data.expiryDate <= data.effectiveDate)
    throw httpError(400, "Expiry date must be after effective date");
  const item = await policies.mutate((rows) => {
    const policyId = nextId("POL", rows, "policyId");
    const number = Number(policyId.slice(3));
    const timestamp = new Date().toISOString();
    const policy: Policy = {
      ...data,
      policyId,
      policyNumber: `MFEC-${data.vehicle.vehicleType === "MOTORCYCLE" ? "MC" : "CAR"}-${new Date().getFullYear()}-${String(number).padStart(5, "0")}`,
      coverageSnapshot: { ...product.coverage },
      genesys: emptyGenesys(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(policy);
    return policy;
  });
  await audit("CREATE_POLICY", actor, item.policyId);
  return item;
}

export async function updatePolicy(
  id: string,
  input: unknown,
  actor: string,
): Promise<Policy> {
  const data = policyInput.partial().parse(input);
  if (
    data.customerId &&
    !(await customers.findById("customerId", data.customerId))
  )
    throw httpError(400, "Customer not found");
  const product = data.productId
    ? await products.findById("productId", data.productId)
    : undefined;
  if (data.productId && !product) throw httpError(400, "Product not found");
  const allCustomers = await customers.all();
  const allProducts = await products.all();
  const item = await policies.mutate((rows) => {
    const index = rows.findIndex((row) => row.policyId === id);
    if (index < 0) throw httpError(404, "Policy not found");
    const next: Policy = {
      ...rows[index],
      ...data,
      vehicle: { ...rows[index].vehicle, ...data.vehicle },
      updatedAt: new Date().toISOString(),
    };
    if (product) next.coverageSnapshot = { ...product.coverage };
    if (next.expiryDate <= next.effectiveDate)
      throw httpError(400, "Expiry date must be after effective date");
    markOutdated(next, allCustomers, allProducts);
    rows[index] = next;
    return next;
  });
  await audit("UPDATE_POLICY", actor, id, { fields: Object.keys(data) });
  return item;
}

async function callbackPolicy(policyId: string) {
  const policy = await policies.findById("policyId", policyId);
  if (!policy) throw httpError(404, "Policy not found");
  const customer = await customers.findById("customerId", policy.customerId);
  if (!customer) throw httpError(400, "Policy customer is missing");
  if (customer.dnc)
    throw httpError(400, "DNC customers cannot be scheduled for callback");
  if (["RENEWED", "CANCELLED"].includes(policy.renewalStatus))
    throw httpError(
      409,
      "Renewed or cancelled policies cannot be scheduled for callback",
    );
  return { policy, customer };
}

async function syncCallbackToPolicy(
  callback: AgentCallback,
  actor: string,
): Promise<void> {
  const policy = await policies.findById("policyId", callback.policyId);
  if (!policy) return;
  if (callback.status === "SCHEDULED") {
    await updatePolicy(
      callback.policyId,
      {
        callbackDateTime: callback.scheduledAt,
        renewalStatus: "CALLBACK_REQUESTED",
        customerIntent: callback.intent,
      },
      actor,
    );
    return;
  }
  await updatePolicy(
    callback.policyId,
    {
      callbackDateTime: null,
      customerIntent: callback.intent,
      renewalStatus: ["RENEWED", "CANCELLED"].includes(policy.renewalStatus)
        ? policy.renewalStatus
        : callback.status === "COMPLETED"
          ? "CONTACTED"
          : policy.renewalStatus === "CALLBACK_REQUESTED"
            ? "CONTACT_PENDING"
            : policy.renewalStatus,
      ...(callback.status === "COMPLETED" ? { voiceCalled: true } : {}),
    },
    actor,
  );
}

export async function createAgentCallback(
  input: unknown,
  actor: string,
): Promise<AgentCallback> {
  const data = agentCallbackInput.parse(input);
  if (Date.parse(data.scheduledAt) < Date.now() - 60_000)
    throw httpError(400, "Callback date and time must be in the future");
  const { policy, customer } = await callbackPolicy(data.policyId);
  const duplicate = (await agentCallbacks.all()).some(
    (item) => item.policyId === data.policyId && item.status === "SCHEDULED",
  );
  if (duplicate)
    throw httpError(409, "This policy already has an active callback schedule");
  const item = await agentCallbacks.mutate((rows) => {
    const timestamp = new Date().toISOString();
    const callback: AgentCallback = {
      callbackId: nextId("CALL", rows, "callbackId"),
      customerId: customer.customerId,
      policyId: policy.policyId,
      scheduledAt: data.scheduledAt,
      status: "SCHEDULED",
      priority: data.priority,
      intent: data.intent,
      assignedAgent: data.assignedAgent || actor,
      agentName: data.agentName,
      notes: data.notes,
      outcomeNotes: "",
      completedAt: "",
      createdBy: actor,
      updatedBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(callback);
    return callback;
  });
  await syncCallbackToPolicy(item, actor);
  await audit("CREATE_AGENT_CALLBACK", actor, item.callbackId, {
    customerId: item.customerId,
    policyId: item.policyId,
    scheduledAt: item.scheduledAt,
    intent: item.intent,
  });
  return item;
}

export async function createAgentCallbackByPolicyNumber(
  input: unknown,
  actor: string,
) {
  const data = publicAgentCallbackInput.parse(input);
  const policy = (await policies.all()).find(
    (item) => item.policyNumber === data.policyNumber,
  );
  if (!policy) throw httpError(404, "Policy not found");

  const callback = await createAgentCallback(
    {
      policyId: policy.policyId,
      scheduledAt: new Date(data.scheduledAt).toISOString(),
      intent: data.intent,
      priority: data.priority,
      assignedAgent: data.assignedAgent || "Unassigned",
      notes: data.notes,
    },
    actor,
  );
  return {
    callbackId: callback.callbackId,
    policyNumber: policy.policyNumber,
    scheduledAt: callback.scheduledAt,
    status: callback.status,
    priority: callback.priority,
    intent: callback.intent,
    assignedAgent: callback.assignedAgent,
    agentName: callback.agentName,
    notes: callback.notes,
    createdAt: callback.createdAt,
  };
}

export async function updateAgentCallback(
  id: string,
  input: unknown,
  actor: string,
): Promise<AgentCallback> {
  const data = agentCallbackUpdate.parse(input);
  const existing = await agentCallbacks.findById("callbackId", id);
  if (!existing) throw httpError(404, "Callback schedule not found");
  const nextStatus = data.status ?? existing.status;
  const nextScheduledAt = data.scheduledAt ?? existing.scheduledAt;
  if (
    nextStatus === "SCHEDULED" &&
    Date.parse(nextScheduledAt) < Date.now() - 60_000
  )
    throw httpError(400, "Callback date and time must be in the future");
  if (nextStatus === "SCHEDULED") {
    await callbackPolicy(existing.policyId);
    const duplicate = (await agentCallbacks.all()).some(
      (item) =>
        item.callbackId !== id &&
        item.policyId === existing.policyId &&
        item.status === "SCHEDULED",
    );
    if (duplicate)
      throw httpError(
        409,
        "This policy already has another active callback schedule",
      );
  }
  const item = await agentCallbacks.mutate((rows) => {
    const index = rows.findIndex((row) => row.callbackId === id);
    if (index < 0) throw httpError(404, "Callback schedule not found");
    const status = data.status ?? rows[index].status;
    rows[index] = {
      ...rows[index],
      ...data,
      status,
      completedAt:
        status === "COMPLETED"
          ? rows[index].completedAt || new Date().toISOString()
          : "",
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };
    return rows[index];
  });
  await syncCallbackToPolicy(item, actor);
  await audit("UPDATE_AGENT_CALLBACK", actor, id, {
    fields: Object.keys(data),
    status: item.status,
    policyId: item.policyId,
  });
  return item;
}

export async function deleteAgentCallback(
  id: string,
  actor: string,
): Promise<void> {
  const existing = await agentCallbacks.findById("callbackId", id);
  if (!existing) throw httpError(404, "Callback schedule not found");

  await agentCallbacks.mutate((rows) => {
    const index = rows.findIndex((row) => row.callbackId === id);
    if (index < 0) throw httpError(404, "Callback schedule not found");
    rows.splice(index, 1);
  }, true);

  const hasAnotherScheduledCallback = (await agentCallbacks.all()).some(
    (item) =>
      item.policyId === existing.policyId && item.status === "SCHEDULED",
  );
  if (existing.status === "SCHEDULED" && !hasAnotherScheduledCallback)
    await syncCallbackToPolicy(
      { ...existing, status: "CANCELLED", completedAt: "" },
      actor,
    );

  await audit("DELETE_AGENT_CALLBACK", actor, id, {
    customerId: existing.customerId,
    policyId: existing.policyId,
    status: existing.status,
  });
}

export async function upsertAgentCallbackFromGenesysImport(
  policyId: string,
  actor: string,
): Promise<{ callback: AgentCallback; created: boolean }> {
  const policy = await policies.findById("policyId", policyId);
  if (!policy) throw httpError(404, "Policy not found");
  const customer = await customers.findById("customerId", policy.customerId);
  if (!customer) throw httpError(400, "Policy customer is missing");

  const result = await agentCallbacks.mutate((rows) => {
    const timestamp = new Date().toISOString();
    let index = -1;
    for (let current = rows.length - 1; current >= 0; current--) {
      if (
        rows[current].customerId === customer.customerId &&
        rows[current].policyId === policy.policyId
      ) {
        index = current;
        break;
      }
    }
    if (index >= 0) {
      rows[index] = {
        ...rows[index],
        status: "SCHEDULED",
        scheduledAt: timestamp,
        completedAt: "",
        updatedBy: actor,
        updatedAt: timestamp,
      };
      return { callback: rows[index], created: false };
    }

    const callback: AgentCallback = {
      callbackId: nextId("CALL", rows, "callbackId"),
      customerId: customer.customerId,
      policyId: policy.policyId,
      scheduledAt: timestamp,
      status: "SCHEDULED",
      priority: "NORMAL",
      intent: "CALLBACK_REQUEST",
      assignedAgent: "",
      agentName: "",
      notes: "Created automatically from a Genesys lead import.",
      outcomeNotes: "",
      completedAt: "",
      createdBy: actor,
      updatedBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(callback);
    return { callback, created: true };
  });
  await audit(
    result.created
      ? "CREATE_AGENT_CALLBACK_FROM_GENESYS"
      : "RESCHEDULE_AGENT_CALLBACK_FROM_GENESYS",
    actor,
    result.callback.callbackId,
    {
      customerId: result.callback.customerId,
      policyId: result.callback.policyId,
    },
  );
  return result;
}

export async function updateAgentCallbackStatusByKeys(
  input: unknown,
  actor: string,
) {
  const data = publicAgentCallbackStatusInput.parse(input);
  const item = await agentCallbacks.mutate((rows) => {
    let index = -1;
    for (let current = rows.length - 1; current >= 0; current--) {
      if (
        rows[current].customerId === data.customerId &&
        rows[current].policyId === data.policyId
      ) {
        index = current;
        break;
      }
    }
    if (index < 0)
      throw httpError(
        404,
        "Agent Call Back not found for this customerId and policyId",
      );
    const timestamp = new Date().toISOString();
    rows[index] = {
      ...rows[index],
      status: data.status,
      outcomeNotes: data.detail,
      ...(data.agentName === undefined ? {} : { agentName: data.agentName }),
      ...(data.status === "SCHEDULED" ? { scheduledAt: timestamp } : {}),
      completedAt:
        data.status === "COMPLETED" ? rows[index].completedAt || timestamp : "",
      updatedBy: actor,
      updatedAt: timestamp,
    };
    return rows[index];
  });
  await syncCallbackToPolicy(item, actor);
  await audit("PUBLIC_UPDATE_AGENT_CALLBACK_STATUS", actor, item.callbackId, {
    customerId: item.customerId,
    policyId: item.policyId,
    status: item.status,
    agentName: item.agentName,
  });
  return {
    callbackId: item.callbackId,
    customerId: item.customerId,
    policyId: item.policyId,
    status: item.status,
    detail: item.outcomeNotes,
    agentName: item.agentName,
    scheduledAt: item.scheduledAt,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
  };
}

const renewPolicyInput = z
  .object({
    policyNumber: z.string().trim().min(1).max(80),
  })
  .strict();

export async function renewPolicyByNumber(input: unknown, actor: string) {
  const { policyNumber } = renewPolicyInput.parse(input);
  const [allCustomers, allProducts] = await Promise.all([
    customers.all(),
    products.all(),
  ]);
  const result = await policies.mutate((rows) => {
    const index = rows.findIndex((row) => row.policyNumber === policyNumber);
    if (index < 0) throw httpError(404, "Policy not found");
    const current = rows[index];
    if (current.renewalStatus === "CANCELLED") {
      throw httpError(409, "Cancelled policies cannot be renewed");
    }
    const renewedRecently =
      current.lastRenewedAt &&
      Date.now() - Date.parse(current.lastRenewedAt) < 24 * 60 * 60 * 1000;
    if (renewedRecently) {
      return {
        policyId: current.policyId,
        policyNumber: current.policyNumber,
        effectiveDate: current.effectiveDate,
        expiryDate: current.expiryDate,
        renewalStatus: current.renewalStatus,
        updatedAt: current.updatedAt,
        alreadyRenewed: true,
      };
    }

    const previousExpiryDate = current.expiryDate;
    const period = nextRenewalPeriod(previousExpiryDate);
    const timestamp = new Date().toISOString();
    const renewed: Policy = {
      ...current,
      ...period,
      renewalStatus: "RENEWED",
      lastRenewedAt: timestamp,
      updatedAt: timestamp,
    };
    markOutdated(renewed, allCustomers, allProducts);
    rows[index] = renewed;
    return {
      policyId: renewed.policyId,
      policyNumber: renewed.policyNumber,
      previousExpiryDate,
      effectiveDate: renewed.effectiveDate,
      expiryDate: renewed.expiryDate,
      renewalStatus: renewed.renewalStatus,
      updatedAt: renewed.updatedAt,
      alreadyRenewed: false,
    };
  });
  if (!result.alreadyRenewed) {
    await audit("RENEW_POLICY", actor, result.policyId, {
      policyNumber: result.policyNumber,
      previousExpiryDate: result.previousExpiryDate,
      expiryDate: result.expiryDate,
    });
    publishPolicyRenewal({
      policyId: result.policyId,
      policyNumber: result.policyNumber,
      expiryDate: result.expiryDate,
      renewalStatus: "RENEWED",
    });
  }
  return result;
}

export async function deletePolicy(id: string, actor: string): Promise<void> {
  await policies.mutate((rows) => {
    const index = rows.findIndex((row) => row.policyId === id);
    if (index < 0) throw httpError(404, "Policy not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_POLICY", actor, id);
}

export async function createInquiry(
  input: unknown,
): Promise<Awaited<ReturnType<typeof inquiries.all>>[number]> {
  const data = inquiryInput.parse(input);
  if (!(await products.findById("productId", data.productId)))
    throw httpError(400, "Product not found");
  const item = await inquiries.mutate((rows) => {
    const timestamp = new Date().toISOString();
    const inquiry = {
      ...data,
      inquiryId: nextId("INQ", rows, "inquiryId"),
      status: "NEW" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.push(inquiry);
    return inquiry;
  });
  await audit("CREATE_INQUIRY", "public", item.inquiryId);
  return item;
}

export async function updateInquiry(id: string, status: string, actor: string) {
  if (!["NEW", "CONTACTED", "CONVERTED", "CLOSED"].includes(status))
    throw httpError(400, "Invalid inquiry status");
  const item = await inquiries.mutate((rows) => {
    const index = rows.findIndex((row) => row.inquiryId === id);
    if (index < 0) throw httpError(404, "Inquiry not found");
    rows[index] = {
      ...rows[index],
      status: status as (typeof rows)[number]["status"],
      updatedAt: new Date().toISOString(),
    };
    return rows[index];
  });
  await audit("UPDATE_INQUIRY", actor, id, { status });
  return item;
}

function markOutdated(
  policy: Policy,
  allCustomers: Customer[],
  allProducts: Product[],
): void {
  if (!policy.genesys.contactId || !policy.genesys.lastPayloadHash) return;
  const customer = allCustomers.find(
    (item) => item.customerId === policy.customerId,
  );
  const product = allProducts.find(
    (item) => item.productId === policy.productId,
  );
  if (!customer || !product) return;
  const current = payloadHash(mapCampaignContact(policy, customer, product));
  if (current !== policy.genesys.lastPayloadHash)
    policy.genesys.syncStatus = "OUTDATED";
}

async function refreshOutdated(
  customerId?: string,
  productId?: string,
): Promise<void> {
  const allCustomers = await customers.all();
  const allProducts = await products.all();
  await policies.mutate((rows) => {
    for (const policy of rows)
      if (
        (customerId && policy.customerId === customerId) ||
        (productId && policy.productId === productId)
      )
        markOutdated(policy, allCustomers, allProducts);
  });
}

export async function getDashboard() {
  const [allCustomers, allProducts, allPolicies, allInquiries] =
    await Promise.all([
      customers.all(),
      products.all(),
      policies.all(),
      inquiries.all(),
    ]);
  const countExpiry = (days: number) =>
    allPolicies.filter((item) => {
      const remaining = daysUntilExpiry(item.expiryDate);
      return remaining >= 0 && remaining <= days;
    }).length;
  const countBy = (values: string[]) =>
    Object.entries(
      values.reduce<Record<string, number>>((acc, value) => {
        acc[value] = (acc[value] || 0) + 1;
        return acc;
      }, {}),
    ).map(([label, value]) => ({ label, value }));
  const productById = new Map(
    allProducts.map((item) => [item.productId, item.productName]),
  );
  return {
    kpis: {
      totalCustomers: allCustomers.length,
      activePolicies: allPolicies.filter(
        (item) =>
          daysUntilExpiry(item.expiryDate) >= 0 &&
          !["CANCELLED", "EXPIRED"].includes(item.renewalStatus),
      ).length,
      totalPremium: allPolicies.reduce((sum, item) => sum + item.premium, 0),
      expiring7: countExpiry(7),
      expiring30: countExpiry(30),
      expiring60: countExpiry(60),
      expiring90: countExpiry(90),
      contactPending: allPolicies.filter(
        (item) => item.renewalStatus === "CONTACT_PENDING",
      ).length,
      callbackRequested: allPolicies.filter(
        (item) => item.renewalStatus === "CALLBACK_REQUESTED",
      ).length,
      renewed: allPolicies.filter((item) => item.renewalStatus === "RENEWED")
        .length,
      dncCustomers: allCustomers.filter((item) => item.dnc).length,
      genesysSynced: allPolicies.filter(
        (item) => item.genesys.syncStatus === "SYNCED",
      ).length,
      genesysFailed: allPolicies.filter(
        (item) => item.genesys.syncStatus === "FAILED",
      ).length,
      newInquiries: allInquiries.filter((item) => item.status === "NEW").length,
    },
    charts: {
      byProduct: countBy(
        allPolicies.map(
          (item) => productById.get(item.productId) || item.productId,
        ),
      ),
      byRenewal: countBy(allPolicies.map((item) => item.renewalStatus)),
      byChannel: countBy(allCustomers.map((item) => item.preferredChannel)),
      byGenesys: countBy(allPolicies.map((item) => item.genesys.syncStatus)),
    },
  };
}

export async function getCustomer360(id: string) {
  const customer = await customers.findById("customerId", id);
  if (!customer) throw httpError(404, "Customer not found");
  const allProducts = await products.all();
  const customerPolicies = (await policies.all())
    .filter((item) => item.customerId === id)
    .map((item) => ({
      ...item,
      daysUntilExpiry: daysUntilExpiry(item.expiryDate),
      product: allProducts.find(
        (product) => product.productId === item.productId,
      ),
    }));
  const customerInquiries = (await inquiries.all()).filter(
    (item) => item.phone === customer.phone,
  );
  return { customer, policies: customerPolicies, inquiries: customerInquiries };
}

export async function searchAll(term: string) {
  const q = term.trim().toLocaleLowerCase();
  if (q.length < 2) return { customers: [], policies: [] };
  const allCustomers = await customers.all();
  const matchingCustomers = allCustomers.filter((item) =>
    [item.customerId, item.firstName, item.lastName, item.phone].some((value) =>
      value.toLocaleLowerCase().includes(q),
    ),
  );
  const customerIds = new Set(matchingCustomers.map((item) => item.customerId));
  const matchingPolicies = (await policies.all()).filter(
    (item) =>
      customerIds.has(item.customerId) ||
      [
        item.policyId,
        item.policyNumber,
        item.vehicle.licensePlate,
        item.vehicle.brand,
        item.vehicle.model,
      ].some((value) => value.toLocaleLowerCase().includes(q)),
  );
  return {
    customers: matchingCustomers.slice(0, 10),
    policies: matchingPolicies.slice(0, 10),
  };
}

export async function createBackup(): Promise<{
  directory: string;
  files: string[];
}> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 17);
  const directory = path.join(backupsDir, stamp);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(path.join(dataDir, name), path.join(directory, name));
    files.push(name);
  }
  const configDir = path.join(dataDir, "config");
  await mkdir(path.join(directory, "config"), { recursive: true });
  for (const name of await readdir(configDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(
      path.join(configDir, name),
      path.join(directory, "config", name),
    );
    files.push(`config/${name}`);
  }
  return { directory: stamp, files };
}

export async function downloadBackup(stamp: string) {
  if (!/^\d{17}$/.test(stamp)) throw httpError(400, "Invalid backup ID");
  const directory = path.join(backupsDir, stamp);
  const files: Record<string, unknown> = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".json"))
      files[name] = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      );
  }
  const configDir = path.join(directory, "config");
  for (const name of await readdir(configDir)) {
    if (name.endsWith(".json")) {
      const value = JSON.parse(
        await readFile(path.join(configDir, name), "utf8"),
      ) as Record<string, unknown>;
      if (name === "genesys.json") {
        delete value.clientId;
        delete value.clientSecretEncrypted;
      }
      files[`config/${name}`] = value;
    }
  }
  return files;
}

export async function resetDemoData(actor: string): Promise<void> {
  await createBackup();
  await customers.replaceAll(seedCustomers());
  await products.replaceAll(seedProducts());
  await policies.replaceAll(seedPolicies());
  await inquiries.replaceAll(seedInquiries());
  await campaigns.replaceAll(seedCampaignLists());
  await genesysScheduleTasks.replaceAll([]);
  await agentCallbacks.replaceAll(seedAgentCallbacks());
  await audit("RESET_DEMO_DATA", actor);
}

export async function listAudit() {
  const business = await auditLog.all();
  let genesys: unknown[] = [];
  try {
    genesys = JSON.parse(
      await readFile(
        path.join(dataDir, "config", "genesys-audit-log.json"),
        "utf8",
      ),
    ) as unknown[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { business, genesys };
}

export async function writeBackupManifest(
  stamp: string,
  files: string[],
): Promise<void> {
  await writeFile(
    path.join(backupsDir, stamp, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2)}\n`,
    "utf8",
  );
}
