import { Router } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildPreview, generateGenesysCsv } from "../domain/campaign-contact";
import { httpError } from "../domain/business";
import {
  audit,
  campaigns,
  customers,
  genesysScheduleTasks,
  nextId,
  policies,
  products,
} from "../domain/store";
import type { CampaignFilters, CampaignList } from "../domain/types";
import { requireAdmin } from "../middleware/require-admin";
import { GenesysConfigService } from "../services/genesys/genesys-config.service";

export const campaignRouter = Router();
campaignRouter.use(requireAdmin);
const genesysConfigService = new GenesysConfigService();

export const filtersSchema = z.object({
  productId: z.string().optional(),
  insuranceClass: z.string().optional(),
  vehicleType: z.string().optional(),
  vehicleBrand: z.string().optional(),
  insurerName: z.string().optional(),
  expiryFrom: z.string().optional(),
  expiryTo: z.string().optional(),
  daysFrom: z.number().optional(),
  daysTo: z.number().optional(),
  renewalStatus: z.string().optional(),
  preferredChannel: z.string().optional(),
  digitalSent: z.boolean().optional(),
  voiceCalled: z.boolean().optional(),
  customerIntent: z.string().optional(),
  premiumFrom: z.number().optional(),
  premiumTo: z.number().optional(),
  province: z.string().optional(),
  genesysStatus: z.string().optional(),
  excludeDnc: z.boolean().optional(),
});
const campaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  filters: filtersSchema,
});

export async function previewCampaign(
  filters: CampaignFilters,
  selectedIds?: string[],
) {
  const [allPolicies, allCustomers, allProducts, genesysConfig] =
    await Promise.all([
      policies.all(),
      customers.all(),
      products.all(),
      genesysConfigService.getConfig(),
    ]);
  return buildPreview(
    allPolicies,
    allCustomers,
    allProducts,
    filters,
    selectedIds,
    genesysConfig.contactListId || undefined,
  );
}

campaignRouter.get("/", async (request, response) => {
  const search = String(request.query.search || "")
    .trim()
    .toLocaleLowerCase();
  const rows = (await campaigns.all()).filter(
    (item) => !search || item.name.toLocaleLowerCase().includes(search),
  );
  const items = await Promise.all(
    rows.map(async (item) => ({
      ...item,
      recordCount: (await previewCampaign(item.filters)).summary.eligible,
    })),
  );
  response.json({ items, total: items.length });
});

campaignRouter.post("/preview", async (request, response) => {
  const filters = filtersSchema.parse(request.body?.filters || {});
  const ids = z.array(z.string()).optional().parse(request.body?.selectedIds);
  response.json(await previewCampaign(filters, ids));
});

campaignRouter.get("/:id", async (request, response) => {
  const item = await campaigns.findById("campaignListId", request.params.id);
  if (!item) throw httpError(404, "Campaign list not found");
  response.json(item);
});

campaignRouter.post("/", async (request, response) => {
  const data = campaignInput.parse(request.body);
  const preview = await previewCampaign(data.filters);
  const item = await campaigns.mutate((rows) => {
    const timestamp = new Date().toISOString();
    const campaign: CampaignList = {
      ...data,
      filters: { ...data.filters, excludeDnc: data.filters.excludeDnc ?? true },
      campaignListId: nextId("CAMP", rows, "campaignListId"),
      recordCount: preview.summary.eligible,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastExportedAt: "",
      lastGenesysSyncAt: "",
    };
    rows.push(campaign);
    return campaign;
  });
  await audit("CREATE_CAMPAIGN_LIST", request.user!.name, item.campaignListId);
  response.status(201).json(item);
});

campaignRouter.put("/:id", async (request, response) => {
  const data = campaignInput.partial().parse(request.body);
  const item = await campaigns.mutate((rows) => {
    const index = rows.findIndex(
      (row) => row.campaignListId === request.params.id,
    );
    if (index < 0) throw httpError(404, "Campaign list not found");
    rows[index] = {
      ...rows[index],
      ...data,
      filters: data.filters ?? rows[index].filters,
      updatedAt: new Date().toISOString(),
    };
    return rows[index];
  });
  const preview = await previewCampaign(item.filters);
  await campaigns.mutate((rows) => {
    const row = rows.find(
      (entry) => entry.campaignListId === item.campaignListId,
    );
    if (row) row.recordCount = preview.summary.eligible;
  });
  await audit("UPDATE_CAMPAIGN_LIST", request.user!.name, item.campaignListId);
  response.json({ ...item, recordCount: preview.summary.eligible });
});

campaignRouter.delete("/:id", async (request, response) => {
  const scheduled = (await genesysScheduleTasks.all()).find(
    (task) => task.campaignListId === request.params.id,
  );
  if (scheduled)
    throw httpError(
      409,
      `Campaign is used by scheduler task ${scheduled.name}. Update or delete that task first.`,
    );
  await campaigns.mutate((rows) => {
    const index = rows.findIndex(
      (row) => row.campaignListId === request.params.id,
    );
    if (index < 0) throw httpError(404, "Campaign list not found");
    rows.splice(index, 1);
  }, true);
  await audit("DELETE_CAMPAIGN_LIST", request.user!.name, request.params.id);
  response.status(204).end();
});

campaignRouter.post("/:id/preview", async (request, response) => {
  const campaign = await campaigns.findById(
    "campaignListId",
    request.params.id,
  );
  if (!campaign) throw httpError(404, "Campaign list not found");
  const ids = z.array(z.string()).optional().parse(request.body?.selectedIds);
  response.json(await previewCampaign(campaign.filters, ids));
});

campaignRouter.post("/:id/export", async (request, response) => {
  const campaign = await campaigns.findById(
    "campaignListId",
    request.params.id,
  );
  if (!campaign) throw httpError(404, "Campaign list not found");
  const ids = z.array(z.string()).optional().parse(request.body?.selectedIds);
  const preview = await previewCampaign(campaign.filters, ids);
  const contacts = preview.rows
    .filter((row) => row.eligibility === "ELIGIBLE")
    .map((row) => row.contact);
  if (!contacts.length) throw httpError(400, "No eligible contacts to export");
  const csv = generateGenesysCsv(contacts);
  const stamp = `${new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 6)}`;
  const safeName =
    campaign.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "campaign";
  const fileName = `genesys-contact-list-${safeName}-${stamp}.csv`;
  const exportDir = path.resolve(
    process.env.EXPORTS_DIR || path.join(process.cwd(), "exports"),
  );
  await mkdir(exportDir, { recursive: true });
  await writeFile(path.join(exportDir, fileName), csv, { flag: "wx" });
  await campaigns.mutate((rows) => {
    const row = rows.find(
      (entry) => entry.campaignListId === campaign.campaignListId,
    );
    if (row) row.lastExportedAt = new Date().toISOString();
  });
  await audit(
    "EXPORT_CAMPAIGN_LIST",
    request.user!.name,
    campaign.campaignListId,
    { fileName, count: contacts.length },
  );
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`,
  );
  response.send(csv);
});
