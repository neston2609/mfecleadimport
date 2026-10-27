import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { audit } from "../domain/store";
import { requireAdmin } from "../middleware/require-admin";
import { adminCredentials } from "../services/admin-credentials.service";

export const authRouter = Router();

const portalSchema = z.enum(["genesys"]);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." },
});

authRouter.get("/session", async (request, response) => {
  const portalResult =
    request.query.portal === undefined
      ? undefined
      : portalSchema.safeParse(request.query.portal);
  if (portalResult && !portalResult.success) {
    response.status(400).json({ message: "Invalid portal" });
    return;
  }
  const accountValid = await adminCredentials.isSessionValid(
    request.session.admin,
    request.session.adminCredentialVersion,
  );
  const authenticated = Boolean(
    accountValid &&
    (!portalResult ||
      request.session.adminPortals?.includes(portalResult.data)),
  );
  response.json({
    authenticated,
    username: authenticated ? request.session.admin : "",
  });
});

authRouter.post("/login", loginLimiter, async (request, response, next) => {
  try {
    const username = String(request.body?.username ?? "");
    const password = String(request.body?.password ?? "");
    const portal = portalSchema.parse(request.body?.portal ?? "genesys");
    const account =
      username.length <= 100 && password.length <= 256
        ? await adminCredentials.authenticate(username, password)
        : null;
    if (!account) {
      response.status(401).json({ message: "Invalid username or password" });
      return;
    }
    const currentSessionMatches =
      request.session.admin === account.username &&
      request.session.adminCredentialVersion === account.version;
    if (currentSessionMatches) {
      request.session.adminPortals = Array.from(
        new Set([...(request.session.adminPortals ?? []), portal]),
      );
      request.session.save((saveError) => {
        if (saveError) {
          next(saveError);
          return;
        }
        void audit("LOGIN", account.username, portal).catch(() => undefined);
        response.json({ authenticated: true, username: account.username });
      });
      return;
    }
    request.session.regenerate((error) => {
      if (error) {
        next(error);
        return;
      }
      request.session.admin = account.username;
      request.session.adminCredentialVersion = account.version;
      request.session.adminPortals = [portal];
      request.session.save((saveError) => {
        if (saveError) {
          next(saveError);
          return;
        }
        void audit("LOGIN", account.username, portal).catch(() => undefined);
        response.json({ authenticated: true, username: account.username });
      });
    });
  } catch (error) {
    next(error);
  }
});

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Too many password change attempts. Please try again later.",
  },
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(1),
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "New passwords do not match",
    path: ["confirmPassword"],
  });

authRouter.post(
  "/change-password",
  requireAdmin,
  changePasswordLimiter,
  async (request, response, next) => {
    try {
      const { currentPassword, newPassword } = changePasswordSchema.parse(
        request.body,
      );
      if (
        !(await adminCredentials.changePassword(currentPassword, newPassword))
      ) {
        response.status(400).json({ message: "Current password is incorrect" });
        return;
      }
      const user = request.user!.name;
      request.session.destroy((error) => {
        if (error) {
          next(error);
          return;
        }
        response.clearCookie("genesys.sid");
        void audit("PASSWORD_CHANGED", user).catch(() => undefined);
        response.status(204).end();
      });
    } catch (error) {
      next(error);
    }
  },
);

authRouter.post("/logout", requireAdmin, (request, response, next) => {
  const user = request.user!.name;
  const portalResult = portalSchema.safeParse(request.body?.portal);
  if (request.body?.portal !== undefined && !portalResult.success) {
    response.status(400).json({ message: "Invalid portal" });
    return;
  }
  if (portalResult.success) {
    const remaining = (request.session.adminPortals ?? []).filter(
      (portal) => portal !== portalResult.data,
    );
    if (remaining.length) {
      request.session.adminPortals = remaining;
      request.session.save((error) => {
        if (error) {
          next(error);
          return;
        }
        void audit("LOGOUT", user, portalResult.data).catch(() => undefined);
        response.status(204).end();
      });
      return;
    }
  }
  request.session.destroy((error) => {
    if (error) {
      next(error);
      return;
    }
    response.clearCookie("genesys.sid");
    void audit(
      "LOGOUT",
      user,
      portalResult.success ? portalResult.data : "",
    ).catch(() => undefined);
    response.status(204).end();
  });
});
