import { randomUUID } from "node:crypto";
import { importJobs, importStates } from "../domain/pipeline-store";
import { httpError } from "../domain/business";
import { audit } from "../domain/store";
import type {
  ImportJob,
  ImportState,
  LeadPreview,
  LeadRow,
} from "../domain/pipeline-types";
import { resolveLead, contactList, contactHash } from "./lead-pipeline.service";
import {
  genesysApiClient,
  GenesysApiError,
} from "./genesys/genesys-api.client";
import { GenesysConfigService } from "./genesys/genesys-config.service";

let activeJob = "";
const running = new Map<string, Promise<void>>();
export const hasActiveImport = () => Boolean(activeJob);
export async function exclusiveDestinationAction<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (activeJob)
    throw httpError(409, "Wait for active imports to finish first");
  activeJob = "MAINTENANCE";
  try {
    return await action();
  } finally {
    activeJob = "";
  }
}
export async function clearLeadDestination(id: string, actor: string) {
  return exclusiveDestinationAction(async () => {
    const destination = await contactList(id);
    const result = await genesysApiClient.post<Record<string, unknown>>(
      `/api/v2/outbound/contactlists/${destination.id}/clear`,
      {},
    );
    await importStates.mutate((rows) => {
      for (let index = rows.length - 1; index >= 0; index--)
        if (rows[index].contactListId === destination.id) rows.splice(index, 1);
    });
    return {
      ...result,
      message:
        "Contact List cleared. Local lead contact identities have been reset for this destination.",
    };
  });
}
type Destination = Awaited<ReturnType<typeof contactList>>;
const eligible = (row: LeadRow) =>
  ["ELIGIBLE", "UPDATE_AVAILABLE"].includes(row.status);

async function writeState(state: ImportState) {
  await importStates.set(state);
}
async function syncRow(
  row: LeadRow,
  preview: LeadPreview,
  destination: Destination,
  actor: string,
) {
  const timestamp = new Date().toISOString();
  const previous = await importStates.findById("id", row.id);
  if (previous && ["PENDING", "UNKNOWN"].includes(previous.status))
    throw new Error(
      "Previous creation outcome is unknown; reconcile the contact first",
    );
  const hash = contactHash(row.data);
  if (previous?.status === "SYNCED" && previous.payloadHash === hash)
    return "SKIPPED";
  const state: ImportState = {
    id: row.id,
    mappingId: preview.mapping.id,
    sourceKey: row.sourceKey,
    contactListId: destination.id,
    contactId: previous?.contactId || row.contactId || "",
    payloadHash: previous?.payloadHash || "",
    status: "PENDING",
    message: "Import request in progress",
    updatedAt: timestamp,
  };
  const base = `/api/v2/outbound/contactlists/${encodeURIComponent(destination.id)}/contacts`;
  const updating = Boolean(state.contactId);
  await writeState(state);
  try {
    if (updating) {
      const existing = await genesysApiClient.get<{
        id: string;
        data: Record<string, string>;
        [key: string]: unknown;
      }>(`${base}/${encodeURIComponent(state.contactId)}`);
      await genesysApiClient.put(
        `${base}/${encodeURIComponent(state.contactId)}`,
        { ...existing, data: { ...existing.data, ...row.data } },
      );
    } else {
      const created = await genesysApiClient.post<unknown>(base, [
        { data: row.data, callable: true },
      ]);
      const result = Array.isArray(created)
        ? created[0]
        : (created as { entities?: unknown[]; contacts?: unknown[] })
            ?.entities?.[0] ||
          (created as { contacts?: unknown[] })?.contacts?.[0] ||
          created;
      const contactId = (result as { id?: string })?.id;
      if (!contactId)
        throw new Error(
          "Genesys did not return a contact ID. Reconcile the contact before retrying.",
        );
      state.contactId = contactId;
      // Persist the remote identity before any subsequent verification request.
      await writeState(state);
    }
    state.status = "SYNCED";
    state.payloadHash = hash;
    state.message = updating ? "Contact updated" : "Contact created";
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    return updating ? "UPDATED" : "CREATED";
  } catch (error) {
    const rejected =
      error instanceof GenesysApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408;
    state.status =
      updating || state.contactId || rejected ? "FAILED" : "UNKNOWN";
    state.message =
      state.status === "UNKNOWN"
        ? "Creation outcome is unknown. Reconcile this contact in Genesys before retrying to avoid duplicates."
        : error instanceof GenesysApiError
          ? `Genesys rejected the request (HTTP ${error.status})`
          : "Contact update failed. Retry after checking the destination.";
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    throw new Error(state.message);
  }
}

async function execute(
  job: ImportJob,
  preview: LeadPreview,
  rows: LeadRow[],
  destination: Destination,
  actor: string,
) {
  try {
    const importOne = async (row: LeadRow) => {
      let status = "FAILED",
        message = "";
      try {
        status = await syncRow(row, preview, destination, actor);
        if (status === "CREATED") job.created++;
        else if (status === "UPDATED") job.updated++;
        else job.skipped++;
        message =
          status === "CREATED"
            ? "Contact created"
            : status === "UPDATED"
              ? "Contact updated"
              : "Already synchronized";
      } catch (error) {
        job.failed++;
        message = (error as Error).message;
      }
      job.processed++;
      job.results.push({
        id: row.id,
        sourceKey: row.sourceKey,
        status,
        message,
      });
      if (job.results.length > 200) job.results.shift();
      job.message = `Processed ${job.processed} / ${job.total}`;
      if (
        job.processed === 1 ||
        job.processed % 10 === 0 ||
        job.processed === job.total
      )
        await importJobs.mutate((jobs) => {
          const index = jobs.findIndex((item) => item.id === job.id);
          if (index >= 0) jobs[index] = { ...job };
        });
    };
    for (let index = 0; index < rows.length; index += 3)
      await Promise.all(rows.slice(index, index + 3).map(importOne));
    job.status = job.failed
      ? job.failed === job.total
        ? "FAILED"
        : "PARTIAL"
      : "SUCCESS";
    job.message = `${job.created} created · ${job.updated} updated · ${job.skipped} skipped · ${job.failed} failed`;
  } catch {
    job.status = "FAILED";
    job.message =
      "Import interrupted by a local storage or server error; review contact states before retrying.";
  } finally {
    job.finishedAt = new Date().toISOString();
    try {
      await importJobs.mutate((jobs) => {
        const index = jobs.findIndex((item) => item.id === job.id);
        if (index >= 0) jobs[index] = { ...job };
      });
      await audit("IMPORT_LEAD_CONFIGURATION", actor, job.id, {
        leadId: job.leadId,
        contactListId: job.contactListId,
        total: job.total,
        created: job.created,
        updated: job.updated,
        failed: job.failed,
      });
    } finally {
      activeJob = "";
      running.delete(job.id);
    }
  }
}

export async function startImport(
  input: {
    leadId: string;
    contactListId: string;
    recordIds?: string[];
    revision?: string;
  },
  actor: string,
  scheduleId = "",
) {
  if (activeJob)
    throw httpError(409, "Another import is running. Wait for it to finish.");
  activeJob = "PREPARING";
  try {
    const config = await new GenesysConfigService().getConfig();
    if (!config.enabled || !config.clientId || !config.clientSecretEncrypted)
      throw httpError(400, "Configure and enable Genesys integration first");
    const [preview, destination] = await Promise.all([
      resolveLead(input.leadId, input.contactListId),
      contactList(input.contactListId),
    ]);
    if (preview.truncated)
      throw httpError(
        400,
        "Source exceeds the 10,000 row or response limit. Narrow the source query before importing all records.",
      );
    if (input.revision && input.revision !== preview.revision)
      throw httpError(
        409,
        "Source data or configuration changed. Refresh the preview before importing.",
      );
    const templateFields = new Set(
      preview.destination.fields.map((field) => field.name),
    );
    if (
      !destination.columnNames?.length ||
      destination.columnNames.some((field) => !templateFields.has(field)) ||
      preview.fields.some((field) => !destination.columnNames.includes(field))
    )
      throw httpError(
        400,
        "Mapping fields no longer match the Genesys Contact List. Refresh Contact List Configuration and edit this mapping.",
      );
    const phoneColumns = destination.phoneColumns || [];
    if (!phoneColumns.length)
      throw httpError(
        400,
        "The destination Contact List must contain a configured phone column",
      );
    const selected = input.recordIds ? new Set(input.recordIds) : null;
    if (
      selected &&
      [...selected].some(
        (id) => !preview.rows.some((row) => row.id === id && eligible(row)),
      )
    )
      throw httpError(
        409,
        "Some selected records are no longer eligible. Refresh the preview.",
      );
    const rows = preview.rows.filter(
      (row) => eligible(row) && (!selected || selected.has(row.id)),
    );
    for (const row of rows) {
      if (
        !phoneColumns.some((column) =>
          /^\+?[1-9]\d{7,14}$/.test(
            row.data[column.columnName]?.replace(/[\s().-]/g, "") || "",
          ),
        )
      )
        throw httpError(
          400,
          `Record ${row.sourceKey} has no valid destination phone number`,
        );
    }
    const job: ImportJob = {
      id: randomUUID(),
      leadId: preview.lead.id,
      leadName: preview.lead.name,
      sourceId: preview.mapping.sourceId,
      contactListId: input.contactListId,
      scheduleId,
      status: "RUNNING",
      total: rows.length,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      message: "Import starting",
      results: [],
      createdAt: new Date().toISOString(),
      finishedAt: "",
    };
    await importJobs.mutate((jobs) => {
      jobs.push(job);
      if (jobs.length > 100) jobs.splice(0, jobs.length - 100);
    });
    activeJob = job.id;
    const work = execute(
      { ...job, results: [] },
      preview,
      rows,
      destination,
      actor,
    );
    running.set(job.id, work);
    void work.catch((error) => {
      console.error("Lead import storage failure", (error as Error).name);
    });
    return job;
  } catch (error) {
    activeJob = "";
    throw error;
  }
}
export async function awaitImport(id: string) {
  await running.get(id);
  const job = await importJobs.findById("id", id);
  if (!job) throw httpError(404, "Import job not found");
  return job;
}

export async function reconcileContact(
  id: string,
  contactId: string,
  actor: string,
) {
  const state = await importStates.findById("id", id);
  if (!state) throw httpError(404, "Import state not found");
  if (hasActiveImport())
    throw httpError(409, "Wait for the active import to finish");
  if (!contactId.trim())
    throw httpError(
      400,
      "Enter the existing Genesys Contact ID after checking the destination list",
    );
  const remote = await genesysApiClient.get<{ id: string }>(
    `/api/v2/outbound/contactlists/${encodeURIComponent(state.contactListId)}/contacts/${encodeURIComponent(contactId)}`,
  );
  if (remote.id !== contactId)
    throw httpError(400, "Contact not found in this list");
  await writeState({
    ...state,
    contactId,
    status: "FAILED",
    message: "Remote identity reconciled; ready to update",
    updatedAt: new Date().toISOString(),
  });
  await audit("RECONCILE_LEAD_CONTACT", actor, id);
}
