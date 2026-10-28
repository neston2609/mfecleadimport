import assert from "node:assert/strict";
import test from "node:test";
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
