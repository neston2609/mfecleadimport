import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("legacy campaigns migrate idempotently and keep existing Genesys contact IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfec-migration-"));
  process.env.DATA_DIR = root;
  process.env.APP_SECRET = "migration-test-secret";
  try {
    const [
      store,
      pipeline,
      { migrateLegacyCampaigns },
      { GenesysConfigService },
      { genesysRegionService },
      { writeJsonFile },
    ] = await Promise.all([
      import("../server/domain/store"),
      import("../server/domain/pipeline-store"),
      import("../server/services/pipeline-migration.service"),
      import("../server/services/genesys/genesys-config.service"),
      import("../server/services/genesys/genesys-region.service"),
      import("../server/services/genesys/file-store"),
    ]);
    await store.initializeBusinessData();
    await pipeline.initializePipeline();
    await genesysRegionService.initialize();
    const listId = "11111111-1111-4111-8111-111111111111";
    await new GenesysConfigService().updateConfig({ contactListId: listId });
    await store.policies.mutate((rows) => {
      rows[0].genesys.contactId = "existing-contact";
      rows[0].genesys.contactListId = listId;
      rows[0].genesys.syncStatus = "SYNCED";
    });
    await migrateLegacyCampaigns();
    const counts = [
      (await pipeline.contactTemplates.all()).length,
      (await pipeline.sourceIntegrations.all()).length,
      (await pipeline.sourceMappings.all()).length,
      (await pipeline.leadDefinitions.all()).length,
      (await pipeline.importStates.all()).length,
    ];
    assert.equal(counts[0], 1);
    assert.equal(counts[3], (await store.campaigns.all()).length);
    assert.ok(
      (await pipeline.importStates.all()).some(
        (state) => state.contactId === "existing-contact",
      ),
    );
    const { resolveLead } =
      await import("../server/services/lead-pipeline.service");
    const definitions = await pipeline.leadDefinitions.all();
    const previews = await Promise.all(
      definitions.map((lead) => resolveLead(lead.id, listId)),
    );
    const shared = previews
      .flatMap((preview) => preview.rows)
      .filter((row) => row.sourceKey === "POL00001");
    assert.ok(shared.length > 1);
    assert.equal(new Set(shared.map((row) => row.id)).size, 1);
    assert.ok(shared.every((row) => row.contactId === "existing-contact"));
    await writeJsonFile("pipeline-migration.json", false);
    await migrateLegacyCampaigns();
    assert.deepEqual(
      [
        (await pipeline.contactTemplates.all()).length,
        (await pipeline.sourceIntegrations.all()).length,
        (await pipeline.sourceMappings.all()).length,
        (await pipeline.leadDefinitions.all()).length,
        (await pipeline.importStates.all()).length,
      ],
      counts,
    );
    await store.policies.mutate((rows) => {
      rows[1].genesys.contactId = "later-contact";
      rows[1].genesys.contactListId = listId;
      rows[1].genesys.syncStatus = "SYNCED";
    });
    const later = (
      await Promise.all(definitions.map((lead) => resolveLead(lead.id, listId)))
    )
      .flatMap((preview) => preview.rows)
      .filter((row) => row.sourceKey === "POL00002");
    assert.ok(later.length > 0);
    assert.ok(later.every((row) => row.contactId === "later-contact"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
