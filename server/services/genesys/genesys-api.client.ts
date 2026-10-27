import { GenesysConfigService } from "./genesys-config.service";
import { genesysRegionService } from "./genesys-region.service";
import { decryptSecret } from "./secret.service";
import { tokenCacheService } from "./token-cache.service";
import type { GenesysConfig } from "./types";

export class GenesysApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionDraft = {
  regionId?: string;
  clientId?: string;
  clientSecret?: string;
};

export class GenesysApiClient {
  constructor(private readonly configService = new GenesysConfigService()) {}

  private async region(config: GenesysConfig) {
    const region = await genesysRegionService.getRegion(config.regionId);
    if (!region.enabled) throw new Error("Selected Genesys region is disabled");
    return region;
  }

  async getAccessToken(draft?: ConnectionDraft): Promise<string> {
    const config = await this.configService.getConfig();
    const regionId = draft?.regionId || config.regionId;
    const clientId = draft?.clientId ?? config.clientId;
    const secret =
      draft?.clientSecret || decryptSecret(config.clientSecretEncrypted);
    const useCache =
      !draft?.regionId && !draft?.clientId && !draft?.clientSecret;
    const cached = useCache ? tokenCacheService.get(regionId) : null;
    if (cached) return cached;
    if (!clientId || !secret)
      throw new Error(
        "Client ID and Client Secret are required before testing the Genesys connection.",
      );
    const region = await this.region({ ...config, regionId });
    const response = await fetch(joinUrl(region.authBaseUrl, "/oauth/token"), {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!response.ok)
      throw new GenesysApiError(
        response.status,
        `Genesys OAuth failed with HTTP ${response.status}`,
      );
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token)
      throw new Error(
        "Genesys OAuth response did not include an access token.",
      );
    if (useCache)
      tokenCacheService.set(
        regionId,
        body.access_token,
        Math.max(60, (body.expires_in ?? 3600) - 60),
      );
    return body.access_token;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    endpoint: string,
    body?: unknown,
    draft?: ConnectionDraft,
  ): Promise<T> {
    const config = await this.configService.getConfig();
    const region = await this.region({
      ...config,
      regionId: draft?.regionId || config.regionId,
    });
    const url = joinUrl(region.apiBaseUrl, endpoint);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.getAccessToken(draft);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (method !== "POST" && attempt < 2) {
          await delay(250 * (attempt + 1));
          continue;
        }
        throw error;
      }
      if (response.ok) {
        if (response.status === 204) return null as T;
        const payload = await response.text();
        return (payload ? JSON.parse(payload) : null) as T;
      }
      if (response.status === 401 && !draft && attempt === 0) {
        tokenCacheService.clear();
        continue;
      }
      if (
        method !== "POST" &&
        [429, 502, 503, 504].includes(response.status) &&
        attempt < 2
      ) {
        const retryAfter = Number(response.headers.get("Retry-After") || 0);
        await delay(
          retryAfter > 0 && retryAfter < 10
            ? retryAfter * 1000
            : 300 * (attempt + 1),
        );
        continue;
      }
      let reason = "";
      try {
        const payload = (await response.json()) as {
          message?: string;
          error?: string;
        };
        reason = payload.message || payload.error || "";
      } catch {
        /* Genesys may return plain text. */
      }
      throw new GenesysApiError(
        response.status,
        `Genesys API HTTP ${response.status}${reason ? `: ${reason.slice(0, 300)}` : ""}`,
      );
    }
    throw new Error("Genesys API request failed after retries");
  }

  get<T = unknown>(endpoint: string, draft?: ConnectionDraft): Promise<T> {
    return this.request<T>("GET", endpoint, undefined, draft);
  }
  post<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>("POST", endpoint, body);
  }
  put<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", endpoint, body);
  }
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export const genesysApiClient = new GenesysApiClient();
