import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCsv,
  selectJsonRows,
  assertReadQuery,
  webData,
} from "../server/services/source-data.service";
import {
  matchesFilter,
  dayNumber,
} from "../server/services/lead-pipeline.service";
import { nextLeadRun } from "../server/services/lead-schedule.service";
import {
  browseLocal,
  validateLocalFile,
  validateRemoteHost,
  verifySshHostFingerprint,
} from "../server/services/file-source.service";

test("Web Service previews block metadata addresses including IPv4-mapped IPv6", async () => {
  for (const uri of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  ]) {
    await assert.rejects(
      webData({
        id: "blocked",
        name: "Blocked source",
        kind: "WEB",
        config: { uri },
        fields: [],
        secretEncrypted: "",
        createdAt: "",
        updatedAt: "",
      }),
      /Metadata and link-local/,
    );
  }
});

test("remote file-source host checks block internal endpoints unless allowlisted", async () => {
  const previous = process.env.SOURCE_REMOTE_ALLOWED_HOSTS;
  delete process.env.SOURCE_REMOTE_ALLOWED_HOSTS;
  try {
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "100.100.100.200",
      "::1",
      "::ffff:a9fe:a9fe",
      "::ffff:7f00:1",
    ])
      await assert.rejects(validateRemoteHost(address), /blocked/i, address);
    process.env.SOURCE_REMOTE_ALLOWED_HOSTS = "127.0.0.1,169.254.169.254";
    assert.equal(await validateRemoteHost("127.0.0.1"), "127.0.0.1");
    assert.equal(
      await validateRemoteHost("169.254.169.254"),
      "169.254.169.254",
    );
  } finally {
    if (previous === undefined) delete process.env.SOURCE_REMOTE_ALLOWED_HOSTS;
    else process.env.SOURCE_REMOTE_ALLOWED_HOSTS = previous;
  }
});

test("SSH host fingerprints use OpenSSH SHA256 base64 formatting", () => {
  const hex = "00".repeat(32);
  const expected = `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/, "")}`;
  assert.equal(verifySshHostFingerprint(hex, expected), true);
  assert.equal(verifySshHostFingerprint(hex, `${expected}x`), false);
  assert.equal(verifySshHostFingerprint("00", expected), false);
});

test("server-local files stay inside configured roots and block symlinks", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "source-paths-"));
  const root = path.join(folder, "allowed");
  const outside = path.join(folder, "outside.csv");
  const previousRoots = process.env.SOURCE_FILE_ROOTS;
  try {
    await mkdir(root);
    await writeFile(path.join(root, "inside.csv"), "id\n1\n");
    await writeFile(outside, "id\n2\n");
    await symlink(outside, path.join(root, "linked.csv"));
    process.env.SOURCE_FILE_ROOTS = root;
    assert.equal(
      (await validateLocalFile(path.join(root, "inside.csv"))).size,
      5,
    );
    assert.equal((await browseLocal(root)).entries[0].name, "inside.csv");
    await assert.rejects(
      validateLocalFile(outside),
      /outside the allowed source folders/i,
    );
    await assert.rejects(
      validateLocalFile(path.join(root, "linked.csv")),
      /symbolic links outside/i,
    );
  } finally {
    if (previousRoots === undefined) delete process.env.SOURCE_FILE_ROOTS;
    else process.env.SOURCE_FILE_ROOTS = previousRoots;
    await rm(folder, { recursive: true, force: true });
  }
});

test("CSV and JSON source previews preserve quoted values and flatten nested objects", () => {
  assert.deepEqual(
    {
      ...parseCsv(
        '\uFEFFid,name,notes\r\n1,"Alice, A","line 1\nline 2"\r\n',
      )[0],
    },
    { id: "1", name: "Alice, A", notes: "line 1\nline 2" },
  );
  assert.throws(() => parseCsv("id,id\n1,2"), /unique/);
  assert.deepEqual(parseCsv("id;name\n").columns, ["id", "name"]);
  assert.deepEqual(
    {
      ...selectJsonRows(
        {
          data: {
            items: [{ id: 1, customer: { name: "Alice" }, tags: ["new"] }],
          },
        },
        "data.items",
      )[0],
    },
    { id: 1, "customer.name": "Alice", tags: '["new"]' },
  );
  assert.throws(
    () => selectJsonRows(JSON.parse('[{"__proto__":{"unsafe":true}}]')),
    /field name/,
  );
  assert.equal(
    assertReadQuery(" SELECT id FROM contacts; "),
    "SELECT id FROM contacts",
  );
  assert.throws(
    () => assertReadQuery("SELECT id INTO OUTFILE 'x' FROM contacts"),
    /SELECT/,
  );
});
test("lead filters distinguish empty numbers and use Bangkok calendar dates", () => {
  const now = new Date("2026-10-27T18:00:00Z");
  assert.equal(
    matchesFilter(
      { value: "" },
      {},
      { scope: "TARGET", field: "value", operator: "LT", value: "1" },
      now,
    ),
    false,
  );
  assert.equal(
    matchesFilter(
      { expiry: "2026-10-29" },
      {},
      {
        scope: "TARGET",
        field: "expiry",
        operator: "DATE_GT_DAYS",
        value: "0",
      },
      now,
    ),
    true,
  );
  assert.equal(
    matchesFilter(
      { expiry: "2026-10-28" },
      {},
      {
        scope: "TARGET",
        field: "expiry",
        operator: "DATE_GT_DAYS",
        value: "0",
      },
      now,
    ),
    false,
  );
  assert.equal(
    matchesFilter(
      {},
      { amount: 42 },
      { scope: "SOURCE", field: "amount", operator: "GTE", value: "42" },
      now,
    ),
    true,
  );
  assert.ok(Number.isNaN(dayNumber("2026-02-30")));
});
test("daily, weekly, monthly and custom month-day schedules advance in Bangkok without overflowing short months", () => {
  const base = {
    frequency: "DAILY" as const,
    time: "09:00",
    dayOfWeek: 1,
    dayOfMonth: 31,
    monthDays: [1, 15],
  };
  assert.equal(
    nextLeadRun(base, new Date("2026-10-27T02:00:00Z")),
    "2026-10-28T02:00:00.000Z",
  );
  assert.equal(
    nextLeadRun(
      { ...base, frequency: "WEEKLY" },
      new Date("2026-10-27T00:00:00Z"),
    ),
    "2026-11-02T02:00:00.000Z",
  );
  assert.equal(
    nextLeadRun(
      { ...base, frequency: "MONTHLY" },
      new Date("2027-02-01T00:00:00Z"),
    ),
    "2027-03-31T02:00:00.000Z",
  );
  assert.equal(
    nextLeadRun(
      { ...base, frequency: "MONTH_DAYS" },
      new Date("2026-10-16T00:00:00Z"),
    ),
    "2026-11-01T02:00:00.000Z",
  );
});
