import { systemStatus } from "../services/system-status.service";
import {
  saveContactListUuid,
  configuredContactList,
} from "../services/contact-list.service";
import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/require-admin";
import {
  bootstrapPipeline,
  saveSource,
  saveMapping,
  saveLead,
  deleteConfiguration,
  previewSource,
  contactLists,
  contactList,
  resolveLead,
  resolveFileImport,
  inspectFileImport,
  entity,
  publicSource,
} from "../services/lead-pipeline.service";
import {
  browseLocal,
  browseRemote,
  testRemoteConnection,
} from "../services/file-source.service";
import { encryptSecret } from "../services/genesys/secret.service";
import {
  sourceIntegrations,
  importJobs,
  leadDefinitions,
} from "../domain/pipeline-store";
import { loadSource } from "../services/source-data.service";
import {
  startImport,
  startFileImport,
  reconcileContact,
  clearLeadDestination,
  exclusiveDestinationAction,
} from "../services/lead-import.service";
import {
  saveSchedule,
  deleteSchedule,
  runSchedule,
} from "../services/lead-schedule.service";
import { GenesysConfigService } from "../services/genesys/genesys-config.service";
import type { SourceIntegration } from "../domain/pipeline-types";
import type { SourceConfig } from "../domain/pipeline-types";

export const pipelineRouter = Router();
pipelineRouter.use(requireAdmin);
const fileConnection = z
  .object({
    sourceId: z.string().uuid().optional(),
    config: z
      .object({
        fileLocation: z.enum(["SERVER", "REMOTE"]).optional(),
        serverPath: z.string().max(2000).optional(),
        transferProtocol: z.enum(["SCP", "SFTP", "FTP", "FTPS"]).optional(),
        host: z.string().max(253).optional(),
        sshHostKeyFingerprint: z.string().max(128).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().max(200).optional(),
        remotePath: z.string().max(2000).optional(),
        authMethod: z.enum(["PASSWORD", "KEY"]).optional(),
        allowInsecureFtp: z.boolean().optional(),
      })
      .strict(),
    secret: z.string().max(8000).optional(),
    passphrase: z.string().max(1000).optional(),
    path: z.string().max(2000).optional(),
  })
  .strict();
function configuredRemoteSecret(
  incoming: string | undefined,
  passphrase: string | undefined,
  previous: SourceIntegration | undefined,
  config: Pick<
    SourceConfig,
    | "host"
    | "port"
    | "username"
    | "transferProtocol"
    | "authMethod"
    | "sshHostKeyFingerprint"
  >,
) {
  if (incoming)
    return encryptSecret(
      JSON.stringify({ secret: incoming, passphrase: passphrase || "" }),
    );
  if (
    previous &&
    ["CSV", "JSON"].includes(previous.kind) &&
    previous.config.fileLocation === "REMOTE" &&
    previous.config.host === config.host &&
    previous.config.port === config.port &&
    previous.config.username === config.username &&
    previous.config.transferProtocol === config.transferProtocol
  ) {
    if (
      (previous.config.authMethod || "PASSWORD") ===
      (config.authMethod || "PASSWORD")
    )
      return previous.secretEncrypted;
  }
  return "";
}
pipelineRouter.post(
  "/sources/files/local/browse",
  async (request, response) => {
    const data = z
      .object({ path: z.string().max(2000).optional() })
      .parse(request.body);
    response.json(await browseLocal(data.path || ""));
  },
);
pipelineRouter.post("/sources/files/remote/test", async (request, response) => {
  const data = fileConnection.parse(request.body);
  const previous = data.sourceId
    ? await entity(sourceIntegrations, data.sourceId)
    : undefined;
  const secretEncrypted = configuredRemoteSecret(
    data.secret,
    data.passphrase,
    previous,
    data.config,
  );
  response.json(await testRemoteConnection(data.config, secretEncrypted));
});
pipelineRouter.post(
  "/sources/files/remote/browse",
  async (request, response) => {
    const data = fileConnection.parse(request.body);
    const previous = data.sourceId
      ? await entity(sourceIntegrations, data.sourceId)
      : undefined;
    const secretEncrypted = configuredRemoteSecret(
      data.secret,
      data.passphrase,
      previous,
      data.config,
    );
    response.json(await browseRemote(data.config, secretEncrypted, data.path));
  },
);
pipelineRouter.get("/status", async (_req, res) =>
  res.json(await systemStatus()),
);
pipelineRouter.post("/status/refresh", async (_req, res) =>
  res.json(await systemStatus(true)),
);
pipelineRouter.put("/contact-lists/:id/uuid", async (req, res) =>
  res.json(await saveContactListUuid(req.params.id, req.body, req.user!.name)),
);
pipelineRouter.get("/bootstrap", async (_request, response) =>
  response.json(await bootstrapPipeline()),
);
pipelineRouter.get("/contact-lists", async (_request, response) =>
  response.json({
    items: (await contactLists()).map((row) => ({
      ...row,
      id: row.contactListId,
    })),
  }),
);
pipelineRouter.get("/contact-lists/:id", async (req, res) =>
  res.json(await configuredContactList(req.params.id, true)),
);
pipelineRouter.post("/contact-lists/:id/clear", async (request, response) => {
  z.object({ confirmation: z.literal("CLEAR") }).parse(request.body);
  const id = z.string().min(1).max(200).parse(request.params.id);
  response.json(await clearLeadDestination(id, request.user!.name));
});
pipelineRouter.post("/sources/preview", async (request, response) =>
  response.json(
    await previewSource(
      request.body.source,
      undefined,
      request.body.connectOnly === true,
    ),
  ),
);
pipelineRouter.get("/sources/:id", async (request, response) =>
  response.json(
    publicSource(await entity(sourceIntegrations, request.params.id)),
  ),
);
pipelineRouter.post("/sources/:id/preview", async (request, response) => {
  const data = await loadSource(
    await entity(sourceIntegrations, request.params.id),
    request.body?.connectOnly === true,
  );
  response.json({
    ...data,
    rows: data.rows.slice(0, 100),
    previewCount: Math.min(100, data.rows.length),
  });
});
const handlers = {
  sources: saveSource,
  mappings: saveMapping,
  leads: saveLead,
};
for (const [kind, handler] of Object.entries(handlers)) {
  pipelineRouter.post(`/${kind}`, async (request, response) =>
    response.status(201).json(await handler(request.body, request.user!.name)),
  );
  pipelineRouter.put(`/${kind}/:id`, async (request, response) =>
    response.json(
      await handler(request.body, request.user!.name, request.params.id),
    ),
  );
  pipelineRouter.delete(`/${kind}/:id`, async (request, response) => {
    const force = kind === "leads" && request.query.force === "true";
    const remove = async () => {
      if (force) {
        const { confirmation } = z
          .object({ confirmation: z.string().trim().min(1).max(120) })
          .parse(request.body);
        const existing = await entity(leadDefinitions, request.params.id);
        if (confirmation !== existing.name)
          throw Object.assign(
            new Error("Lead Configuration name confirmation does not match"),
            { status: 400 },
          );
      }
      return deleteConfiguration(
        kind,
        request.params.id,
        request.user!.name,
        force,
      );
    };
    const result =
      kind === "leads"
        ? await exclusiveDestinationAction(remove)
        : await remove();
    if (force) {
      response.json(result);
      return;
    }
    response.status(204).end();
  });
}
pipelineRouter.get("/leads/:id/preview", async (request, response) => {
  const listId = request.query.contactListId
    ? z.string().min(1).max(200).parse(request.query.contactListId)
    : "";
  const preview = await resolveLead(request.params.id, listId);
  response.json({
    ...preview,
    rows: preview.rows.map(({ source, ...row }) => row),
  });
});
pipelineRouter.get("/leads/:id/export", async (request, response) => {
  const preview = await resolveLead(request.params.id);
  const cell = (value: string) =>
    `"${(/^[=+@\-\t\r]/.test(value) ? "'" : "") + value.replace(/"/g, '""')}"`;
  const lines = [
    preview.fields.map(cell).join(","),
    ...preview.rows
      .filter((row) =>
        ["ELIGIBLE", "UPDATE_AVAILABLE", "ALREADY_SYNCED"].includes(row.status),
      )
      .map((row) =>
        preview.fields.map((field) => cell(row.data[field] || "")).join(","),
      ),
  ];
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader(
    "Content-Disposition",
    'attachment; filename="lead-export.csv"',
  );
  response.send("\uFEFF" + lines.join("\r\n") + "\r\n");
});
const fileImportInput = z
  .object({
    contactListId: z.string().trim().min(1).max(200),
    fileName: z.string().trim().min(1).max(255),
    content: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
    keyField: z.string().trim().min(1).max(128).optional(),
    revision: z.string().max(100).optional(),
    reimport: z.boolean().optional(),
  })
  .strict();
pipelineRouter.post("/file-import/inspect", async (request, response) => {
  const data = fileImportInput
    .pick({ contactListId: true, fileName: true, content: true })
    .parse(request.body);
  response.json(
    await inspectFileImport(data.contactListId, data.fileName, data.content),
  );
});
pipelineRouter.post("/file-import/preview", async (request, response) => {
  const data = fileImportInput
    .pick({
      contactListId: true,
      fileName: true,
      content: true,
      keyField: true,
    })
    .required({ keyField: true })
    .parse(request.body);
  const preview = await resolveFileImport(
    data.contactListId,
    data.fileName,
    data.content,
    data.keyField,
  );
  response.json({
    ...preview,
    rows: preview.rows.slice(0, 100),
    previewCount: Math.min(100, preview.rows.length),
  });
});
pipelineRouter.post("/file-import", async (request, response) => {
  const data = fileImportInput
    .required({ keyField: true, revision: true })
    .parse(request.body);
  response.status(202).json(
    await startFileImport(
      data as z.infer<typeof fileImportInput> & {
        keyField: string;
        revision: string;
      },
      request.user!.name,
    ),
  );
});
pipelineRouter.post("/imports", async (request, response) => {
  const data = z
    .object({
      leadId: z.string().uuid(),
      contactListId: z.string().min(1).max(200),
      revision: z.string().max(100).optional(),
      recordIds: z.array(z.string().max(100)).min(1).max(10000).optional(),
      reimport: z.boolean().optional(),
    })
    .parse(request.body);
  response.status(202).json(await startImport(data, request.user!.name));
});
pipelineRouter.get("/imports/:id", async (request, response) => {
  const job = await importJobs.findById("id", request.params.id);
  response
    .status(job ? 200 : 404)
    .json(job || { message: "Import job not found" });
});
pipelineRouter.post("/imports/reconcile/:id", async (request, response) => {
  const data = z
    .object({ contactId: z.string().trim().min(1).max(200) })
    .parse(request.body);
  await reconcileContact(request.params.id, data.contactId, request.user!.name);
  response.status(204).end();
});
pipelineRouter.post("/schedules", async (request, response) =>
  response
    .status(201)
    .json(await saveSchedule(request.body, request.user!.name)),
);
pipelineRouter.put("/schedules/:id", async (request, response) =>
  response.json(
    await saveSchedule(request.body, request.user!.name, request.params.id),
  ),
);
pipelineRouter.delete("/schedules/:id", async (request, response) => {
  await deleteSchedule(request.params.id, request.user!.name);
  response.status(204).end();
});
pipelineRouter.post("/schedules/:id/run", async (request, response) => {
  const result = await runSchedule(request.params.id, request.user!.name);
  response.json(result);
});
