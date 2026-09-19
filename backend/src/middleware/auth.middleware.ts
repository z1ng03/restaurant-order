import type { NextFunction, Request, Response } from "express";
import { verifyStaffToken, type StaffRole, type StaffTokenPayload } from "../lib/auth";
import { ForbiddenError, UnauthorizedError } from "../lib/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffTokenPayload;
    }
  }
}

/** Reads `Authorization: Bearer <token>`, verifies it, attaches `req.staff`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError();
  }
  const token = header.slice("Bearer ".length);
  try {
    req.staff = verifyStaffToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired session, please log in again");
  }
  next();
}

/** Use after requireAuth. Rejects staff whose role isn't in `roles`. */
export function requireRole(...roles: StaffRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.staff) {
      throw new UnauthorizedError();
    }
    if (!roles.includes(req.staff.role)) {
      throw new ForbiddenError(`This action requires one of: ${roles.join(", ")}`);
    }
    next();
  };
}
