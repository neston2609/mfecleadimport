import "dotenv/config";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import { ZodError } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { genesysAdminRouter } from "./routes/genesys-admin.routes";
import { adminDataRouter } from "./routes/admin-data.routes";
import { authRouter } from "./routes/auth.routes";
import { campaignRouter } from "./routes/campaign.routes";
import { initializeBusinessData } from "./domain/store";
import { FileSessionStore } from "./middleware/file-session-store";
import { genesysRegionService } from "./services/genesys/genesys-region.service";
import { adminCredentials } from "./services/admin-credentials.service";
import { genesysSchedulerService } from "./services/genesys/genesys-scheduler.service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3002);
const host =
  process.env.HOST ||
  (process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");

app.disable("x-powered-by");
app.set("trust proxy", "loopback");

if (process.env.NODE_ENV === "production" && !process.env.APP_SECRET) {
  throw new Error("APP_SECRET must be configured in production");
}
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be configured in production");
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    name: "genesys.sid",
    store: new FileSessionStore(),
    secret: process.env.SESSION_SECRET || "development-only-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);
app.use("/api/admin", (request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const origin = request.get("Origin");
  const hostHeader = request.get("Host");
  let sameOrigin = !origin;
  if (origin) {
    try {
      const source = new URL(origin);
      const target = new URL(`${request.protocol}://${hostHeader}`);
      sameOrigin =
        source.host === target.host ||
        (process.env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1"].includes(source.hostname) &&
          ["localhost", "127.0.0.1"].includes(target.hostname));
    } catch {
      sameOrigin = false;
    }
  }
  if (!sameOrigin) {
    response
      .status(403)
      .json({ message: "Cross-origin admin request blocked" });
    return;
  }
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "mfec-lead-import-export",
    time: new Date().toISOString(),
  });
});

app.use("/api/admin/genesys", genesysAdminRouter);
app.use("/api/admin/auth", authRouter);
app.use("/api/admin/campaigns", campaignRouter);
app.use("/api/admin", adminDataRouter);
app.use("/api", (_request, response) =>
  response.status(404).json({ message: "API endpoint not found" }),
);

app.use(["/manage"], (_request, response) => {
  response.status(404).send("Page not found");
});
app.use("/genesys", (request, response) => {
  const target = request.originalUrl
    .replace(/^\/genesys(?=\/|\?|$)/i, "")
    .replace(/^\/+/, "/");
  response.redirect(308, target.startsWith("/") ? target : `/${target}`);
});

if (process.env.NODE_ENV === "production") {
  const clientDir = path.resolve(__dirname, "..", "dist", "client");
  app.use(express.static(clientDir));
  app.use((_request, response) => {
    response.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use(
  (
    error: Error & { status?: number },
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        message: error.issues[0]?.message || "Invalid input",
        issues: error.issues,
      });
      return;
    }
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    response.status(status).json({
      message: status >= 500 ? "Unexpected server error" : error.message,
    });
  },
);

await adminCredentials.initialize();
await genesysRegionService.initialize();
await initializeBusinessData();
await genesysSchedulerService.start();

app.listen(port, host, () => {
  console.log(`genesys listening on ${host}:${port}`);
});
