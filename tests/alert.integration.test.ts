import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

test("Alert ingestion, isolated capture, enrichment, dedupe and approved Genesys sync", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfec-alert-"));
  const previous = {
    data: process.env.DATA_DIR,
    backups: process.env.BACKUPS_DIR,
    secret: process.env.APP_SECRET,
    fetch: globalThis.fetch,
  };
  process.env.DATA_DIR = path.join(root, "data");
  process.env.BACKUPS_DIR = path.join(root, "backups");
  process.env.APP_SECRET = "alert-integration-test-secret";
  const listId = "a1111111-1111-4111-8111-111111111111";
  const contactListFields = ["customer_id", "name", "phone"];
  const contacts = new Map<string, Record<string, string>>();
  let posts = 0;
  let failNextPost = false;
  try {
    const [auditStore, alertStore, pipelineStore, regions, configModule, secretModule, contactService, rules, enrichment, mapping, processing, snmp, ruleService, business] = await Promise.all([
      import("../server/domain/store"),
      import("../server/domain/alert-store"),
      import("../server/domain/pipeline-store"),
      import("../server/services/genesys/genesys-region.service"),
      import("../server/services/genesys/genesys-config.service"),
      import("../server/services/genesys/secret.service"),
      import("../server/services/contact-list.service"),
      import("../server/services/alert-rules.service"),
      import("../server/services/alert-enrichment.service"),
      import("../server/services/alert-mapping.service"),
      import("../server/services/alert-processing.service"),
      import("../server/services/snmp-listener.service"),
      import("../server/services/alert-rules.service"),
      import("../server/domain/business"),
    ]);
    await auditStore.initializeAudit();
    await alertStore.initializeAlertStore();
    await pipelineStore.initializePipeline();
    await regions.genesysRegionService.initialize();
    await new configModule.GenesysConfigService().updateConfig({
      enabled: true,
      clientId: "alert-test-client",
      clientSecretEncrypted: secretModule.encryptSecret("alert-test-secret"),
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "alert-test-access", expires_in: 3600 });
      if (url.includes("/outbound/contactlists?pageSize=100")) return Response.json({ entities: [{ id: listId, name: "Alert Contacts" }], pageCount: 1 });
      if (url.endsWith(`/contactlists/${listId}`)) return Response.json({ id: listId, name: "Alert Contacts", columnNames: contactListFields, phoneColumns: [{ columnName: "phone" }] });
      if (url.endsWith(`/contactlists/${listId}/contacts`) && method === "POST") {
        posts++;
        const body = JSON.parse(String(init?.body)) as { data: Record<string, string> }[];
        if (failNextPost) {
          failNextPost = false;
          throw new TypeError("Simulated lost Genesys POST response");
        }
        const id = `alert-contact-${posts}`;
        contacts.set(id, body[0].data);
        return Response.json([{ id, data: body[0].data }]);
      }
      const contactId = url.split("/").at(-1) || "";
      if (url.includes(`/contactlists/${listId}/contacts/${contactId}`) && contacts.has(contactId)) return Response.json({ id: contactId, data: contacts.get(contactId) });
      if (url.includes(`/contactlists/${listId}/contacts?`)) return Response.json({ entities: [...contacts.entries()].map(([id, data]) => ({ id, data })), pageCount: 1, total: contacts.size });
      return Response.json({ message: `Unexpected mock Genesys request: ${method} ${url}` }, { status: 500 });
    };

    const lists = await contactService.refreshContactLists();
    assert.equal(lists[0]?.contactListId, listId);
    const config = await rules.saveAlertConfiguration({
      name: "Router alerts",
      description: "integration test",
      type: "API",
      enabled: true,
      priority: 10,
      defaultSubject: "Router {{customerId}}",
      match: { match: "ALL", conditions: [{ field: "eventType", operator: "EQ", value: "router-down" }] },
      fields: [
        { name: "customerId", source: "customerId", type: "STRING", required: true, defaultValue: "", description: "" },
        { name: "phone", source: "phone", type: "PHONE", required: true, defaultValue: "", description: "" },
        { name: "contactEmail", source: "email", type: "STRING", required: false, defaultValue: "", description: "", sensitive: true },
      ],
      duplicateField: "customerId",
      duplicateWindowSeconds: 3600,
      allowedSources: [],
      api: { auth: "BEARER", token: "test-ingest-token", maxBodyBytes: 1048576 },
    }, "test");
    const sampleConfig = { ...config, fields: [{ name: "device", source: "oid:1.3.6.1.4.1.9.1", type: "STRING" as const, required: false, defaultValue: "", description: "", extract: { mode: "REGEX" as const, expression: "Device\\s+([\\w-]+)", after: "", group: 1 } }] };
    assert.equal(ruleService.createAlertFields(sampleConfig as unknown as import("../server/domain/alert-types").AlertConfiguration, { "oid:1.3.6.1.4.1.9.1": "Device router-7 is down" }).device, "router-7");
    const arrayConfig = { ...config, fields: [{ name: "serial", source: "items.0.serial", type: "STRING" as const, required: false, defaultValue: "", description: "" }] };
    assert.equal(ruleService.createAlertFields(arrayConfig as unknown as import("../server/domain/alert-types").AlertConfiguration, { items: [{ serial: "serial-42" }] }).serial, "serial-42");

    const first = await rules.acceptAlert({
      transport: "API", sourceIp: "127.0.0.1", sourcePort: 43000,
      configId: config.id,
      raw: { eventType: "router-down", customerId: "customer-17", phone: "0812345678", email: "private@example.test" },
      fields: { eventType: "router-down", customerId: "customer-17", phone: "0812345678", email: "private@example.test" },
    });
    assert.equal(first.matched, true);
    const duplicate = await rules.acceptAlert({
      transport: "API", sourceIp: "127.0.0.1", sourcePort: 43000,
      configId: config.id,
      raw: { eventType: "router-down", customerId: "customer-17", phone: "0812345678", email: "private@example.test" },
      fields: { eventType: "router-down", customerId: "customer-17", phone: "0812345678", email: "private@example.test" },
    });
    assert.equal("duplicate" in duplicate && duplicate.duplicate, true);

    const testSessionId = randomUUID();
    await alertStore.alertTestSessions.mutate((sessions) => sessions.push({
      id: testSessionId, alertConfigId: config.id, transport: "API", tokenHash: "test-token-hash",
      sourceIp: "127.0.0.1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), capture: null,
    }));
    await rules.acceptAlert({
      transport: "API", sourceIp: "127.0.0.1", sourcePort: 43000, configId: config.id, testSessionId,
      raw: { eventType: "router-down", customerId: "preview-only", phone: "0812345678", email: "private@example.test" },
      fields: { eventType: "router-down", customerId: "preview-only", phone: "0812345678", email: "private@example.test" },
    });
    const capture = (await alertStore.alertTestSessions.findById("id", testSessionId))?.capture;
    assert.ok(capture);
    assert.notEqual(JSON.stringify(capture), "");
    assert.ok(!JSON.stringify(capture).includes("private@example.test"), "isolated sample should persist only redacted sensitive values");
    assert.equal((await alertStore.receivedAlerts.all()).filter((item) => item.configId === config.id).length, 2, "test sessions must not create inbox alerts");

    const upload = await enrichment.uploadAlertDatasource({
      fileName: "customers.csv",
      content: Buffer.from("CustomerID,FullName\ncustomer-17,Ada Example\ncustomer-18,Grace Example\n", "utf8").toString("base64"),
    });
    const datasource = await enrichment.saveAlertDatasource({
      name: "Customer lookup", kind: "FILE", enabled: true, fileName: upload.fileName,
      fileId: upload.fileId, storedFile: upload.storedFile, worksheet: "", sourceId: "00000000-0000-4000-8000-000000000000",
      query: "", keyColumn: "CustomerID", description: "",
    }, "test");
    const rule = await enrichment.saveEnrichmentRule({
      name: "Customer name lookup", description: "", enabled: true, priority: 10,
      alertConfigId: config.id, datasourceId: datasource.id,
      lookup: [{ alertField: "customerId", column: "CustomerID" }],
      outputs: [{ name: "customerName", kind: "COLUMN", columns: ["FullName"], value: "", required: true, defaultValue: "", overwrite: true }],
      notFound: "FAIL", onError: "FAIL",
    }, "test");
    assert.equal(rule.enabled, true);

    const alertMapping = await mapping.saveAlertMapping({
      name: "Router to Genesys", description: "", enabled: true, priority: 10,
      alertConfigId: config.id, contactListId: listId,
      fields: [
        { target: "customer_id", sourceType: "ALERT", source: "customerId", value: "", required: true },
        { target: "name", sourceType: "ENRICHMENT", source: "customerName", value: "", required: true },
        { target: "phone", sourceType: "ALERT", source: "phone", value: "", required: true },
      ],
      phoneField: "phone", uniqueField: "customer_id", duplicateWindowSeconds: 3600,
      duplicateBehavior: "SKIP", autoImport: false,
    }, "test");
    assert.equal(alertMapping.autoImport, false);
    await processing.tickAlertWorker();
    const received = (await alertStore.receivedAlerts.findById("id", first.id as string))!;
    assert.equal(received.processingStatus, "READY_FOR_SYNC");
    assert.equal(received.enrichedFields.customerName, "Ada Example");
    const preview = await mapping.previewAlertMapping(received.id, alertMapping.id);
    assert.equal(preview.readyForSync, true);
    assert.equal((await mapping.syncAlert(received.id, alertMapping.id, "test-approver", "MANUAL")).status, "SYNCED");
    assert.equal(posts, 1);
    assert.equal(contacts.get("alert-contact-1")?.name, "Ada Example");

    const second = await rules.acceptAlert({
      transport: "API", sourceIp: "127.0.0.1", sourcePort: 43000, configId: config.id,
      raw: { eventType: "router-down", customerId: "customer-18", phone: "0812345679", email: "other-private@example.test" },
      fields: { eventType: "router-down", customerId: "customer-18", phone: "0812345679", email: "other-private@example.test" },
    });
    await processing.tickAlertWorker();
    const secondAlert = (await alertStore.receivedAlerts.findById("id", second.id as string))!;
    assert.equal(secondAlert.processingStatus, "READY_FOR_SYNC");
    failNextPost = true;
    await assert.rejects(mapping.syncAlert(secondAlert.id, alertMapping.id, "test-approver", "MANUAL"));
    assert.equal((await alertStore.receivedAlerts.findById("id", secondAlert.id))?.syncStatus, "UNKNOWN");
    await assert.rejects(mapping.retryAlertSync(secondAlert.id, "test-approver"), /outcome is unknown/i);
    await mapping.reconcileAlertSync(secondAlert.id, "NOT_FOUND", "", "test-approver");
    assert.equal((await alertStore.receivedAlerts.findById("id", secondAlert.id))?.syncStatus, "AWAITING_MANUAL");
    assert.equal((await mapping.retryAlertSync(secondAlert.id, "test-approver")).status, "SYNCED");
    assert.equal(posts, 3, "ambiguous POST is never repeated until a Genesys reconciliation permits manual retry");
    const attempts = (await alertStore.alertSyncHistory.all()).filter((item) => item.alertId === secondAlert.id).map((item) => item.attempt);
    assert.deepEqual(attempts, [1, 2]);

    contacts.set("existing-genesys-contact", { customer_id: "customer-99", name: "Existing contact", phone: "+66812345699" });
    const third = await rules.acceptAlert({
      transport: "API", sourceIp: "127.0.0.1", sourcePort: 43000, configId: config.id,
      raw: { eventType: "router-down", customerId: "customer-99", phone: "0812345699", email: "third-private@example.test" },
      fields: { eventType: "router-down", customerId: "customer-99", phone: "0812345699", email: "third-private@example.test" },
    });
    const thirdAlert = {
      ...(await alertStore.receivedAlerts.findById("id", third.id as string))!,
      processingStatus: "READY_FOR_SYNC" as const,
      syncStatus: "AWAITING_MANUAL" as const,
      mappingId: alertMapping.id,
      mappingName: alertMapping.name,
      originalFields: { customerId: "customer-99", phone: "+66812345699" },
      enrichedFields: { customerId: "customer-99", customerName: "Existing contact", phone: "+66812345699" },
      mappedContact: {},
    };
    await alertStore.receivedAlerts.mutate((rows) => {
      const current = rows.find((item) => item.id === thirdAlert.id)!;
      Object.assign(current, thirdAlert);
    });
    await assert.rejects(mapping.syncAlert(thirdAlert.id, alertMapping.id, "test-approver", "MANUAL"), /Genesys Contact already uses/i);
    assert.equal(posts, 3, "an existing Genesys Contact is detected before creating another Contact");

    const backup = await business.createBackup();
    await business.writeBackupManifest(backup.directory, backup.files);
    const exported = await business.downloadBackup(backup.directory) as Record<string, unknown>;
    assert.ok(Array.isArray(exported["received-alerts.json"]));
    assert.ok(!JSON.stringify(exported["received-alerts.json"]).includes("private@example.test"));
    assert.ok(!JSON.stringify(exported["received-alerts.json"]).includes("other-private@example.test"));
    assert.ok(!JSON.stringify(exported["alert-configurations.json"]).includes("test-ingest-token"));
    assert.equal(((exported["alert-configurations.json"] as Record<string, unknown>[])[0]).enabled, false);
    assert.equal(((exported["alert-mappings.json"] as Record<string, unknown>[])[0]).autoImport, false);
    assert.ok(Object.keys(exported).some((key) => key.startsWith("alert-datasources/")), "backup should include referenced enrichment files");
    await business.restoreConfigurationBackup({ confirmation: "RESTORE", files: exported }, "test-restorer");
    assert.equal((await alertStore.alertConfigurations.findById("id", config.id))?.enabled, false, "restored Alert configurations must remain disabled");
    assert.equal((await alertStore.alertMappings.findById("id", alertMapping.id))?.autoImport, false, "restored Auto Import must remain disabled");
    assert.ok((await alertStore.alertDatasources.findById("id", datasource.id))?.enabled === false, "restored enrichment datasources must remain disabled");
    assert.equal((await alertStore.alertTestSessions.all()).length, 0, "test bearer sessions must not survive restore");
    assert.equal((await alertStore.receivedAlerts.findById("id", first.id as string))?.syncAttempts, 1, "restore should retain independent Contact attempt accounting");

    await t.test("SNMP credential/version rules distinguish v1, v2c and v3", async () => {
      const configuration = {
        id: "singleton" as const, enabled: true, bindAddress: "127.0.0.1", port: 1162,
        allowedSources: [], maxMessageBytes: 65507, logLevel: "ERROR" as const,
        versions: ["v1", "v2c", "v3"] as ("v1" | "v2c" | "v3")[], updatedAt: "",
        communities: [{ name: "public-v1", secretEncrypted: secretModule.encryptSecret("v1-secret"), versions: ["v1"] as ("v1" | "v2c")[] }, { name: "private-v2", secretEncrypted: secretModule.encryptSecret("v2-secret"), versions: ["v2c"] as ("v1" | "v2c")[] }],
        users: [{ username: "alert-user", level: "authPriv" as const, authProtocol: "sha256" as const, authKeyEncrypted: secretModule.encryptSecret("auth-secret"), privProtocol: "aes" as const, privKeyEncrypted: secretModule.encryptSecret("privacy-secret") }],
      };
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 164, community: "v1-secret" }), true);
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 164, community: "v2-secret" }), false);
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 167, community: "v2-secret" }), true);
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 167, community: "v1-secret" }), false);
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 167, user: "alert-user" }), true);
      assert.equal(snmp.trapCredentialsAllowed(configuration, { type: 167, user: "unknown-user" }), false);
    });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.data === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous.data;
    if (previous.backups === undefined) delete process.env.BACKUPS_DIR; else process.env.BACKUPS_DIR = previous.backups;
    if (previous.secret === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = previous.secret;
    await rm(root, { recursive: true, force: true });
  }
});
