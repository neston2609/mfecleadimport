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
  "genesys runs independently with isolated authentication, records, backups and routes",
  { timeout: 30000 },
  async () => {
    const { folder, request, stop } = await launch();
    try {
      assert.equal(
        (await (await request("/api/health")).json()).service,
        "mfec-lead-import-export",
      );
      const homepage = await request("/");
      assert.equal(homepage.status, 200);
      assert.equal(homepage.headers.get("location"), null);
      assert.match(await homepage.text(), /MFEC LeadSync/);
      for (const [oldPath, newPath] of [
        ["/genesys", "/"],
        ["/genesys/", "/"],
        ["/genesys/import-leads?campaign=demo", "/import-leads?campaign=demo"],
        ["/genesys/customers/CUST00001", "/customers/CUST00001"],
        ["/genesys/login?passwordChanged=1", "/login?passwordChanged=1"],
      ]) {
        const legacy = await request(oldPath);
        assert.equal(legacy.status, 308, oldPath);
        assert.equal(legacy.headers.get("location"), newPath, oldPath);
      }
      assert.equal((await request("/manage")).status, 404);
      assert.equal((await request("/api/admin/customers")).status, 401);
      assert.equal(
        (await request("/api/admin/pipeline/bootstrap")).status,
        401,
      );
      assert.equal(
        (
          await request("/api/admin/auth/login", "POST", {
            username: "admin",
            password: "TestPassword123!",
            portal: "manage",
          })
        ).status,
        400,
      );
      const login = await request("/api/admin/auth/login", "POST", {
        username: "admin",
        password: "TestPassword123!",
        portal: "genesys",
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get("set-cookie")!;
      assert.match(setCookie, /^genesys\.sid=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /Secure/);
      const cookie = setCookie.split(";")[0];
      const initialPipeline = await (
        await request("/api/admin/pipeline/bootstrap", "GET", undefined, cookie)
      ).json();
      assert.ok(
        initialPipeline.leads.length >= 6,
        "Legacy campaign leads must be retained",
      );
      assert.ok(
        initialPipeline.sources.every(
          (source: Record<string, unknown>) =>
            source.secretEncrypted === undefined,
        ),
      );
      const template = await (
        await request(
          "/api/admin/pipeline/templates",
          "POST",
          {
            name: "API custom fields",
            contactListId: "",
            fields: [
              { name: "id", type: "STRING", required: true },
              { name: "phone", type: "PHONE", required: true },
              { name: "amount", type: "NUMBER", required: false },
            ],
          },
          cookie,
        )
      ).json();
      assert.ok(template.id);
      const sourceDraft = {
        name: "API JSON source",
        kind: "JSON",
        config: {
          fileName: "fixture.json",
          content: JSON.stringify([
            { id: "one", phone: "0812345678", amount: 500 },
            { id: "two", phone: "0822345678", amount: 5 },
          ]),
        },
      };
      const sourcePreview = await request(
        "/api/admin/pipeline/sources/preview",
        "POST",
        { source: sourceDraft },
        cookie,
      );
      assert.equal(sourcePreview.status, 200);
      assert.equal((await sourcePreview.json()).rows.length, 2);
      const afterPreview = await (
        await request("/api/admin/pipeline/bootstrap", "GET", undefined, cookie)
      ).json();
      assert.equal(
        afterPreview.sources.length,
        initialPipeline.sources.length,
        "Preview must not save a source",
      );
      const source = await (
        await request(
          "/api/admin/pipeline/sources",
          "POST",
          sourceDraft,
          cookie,
        )
      ).json();
      assert.ok(source.id);
      const mapping = await (
        await request(
          "/api/admin/pipeline/mappings",
          "POST",
          {
            name: "API mapping",
            templateId: template.id,
            sourceId: source.id,
            keyField: "id",
            fields: ["id", "phone", "amount"].map((name) => ({
              targetField: name,
              sourceField: name,
              defaultValue: "",
            })),
          },
          cookie,
        )
      ).json();
      assert.ok(mapping.id);
      const lead = await (
        await request(
          "/api/admin/pipeline/leads",
          "POST",
          {
            name: "API filtered lead",
            mappingId: mapping.id,
            match: "ALL",
            filters: [
              { field: "amount", scope: "TARGET", operator: "GT", value: "10" },
            ],
          },
          cookie,
        )
      ).json();
      assert.ok(lead.id);
      const previewLead = await (
        await request(
          `/api/admin/pipeline/leads/${lead.id}/preview`,
          "GET",
          undefined,
          cookie,
        )
      ).json();
      assert.equal(previewLead.summary.eligible, 1);
      assert.equal(previewLead.rows[0].data.phone, "+66812345678");
      assert.equal(
        (
          await request(
            `/api/admin/pipeline/sources/${source.id}`,
            "DELETE",
            undefined,
            cookie,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            `/api/admin/pipeline/leads/${lead.id}/export`,
            "GET",
            undefined,
            cookie,
          )
        ).status,
        200,
      );
      const newSchedule = await request(
        "/api/admin/pipeline/schedules",
        "POST",
        {
          name: "API monthly import",
          leadId: lead.id,
          contactListId: "11111111-1111-4111-8111-111111111111",
          frequency: "MONTH_DAYS",
          time: "10:30",
          monthDays: [1, 15],
          enabled: false,
        },
        cookie,
      );
      assert.equal(newSchedule.status, 201);
      assert.equal(
        (
          await (
            await request(
              "/api/admin/auth/session?portal=genesys",
              "GET",
              undefined,
              cookie,
            )
          ).json()
        ).authenticated,
        true,
      );
      assert.equal(
        (
          await request(
            "/api/admin/customers",
            "GET",
            undefined,
            cookie.replace("genesys.sid", "manage.sid"),
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request(
            "/api/admin/customers/CUST00001",
            "PUT",
            { firstName: "Blocked" },
            cookie,
            { Origin: "https://unrelated.example" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/api/admin/customers/CUST00001",
            "PUT",
            { firstName: "Standalone" },
            cookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await (
            await request(
              "/api/admin/customers/CUST00001",
              "GET",
              undefined,
              cookie,
            )
          ).json()
        ).firstName,
        "Standalone",
      );
      const saved = JSON.parse(
        await readFile(path.join(folder, "data/customers.json"), "utf8"),
      );
      assert.ok(
        saved.some(
          (row: { firstName: string }) => row.firstName === "Standalone",
        ),
      );
      const campaignResponse = await request(
        "/api/admin/campaigns",
        "POST",
        {
          name: "Independent campaign",
          description: "Local source",
          filters: { excludeDnc: true },
        },
        cookie,
      );
      assert.equal(campaignResponse.status, 201);
      const campaign = await campaignResponse.json();
      const preview = await (
        await request(
          "/api/admin/campaigns/" + campaign.campaignListId + "/preview",
          "POST",
          {},
          cookie,
        )
      ).json();
      assert.ok(preview.summary.eligible > 0);
      const exported = await request(
        "/api/admin/campaigns/" + campaign.campaignListId + "/export",
        "POST",
        {},
        cookie,
      );
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-type") || "", /csv/);
      assert.ok((await exported.text()).includes("customerId"));
      const backupResponse = await request(
        "/api/admin/settings/backup",
        "POST",
        {},
        cookie,
      );
      assert.equal(backupResponse.status, 201);
      const backup = await backupResponse.json();
      const download = await (
        await request(backup.downloadUrl, "GET", undefined, cookie)
      ).json();
      assert.ok(download.files["customers.json"]);
      assert.equal(download.files[".auth/admin.json"], undefined);

      assert.equal((await request("/api/public/products")).status, 404);
      assert.equal(
        (await request("/api/admin/genesys/config", "GET", undefined, cookie))
          .status,
        200,
      );
      const regions = await (
        await request("/api/admin/genesys/regions", "GET", undefined, cookie)
      ).json();
      assert.ok(regions.regions.length > 10);
      const scheduleResponse = await request(
        "/api/admin/genesys/schedules",
        "POST",
        {
          name: "Local schedule",
          campaignListId: campaign.campaignListId,
          frequency: "DAILY",
          time: "09:00",
          enabled: false,
        },
        cookie,
      );
      assert.equal(scheduleResponse.status, 201);
      assert.equal(
        (
          await request(
            "/api/admin/campaigns/" + campaign.campaignListId,
            "DELETE",
            undefined,
            cookie,
          )
        ).status,
        409,
      );

      const passwordResponse = await request(
        "/api/admin/auth/change-password",
        "POST",
        {
          currentPassword: "TestPassword123!",
          newPassword: "NewPassword456!",
          confirmPassword: "NewPassword456!",
        },
        cookie,
      );
      assert.equal(passwordResponse.status, 204);
      assert.match(
        passwordResponse.headers.get("set-cookie") || "",
        /^genesys\.sid=/,
      );
      assert.equal(
        (await request("/api/admin/customers", "GET", undefined, cookie))
          .status,
        401,
      );
      for (const url of [
        "/",
        "/login",
        "/import-leads",
        "/regions",
        "/scheduler",
        "/customers",
        "/customers/CUST00001",
        "/policies/POL00001",
        "/campaigns",
        "/settings",
      ])
        assert.equal((await request(url)).status, 200, url);
    } finally {
      await stop();
    }
  },
);
