import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test(
  "Genesys sync creates once, updates complete contact, and blocks DNC/schema mismatch",
  { timeout: 30000 },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "mfec-genesys-test-"));
    process.env.DATA_DIR = path.join(temp, "data");
    process.env.APP_SECRET = "genesys-test-encryption-secret";
    const realFetch = globalThis.fetch;
    let posts = 0,
      puts = 0,
      recalls = 0,
      clears = 0,
      schemaValid = true,
      remoteContactExists = false;
    let lastPut: Record<string, unknown> = {};
    try {
      const [
        { initializeBusinessData, agentCallbacks, customers, policies },
        { updateCustomer },
        { genesysRegionService },
        { GenesysConfigService },
        { encryptSecret },
        { CONTACT_COLUMNS },
        { bulkSyncPolicies, clearGenesysContactList, recallPolicy, syncPolicy },
      ] = await Promise.all([
        import("../server/domain/store"),
        import("../server/domain/business"),
        import("../server/services/genesys/genesys-region.service"),
        import("../server/services/genesys/genesys-config.service"),
        import("../server/services/genesys/secret.service"),
        import("../server/domain/campaign-contact"),
        import("../server/services/genesys/genesys-sync.service"),
      ]);
      await genesysRegionService.initialize();
      await initializeBusinessData();
      await new GenesysConfigService().updateConfig({
        clientId: "mock-client",
        clientSecretEncrypted: encryptSecret("mock-secret"),
        contactListId: "list-1",
        contactListName: "Demo",
        phoneColumn: "phone",
      });
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (url.endsWith("/oauth/token"))
          return Response.json({
            access_token: "mock-token",
            expires_in: 3600,
          });
        if (url.endsWith("/contactlists/list-1") && method === "GET")
          return Response.json({
            id: "list-1",
            name: "Demo",
            columnNames: schemaValid
              ? [...CONTACT_COLUMNS]
              : CONTACT_COLUMNS.filter((column) => column !== "vehicleType"),
            phoneColumns: [{ columnName: "phone", type: "Cell" }],
          });
        if (url.endsWith("/contactlists/list-1/clear") && method === "POST") {
          clears++;
          remoteContactExists = false;
          return new Response(null, { status: 204 });
        }
        if (
          url.includes(
            "/contactlists/list-1/contacts?priority=true&clearSystemData=true&doNotQueue=false",
          ) &&
          method === "POST"
        ) {
          recalls++;
          const body = JSON.parse(String(init?.body)) as {
            id: string;
            callable: boolean;
          }[];
          assert.equal(body[0]?.id, "contact-1");
          assert.equal(body[0]?.callable, true);
          return Response.json(body);
        }
        if (
          url.endsWith("/contactlists/list-1/contacts") &&
          method === "POST"
        ) {
          posts++;
          remoteContactExists = true;
          return Response.json([{ id: `contact-${posts}` }]);
        }
        if (/\/contacts\/contact-\d+$/.test(url) && method === "GET") {
          if (!remoteContactExists)
            return Response.json({ message: "Not found" }, { status: 404 });
          const id = url.split("/").at(-1);
          return Response.json({
            id,
            contactListId: "list-1",
            callable: true,
            data: { customField: "preserve" },
          });
        }
        if (url.endsWith("/contacts/contact-1") && method === "PUT") {
          puts++;
          lastPut = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ id: "contact-1" });
        }
        throw new Error(`Unexpected mock request: ${method} ${url}`);
      };
      const first = await syncPolicy("POL00001", "test");
      assert.equal(first.status, "SYNCED");
      assert.equal(first.contactId, "contact-1");
      assert.equal(posts, 1);
      const second = await syncPolicy("POL00001", "test");
      assert.equal(second.status, "ALREADY_SYNCED");
      assert.equal(posts, 1);
      const forced = await syncPolicy("POL00001", "test", undefined, {
        force: true,
        verify: true,
      });
      assert.equal(forced.status, "SYNCED");
      assert.equal(forced.verified, true);
      assert.match(forced.message, /Demo/);
      assert.match(forced.message, /contact-1/);
      assert.equal(puts, 1);
      const reimported = await bulkSyncPolicies(
        ["POL00001"],
        "test",
        "CAMP00001",
        true,
      );
      assert.equal(reimported.results[0]?.status, "SYNCED");
      assert.equal(puts, 2);
      const importedCallbacks = (await agentCallbacks.all()).filter(
        (item) =>
          item.customerId === "CUST00001" && item.policyId === "POL00001",
      );
      assert.equal(importedCallbacks.length, 1);
      assert.equal(importedCallbacks[0]?.status, "SCHEDULED");
      const importedCallbackId = importedCallbacks[0]?.callbackId;
      await agentCallbacks.mutate((rows) => {
        const item = rows.find(
          (row) =>
            row.customerId === "CUST00001" && row.policyId === "POL00001",
        );
        assert.ok(item);
        item.status = "COMPLETED";
        item.completedAt = new Date().toISOString();
      });
      const repeatedImport = await bulkSyncPolicies(
        ["POL00001"],
        "test",
        "CAMP00001",
      );
      assert.equal(repeatedImport.results[0]?.status, "ALREADY_SYNCED");
      assert.equal(puts, 2);
      const repeatedCallbacks = (await agentCallbacks.all()).filter(
        (item) =>
          item.customerId === "CUST00001" && item.policyId === "POL00001",
      );
      assert.equal(repeatedCallbacks.length, 1);
      assert.equal(repeatedCallbacks[0]?.callbackId, importedCallbackId);
      assert.equal(repeatedCallbacks[0]?.status, "SCHEDULED");
      assert.equal(repeatedCallbacks[0]?.completedAt, "");
      const recalled = await recallPolicy("POL00001", "test");
      assert.equal(recalled.status, "RECALLED");
      assert.equal(recalled.verified, true);
      assert.match(recalled.message, /queued for recall/);
      assert.equal(recalls, 1);
      await updateCustomer("CUST00001", { firstName: "สมศักดิ์" }, "test");
      assert.equal(
        (await policies.findById("policyId", "POL00001"))?.genesys.syncStatus,
        "OUTDATED",
      );
      const third = await syncPolicy("POL00001", "test");
      assert.equal(third.status, "SYNCED");
      assert.equal(puts, 3);
      assert.equal(posts, 1);
      assert.equal(
        (lastPut.data as Record<string, string>).customField,
        "preserve",
      );
      assert.equal(
        (lastPut.data as Record<string, string>).firstName,
        "สมศักดิ์",
      );
      remoteContactExists = false;
      const recreated = await syncPolicy("POL00001", "test", undefined, {
        force: true,
        verify: true,
      });
      assert.equal(recreated.status, "SYNCED");
      assert.equal(recreated.contactId, "contact-2");
      assert.equal(recreated.verified, true);
      assert.equal(posts, 2);
      const cleared = await clearGenesysContactList("list-1", "test");
      assert.equal(cleared.contactListName, "Demo");
      assert.ok(cleared.resetPolicies >= 1);
      assert.equal(clears, 1);
      assert.deepEqual(
        (await policies.findById("policyId", "POL00001"))?.genesys,
        {
          contactListId: "",
          contactId: "",
          syncStatus: "NOT_SYNCED",
          lastSyncAt: "",
          lastSyncError: null,
          lastPayloadHash: "",
          lastSyncedBy: "",
        },
      );
      await updateCustomer("CUST00001", { dnc: true }, "test");
      assert.equal(
        (await syncPolicy("POL00001", "test")).status,
        "SKIPPED_DNC",
      );
      await assert.rejects(
        () => recallPolicy("POL00001", "test"),
        /DNC customers cannot be recalled/,
      );
      await assert.rejects(
        () => recallPolicy("POL00002", "test"),
        /Push this policy to Genesys before using Recall/,
      );
      assert.equal(recalls, 1);
      assert.equal(posts, 2);
      assert.equal(puts, 3);
      schemaValid = false;
      const mismatch = await syncPolicy("POL00002", "test");
      assert.equal(mismatch.status, "SCHEMA_MISMATCH");
      assert.equal(posts, 2);
      assert.equal(puts, 3);
      assert.equal(
        (await customers.findById("customerId", "CUST00001"))?.dnc,
        true,
      );
    } finally {
      globalThis.fetch = realFetch;
      await rm(temp, { recursive: true, force: true });
    }
  },
);
