import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  access,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";

test(
  "pipeline reads sources, configures Genesys Contact Lists, maps and filters leads, imports idempotently and preserves secrets",
  { timeout: 60000 },
  async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "mfec-pipeline-"));
    process.env.DATA_DIR = path.join(folder, "data");
    process.env.BACKUPS_DIR = path.join(folder, "backups");
    process.env.SOURCE_FILE_ROOTS = path.join(folder, "source-inputs");
    process.env.APP_SECRET = "pipeline-test-secret";
    process.env.SOURCE_ALLOWED_HOSTS = "127.0.0.1";
    process.env.JDBC_TEST_H2 = "true";
    const listId = "11111111-1111-4111-8111-111111111111";
    const alternateListId = "22222222-2222-4222-8222-222222222222";
    const incompatibleListId = "33333333-3333-4333-8333-333333333333";
    const columns = ["customer_id", "name", "phone", "premium", "expiry"];
    const date = (days: number) =>
      new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    let sourceRows = [
      {
        id: "a",
        fullName: "Alice",
        mobile: "0812345678",
        amount: 500,
        expires: date(15),
      },
      {
        id: "b",
        fullName: "Bob",
        mobile: "0822345678",
        amount: 1500,
        expires: date(40),
      },
      {
        id: "c",
        fullName: "Carol",
        mobile: "0832345678",
        amount: 50,
        expires: date(15),
      },
      {
        id: "d",
        fullName: "DNC",
        mobile: "0842345678",
        amount: 500,
        expires: date(15),
        dnc: true,
      },
    ];
    let observedAuthorization = "",
      failSource = false;
    const sourceServer = createServer((request, response) => {
      if (failSource) {
        response.writeHead(503);
        response.end("Unavailable");
        return;
      }
      observedAuthorization = request.headers.authorization || "";
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ records: sourceRows }));
    });
    sourceServer.listen(0, "127.0.0.1");
    await once(sourceServer, "listening");
    const sourcePort = (sourceServer.address() as { port: number }).port;
    const realFetch = globalThis.fetch;
    const remote = new Map<
      string,
      { id: string; data: Record<string, string>; extra: string }
    >();
    let posts = 0,
      puts = 0,
      loseNextPost = false;
    try {
      const [
        { initializeAudit },
        {
          initializePipeline,
          contactListConfigurations,
          sourceIntegrations,
          leadDefinitions,
          importSchedules,
          importJobs,
          importStates,
        },
        { genesysRegionService },
        { GenesysConfigService },
        { encryptSecret },
        pipeline,
        imports,
        schedules,
        sources,
        business,
      ] = await Promise.all([
        import("../server/domain/store"),
        import("../server/domain/pipeline-store"),
        import("../server/services/genesys/genesys-region.service"),
        import("../server/services/genesys/genesys-config.service"),
        import("../server/services/genesys/secret.service"),
        import("../server/services/lead-pipeline.service"),
        import("../server/services/lead-import.service"),
        import("../server/services/lead-schedule.service"),
        import("../server/services/source-data.service"),
        import("../server/domain/business"),
      ]);
      await initializeAudit();
      await initializePipeline();
      await genesysRegionService.initialize();
      await new GenesysConfigService().updateConfig({
        enabled: true,
        clientId: "mock",
        clientSecretEncrypted: encryptSecret("mock-gene-secret"),
        contactListId: listId,
      });
      globalThis.fetch = async (input, init) => {
        const url = String(input),
          method = init?.method || "GET";
        if (url.endsWith("/oauth/token"))
          return Response.json({
            access_token: "mock-access-token",
            expires_in: 3600,
          });
        if (url.includes("/outbound/contactlists?page"))
          return Response.json({
            entities: [
              { id: listId, name: "Custom contacts" },
              { id: alternateListId, name: "Alternate contacts" },
              { id: incompatibleListId, name: "Different columns" },
            ],
            pageCount: 1,
          });
        if (url.endsWith(`/contactlists/${listId}`))
          return Response.json({
            id: listId,
            name: "Custom contacts",
            columnNames: columns,
            phoneColumns: [{ columnName: "phone" }],
          });
        if (url.endsWith(`/contactlists/${alternateListId}`))
          return Response.json({
            id: alternateListId,
            name: "Alternate contacts",
            columnNames: columns,
            phoneColumns: [{ columnName: "phone" }],
          });
        if (url.endsWith(`/contactlists/${incompatibleListId}`))
          return Response.json({
            id: incompatibleListId,
            name: "Different columns",
            columnNames: columns.slice(0, -1),
            phoneColumns: [{ columnName: "phone" }],
          });
        if (
          url.endsWith(`/contactlists/${listId}/clear`) &&
          method === "POST"
        ) {
          remote.clear();
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/contacts") && method === "POST") {
          posts++;
          const body = JSON.parse(String(init?.body)) as {
            data: Record<string, string>;
          }[];
          const contact = {
            id: "remote-" + posts,
            data: body[0].data,
            extra: "preserve-me",
          };
          remote.set(contact.id, contact);
          if (loseNextPost) {
            loseNextPost = false;
            throw new TypeError("Simulated ambiguous network response");
          }
          return Response.json([contact]);
        }
        const contactId = url.split("/").at(-1)!;
        if (remote.has(contactId) && method === "GET")
          return Response.json(remote.get(contactId));
        if (method === "GET")
          return Response.json(
            { message: `A Contact with id ${contactId} could not be found` },
            { status: 404 },
          );
        if (remote.has(contactId) && method === "PUT") {
          puts++;
          const body = JSON.parse(String(init?.body));
          assert.equal(body.extra, "preserve-me");
          remote.set(contactId, body);
          return Response.json(body);
        }
        throw new Error(
          "Unexpected mock Genesys request: " + method + " " + url,
        );
      };
      const contactLists =
        await import("../server/services/contact-list.service");
      await t.test(
        "Genesys IDs are auto-configured and UUID edits require explicit confirmation",
        async () => {
          const rows = await contactLists.refreshContactLists();
          assert.equal(rows[0].uuid, listId);
          await assert.rejects(
            contactLists.saveContactListUuid(
              listId,
              { uuid: listId, expectedUuid: listId },
              "test",
            ),
          );
          await assert.rejects(
            contactLists.saveContactListUuid(
              listId,
              {
                uuid: "22222222-2222-4222-8222-222222222222",
                expectedUuid: listId,
                confirmation: true,
              },
              "test",
            ),
            /must match/,
          );
          await assert.rejects(
            contactLists.saveContactListUuid(
              listId,
              { uuid: listId, expectedUuid: "stale", confirmation: true },
              "test",
            ),
            /changed since/,
          );
          await contactLists.saveContactListUuid(
            listId,
            { uuid: listId, expectedUuid: listId, confirmation: true },
            "test",
          );
          await contactLists.refreshContactLists();
          assert.equal(
            (await contactListConfigurations.all())[0].uuidSource,
            "MANUAL",
          );
        },
      );
      const source = await pipeline.saveSource(
        {
          name: "Customer API",
          kind: "WEB",
          config: {
            uri: `http://127.0.0.1:${sourcePort}/customers`,
            auth: "BEARER",
            resultPath: "records",
          },
          secret: "private-source-token",
        },
        "test",
      );
      assert.equal(observedAuthorization, "Bearer private-source-token");
      assert.equal(source.secretConfigured, true);
      assert.ok(
        !JSON.stringify(await pipeline.bootstrapPipeline()).includes(
          "private-source-token",
        ),
      );
      assert.equal(
        (source as unknown as { secretEncrypted?: string }).secretEncrypted,
        undefined,
      );
      assert.ok((await sourceIntegrations.all())[0].secretEncrypted);
      const mapping = await pipeline.saveMapping(
        {
          name: "Customer mapping",
          sourceId: source.id,
          contactListId: listId,
          keyField: "id",
          fields: columns.map((targetField, index) => ({
            targetField,
            sourceField: ["id", "fullName", "mobile", "amount", "expires"][
              index
            ],
            defaultValue: "",
            type:
              targetField === "premium"
                ? "NUMBER"
                : targetField === "expiry"
                  ? "DATE"
                  : targetField === "phone"
                    ? "PHONE"
                    : "STRING",
          })),
        },
        "test",
      );
      const lead = await pipeline.saveLead(
        {
          name: "Upcoming high value leads",
          mappingId: mapping.id,
          match: "ALL",
          filters: [
            { scope: "TARGET", field: "premium", operator: "GT", value: "100" },
            {
              scope: "TARGET",
              field: "expiry",
              operator: "DATE_GT_DAYS",
              value: "0",
            },
            {
              scope: "TARGET",
              field: "expiry",
              operator: "DATE_LT_DAYS",
              value: "30",
            },
          ],
        },
        "test",
      );
      await t.test(
        "filtering, DNC exclusion and normalized phone values",
        async () => {
          const preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.summary.matched, 2);
          assert.equal(preview.summary.eligible, 1);
          assert.equal(
            preview.rows.find((row) => row.sourceKey === "d")?.status,
            "DNC",
          );
          assert.equal(preview.rows[0].data.phone, "+66812345678");
        },
      );
      await t.test(
        "manual import creates once, skips unchanged contacts, and updates complete remote records",
        async () => {
          let preview = await pipeline.resolveLead(lead.id, listId);
          let job = await imports.startImport(
            {
              leadId: lead.id,
              contactListId: listId,
              revision: preview.revision,
            },
            "test",
          );
          job = await imports.awaitImport(job.id);
          assert.equal(job.status, "SUCCESS");
          assert.equal(job.created, 1);
          assert.equal(posts, 1);
          preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.summary.synced, 1);
          job = await imports.awaitImport(
            (
              await imports.startImport(
                { leadId: lead.id, contactListId: listId },
                "test",
              )
            ).id,
          );
          assert.equal(job.total, 0);
          assert.equal(posts, 1);
          sourceRows = sourceRows.map((row) =>
            row.id === "a" ? { ...row, amount: 700 } : row,
          );
          const changed = await pipeline.resolveLead(lead.id, listId);
          assert.equal(changed.rows[0].status, "UPDATE_AVAILABLE");
          await assert.rejects(
            imports.startImport(
              {
                leadId: lead.id,
                contactListId: listId,
                revision: preview.revision,
              },
              "test",
            ),
            /changed/,
          );
          job = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: listId,
                  revision: changed.revision,
                },
                "test",
              )
            ).id,
          );
          assert.equal(job.updated, 1);
          assert.equal(puts, 1);
          assert.equal(posts, 1);
          assert.equal(remote.get("remote-1")?.data.premium, "700");

          preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.rows[0].status, "ALREADY_SYNCED");
          job = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: listId,
                  recordIds: [preview.rows[0].id],
                  revision: preview.revision,
                  reimport: true,
                },
                "test",
              )
            ).id,
          );
          assert.equal(job.status, "SUCCESS");
          assert.equal(job.reimport, true);
          assert.equal(job.updated, 1);
          assert.equal(job.created, 0);
          assert.equal(puts, 2);
          assert.equal(posts, 1, "re-import updates rather than duplicates");

          remote.delete("remote-1");
          preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.rows[0].status, "ALREADY_SYNCED");
          job = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: listId,
                  recordIds: [preview.rows[0].id],
                  revision: preview.revision,
                  reimport: true,
                },
                "test",
              )
            ).id,
          );
          assert.equal(job.status, "SUCCESS");
          assert.equal(job.created, 1);
          assert.equal(job.updated, 0);
          assert.equal(posts, 2);
          assert.equal(remote.has("remote-2"), true);
          preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.rows[0].status, "ALREADY_SYNCED");
          assert.equal(preview.rows[0].contactId, "remote-2");
        },
      );
      await t.test(
        "file imports validate columns and IDs, then safely import and re-import",
        async () => {
          const fileName = "file-import-customers.csv";
          const content = [
            "customer_id,name,phone,premium,expiry",
            `file-1,File Alice,0851234567,50,${date(15)}`,
          ].join("\n");
          await assert.rejects(
            pipeline.inspectFileImport(
              listId,
              fileName,
              "id,phone\n1,0812345678",
            ),
            /fields do not match/i,
          );
          await assert.rejects(
            pipeline.inspectFileImport(
              listId,
              fileName,
              "x".repeat(5 * 1024 * 1024 + 1),
            ),
            /5 MB/i,
          );
          const duplicate = await pipeline.resolveFileImport(
            listId,
            fileName,
            [
              "customer_id,name,phone,premium,expiry",
              `duplicate,First,0851234567,50,${date(15)}`,
              `duplicate,Second,0861234567,50,${date(15)}`,
            ].join("\n"),
            "customer_id",
          );
          assert.equal(duplicate.summary.eligible, 0);
          assert.equal(
            duplicate.rows.every((row) => row.status === "DUPLICATE"),
            true,
          );

          const inspection = await pipeline.inspectFileImport(
            listId,
            fileName,
            content,
          );
          assert.deepEqual(inspection.fields, columns);
          const jsonInspection = await pipeline.inspectFileImport(
            listId,
            "file-import-customers.json",
            JSON.stringify([
              {
                customer_id: "json-1",
                name: "JSON Alice",
                phone: "0852234567",
                premium: 75,
                expiry: date(20),
              },
            ]),
          );
          assert.deepEqual(jsonInspection.fields, columns);
          await assert.rejects(
            pipeline.inspectFileImport(
              listId,
              "file-import-customers.json",
              "not json",
            ),
            /Invalid JSON/i,
          );
          const preview = await pipeline.resolveFileImport(
            listId,
            fileName,
            content,
            "customer_id",
          );
          assert.equal(preview.summary.eligible, 1);
          const postsBefore = posts;
          const imported = await imports.awaitImport(
            (
              await imports.startFileImport(
                {
                  contactListId: listId,
                  fileName,
                  content,
                  keyField: "customer_id",
                  revision: preview.revision,
                },
                "test",
              )
            ).id,
          );
          assert.equal(imported.status, "SUCCESS");
          assert.equal(imported.created, 1);
          assert.equal(posts, postsBefore + 1);

          const synced = await pipeline.resolveFileImport(
            listId,
            fileName,
            content,
            "customer_id",
          );
          assert.equal(synced.summary.synced, 1);
          const reimport = await imports.awaitImport(
            (
              await imports.startFileImport(
                {
                  contactListId: listId,
                  fileName,
                  content,
                  keyField: "customer_id",
                  revision: synced.revision,
                  reimport: true,
                },
                "test",
              )
            ).id,
          );
          assert.equal(reimport.updated, 1);
          assert.equal(reimport.created, 0);
          assert.equal(posts, postsBefore + 1);
        },
      );
      await t.test(
        "ambiguous creations are not retried and can be reconciled to an existing contact",
        async () => {
          sourceRows.push({
            id: "e",
            fullName: "Eve",
            mobile: "0912345678",
            amount: 500,
            expires: date(10),
          });
          const postsBefore = posts;
          loseNextPost = true;
          const job = await imports.awaitImport(
            (
              await imports.startImport(
                { leadId: lead.id, contactListId: listId },
                "test",
              )
            ).id,
          );
          assert.equal(job.failed, 1);
          assert.equal(posts, postsBefore + 1);
          let preview = await pipeline.resolveLead(lead.id, listId);
          const unknown = preview.rows.find((row) => row.sourceKey === "e")!;
          assert.equal(unknown.status, "UNKNOWN");
          await imports.awaitImport(
            (
              await imports.startImport(
                { leadId: lead.id, contactListId: listId },
                "test",
              )
            ).id,
          );
          assert.equal(posts, postsBefore + 1);
          await imports.reconcileContact(
            unknown.id,
            `remote-${postsBefore + 1}`,
            "test",
          );
          preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(
            preview.rows.find((row) => row.sourceKey === "e")?.status,
            "UPDATE_AVAILABLE",
          );
          const updated = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: listId,
                  recordIds: [unknown.id],
                },
                "test",
              )
            ).id,
          );
          assert.equal(updated.updated, 1);
          assert.equal(posts, postsBefore + 1);
        },
      );
      await t.test(
        "scheduled imports use Lead Configuration and retain dependency checks",
        async () => {
          await assert.rejects(
            schedules.saveSchedule(
              {
                name: "Wrong destination",
                leadId: lead.id,
                contactListId: "22222222-2222-4222-8222-222222222222",
                frequency: "DAILY",
                time: "09:00",
                enabled: false,
              },
              "test",
            ),
            /Source Mapping/,
          );
          const schedule = await schedules.saveSchedule(
            {
              name: "Daily leads",
              leadId: lead.id,
              contactListId: listId,
              frequency: "DAILY",
              time: "09:00",
              enabled: false,
            },
            "test",
          );
          const result = await schedules.runSchedule(schedule.id, "test");
          assert.equal(result.status, "SUCCESS");
          assert.equal(result.total, 0);
          const original = await pipeline.entity(sourceIntegrations, source.id);
          await sourceIntegrations.mutate((rows) => {
            const item = rows.find((row) => row.id === source.id)!;
            item.kind = "CSV";
            item.config = {
              fileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              fileName: "uploaded.csv",
            };
          });
          await assert.rejects(
            schedules.saveSchedule(
              {
                name: "Legacy upload schedule",
                leadId: lead.id,
                contactListId: listId,
                frequency: "DAILY",
                time: "09:00",
                enabled: false,
              },
              "test",
            ),
            /browser-upload files are not supported/i,
          );
          await sourceIntegrations.mutate((rows) => {
            const index = rows.findIndex((row) => row.id === source.id);
            rows[index] = original;
          });
          await assert.rejects(
            pipeline.deleteConfiguration("leads", lead.id, "test"),
            /used by one or more schedules|in use/i,
          );
          await assert.rejects(
            pipeline.deleteConfiguration("mappings", mapping.id, "test"),
            /in use/,
          );

          const disposableLead = await pipeline.saveLead(
            {
              name: "Force delete fixture",
              mappingId: mapping.id,
              match: "ALL",
              filters: [],
            },
            "test",
          );
          const disposableSchedule = await schedules.saveSchedule(
            {
              name: "Fixture schedule",
              leadId: disposableLead.id,
              contactListId: listId,
              frequency: "DAILY",
              time: "09:00",
              enabled: false,
            },
            "test",
          );
          const priorStateCount = (await importStates.all()).length;
          const priorJobCount = (await importJobs.all()).length;
          const priorRemoteCount = remote.size;
          await assert.rejects(
            pipeline.deleteConfiguration("leads", disposableLead.id, "test"),
            /force delete/i,
          );
          const deletion = await pipeline.deleteConfiguration(
            "leads",
            disposableLead.id,
            "test",
            true,
          );
          assert.deepEqual(deletion, { deleted: true, removedSchedules: 1 });
          assert.equal(
            await leadDefinitions.findById("id", disposableLead.id),
            undefined,
          );
          assert.equal(
            await importSchedules.findById("id", disposableSchedule.id),
            undefined,
          );
          assert.equal((await importStates.all()).length, priorStateCount);
          assert.equal((await importJobs.all()).length, priorJobCount);
          assert.equal(remote.size, priorRemoteCount);
        },
      );
      await t.test(
        "local source paths reread on demand, uploads are not persisted and backups redact credentials",
        async () => {
          assert.equal(observedAuthorization, "Bearer private-source-token");
          const sourceRoot = process.env.SOURCE_FILE_ROOTS!;
          await mkdir(sourceRoot, { recursive: true });
          const csvPath = path.join(sourceRoot, "customers.csv");
          await writeFile(csvPath, 'id,name\r\n1,"Alice, A"\r\n');
          const file = await pipeline.saveSource(
            {
              name: "Server CSV",
              kind: "CSV",
              config: {
                fileLocation: "SERVER",
                serverPath: csvPath,
                fileName: "customers.csv",
              },
            },
            "test",
          );
          const saved = await pipeline.saveSource(
            {
              id: file.id,
              name: "CSV renamed",
              kind: "CSV",
              config: file.config,
            },
            "test",
            file.id,
          );
          let loaded = await sources.loadSource(
            await pipeline.entity(sourceIntegrations, saved.id),
          );
          assert.equal(loaded.rows[0].name, "Alice, A");
          await writeFile(csvPath, "id,name\n2,Bob\n");
          loaded = await sources.loadSource(
            await pipeline.entity(sourceIntegrations, saved.id),
          );
          assert.equal(loaded.rows[0].name, "Bob");
          const pastedPreview = await pipeline.previewSource({
            name: "Transient file preview",
            kind: "CSV",
            config: { content: "id,name\ntransient,Temporary" },
          });
          assert.equal(pastedPreview.rows[0].name, "Temporary");
          await assert.rejects(
            pipeline.saveSource(
              {
                name: "Browser upload is not persisted",
                kind: "CSV",
                config: {
                  content: "id,name\ntransient,Temporary",
                  fileName: "computer.csv",
                },
              },
              "test",
            ),
            /server-local file/i,
          );
          await pipeline.saveSource(
            {
              name: "Taken source name",
              kind: "CSV",
              config: { fileLocation: "SERVER", serverPath: csvPath },
            },
            "test",
          );
          await assert.rejects(
            pipeline.saveSource(
              {
                id: file.id,
                name: "Taken source name",
                kind: "CSV",
                config: { fileLocation: "SERVER", serverPath: csvPath },
              },
              "test",
              file.id,
            ),
            /already in use/,
          );
          const unchanged = await sources.loadSource(
            await pipeline.entity(sourceIntegrations, file.id),
          );
          assert.equal(unchanged.rows[0].name, "Bob");
          const backup = await business.createBackup();
          const downloaded = await business.downloadBackup(backup.directory);
          assert.equal(
            Object.keys(downloaded).some((name) =>
              name.startsWith("source-files/"),
            ),
            false,
          );
          assert.ok(
            !JSON.stringify(downloaded).includes("private-source-token"),
          );
          assert.ok(!JSON.stringify(downloaded).includes("Mallory"));
          assert.ok(
            (
              downloaded["source-integrations.json"] as Record<
                string,
                unknown
              >[]
            ).every((row) => row.secretEncrypted === undefined),
          );
        },
      );
      await t.test(
        "JDBC executes a real read-only query through the Java bridge",
        async (context) => {
          try {
            await access(path.resolve("server/jdbc/drivers/h2.jar"));
            await access(path.resolve("server/jdbc/JdbcBridge.class"));
          } catch {
            context.skip(
              "Run npm run setup:jdbc -- --test to enable the JDBC integration fixture",
            );
            return;
          }
          const data = await sources.jdbcData({
            id: "test",
            name: "JDBC fixture",
            kind: "JDBC",
            config: {
              jdbcUrl: "jdbc:h2:mem:pipeline",
              query: 'SELECT 1 AS "id", \'Alice\' AS "name"',
            },
            fields: [],
            secretEncrypted: "",
            createdAt: "",
            updatedAt: "",
          });
          assert.deepEqual(data.fields, ["id", "name"]);
          assert.deepEqual({ ...data.rows[0] }, { id: "1", name: "Alice" });
          assert.throws(
            () => sources.assertReadQuery("DELETE FROM customers"),
            /SELECT/,
          );
          assert.throws(
            () => sources.assertReadQuery("SELECT 1; DELETE FROM customers"),
            /SELECT/,
          );
        },
      );
      assert.ok(
        (await importStates.all()).every((state) => state.status !== "PENDING"),
      );
      await t.test(
        "system status derives connection, source failures and latest imports from real operations",
        async () => {
          const { systemStatus } =
            await import("../server/services/system-status.service");
          const healthy = await systemStatus(true);
          assert.equal(healthy.integration.status, "CONNECTED");
          const current = healthy.sources.find(
            (item) => item.id === source.id,
          )!;
          assert.equal(current.status, "ACTIVE");
          assert.equal(current.lastSyncStatus, "SUCCESS");
          assert.ok(current.lastSyncTime);
          failSource = true;
          try {
            const failed = await systemStatus(true);
            assert.equal(
              failed.sources.find((item) => item.id === source.id)!.status,
              "ERROR",
            );
          } finally {
            failSource = false;
          }
          assert.equal(
            (await systemStatus(true)).sources.find(
              (item) => item.id === source.id,
            )!.status,
            "ACTIVE",
          );
        },
      );
      await t.test(
        "clearing a destination resets its generic import identities",
        async () => {
          await imports.clearLeadDestination(listId, "test");
          assert.equal(remote.size, 0);
          assert.equal(
            (await importStates.all()).filter(
              (state) => state.contactListId === listId,
            ).length,
            0,
          );
          const preview = await pipeline.resolveLead(lead.id, listId);
          assert.equal(preview.summary.synced, 0);
          assert.equal(preview.summary.eligible, 2);
        },
      );
      await t.test(
        "manual imports can change to a compatible destination and re-import its synced contacts",
        async () => {
          const alternatePreview = await pipeline.resolveLead(
            lead.id,
            alternateListId,
          );
          assert.equal(
            alternatePreview.destination.contactListId,
            alternateListId,
          );
          assert.equal(alternatePreview.summary.eligible, 2);
          await assert.rejects(
            pipeline.resolveLead(lead.id, incompatibleListId),
            /columns must match/i,
          );

          const row = alternatePreview.rows.find(
            (item) => item.sourceKey === "a",
          )!;
          const postsBefore = posts;
          const firstJob = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: alternateListId,
                  recordIds: [row.id],
                  revision: alternatePreview.revision,
                },
                "test",
              )
            ).id,
          );
          assert.equal(firstJob.status, "SUCCESS");
          assert.equal(firstJob.contactListId, alternateListId);
          assert.equal(firstJob.created, 1);
          assert.equal(posts, postsBefore + 1);

          const syncedPreview = await pipeline.resolveLead(
            lead.id,
            alternateListId,
          );
          const syncedRow = syncedPreview.rows.find(
            (item) => item.sourceKey === "a",
          )!;
          assert.equal(syncedRow.status, "ALREADY_SYNCED");
          const putsBefore = puts;
          const reimportJob = await imports.awaitImport(
            (
              await imports.startImport(
                {
                  leadId: lead.id,
                  contactListId: alternateListId,
                  recordIds: [syncedRow.id],
                  revision: syncedPreview.revision,
                  reimport: true,
                },
                "test",
              )
            ).id,
          );
          assert.equal(reimportJob.status, "SUCCESS");
          assert.equal(reimportJob.reimport, true);
          assert.equal(reimportJob.updated, 1);
          assert.equal(puts, putsBefore + 1);
          assert.equal(
            posts,
            postsBefore + 1,
            "re-import updates the known contact",
          );
        },
      );
      await t.test(
        "configuration restore validates backup, preserves local secrets and identities, and disables schedules",
        async () => {
          const backup = await business.createBackup();
          const downloaded = await business.downloadBackup(backup.directory);
          const files = Object.fromEntries(
            Object.entries(downloaded).filter(
              ([name]) =>
                [
                  "genesys-contact-list-configurations.json",
                  "source-integrations.json",
                  "source-mappings.json",
                  "lead-definitions.json",
                  "lead-import-schedules.json",
                ].includes(name) || name.startsWith("source-files/"),
            ),
          ) as Record<string, unknown>;
          const scheduleFile = files["lead-import-schedules.json"] as Record<
            string,
            unknown
          >[];
          files["lead-import-schedules.json"] = scheduleFile.map((schedule) =>
            schedule.name === "Daily leads"
              ? { ...schedule, enabled: true }
              : schedule,
          );
          const beforeSources = await sourceIntegrations.all();
          const beforeStates = await importStates.all();
          const beforeLists = await contactListConfigurations.all();
          await assert.rejects(
            business.restoreConfigurationBackup(
              { confirmation: "RESTORE", files: {} },
              "test",
            ),
            /missing genesys-contact-list-configurations/i,
          );
          assert.deepEqual(await sourceIntegrations.all(), beforeSources);
          const invalidDependency = structuredClone(files);
          const invalidMappings = invalidDependency[
            "source-mappings.json"
          ] as Record<string, unknown>[];
          invalidMappings[0] = {
            ...invalidMappings[0],
            sourceId: "99999999-9999-4999-8999-999999999999",
          };
          await assert.rejects(
            business.restoreConfigurationBackup(
              { confirmation: "RESTORE", files: invalidDependency },
              "test",
            ),
            /references a missing source/i,
          );
          assert.deepEqual(await sourceIntegrations.all(), beforeSources);

          const result = await business.restoreConfigurationBackup(
            { confirmation: "RESTORE", files },
            "test",
          );
          assert.ok(result.safetyBackup);
          assert.ok(
            (await importSchedules.all()).every(
              (schedule) => !schedule.enabled,
            ),
          );
          assert.deepEqual(await importStates.all(), beforeStates);
          assert.deepEqual(await contactListConfigurations.all(), beforeLists);
          const restoredSources = await sourceIntegrations.all();
          for (const source of beforeSources) {
            assert.equal(
              restoredSources.find((item) => item.id === source.id)
                ?.secretEncrypted,
              source.secretEncrypted,
            );
          }
        },
      );
    } finally {
      globalThis.fetch = realFetch;
      sourceServer.closeAllConnections();
      await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    }
  },
);
