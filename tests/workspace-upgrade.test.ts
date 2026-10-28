import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

test("workspace upgrade preserves mappings, source records and remote identities across partial retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfec-upgrade-"));
  process.env.DATA_DIR = path.join(root, "data");
  const backupRoot = process.env.TEST_CROSS_DEVICE_BACKUPS
    ? await mkdtemp(
        path.join(
          process.env.TEST_CROSS_DEVICE_BACKUPS,
          "mfec-upgrade-backups-",
        ),
      )
    : path.join(root, "backups");
  process.env.BACKUPS_DIR = backupRoot;
  process.env.APP_SECRET = "upgrade-test-secret";
  const put = async (name: string, value: unknown) => {
    const file = path.join(process.env.DATA_DIR!, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  try {
    const listId = "11111111-1111-4111-8111-111111111111",
      now = new Date().toISOString();
    const identity = {
      mappingId: "mapping",
      sourceKey: "policy-one",
      contactListId: listId,
      contactId: "remote-existing",
      payloadHash: "same-payload",
      status: "SYNCED",
      message: "Preserved",
      updatedAt: now,
    };
    // Simulate a restart after source conversion but before identities were restored.
    await put("source-integrations.json", [
      {
        id: "source",
        name: "Customers",
        kind: "JSON",
        config: { fileId: "unfinished" },
        identityNamespace: "migrated-policy",
        fields: ["id", "phone"],
        secretEncrypted: "",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await put("source-mappings.json", [
      {
        id: "mapping",
        name: "Existing mapping",
        sourceId: "source",
        templateId: "old-template",
        keyField: "id",
        fields: [
          { sourceField: "phone", targetField: "phone", defaultValue: "" },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await put("contact-templates.json", [
      {
        id: "old-template",
        name: "Existing list",
        contactListId: listId,
        fields: [{ name: "phone", type: "PHONE", required: true }],
      },
    ]);
    await put("config/source-upgrade-snapshots.json", [
      {
        sourceId: "source",
        rows: [{ id: "policy-one", phone: "0812345678" }],
        identities: [identity],
      },
    ]);
    const store = await import("../server/domain/pipeline-store");
    const { GenesysConfigService } =
      await import("../server/services/genesys/genesys-config.service");
    const { upgradeWorkspace } =
      await import("../server/services/workspace-upgrade.service");
    await store.initializePipeline();
    await new GenesysConfigService().updateConfig({ contactListId: listId });
    await upgradeWorkspace();
    await upgradeWorkspace();
    const source = (await store.sourceIntegrations.all())[0];
    assert.equal(source.kind, "JSON");
    assert.equal(source.id, "source");
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(
            process.env.DATA_DIR!,
            "source-files",
            source.config.fileId + ".txt",
          ),
          "utf8",
        ),
      ),
      [{ id: "policy-one", phone: "0812345678" }],
    );
    const mapping = (await store.sourceMappings.all())[0];
    assert.equal(mapping.id, "mapping");
    assert.equal(mapping.contactListId, listId);
    assert.equal(
      (mapping as unknown as Record<string, unknown>).templateId,
      undefined,
    );
    assert.equal(mapping.fields[0].type, "PHONE");
    assert.equal((await store.contactListConfigurations.all())[0].uuid, listId);
    const states = await store.importStates.all();
    assert.equal(states.length, 1);
    assert.equal(states[0].contactId, "remote-existing");
    assert.equal(
      states[0].id,
      createHash("sha256")
        .update(JSON.stringify(["migrated-policy", "policy-one", listId]))
        .digest("hex"),
    );
    assert.ok(
      !(await readdir(process.env.DATA_DIR!)).includes(
        "contact-templates.json",
      ),
    );
    assert.ok((await readdir(process.env.BACKUPS_DIR!)).length);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (process.env.TEST_CROSS_DEVICE_BACKUPS)
      await rm(backupRoot, { recursive: true, force: true });
  }
});
