import { Router } from "express";
import { requireAdmin } from "../middleware/require-admin";
import { GenesysConfigService } from "../services/genesys/genesys-config.service";
import { genesysApiClient } from "../services/genesys/genesys-api.client";
import { genesysRegionService } from "../services/genesys/genesys-region.service";
import { encryptSecret } from "../services/genesys/secret.service";
import type { GenesysConfig } from "../services/genesys/types";
import { z } from "zod";
export const genesysAdminRouter = Router();
const configService = new GenesysConfigService();
genesysAdminRouter.use(requireAdmin);
genesysAdminRouter.get("/regions", async (_request, response, next) => {
  try {
    response.json({ regions: await genesysRegionService.listRegions() });
  } catch (error) {
    next(error);
  }
});

genesysAdminRouter.get(
  "/regions/:regionId",
  async (request, response, next) => {
    try {
      response.json({
        region: await genesysRegionService.getRegion(request.params.regionId),
        history: await genesysRegionService.getHistory(request.params.regionId),
      });
    } catch (error) {
      next(error);
    }
  },
);

genesysAdminRouter.post("/regions", async (request, response, next) => {
  try {
    const region = await genesysRegionService.createCustomRegion(
      request.body,
      request.user?.name,
    );
    response.status(201).json({ region });
  } catch (error) {
    next(error);
  }
});

genesysAdminRouter.put(
  "/regions/:regionId",
  async (request, response, next) => {
    try {
      const region = await genesysRegionService.updateRegion(
        request.params.regionId,
        request.body,
        request.user?.name,
      );
      response.json({ region });
    } catch (error) {
      next(error);
    }
  },
);

genesysAdminRouter.post(
  "/regions/:regionId/test",
  async (request, response, next) => {
    try {
      response.json({
        regionId: request.params.regionId,
        results:
          Object.keys(request.body ?? {}).length > 0
            ? await genesysRegionService.validateEndpointValues(request.body)
            : await genesysRegionService.validateEndpoints(
                request.params.regionId,
              ),
      });
    } catch (error) {
      next(error);
    }
  },
);

genesysAdminRouter.post(
  "/regions/:regionId/reset",
  async (request, response, next) => {
    try {
      response.json({
        region: await genesysRegionService.resetRegion(
          request.params.regionId,
          request.user?.name,
        ),
      });
    } catch (error) {
      next(error);
    }
  },
);

genesysAdminRouter.delete(
  "/regions/:regionId",
  async (request, response, next) => {
    try {
      await genesysRegionService.deleteRegion(request.params.regionId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

genesysAdminRouter.get("/config", async (_request, response, next) => {
  try {
    const config = await configService.getConfig();
    const activeRegion = await genesysRegionService.getActiveRegion();
    const regions = await genesysRegionService.listRegions();
    response.json({
      config: serializeConfig(config),
      activeRegion,
      enabledRegions: regions.filter((region) => region.enabled),
    });
  } catch (error) {
    next(error);
  }
});

genesysAdminRouter.put("/config", async (request, response, next) => {
  try {
    const body = z
      .object({
        enabled: z.boolean(),
        regionId: z.string().min(1),
        clientId: z.string().trim().max(500),
        clientSecret: z.string().max(5000).optional(),
      })
      .parse(request.body);
    if (body.regionId) {
      const region = await genesysRegionService.getRegion(body.regionId);
      if (!region.enabled) {
        response.status(400).json({ message: "Selected region is disabled" });
        return;
      }
    }
    const update: Partial<GenesysConfig> = {
      enabled: body.enabled,
      regionId: body.regionId,
      clientId: body.clientId,
    };
    if (body.clientSecret !== undefined) {
      update.clientSecretEncrypted = encryptSecret(body.clientSecret);
    }

    const config = await configService.updateConfig(update, request.user?.name);
    response.json({
      config: serializeConfig(config),
      activeRegion: await genesysRegionService.getActiveRegion(),
      enabledRegions: (await genesysRegionService.listRegions()).filter(
        (region) => region.enabled,
      ),
    });
  } catch (error) {
    next(error);
  }
});

genesysAdminRouter.post("/test-connection", async (request, response) => {
  try {
    const draft = z
      .object({
        regionId: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      })
      .parse(request.body || {});
    await genesysApiClient.getAccessToken(draft);
    await genesysApiClient.get(
      "/api/v2/outbound/contactlists?pageSize=1",
      draft,
    );
    const saved = await configService.getConfig();
    const isSaved =
      (!draft.regionId || draft.regionId === saved.regionId) &&
      (!draft.clientId || draft.clientId === saved.clientId) &&
      !draft.clientSecret;
    const config = isSaved
      ? await configService.markConnection("SUCCESS")
      : saved;
    response.json({
      ok: true,
      config: serializeConfig(config),
      message: isSaved
        ? "Connection verified"
        : "Draft connection verified; save to apply",
    });
  } catch (error) {
    const config =
      request.body && Object.keys(request.body).length
        ? await configService.getConfig()
        : await configService.markConnection("FAILED");
    response.status(400).json({
      ok: false,
      config: serializeConfig(config),
      message:
        error instanceof Error ? error.message : "Connection test failed",
    });
  }
});

function serializeConfig(config: GenesysConfig) {
  return {
    ...config,
    clientSecretEncrypted: undefined,
    secretConfigured: Boolean(config.clientSecretEncrypted),
  };
}
