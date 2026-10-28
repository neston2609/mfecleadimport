import { randomUUID } from "node:crypto";
import { JsonRepository } from "./json-repository";
const auditLog = new JsonRepository<{
  id: string;
  action: string;
  actor: string;
  target: string;
  detail: Record<string, unknown>;
  timestamp: string;
}>("audit-log.json", () => []);
export async function initializeAudit() {
  await auditLog.initialize();
}
export async function audit(
  action: string,
  actor: string,
  target = "",
  detail: Record<string, unknown> = {},
) {
  await auditLog.mutate((rows) => {
    rows.unshift({
      id: randomUUID(),
      action,
      actor,
      target,
      detail,
      timestamp: new Date().toISOString(),
    });
    if (rows.length > 5000) rows.splice(5000);
  });
}
