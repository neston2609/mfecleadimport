let cachedToken: {
  regionId: string;
  accessToken: string;
  expiresAt: number;
} | null = null;

export const tokenCacheService = {
  get(regionId: string) {
    if (
      !cachedToken ||
      cachedToken.regionId !== regionId ||
      cachedToken.expiresAt <= Date.now()
    ) {
      return null;
    }
    return cachedToken.accessToken;
  },
  set(regionId: string, accessToken: string, ttlSeconds: number) {
    cachedToken = {
      regionId,
      accessToken,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  },
  clear() {
    cachedToken = null;
  },
};
