import type { NextFunction, Request, Response } from "express";
import { adminCredentials } from "../services/admin-credentials.service";

export async function requireAdmin(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = request.session?.admin;
    if (
      !(await adminCredentials.isSessionValid(
        user,
        request.session?.adminCredentialVersion,
      ))
    ) {
      response
        .status(401)
        .json({ message: "Administrator authentication required" });
      return;
    }
    request.user = { name: user! };
    next();
  } catch (error) {
    next(error);
  }
}
