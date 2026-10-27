import { Router } from "express";
import { daysUntilExpiry } from "../domain/campaign-contact";
import {
  createBackup,
  createAgentCallback,
  createCustomer,
  createPolicy,
  createProduct,
  deleteAgentCallback,
  deleteCustomer,
  deletePolicy,
  deleteProduct,
  downloadBackup,
  getCustomer360,
  getDashboard,
  httpError,
  listAudit,
  resetDemoData,
  renewPolicyByNumber,
  searchAll,
  updateCustomer,
  updateAgentCallback,
  updateInquiry,
  updatePolicy,
  updateProduct,
  writeBackupManifest,
} from "../domain/business";
import {
  agentCallbacks,
  campaigns,
  customers,
  inquiries,
  policies,
  products,
} from "../domain/store";
import { requireAdmin } from "../middleware/require-admin";
import type { Customer } from "../domain/types";
import { subscribeToPolicyRenewals } from "../domain/policy-renewal-events";

export const adminDataRouter = Router();
adminDataRouter.use(requireAdmin);

const string = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown, fallback: number) =>
  Number.isFinite(Number(value)) && value !== undefined
    ? Number(value)
    : fallback;
const paging = (query: Record<string, unknown>) => ({
  page: number(query.page, 1),
  pageSize: number(query.pageSize, 20),
});
const contains = (value: string, query: string) =>
  value.toLocaleLowerCase().includes(query.toLocaleLowerCase());

adminDataRouter.get("/dashboard", async (_request, response) => {
  response.json(await getDashboard());
});

adminDataRouter.get("/customers", async (request, response) => {
  const { page, pageSize } = paging(request.query);
  const result = await customers.query({
    search: string(request.query.search),
    fields: [
      "customerId",
      "firstName",
      "lastName",
      "phone",
      "email",
      "province",
    ],
    filter: (item) =>
      (!request.query.channel ||
        item.preferredChannel === request.query.channel) &&
      (!request.query.dnc || String(item.dnc) === request.query.dnc) &&
      (!request.query.province || item.province === request.query.province),
    sortBy: (string(request.query.sortBy) as keyof Customer) || "updatedAt",
    descending: request.query.order !== "asc",
    page,
    pageSize,
  });
  response.json(result);
});
adminDataRouter.get("/customers/:id/360", async (request, response) => {
  response.json(await getCustomer360(request.params.id));
});
adminDataRouter.get("/customers/:id", async (request, response) => {
  const item = await customers.findById("customerId", request.params.id);
  if (!item) throw httpError(404, "Customer not found");
  response.json(item);
});
adminDataRouter.post("/customers", async (request, response) => {
  response
    .status(201)
    .json(await createCustomer(request.body, request.user!.name));
});
adminDataRouter.put("/customers/:id", async (request, response) => {
  response.json(
    await updateCustomer(request.params.id, request.body, request.user!.name),
  );
});
adminDataRouter.delete("/customers/:id", async (request, response) => {
  await deleteCustomer(request.params.id, request.user!.name);
  response.status(204).end();
});

adminDataRouter.get("/products", async (request, response) => {
  const { page, pageSize } = paging(request.query);
  response.json(
    await products.query({
      search: string(request.query.search),
      fields: [
        "productCode",
        "productName",
        "insuranceClass",
        "insurerName",
        "slug",
      ],
      filter: (item) =>
        (!request.query.active ||
          String(item.active) === request.query.active) &&
        (!request.query.vehicleType ||
          item.vehicleType === request.query.vehicleType),
      sortBy:
        (string(request.query.sortBy) as "displayOrder") || "displayOrder",
      descending: request.query.order === "desc",
      page,
      pageSize,
    }),
  );
});
adminDataRouter.get("/products/:id", async (request, response) => {
  const item = await products.findById("productId", request.params.id);
  if (!item) throw httpError(404, "Product not found");
  response.json(item);
});
adminDataRouter.post("/products", async (request, response) => {
  response
    .status(201)
    .json(await createProduct(request.body, request.user!.name));
});
adminDataRouter.put("/products/:id", async (request, response) => {
  response.json(
    await updateProduct(request.params.id, request.body, request.user!.name),
  );
});
adminDataRouter.delete("/products/:id", async (request, response) => {
  await deleteProduct(request.params.id, request.user!.name);
  response.status(204).end();
});

async function policyRows(
  query: Record<string, unknown>,
  defaultExcludeDnc = false,
) {
  const [allCustomers, allProducts, allPolicies] = await Promise.all([
    customers.all(),
    products.all(),
    policies.all(),
  ]);
  const customerMap = new Map(
    allCustomers.map((item) => [item.customerId, item]),
  );
  const productMap = new Map(allProducts.map((item) => [item.productId, item]));
  const search = string(query.search);
  let rows = allPolicies.map((policy) => ({
    ...policy,
    daysUntilExpiry: daysUntilExpiry(policy.expiryDate),
    customer: customerMap.get(policy.customerId),
    product: productMap.get(policy.productId),
  }));
  if (search)
    rows = rows.filter((row) =>
      [
        row.policyId,
        row.policyNumber,
        row.customer?.firstName,
        row.customer?.lastName,
        row.customer?.phone,
        row.vehicle.licensePlate,
        row.vehicle.brand,
        row.vehicle.model,
      ].some((value) => contains(String(value || ""), search)),
    );
  if (query.productId)
    rows = rows.filter((row) => row.productId === query.productId);
  if (query.insuranceClass)
    rows = rows.filter(
      (row) => row.product?.insuranceClass === query.insuranceClass,
    );
  if (query.insurerName)
    rows = rows.filter((row) => row.insurerName === query.insurerName);
  if (query.vehicleType)
    rows = rows.filter((row) => row.vehicle.vehicleType === query.vehicleType);
  if (query.renewalStatus)
    rows = rows.filter((row) => row.renewalStatus === query.renewalStatus);
  if (query.genesysStatus)
    rows = rows.filter((row) => row.genesys.syncStatus === query.genesysStatus);
  if (query.channel)
    rows = rows.filter((row) => row.preferredChannel === query.channel);
  if (
    query.excludeDnc === "true" ||
    (defaultExcludeDnc && query.excludeDnc !== "false")
  )
    rows = rows.filter((row) => !row.customer?.dnc);
  if (query.daysTo !== undefined)
    rows = rows.filter(
      (row) =>
        row.daysUntilExpiry >= 0 &&
        row.daysUntilExpiry <= number(query.daysTo, 90),
    );
  if (query.expiryFrom)
    rows = rows.filter((row) => row.expiryDate >= string(query.expiryFrom));
  if (query.expiryTo)
    rows = rows.filter((row) => row.expiryDate <= string(query.expiryTo));
  const sortBy = string(query.sortBy) || "expiryDate";
  rows.sort(
    (a, b) =>
      String(a[sortBy as keyof typeof a] ?? "").localeCompare(
        String(b[sortBy as keyof typeof b] ?? ""),
        "th",
        { numeric: true },
      ) * (query.order === "desc" ? -1 : 1),
  );
  const { page, pageSize } = paging(query);
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  };
}

adminDataRouter.get("/policies", async (request, response) => {
  response.json(await policyRows(request.query));
});
adminDataRouter.get("/renewals", async (request, response) => {
  response.json(await policyRows(request.query, true));
});

const bangkokDay = (value: string | Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

adminDataRouter.get("/agent-callbacks/options", async (_request, response) => {
  const [allCustomers, allPolicies, allCallbacks] = await Promise.all([
    customers.all(),
    policies.all(),
    agentCallbacks.all(),
  ]);
  const activePolicyIds = new Set(
    allCallbacks
      .filter((item) => item.status === "SCHEDULED")
      .map((item) => item.policyId),
  );
  const customerMap = new Map(
    allCustomers.map((item) => [item.customerId, item]),
  );
  const items = allPolicies
    .map((policy) => ({
      policy,
      customer: customerMap.get(policy.customerId),
      daysUntilExpiry: daysUntilExpiry(policy.expiryDate),
    }))
    .filter(
      (item) =>
        item.customer &&
        !item.customer.dnc &&
        !activePolicyIds.has(item.policy.policyId) &&
        !["RENEWED", "CANCELLED"].includes(item.policy.renewalStatus) &&
        item.daysUntilExpiry >= -90 &&
        item.daysUntilExpiry <= 365,
    )
    .sort((a, b) => a.policy.expiryDate.localeCompare(b.policy.expiryDate));
  response.json({ items });
});

adminDataRouter.get("/agent-callbacks", async (request, response) => {
  const [allCallbacks, allCustomers, allPolicies] = await Promise.all([
    agentCallbacks.all(),
    customers.all(),
    policies.all(),
  ]);
  const customerMap = new Map(
    allCustomers.map((item) => [item.customerId, item]),
  );
  const policyMap = new Map(allPolicies.map((item) => [item.policyId, item]));
  const now = new Date();
  const today = bangkokDay(now);
  const allRows = allCallbacks.map((callback) => {
    const policy = policyMap.get(callback.policyId);
    return {
      ...callback,
      customer: customerMap.get(callback.customerId),
      policy,
      daysUntilExpiry: policy ? daysUntilExpiry(policy.expiryDate) : 0,
      overdue:
        callback.status === "SCHEDULED" &&
        Date.parse(callback.scheduledAt) < now.getTime(),
    };
  });
  const search = string(request.query.search);
  let rows = allRows;
  if (search)
    rows = rows.filter((row) =>
      [
        row.callbackId,
        row.customer?.firstName,
        row.customer?.lastName,
        row.customer?.phone,
        row.policy?.policyNumber,
        row.intent,
        row.assignedAgent,
        row.agentName,
        row.notes,
        row.outcomeNotes,
      ].some((value) => contains(String(value || ""), search)),
    );
  if (request.query.status)
    rows = rows.filter((row) => row.status === request.query.status);
  if (request.query.intent)
    rows = rows.filter((row) => row.intent === request.query.intent);
  if (request.query.timing === "today")
    rows = rows.filter(
      (row) =>
        row.status === "SCHEDULED" && bangkokDay(row.scheduledAt) === today,
    );
  if (request.query.timing === "upcoming")
    rows = rows.filter(
      (row) =>
        row.status === "SCHEDULED" &&
        Date.parse(row.scheduledAt) >= now.getTime(),
    );
  if (request.query.timing === "overdue")
    rows = rows.filter((row) => row.overdue);
  rows.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const { page, pageSize } = paging(request.query);
  response.json({
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
    summary: {
      scheduled: allRows.filter((item) => item.status === "SCHEDULED").length,
      today: allRows.filter(
        (item) =>
          item.status === "SCHEDULED" && bangkokDay(item.scheduledAt) === today,
      ).length,
      overdue: allRows.filter((item) => item.overdue).length,
      completed: allRows.filter((item) => item.status === "COMPLETED").length,
    },
  });
});

adminDataRouter.post("/agent-callbacks", async (request, response) => {
  response
    .status(201)
    .json(await createAgentCallback(request.body, request.user!.name));
});

adminDataRouter.put("/agent-callbacks/:id", async (request, response) => {
  response.json(
    await updateAgentCallback(
      request.params.id,
      request.body,
      request.user!.name,
    ),
  );
});

adminDataRouter.delete("/agent-callbacks/:id", async (request, response) => {
  await deleteAgentCallback(request.params.id, request.user!.name);
  response.status(204).end();
});

adminDataRouter.get("/policies/renewal-events", (_request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write(": connected\n\n");
  const unsubscribe = subscribeToPolicyRenewals((event) => {
    response.write(`event: policy-renewed\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 25000);
  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
adminDataRouter.get("/policies/:id", async (request, response) => {
  const item = await policies.findById("policyId", request.params.id);
  if (!item) throw httpError(404, "Policy not found");
  response.json({
    ...item,
    daysUntilExpiry: daysUntilExpiry(item.expiryDate),
    customer: await customers.findById("customerId", item.customerId),
    product: await products.findById("productId", item.productId),
  });
});
adminDataRouter.post("/policies", async (request, response) => {
  response
    .status(201)
    .json(await createPolicy(request.body, request.user!.name));
});
adminDataRouter.post("/policies/:id/renew", async (request, response) => {
  const policy = await policies.findById("policyId", request.params.id);
  if (!policy) throw httpError(404, "Policy not found");
  response.json(
    await renewPolicyByNumber(
      { policyNumber: policy.policyNumber },
      request.user!.name,
    ),
  );
});
adminDataRouter.put("/policies/:id", async (request, response) => {
  response.json(
    await updatePolicy(request.params.id, request.body, request.user!.name),
  );
});
adminDataRouter.delete("/policies/:id", async (request, response) => {
  await deletePolicy(request.params.id, request.user!.name);
  response.status(204).end();
});

adminDataRouter.get("/inquiries", async (request, response) => {
  const { page, pageSize } = paging(request.query);
  response.json(
    await inquiries.query({
      search: string(request.query.search),
      fields: ["firstName", "lastName", "phone"],
      filter: (item) =>
        !request.query.status || item.status === request.query.status,
      sortBy: "createdAt",
      descending: true,
      page,
      pageSize,
    }),
  );
});
adminDataRouter.put("/inquiries/:id/status", async (request, response) => {
  response.json(
    await updateInquiry(
      request.params.id,
      string(request.body?.status),
      request.user!.name,
    ),
  );
});

adminDataRouter.get("/audit", async (_request, response) => {
  response.json(await listAudit());
});
adminDataRouter.get("/search", async (request, response) => {
  response.json(await searchAll(string(request.query.q)));
});
adminDataRouter.get("/meta", async (_request, response) => {
  response.json({
    customers: await customers.all(),
    products: await products.all(),
    campaigns: await campaigns.all(),
  });
});

adminDataRouter.post("/settings/backup", async (request, response) => {
  const result = await createBackup();
  await writeBackupManifest(result.directory, result.files);
  response.status(201).json({
    ...result,
    downloadUrl: `/api/admin/settings/backups/${result.directory}/download`,
  });
});
adminDataRouter.get(
  "/settings/backups/:stamp/download",
  async (request, response) => {
    const data = await downloadBackup(request.params.stamp);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="mfec-backup-${request.params.stamp}.json"`,
    );
    response.json({
      note: "The encryption key is not included. Re-enter the Genesys Client Secret after migrating servers.",
      files: data,
    });
  },
);
adminDataRouter.post("/settings/reset-demo", async (request, response) => {
  if (request.body?.confirmation !== "RESET")
    throw httpError(400, "Type RESET to confirm demo reset");
  await resetDemoData(request.user!.name);
  response.json({ ok: true });
});
