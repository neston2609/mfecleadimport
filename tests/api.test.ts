import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function launch() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "independent-app-"));
  const port = await freePort();
  let output = "";
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_DIR: path.join(folder, "data"),
        BACKUPS_DIR: path.join(folder, "backups"),
        EXPORTS_DIR: path.join(folder, "exports"),
        APP_SECRET: "isolated-test-app-secret",
        SESSION_SECRET: "isolated-test-session-secret",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "TestPassword123!",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const origin = "http://127.0.0.1:" + port;
  const request = (
    url: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(origin + url, {
      method,
      headers: {
        "X-Forwarded-Proto": "https",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  const stop = async () => {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    await rm(folder, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) break;
      try {
        ready = (await request("/api/health")).ok;
        if (ready) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Application did not start: " + output);
    return { folder, request, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  "standalone APIs preserve authentication, remove obsolete features and report actual source status",
  { timeout: 30000 },
  async () => {
    const { request, stop } = await launch();
    try {
      assert.equal((await request("/api/health")).status, 200);
      assert.equal(
        (await request("/api/admin/pipeline/bootstrap")).status,
        401,
      );
      const login = await request("/api/admin/auth/login", "POST", {
        username: "admin",
        password: "TestPassword123!",
        portal: "genesys",
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      for (const url of [
        "/api/admin/campaigns",
        "/api/admin/customers",
        "/api/admin/pipeline/templates",
        "/api/admin/genesys/schedules",
      ]) {
        assert.equal(
          (await request(url, "GET", undefined, cookie)).status,
          404,
          url,
        );
      }
      for (const url of ["/templates", "/campaigns", "/customers", "/manage"]) {
        assert.equal((await request(url)).status, 404, url);
      }
      const initial = await (
        await request("/api/admin/pipeline/bootstrap", "GET", undefined, cookie)
      ).json();
      assert.equal(initial.templates, undefined);
      assert.deepEqual(initial.sources, []);
      let status = await (
        await request("/api/admin/pipeline/status", "GET", undefined, cookie)
      ).json();
      assert.equal(status.integration.status, "DISCONNECTED");
      assert.deepEqual(status.sources, []);
      const draft = {
        name: "Uploaded customers",
        kind: "CSV",
        config: {
          fileName: "customers.csv",
          content: "id,phone\n1,0812345678\n",
        },
      };
      assert.equal(
        (
          await request(
            "/api/admin/pipeline/sources/preview",
            "POST",
            { source: draft },
            cookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await (
            await request(
              "/api/admin/pipeline/bootstrap",
              "GET",
              undefined,
              cookie,
            )
          ).json()
        ).sources.length,
        0,
      );
      const saved = await request(
        "/api/admin/pipeline/sources",
        "POST",
        draft,
        cookie,
      );
      assert.equal(saved.status, 201);
      const source = await saved.json();
      status = await (
        await request("/api/admin/pipeline/status/refresh", "POST", {}, cookie)
      ).json();
      assert.equal(status.sources[0].status, "ACTIVE");
      assert.equal(status.sources[0].lastSyncStatus, null);
      assert.equal(status.sources[0].lastSyncTime, null);
      assert.ok(status.sources[0].checkedAt);
      const missing = await request(
        "/api/admin/pipeline/mappings",
        "POST",
        {
          name: "Missing UUID",
          sourceId: source.id,
          contactListId: "11111111-1111-4111-8111-111111111111",
          keyField: "id",
          fields: [
            { sourceField: "phone", targetField: "phone", defaultValue: "" },
          ],
        },
        cookie,
      );
      assert.equal(missing.status, 409);
      assert.match((await missing.json()).message, /UUID/);
      assert.equal(
        (
          await request(
            "/api/admin/pipeline/sources",
            "POST",
            { ...draft, name: "Old", kind: "LEGACY" },
            cookie,
          )
        ).status,
        400,
      );
      const backup = await (
        await request("/api/admin/settings/backup", "POST", {}, cookie)
      ).json();
      const download = await (
        await request(backup.downloadUrl, "GET", undefined, cookie)
      ).json();
      assert.ok(download.files["source-integrations.json"]);
      assert.equal(download.files[".auth/admin.json"], undefined);
      const restored = await request(
        "/api/admin/settings/restore",
        "POST",
        { confirmation: "RESTORE", files: download.files },
        cookie,
      );
      assert.equal(restored.status, 200, await restored.text());
      const invalidRestore = await request(
        "/api/admin/settings/restore",
        "POST",
        { confirmation: "RESTORE", files: {} },
        cookie,
      );
      assert.equal(invalidRestore.status, 400);
      assert.equal(
        (
          await request("/api/admin/pipeline/sources", "POST", draft, cookie, {
            Origin: "https://unrelated.example",
          })
        ).status,
        403,
      );
      const changed = await request(
        "/api/admin/auth/change-password",
        "POST",
        {
          currentPassword: "TestPassword123!",
          newPassword: "NewPassword456!",
          confirmPassword: "NewPassword456!",
        },
        cookie,
      );
      assert.equal(changed.status, 204);
      assert.equal(
        (
          await request(
            "/api/admin/pipeline/bootstrap",
            "GET",
            undefined,
            cookie,
          )
        ).status,
        401,
      );
    } finally {
      await stop();
    }
  },
);
