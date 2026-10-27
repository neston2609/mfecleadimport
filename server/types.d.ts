declare global {
  namespace Express {
    interface Request {
      user?: {
        name: string;
      };
    }
  }
}

export {};

declare module "express-session" {
  interface SessionData {
    admin?: string;
    adminCredentialVersion?: string;
    adminPortals?: ("manage" | "genesys")[];
  }
}
