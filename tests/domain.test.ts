import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreview,
  CONTACT_COLUMNS,
  daysUntilExpiry,
  generateGenesysCsv,
  mapCampaignContact,
  normalizeThaiPhone,
  payloadHash,
} from "../server/domain/campaign-contact";
import {
  seedCustomers,
  seedPolicies,
  seedProducts,
} from "../server/domain/seed";
import { compareSchema } from "../server/services/genesys/genesys-sync.service";
import { nextRenewalPeriod } from "../server/domain/renewal-date";
import { THAI_PROVINCES } from "../src/lib/thai-provinces";
import { nextGenesysRunAt } from "../server/services/genesys/genesys-scheduler.service";

test("renewal adds a calendar year and clamps leap day", () => {
  assert.deepEqual(nextRenewalPeriod("2027-09-30"), {
    effectiveDate: "2027-10-01",
    expiryDate: "2028-09-30",
  });
  assert.deepEqual(nextRenewalPeriod("2024-02-29"), {
    effectiveDate: "2024-03-01",
    expiryDate: "2025-02-28",
  });
});

test("customer province choices cover all 77 provinces", () => {
  assert.equal(THAI_PROVINCES.length, 77);
  assert.equal(new Set(THAI_PROVINCES).size, 77);
  assert.ok(THAI_PROVINCES.includes("กรุงเทพมหานคร"));
  assert.ok(THAI_PROVINCES.includes("บึงกาฬ"));
});

test("Genesys scheduler calculates Bangkok once, daily, and weekly runs", () => {
  assert.equal(
    nextGenesysRunAt(
      { frequency: "DAILY", time: "09:30" },
      new Date("2026-10-09T01:00:00.000Z"),
    ),
    "2026-10-09T02:30:00.000Z",
  );
  assert.equal(
    nextGenesysRunAt(
      { frequency: "DAILY", time: "09:30" },
      new Date("2026-10-09T03:00:00.000Z"),
    ),
    "2026-10-10T02:30:00.000Z",
  );
  assert.equal(
    nextGenesysRunAt(
      { frequency: "WEEKLY", time: "09:00", dayOfWeek: 1 },
      new Date("2026-10-09T03:00:00.000Z"),
    ),
    "2026-10-12T02:00:00.000Z",
  );
  assert.equal(
    nextGenesysRunAt(
      { frequency: "ONCE", time: "15:45", date: "2026-10-10" },
      new Date("2026-10-09T03:00:00.000Z"),
    ),
    "2026-10-10T08:45:00.000Z",
  );
});

test("normalizes Thai mobile numbers and rejects other formats", () => {
  assert.equal(normalizeThaiPhone("081-234-5678"), "+66812345678");
  assert.equal(normalizeThaiPhone("+66 81 234 5678"), "+66812345678");
  assert.throws(() => normalizeThaiPhone("020001111"));
});

test("expiry uses Bangkok calendar date", () => {
  assert.equal(
    daysUntilExpiry("2026-10-09", new Date("2026-10-08T18:00:00Z")),
    0,
  );
  assert.equal(
    daysUntilExpiry("2026-10-10", new Date("2026-10-08T18:00:00Z")),
    1,
  );
});

test("seed includes required sample and DNC is never eligible", () => {
  const customers = seedCustomers(),
    products = seedProducts(),
    policies = seedPolicies();
  assert.equal(customers.length, 30);
  assert.ok(products.length >= 8);
  assert.equal(policies.length, 40);
  assert.equal(customers[0].customerId, "CUST00001");
  assert.equal(policies[0].policyNumber, "MFEC-MC-2026-00001");
  const preview = buildPreview(policies, customers, products, {});
  assert.ok(preview.rows.some((row) => row.eligibility === "DNC"));
  assert.ok(
    preview.rows.every((row) =>
      row.customer.dnc ? row.eligibility === "DNC" : true,
    ),
  );
  assert.ok(preview.summary.eligible > 0);
  assert.equal(preview.summary.matched, preview.rows.length);

  const samplePolicy = policies[0];
  const sampleCustomer = customers.find(
    (customer) => customer.customerId === samplePolicy.customerId,
  )!;
  const sampleProduct = products.find(
    (product) => product.productId === samplePolicy.productId,
  )!;
  samplePolicy.genesys = {
    contactListId: "list-a",
    contactId: "contact-a",
    syncStatus: "SYNCED",
    lastSyncAt: new Date().toISOString(),
    lastSyncError: null,
    lastPayloadHash: payloadHash(
      mapCampaignContact(samplePolicy, sampleCustomer, sampleProduct),
    ),
    lastSyncedBy: "test",
  };
  const sameList = buildPreview(
    policies,
    customers,
    products,
    {},
    [samplePolicy.policyId],
    "list-a",
  );
  const differentList = buildPreview(
    policies,
    customers,
    products,
    {},
    [samplePolicy.policyId],
    "list-b",
  );
  assert.equal(sameList.rows[0]?.eligibility, "ALREADY_SYNCED");
  assert.equal(differentList.rows[0]?.eligibility, "ELIGIBLE");
  samplePolicy.genesys.lastPayloadHash = "sha256:outdated";
  samplePolicy.genesys.syncStatus = "OUTDATED";
  const reloadable = buildPreview(
    policies,
    customers,
    products,
    {},
    [samplePolicy.policyId],
    "list-a",
  );
  assert.equal(reloadable.rows[0]?.eligibility, "RELOAD_AVAILABLE");
  assert.equal(reloadable.summary.reloadAvailable, 1);
});

test("CSV is BOM/CRLF UTF-8, escaped, and protects formulas", () => {
  const contact = mapCampaignContact(
    seedPolicies()[0],
    seedCustomers()[0],
    seedProducts()[5],
  );
  const buffer = generateGenesysCsv([
    { ...contact, firstName: '=HYPERLINK("bad")' },
  ]);
  const csv = buffer.toString("utf8");
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes("สมชาย") === false);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.equal(
    csv.trim().split("\r\n")[0].split(",").length,
    CONTACT_COLUMNS.length,
  );
  assert.equal(payloadHash(contact), payloadHash({ ...contact }));
});

test("Genesys schema reports missing, case mismatch, phone mismatch and extras", () => {
  const good = compareSchema(
    {
      name: "test",
      columnNames: [...CONTACT_COLUMNS],
      phoneColumns: [{ columnName: "phone", type: "Cell" }],
    },
    "list-1",
    "phone",
  );
  assert.equal(good.valid, true);
  const bad = compareSchema(
    {
      columnNames: [
        ...CONTACT_COLUMNS.filter(
          (name) => name !== "vehicleType" && name !== "phone",
        ),
        "Phone",
        "extra",
      ],
      phoneColumns: [{ columnName: "Phone" }],
    },
    "list-1",
    "phone",
  );
  assert.equal(bad.valid, false);
  assert.ok(
    bad.mapping.some(
      (item) =>
        item.applicationField === "phone" && item.status === "CASE_MISMATCH",
    ),
  );
  assert.ok(
    bad.mapping.some(
      (item) =>
        item.applicationField === "vehicleType" && item.status === "MISSING",
    ),
  );
  assert.deepEqual(bad.unexpectedColumns, ["extra"]);
  assert.equal(bad.phoneColumnValid, false);
});
