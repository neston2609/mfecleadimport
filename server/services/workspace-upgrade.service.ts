import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { dataDir, backupsDir } from "../domain/json-repository";
import {
  sourceIntegrations,
  sourceMappings,
  contactListConfigurations,
  importStates,
} from "../domain/pipeline-store";
import { GenesysConfigService } from "./genesys/genesys-config.service";
import type { ContactField, ImportState } from "../domain/pipeline-types";

async function read<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
type OldMapping = {
  id: string;
  templateId?: string;
  contactListId?: string;
  regionId?: string;
  fields: {
    targetField: string;
    type?: ContactField["type"];
    required?: boolean;
  }[];
};
type Snapshot = {
  sourceId: string;
  rows: Record<string, unknown>[];
  identities: Omit<ImportState, "id">[];
};
export async function upgradeWorkspace() {
  if (await read("config/contact-list-workspace-upgrade.json", false)) return;
  const sources = await read<
    {
      id: string;
      kind: string;
      name: string;
      fields: string[];
      config: unknown;
    }[]
  >("source-integrations.json", []);
  const snapshots = await read<Snapshot[]>(
    "config/source-upgrade-snapshots.json",
    [],
  );
  for (const source of sources.filter((item) => item.kind === "LEGACY"))
    if (!snapshots.some((item) => item.sourceId === source.id))
      throw new Error(
        "Existing source data needs a migration snapshot. Run deploy/prepare-workspace-upgrade.mjs against the previous release before upgrading.",
      );
  const config = await new GenesysConfigService().getConfig();
  const templates = await read<
    {
      id: string;
      name: string;
      contactListId: string;
      fields: ContactField[];
    }[]
  >("contact-templates.json", []);
  const mappings = await read<OldMapping[]>("source-mappings.json", []);
  const archive = path.join(
    backupsDir,
    "workspace-upgrade-" + new Date().toISOString().replace(/\D/g, ""),
  );
  await mkdir(archive, { recursive: true });
  for (const name of [
    "source-integrations.json",
    "source-mappings.json",
    "genesys-contact-list-configurations.json",
  ]) {
    try {
      await copyFile(path.join(dataDir, name), path.join(archive, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(path.join(dataDir, "source-files"), { recursive: true });
  for (const source of sources.filter(
    (item) =>
      item.kind === "LEGACY" ||
      snapshots.some((snapshot) => snapshot.sourceId === item.id),
  )) {
    const snapshot = snapshots.find((item) => item.sourceId === source.id)!;
    const fileId = randomUUID();
    await writeFile(
      path.join(dataDir, "source-files", fileId + ".txt"),
      JSON.stringify(snapshot.rows),
      { mode: 0o600 },
    );
    await sourceIntegrations.mutate((rows) => {
      const row = rows.find((item) => item.id === source.id);
      if (!row) return;
      row.kind = "JSON";
      row.identityNamespace = "migrated-policy";
      row.name = row.name.replace(/^Legacy\s*[·:\-]?\s*/i, "");
      row.config = { fileId, fileName: "existing-source-data.json" };
      row.fields = row.fields.filter((field) => field !== "legacyEligible");
      row.updatedAt = new Date().toISOString();
    });
    await importStates.mutate((rows) => {
      for (const identity of snapshot.identities) {
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              "migrated-policy",
              identity.sourceKey,
              identity.contactListId,
            ]),
          )
          .digest("hex");
        if (!rows.some((row) => row.id === id)) rows.push({ ...identity, id });
      }
    });
  }
  const now = new Date().toISOString();
  // Existing durable journal entries take precedence over the policy fallback,
  // including UNKNOWN outcomes that must never be retried as new contacts.
  await importStates.mutate((rows) => {
    for (const previous of [...rows]) {
      const oldId = createHash("sha256")
        .update(
          JSON.stringify([
            "legacy-policy",
            previous.sourceKey,
            previous.contactListId,
          ]),
        )
        .digest("hex");
      if (previous.id !== oldId) continue;
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            "migrated-policy",
            previous.sourceKey,
            previous.contactListId,
          ]),
        )
        .digest("hex");
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows[index] = { ...previous, id };
      else rows.push({ ...previous, id });
    }
  });
  for (const mapping of mappings) {
    const previous = templates.find((item) => item.id === mapping.templateId);
    const listId =
      mapping.contactListId ||
      previous?.contactListId ||
      config.contactListId ||
      "";
    if (listId)
      await contactListConfigurations.mutate((rows) => {
        if (
          !rows.some(
            (row) =>
              row.contactListId === listId && row.regionId === config.regionId,
          )
        )
          rows.push({
            id: config.regionId + ":" + listId,
            contactListId: listId,
            name: previous?.name || config.contactListName || listId,
            regionId: config.regionId,
            uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              listId,
            )
              ? listId
              : "",
            uuidSource: "CONTACT_LIST_ID",
            missing: false,
            fields: previous?.fields || [],
            createdAt: now,
            updatedAt: now,
          });
      });
    await sourceMappings.mutate((rows) => {
      const row = rows.find((item) => item.id === mapping.id);
      if (!row) return;
      row.contactListId = listId;
      row.regionId = mapping.regionId || config.regionId;
      row.fields = row.fields.map((field) => {
        const type = previous?.fields.find(
          (item) => item.name === field.targetField,
        );
        return {
          ...field,
          type: field.type || type?.type,
          required: field.required ?? type?.required,
        };
      });
      delete (row as unknown as Record<string, unknown>).templateId;
    });
  }
  for (const name of [
    "contact-templates.json",
    "campaign-lists.json",
    "customers.json",
    "policies.json",
    "products.json",
    "inquiries.json",
    "agent-callbacks.json",
    "genesys-schedule-tasks.json",
    "config/pipeline-migration.json",
    "config/source-upgrade-snapshots.json",
  ]) {
    try {
      await mkdir(path.dirname(path.join(archive, name)), { recursive: true });
      // systemd can expose data and backups as different mounts. Persist the
      // archived copy before removing the active file; rename cannot cross them.
      const archived = path.join(archive, name);
      await copyFile(path.join(dataDir, name), archived);
      const handle = await open(archived, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await unlink(path.join(dataDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(path.join(dataDir, "config"), { recursive: true });
  await writeFile(
    path.join(dataDir, "config/contact-list-workspace-upgrade.json"),
    JSON.stringify({ completedAt: now }),
    { mode: 0o600 },
  );
}
