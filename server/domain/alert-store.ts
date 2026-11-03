import { JsonRepository, dataDir } from "./json-repository";
import type {
  AlertConfiguration,
  AlertDatasource,
  AlertEnrichmentRule,
  AlertMapping,
  AlertSyncHistory,
  AlertTestSession,
  ReceivedAlert,
  SnmpListenerConfiguration,
} from "./alert-types";

export const alertConfigurations = new JsonRepository<AlertConfiguration>(
  "alert-configurations.json",
  () => [],
);
export const alertDatasources = new JsonRepository<AlertDatasource>(
  "alert-datasources.json",
  () => [],
);
export const alertEnrichmentRules = new JsonRepository<AlertEnrichmentRule>(
  "alert-enrichment-rules.json",
  () => [],
);
export const alertMappings = new JsonRepository<AlertMapping>(
  "alert-mappings.json",
  () => [],
);
export const receivedAlerts = new JsonRepository<ReceivedAlert>(
  "received-alerts.json",
  () => [],
);
export const alertSyncHistory = new JsonRepository<AlertSyncHistory>(
  "alert-sync-history.json",
  () => [],
);
export const alertTestSessions = new JsonRepository<AlertTestSession>(
  "alert-test-sessions.json",
  () => [],
);
export const snmpListenerConfiguration = new JsonRepository<SnmpListenerConfiguration>(
  "snmp-listener-configuration.json",
  () => [{
    id: "singleton",
    enabled: false,
    bindAddress: "0.0.0.0",
    port: 162,
    allowedSources: [],
    maxMessageBytes: 65507,
    logLevel: "INFO",
    versions: [],
    communities: [],
    users: [],
    updatedAt: "",
  }],
);

export const alertRepositories = [
  alertConfigurations,
  alertDatasources,
  alertEnrichmentRules,
  alertMappings,
  receivedAlerts,
  alertSyncHistory,
  alertTestSessions,
  snmpListenerConfiguration,
] as const;

export async function initializeAlertStore() {
  for (const repository of alertRepositories) await repository.initialize();
}

export const alertUploadDir = `${dataDir}/alert-datasources`;
