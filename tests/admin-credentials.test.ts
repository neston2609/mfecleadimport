import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("admin password persists across restarts and invalidates old sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfec-auth-test-"));
  const priorDataDir = process.env.DATA_DIR;
  const priorPassword = process.env.ADMIN_PASSWORD;
  try {
    process.env.DATA_DIR = root;
    process.env.ADMIN_PASSWORD = "InitialPassword123!";
    const { AdminCredentialsService } =
      await import("../server/services/admin-credentials.service");
    const first = new AdminCredentialsService();
    await first.initialize();
    const oldLogin = await first.authenticate("admin", "InitialPassword123!");
    assert.ok(oldLogin);
    const changes = await Promise.all([
      first.changePassword("InitialPassword123!", "ChangedPassword456!"),
      first.changePassword("InitialPassword123!", "AnotherPassword789!"),
    ]);
    assert.deepEqual(changes, [true, false]);

    delete process.env.ADMIN_PASSWORD;
    const restarted = new AdminCredentialsService();
    await restarted.initialize();
    assert.equal(
      await restarted.authenticate("admin", "InitialPassword123!"),
      null,
    );
    const newLogin = await restarted.authenticate(
      "admin",
      "ChangedPassword456!",
    );
    assert.ok(newLogin);
    assert.equal(
      await restarted.isSessionValid(oldLogin.username, oldLogin.version),
      false,
    );
    assert.equal(
      await restarted.isSessionValid(newLogin.username, newLogin.version),
      true,
    );
    const saved = await readFile(
      path.join(root, ".auth", "admin.json"),
      "utf8",
    );
    assert.ok(!saved.includes("InitialPassword123!"));
    assert.ok(!saved.includes("ChangedPassword456!"));
  } finally {
    if (priorDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = priorDataDir;
    if (priorPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = priorPassword;
    await rm(root, { recursive: true, force: true });
  }
});
