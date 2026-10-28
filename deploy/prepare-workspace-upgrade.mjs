// Run once with the previous release's runtime environment, after stopping its service.
// This exports existing source records and remote identities; it never writes to Genesys.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const previous = process.argv[2];
if (!previous || !process.env.DATA_DIR)
  throw new Error("Pass the previous release folder and DATA_DIR");
const load = (file) => import(pathToFileURL(path.join(previous, file)).href);
const { loadSource } = await load("server/services/source-data.service.ts");
const { resolveLead, contactHash } = await load(
  "server/services/lead-pipeline.service.ts",
);
const read = async (name, fallback) => {
  try {
    return JSON.parse(
      await fs.readFile(path.join(process.env.DATA_DIR, name), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
const sources = await read("source-integrations.json", []),
  mappings = await read("source-mappings.json", []),
  leads = await read("lead-definitions.json", []),
  templates = await read("contact-templates.json", []),
  config = await read("config/genesys.json", {});
const result = [];
const policies = await read("policies.json", []);
for (const source of sources.filter((item) => item.kind === "LEGACY")) {
  const data = await loadSource(source);
  const identities = [];
  for (const mapping of mappings.filter(
    (item) => item.sourceId === source.id,
  )) {
    const lead = leads.find((item) => item.mappingId === mapping.id);
    const listId =
      templates.find((item) => item.id === mapping.templateId)?.contactListId ||
      config.contactListId;
    if (!lead || !listId) continue;
    const preview = await resolveLead(lead.id, listId);
    for (const row of preview.rows.filter(
      (item) => item.contactId || item.status === "UNKNOWN",
    ))
      identities.push({
        mappingId: mapping.id,
        sourceKey: row.sourceKey,
        contactListId: listId,
        contactId: row.contactId,
        payloadHash:
          row.status === "ALREADY_SYNCED"
            ? contactHash(row.data)
            : "migrated-outdated",
        status:
          row.status === "UNKNOWN"
            ? "UNKNOWN"
            : row.status === "ALREADY_SYNCED"
              ? "SYNCED"
              : "FAILED",
        message: "Preserved contact identity during workspace upgrade",
        updatedAt: new Date().toISOString(),
      });
    // Preserve policy identities even when current lead filters hide that record.
    for (const row of data.rows) {
      const key = String(row[mapping.keyField] ?? "").trim();
      const policy = policies.find((item) => item.policyId === key);
      if (
        policy?.genesys?.contactId &&
        policy.genesys.contactListId === listId &&
        !identities.some(
          (item) => item.sourceKey === key && item.contactListId === listId,
        )
      )
        identities.push({
          mappingId: mapping.id,
          sourceKey: key,
          contactListId: listId,
          contactId: policy.genesys.contactId,
          payloadHash: "migrated-outdated",
          status: "SYNCED",
          message: "Preserved existing policy contact identity",
          updatedAt: new Date().toISOString(),
        });
    }
  }
  result.push({
    sourceId: source.id,
    rows: data.rows
      .filter((row) => row.legacyEligible !== false)
      .map(({ legacyEligible, ...row }) => row),
    identities,
  });
}
await fs.mkdir(path.join(process.env.DATA_DIR, "config"), { recursive: true });
const target = path.join(
  process.env.DATA_DIR,
  "config/source-upgrade-snapshots.json",
);
await fs.writeFile(target + ".tmp", JSON.stringify(result), { mode: 0o600 });
await fs.rename(target + ".tmp", target);
console.log(
  JSON.stringify({
    snapshots: result.length,
    records: result.reduce((n, item) => n + item.rows.length, 0),
    identities: result.reduce((n, item) => n + item.identities.length, 0),
  }),
);
