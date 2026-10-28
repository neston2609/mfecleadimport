import { JsonRepository } from "./json-repository";
import { ImportStateRepository } from "./import-state-repository";
import type {
  ContactTemplate,
  SourceIntegration,
  SourceMapping,
  LeadDefinition,
  ImportSchedule,
  ImportState,
  ImportJob,
} from "./pipeline-types";

export const contactTemplates = new JsonRepository<ContactTemplate>(
  "contact-templates.json",
  () => [],
);
export const sourceIntegrations = new JsonRepository<SourceIntegration>(
  "source-integrations.json",
  () => [],
);
export const sourceMappings = new JsonRepository<SourceMapping>(
  "source-mappings.json",
  () => [],
);
export const leadDefinitions = new JsonRepository<LeadDefinition>(
  "lead-definitions.json",
  () => [],
);
export const importSchedules = new JsonRepository<ImportSchedule>(
  "lead-import-schedules.json",
  () => [],
);
export const importStates = new ImportStateRepository();
export const importJobs = new JsonRepository<ImportJob>(
  "lead-import-jobs.json",
  () => [],
);
export const pipelineRepositories = [
  contactTemplates,
  sourceIntegrations,
  sourceMappings,
  leadDefinitions,
  importSchedules,
  importStates,
  importJobs,
] as const;

export async function initializePipeline() {
  for (const repository of pipelineRepositories) await repository.initialize();
  await importStates.mutate((rows) => {
    for (const row of rows)
      if (row.status === "PENDING") {
        row.status = "UNKNOWN";
        row.message =
          "Interrupted request. Reconcile this contact in Genesys before retrying.";
      }
  });
  await importJobs.mutate((rows) => {
    for (const row of rows)
      if (row.status === "RUNNING") {
        row.status = "INTERRUPTED";
        row.message = "Interrupted by server restart";
        row.finishedAt = new Date().toISOString();
      }
  });
}
