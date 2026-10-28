import { z } from "zod";
import { contactListConfigurations } from "../domain/pipeline-store";
import type {
  ContactField,
  ContactListConfiguration,
} from "../domain/pipeline-types";
import { httpError } from "../domain/business";
import { audit } from "../domain/store";
import { GenesysConfigService } from "./genesys/genesys-config.service";
import { genesysApiClient } from "./genesys/genesys-api.client";

type RemoteList = {
  id: string;
  name: string;
  columnNames?: string[];
  phoneColumns?: { columnName: string }[];
};
const configService = new GenesysConfigService();
const validUuid = (value: string) => z.string().uuid().safeParse(value).success;
export function contactFields(list: RemoteList): ContactField[] {
  const phones = new Set(
    (list.phoneColumns || []).map((item) => item.columnName),
  );
  return (list.columnNames || []).map((name) => ({
    name,
    type: phones.has(name) ? "PHONE" : "STRING",
    required: phones.has(name),
  }));
}
export async function listConfiguredContactLists() {
  const config = await configService.getConfig();
  return (await contactListConfigurations.all()).filter(
    (item) => item.regionId === config.regionId,
  );
}
export async function refreshContactLists() {
  const config = await configService.getConfig();
  if (!config.enabled || !config.clientId || !config.clientSecretEncrypted)
    throw httpError(
      400,
      "Configure and enable Genesys OAuth under Integration Setting first.",
    );
  const remote: RemoteList[] = [];
  for (let page = 1; page <= 50; page++) {
    const result = await genesysApiClient.get<{
      entities?: RemoteList[];
      pageCount?: number;
      nextUri?: string;
    }>(`/api/v2/outbound/contactlists?pageSize=100&pageNumber=${page}`);
    remote.push(...(result.entities || []));
    if (page >= (result.pageCount || 1) && !result.nextUri) break;
    if (!(result.entities || []).length) break;
    if (page === 50)
      throw httpError(
        413,
        "More than 5,000 Contact Lists returned. Contact your administrator to narrow the Genesys permissions.",
      );
  }
  const current = await configService.getConfig();
  if (
    current.regionId !== config.regionId ||
    current.clientId !== config.clientId
  )
    throw httpError(
      409,
      "Genesys connection changed. Refresh Contact Lists again.",
    );
  const now = new Date().toISOString();
  await contactListConfigurations.mutate((rows) => {
    for (const row of rows.filter((item) => item.regionId === config.regionId))
      row.missing = !remote.some((item) => item.id === row.contactListId);
    for (const list of remote) {
      if (!list.id || !list.name) continue;
      const previous = rows.find(
        (item) =>
          item.regionId === config.regionId && item.contactListId === list.id,
      );
      const fields = contactFields(list);
      if (previous) {
        previous.name = list.name;
        previous.missing = false;
        previous.updatedAt = now;
        if (fields.length) previous.fields = fields;
        // Discovery can fill an empty UUID, but never replace an existing one.
        if (!previous.uuid && validUuid(list.id)) {
          previous.uuid = list.id;
          previous.uuidSource = "CONTACT_LIST_ID";
        }
      } else
        rows.push({
          id: config.regionId + ":" + list.id,
          contactListId: list.id,
          name: list.name,
          regionId: config.regionId,
          uuid: validUuid(list.id) ? list.id : "",
          uuidSource: validUuid(list.id) ? "CONTACT_LIST_ID" : "",
          missing: false,
          fields,
          createdAt: now,
          updatedAt: now,
        });
    }
  });
  await configService.markConnection("SUCCESS");
  return listConfiguredContactLists();
}
export async function configuredContactList(id: string, live = false) {
  const config = await configService.getConfig();
  const row = (await listConfiguredContactLists()).find(
    (item) => item.contactListId === id,
  );
  if (!row?.uuid)
    throw httpError(
      409,
      "This Contact List has no configured UUID. Open Genesys Configuration → Contact List Configuration first.",
    );
  if (row.missing)
    throw httpError(
      409,
      "This Contact List is no longer available in the current Genesys connection. Refresh Contact List Configuration.",
    );
  if (!live && row.fields.length) return row;
  const remote = await genesysApiClient.get<RemoteList>(
    `/api/v2/outbound/contactlists/${encodeURIComponent(row.uuid)}`,
  );
  if (remote.id !== row.uuid)
    throw httpError(
      409,
      "Genesys returned a different Contact List ID. Verify the configured UUID before importing.",
    );
  const fields = contactFields(remote);
  if (!fields.length)
    throw httpError(400, "The Genesys Contact List has no columns configured.");
  const latestConfig = await configService.getConfig();
  if (
    latestConfig.regionId !== config.regionId ||
    latestConfig.clientId !== config.clientId
  )
    throw httpError(
      409,
      "Genesys configuration changed. Refresh the Contact List.",
    );
  await contactListConfigurations.mutate((rows) => {
    const current = rows.find((item) => item.id === row.id);
    if (!current || current.uuid !== row.uuid)
      throw httpError(409, "The UUID changed. Refresh before importing.");
    current.fields = fields;
    current.name = remote.name;
    current.updatedAt = new Date().toISOString();
  });
  return { ...row, fields, name: remote.name };
}
export async function saveContactListUuid(
  id: string,
  input: unknown,
  actor: string,
) {
  const value = z
    .object({
      uuid: z.string().uuid(),
      confirmation: z.literal(true),
      expectedUuid: z.string().max(200),
    })
    .parse(input);
  const config = await configService.getConfig();
  const previous = (await listConfiguredContactLists()).find(
    (item) => item.contactListId === id,
  );
  if (!previous)
    throw httpError(
      404,
      "Refresh Contact Lists from Genesys before configuring a UUID.",
    );
  if (validUuid(id) && value.uuid !== id)
    throw httpError(
      400,
      "Genesys Outbound uses Contact List ID as its UUID. The UUID must match this Contact List ID to avoid syncing another list.",
    );
  const remote = await genesysApiClient.get<RemoteList>(
    `/api/v2/outbound/contactlists/${encodeURIComponent(value.uuid)}`,
  );
  if (
    remote.id !== value.uuid ||
    (remote.id !== id && remote.name !== previous.name)
  )
    throw httpError(400, "This UUID belongs to a different Contact List.");
  const latest = await configService.getConfig();
  if (
    latest.regionId !== config.regionId ||
    latest.clientId !== config.clientId
  )
    throw httpError(
      409,
      "Genesys configuration changed. Refresh before saving.",
    );
  await contactListConfigurations.mutate((rows) => {
    const row = rows.find((item) => item.id === previous.id);
    if (!row || row.uuid !== value.expectedUuid)
      throw httpError(
        409,
        "UUID configuration changed since this editor was opened. Refresh before saving.",
      );
    row.uuid = value.uuid;
    row.uuidSource = "MANUAL";
    row.fields = contactFields(remote);
    row.missing = false;
    row.updatedAt = new Date().toISOString();
  });
  await audit("SAVE_CONTACT_LIST_UUID", actor, id);
  return configuredContactList(id);
}
