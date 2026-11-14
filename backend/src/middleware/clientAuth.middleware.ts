import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma";
import { verifyClientToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { asyncHandler } from "./error.middleware";

export interface ClientContext {
  clientUserId: bigint;
  jti: string;
  /** restaurant session this login is bound to (shared kiosk), if any */
  kioskSessionId: bigint | null;
  name: string;
  email: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      client?: ClientContext;
    }
  }
}

const unauthorized = (code: string, message: string) => new AppError(401, code, message);

/**
 * Validates a client bearer token end to end: signature (client secret, typ=client),
 * the server-side session row (not revoked / not expired), the account (active, not
 * deleted) and - for a login made on a shared kiosk - that the table session it was
 * made on is still ACTIVE. The last check is what makes "the next guest at this monitor
 * cannot see the previous guest's account" true on the server, not only in the UI.
 */
export async function authenticateClientToken(token: string): Promise<ClientContext> {
  let payload;
  try {
    payload = verifyClientToken(token);
  } catch {
    throw unauthorized("CLIENT_UNAUTHORIZED", "Сессия недействительна. Войдите снова.");
  }
  const row = await prisma.clientAuthSession.findUnique({
    where: { jti: payload.jti },
    include: {
      clientUser: true,
      kioskSession: { select: { status: true } },
    },
  });
  if (!row || row.clientUserId.toString() !== payload.sub || row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("CLIENT_UNAUTHORIZED", "Сессия недействительна. Войдите снова.");
  }
  // A login made on a shared kiosk dies with the table session - say so explicitly (it is also revoked
  // when the table is released, so this check must come before the generic "revoked" one).
  if (row.kioskSessionId !== null && row.kioskSession?.status !== "ACTIVE") {
    throw unauthorized("CLIENT_SESSION_ENDED", "Сессия за столом завершена. Войдите снова.");
  }
  if (row.revokedAt) {
    throw unauthorized("CLIENT_UNAUTHORIZED", "Сессия недействительна. Войдите снова.");
  }
  if (!row.clientUser.isActive || row.clientUser.deletedAt) {
    throw unauthorized("CLIENT_UNAUTHORIZED", "Учётная запись недоступна.");
  }
  return {
    clientUserId: row.clientUserId,
    jti: row.jti,
    kioskSessionId: row.kioskSessionId,
    name: row.clientUser.name,
    email: row.clientUser.email,
  };
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/** 401 unless a valid client token is present. Attaches `req.client`. */
export const requireClient = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  if (!token) throw unauthorized("CLIENT_UNAUTHORIZED", "Войдите в личный кабинет.");
  req.client = await authenticateClientToken(token);
  next();
});

/**
 * Guest-friendly: no header = anonymous guest. A header that IS present must be a valid
 * client token (an expired/revoked one answers 401 so the UI can clean up its login state
 * instead of silently losing the cashback it is showing).
 */
export const optionalClient = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  if (token) req.client = await authenticateClientToken(token);
  next();
});
