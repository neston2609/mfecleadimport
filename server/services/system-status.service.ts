import {
  importJobs,
  sourceIntegrations,
  sourceMappings,
  leadDefinitions,
  sourceObservations,
} from "../domain/pipeline-store";
import { GenesysConfigService } from "./genesys/genesys-config.service";
import { genesysApiClient } from "./genesys/genesys-api.client";
import { loadSource } from "./source-data.service";
import { httpError } from "../domain/business";
let refreshing = false;
export async function systemStatus(refresh = false) {
  if (refreshing && refresh)
    throw httpError(409, "A status refresh is already running. Please wait.");
  const configService = new GenesysConfigService();
  let config = await configService.getConfig();
  const sources = await sourceIntegrations.all();
  if (refresh) {
    refreshing = true;
    try {
      if (config.enabled && config.clientId && config.clientSecretEncrypted) {
        try {
          await genesysApiClient.get(
            "/api/v2/outbound/contactlists?pageSize=1",
          );
          await configService.markConnection("SUCCESS");
        } catch {
          await configService.markConnection("FAILED");
        }
      }
      for (const source of sources) {
        try {
          await loadSource(source);
        } catch {
          /* Actual failures are recorded by the source adapter. */
        }
      }
    } finally {
      refreshing = false;
    }
    config = await configService.getConfig();
  }
  const [observations, jobs, mappings, leads] = await Promise.all([
    sourceObservations.all(),
    importJobs.all(),
    sourceMappings.all(),
    leadDefinitions.all(),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    integration: {
      status:
        !config.enabled || !config.clientId || !config.clientSecretEncrypted
          ? "DISCONNECTED"
          : config.lastConnectionStatus === "SUCCESS"
            ? "CONNECTED"
            : config.lastConnectionStatus === "FAILED"
              ? "ERROR"
              : "DISCONNECTED",
      checkedAt: config.lastConnectionAt || null,
      message:
        config.lastConnectionStatus === "FAILED"
          ? "Genesys connection failed. Use Test Connection in Integration Setting."
          : config.lastConnectionStatus === "SUCCESS"
            ? "Last connection check succeeded"
            : "Connection has not been verified",
    },
    sources: sources.map((source) => {
      const observation = observations.find((item) => item.id === source.id);
      const sourceJobs = jobs
        .filter(
          (job) =>
            job.sourceId === source.id ||
            (!job.sourceId &&
              mappings.some(
                (mapping) =>
                  mapping.sourceId === source.id &&
                  leads.some(
                    (lead) =>
                      lead.mappingId === mapping.id && lead.id === job.leadId,
                  ),
              )),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const job = sourceJobs[0];
      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        status: observation?.status || "INACTIVE",
        checkedAt: observation?.checkedAt || null,
        message:
          observation?.message ||
          "Not checked yet. Refresh status to verify the connection.",
        lastSyncStatus: job
          ? job.status === "RUNNING"
            ? "IN_PROGRESS"
            : job.status === "SUCCESS"
              ? "SUCCESS"
              : "FAILED"
          : null,
        lastSyncTime: job ? job.finishedAt || job.createdAt : null,
        lastSyncMessage: job?.message || "No sync has run for this source",
      };
    }),
  };
}
