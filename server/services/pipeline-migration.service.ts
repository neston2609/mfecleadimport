import { createHash } from "node:crypto";
import {
  contactTemplates,
  sourceIntegrations,
  sourceMappings,
  leadDefinitions,
  importStates,
  importSchedules,
} from "../domain/pipeline-store";
import {
  campaigns,
  policies,
  customers,
  products,
  genesysScheduleTasks,
  audit,
} from "../domain/store";
import {
  CONTACT_COLUMNS,
  buildPreview,
  payloadHash,
} from "../domain/campaign-contact";
import { readJsonFile, writeJsonFile } from "./genesys/file-store";
import { GenesysConfigService } from "./genesys/genesys-config.service";
import { contactHash, stateKey } from "./lead-pipeline.service";
import { nextLeadRun } from "./lead-schedule.service";
import type { ContactTemplate, ImportSchedule } from "../domain/pipeline-types";

export async function migrateLegacyCampaigns() {
  if (await readJsonFile<boolean>("pipeline-migration.json", false)) return;
  const legacy = await campaigns.all();
  if (!legacy.length) {
    await writeJsonFile("pipeline-migration.json", true);
    return;
  }
  const config = await new GenesysConfigService().getConfig();
  const now = new Date().toISOString();
  const stableId = (value: string) => {
    const hash = createHash("sha256")
      .update("legacy-pipeline:" + value)
      .digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  const template: ContactTemplate = {
    id: stableId("template"),
    name: "Insurance contact template (migrated)",
    contactListId: config.contactListId || "",
    createdAt: now,
    updatedAt: now,
    fields: CONTACT_COLUMNS.map((name) => ({
      name,
      type: name === "phone" ? "PHONE" : "STRING",
      required: name === "phone",
    })),
  };
  await contactTemplates.mutate((rows) => {
    if (!rows.some((row) => row.id === template.id)) rows.push(template);
  });
  const [allPolicies, allCustomers, allProducts] = await Promise.all([
    policies.all(),
    customers.all(),
    products.all(),
  ]);
  const migrated = new Map<string, string>();
  for (const campaign of legacy) {
    const sourceId = stableId("source:" + campaign.campaignListId),
      mappingId = stableId("mapping:" + campaign.campaignListId),
      leadId = stableId("lead:" + campaign.campaignListId);
    const base = { createdAt: now, updatedAt: now };
    const preview = buildPreview(
      allPolicies,
      allCustomers,
      allProducts,
      campaign.filters,
    );
    await sourceIntegrations.mutate((rows) => {
      if (!rows.some((row) => row.id === sourceId))
        rows.push({
          ...base,
          id: sourceId,
          name: "Legacy · " + campaign.name,
          kind: "LEGACY",
          config: { campaignListId: campaign.campaignListId },
          secretEncrypted: "",
          fields: [...CONTACT_COLUMNS, "dnc", "legacyEligible"],
        });
    });
    await sourceMappings.mutate((rows) => {
      if (!rows.some((row) => row.id === mappingId))
        rows.push({
          ...base,
          id: mappingId,
          name: "Mapping · " + campaign.name,
          sourceId,
          templateId: template.id,
          keyField: "policyId",
          fields: CONTACT_COLUMNS.map((name) => ({
            targetField: name,
            sourceField: name,
            defaultValue: "",
          })),
        });
    });
    await leadDefinitions.mutate((rows) => {
      if (!rows.some((row) => row.id === leadId))
        rows.push({
          ...base,
          id: leadId,
          name: campaign.name,
          mappingId,
          match: "ALL",
          filters: [],
        });
    });
    migrated.set(campaign.campaignListId, leadId);
    await importStates.mutate((rows) => {
      for (const row of preview.rows) {
        const previous = row.policy.genesys;
        if (!previous.contactId || !previous.contactListId) continue;
        const id = stateKey(
          "legacy-policy",
          row.policy.policyId,
          previous.contactListId,
        );
        if (!rows.some((state) => state.id === id))
          rows.push({
            id,
            mappingId,
            sourceKey: row.policy.policyId,
            contactListId: previous.contactListId,
            contactId: previous.contactId,
            payloadHash:
              previous.syncStatus === "SYNCED" &&
              previous.lastPayloadHash === payloadHash(row.contact)
                ? contactHash({ ...row.contact })
                : "legacy-outdated",
            status: previous.syncStatus === "SYNCED" ? "SYNCED" : "FAILED",
            message: "Migrated existing Genesys contact identity",
            updatedAt: now,
          });
      }
    });
  }
  const schedules = await genesysScheduleTasks.all();
  for (const schedule of schedules) {
    const leadId = migrated.get(schedule.campaignListId);
    if (
      !leadId ||
      !config.contactListId ||
      !["DAILY", "WEEKLY"].includes(schedule.frequency)
    )
      continue;
    const value: ImportSchedule = {
      id: stableId("schedule:" + schedule.schedulerTaskId),
      name: schedule.name,
      leadId,
      contactListId: config.contactListId,
      frequency: schedule.frequency as "DAILY" | "WEEKLY",
      time: schedule.time,
      dayOfWeek: schedule.dayOfWeek ?? 1,
      dayOfMonth: 1,
      monthDays: [],
      enabled: schedule.enabled,
      nextRunAt: "",
      lastRunAt: schedule.lastRunAt,
      lastStatus: schedule.lastRunStatus,
      lastMessage: schedule.lastRunMessage,
      lastJobId: "",
      createdAt: now,
      updatedAt: now,
    };
    if (value.enabled) value.nextRunAt = nextLeadRun(value);
    await importSchedules.mutate((rows) => {
      if (!rows.some((row) => row.id === value.id)) rows.push(value);
    });
    await genesysScheduleTasks.mutate((rows) => {
      const old = rows.find(
        (row) => row.schedulerTaskId === schedule.schedulerTaskId,
      );
      if (old) {
        old.enabled = false;
        old.nextRunAt = "";
        old.lastRunMessage = "Migrated to Lead Configuration scheduler";
      }
    });
  }
  await writeJsonFile("pipeline-migration.json", true);
  await audit("MIGRATE_LEAD_PIPELINE", "system", "", {
    campaigns: legacy.length,
  });
}
