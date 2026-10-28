import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("contact identity journal survives restarts, torn final writes, compaction and deletion", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mfec-state-journal-"));
  process.env.DATA_DIR = folder;
  try {
    const { ImportStateRepository } =
      await import("../server/domain/import-state-repository");
    const first = new ImportStateRepository();
    const row = {
      id: "record-a",
      mappingId: "mapping-a",
      sourceKey: "source-a",
      contactListId: "list-a",
      contactId: "",
      payloadHash: "",
      status: "PENDING" as const,
      message: "Pending remote request",
      updatedAt: new Date().toISOString(),
    };
    await first.set(row);
    await appendFile(
      path.join(folder, "lead-import-states.journal"),
      '{"set":[incomplete',
    );
    const restarted = new ImportStateRepository();
    assert.equal((await restarted.findById("id", row.id))?.status, "PENDING");
    await restarted.set({ ...row, status: "SYNCED", contactId: "remote-a" });
    const secondRestart = new ImportStateRepository();
    assert.equal(
      (await secondRestart.findById("id", row.id))?.contactId,
      "remote-a",
    );
    await secondRestart.flush();
    const compacted = new ImportStateRepository();
    assert.equal((await compacted.all()).length, 1);
    await compacted.mutate((rows) => rows.splice(0, rows.length));
    const deleted = new ImportStateRepository();
    assert.equal((await deleted.all()).length, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
