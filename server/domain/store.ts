import { randomUUID } from "node:crypto";
import { JsonRepository } from "./json-repository";
import { AGENT_CALLBACK_INTENTS } from "./types";
import {
  seedCampaignLists,
  seedCustomers,
  seedInquiries,
  seedPolicies,
  seedProducts,
} from "./seed";
import type {
  AgentCallback,
  AuditRecord,
  CampaignList,
  Customer,
  GenesysScheduleTask,
  Inquiry,
  Policy,
  Product,
} from "./types";

export const customers = new JsonRepository<Customer>(
  "customers.json",
  seedCustomers,
);
export const products = new JsonRepository<Product>(
  "products.json",
  seedProducts,
);
export const policies = new JsonRepository<Policy>(
  "policies.json",
  seedPolicies,
);
export const inquiries = new JsonRepository<Inquiry>(
  "inquiries.json",
  seedInquiries,
);
export const campaigns = new JsonRepository<CampaignList>(
  "campaign-lists.json",
  seedCampaignLists,
);
export const genesysScheduleTasks = new JsonRepository<GenesysScheduleTask>(
  "genesys-schedule-tasks.json",
  () => [],
);
export const agentCallbacks = new JsonRepository<AgentCallback>(
  "agent-callbacks.json",
  () => [],
);
export const auditLog = new JsonRepository<AuditRecord>(
  "audit-log.json",
  () => [],
);
export const businessRepositories = [
  customers,
  products,
  policies,
  inquiries,
  campaigns,
  genesysScheduleTasks,
  agentCallbacks,
  auditLog,
] as const;

export async function initializeBusinessData(): Promise<void> {
  for (const repository of businessRepositories) await repository.initialize();
  if ((await agentCallbacks.all()).length === 0) {
    const callbackPolicies = (await policies.all()).filter(
      (policy) =>
        policy.callbackDateTime &&
        policy.renewalStatus === "CALLBACK_REQUESTED",
    );
    if (callbackPolicies.length)
      await agentCallbacks.replaceAll(
        callbackPolicies.map((policy, index) => {
          const timestamp = new Date().toISOString();
          return {
            callbackId: `CALL${String(index + 1).padStart(5, "0")}`,
            customerId: policy.customerId,
            policyId: policy.policyId,
            scheduledAt: policy.callbackDateTime!,
            status: "SCHEDULED",
            priority: "NORMAL",
            intent: "CALLBACK_REQUEST",
            assignedAgent: "",
            agentName: "",
            notes: "Migrated from the policy renewal callback.",
            outcomeNotes: "",
            completedAt: "",
            createdBy: "system",
            updatedBy: "system",
            createdAt: timestamp,
            updatedAt: timestamp,
          } satisfies AgentCallback;
        }),
      );
  }
  const validIntents = new Set<string>(AGENT_CALLBACK_INTENTS);
  const storedCallbacks = await agentCallbacks.all();
  if (
    storedCallbacks.some(
      (item) =>
        !validIntents.has(item.intent) || typeof item.agentName !== "string",
    )
  )
    await agentCallbacks.mutate((rows) => {
      for (const row of rows) {
        if (!validIntents.has(row.intent)) row.intent = "CALLBACK_REQUEST";
        if (typeof row.agentName !== "string") row.agentName = "";
      }
    });
}

export async function audit(
  action: string,
  actor: string,
  target = "",
  detail: Record<string, unknown> = {},
): Promise<void> {
  await auditLog.mutate((rows) => {
    rows.unshift({
      id: randomUUID(),
      action,
      actor,
      target,
      detail,
      timestamp: new Date().toISOString(),
    });
  });
}

export function nextId<T>(prefix: string, rows: T[], key: keyof T): string {
  const highest = rows.reduce((max, row) => {
    const match = String(row[key] ?? "").match(new RegExp(`^${prefix}(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(5, "0")}`;
}
