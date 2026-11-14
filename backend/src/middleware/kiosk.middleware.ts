import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { safeEqual, sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { parseIdParam } from "../lib/params";
import { asyncHandler } from "./error.middleware";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by assertKioskAccess once the kiosk session secret has been verified. */
      kioskSessionId?: bigint;
    }
  }
}

export const KIOSK_TOKEN_HEADER = "x-kiosk-session-token";

export type KioskAccessMode = "read" | "write";

/**
 * TZ §5.2: knowing a numeric session id must never be enough to read or change
 * a cart, order, tracker or receipt. Every such endpoint verifies the opaque
 * secret that POST /sessions/open handed to the kiosk.
 *
 *  - "write" (cart / checkout / age check): the table session must be ACTIVE.
 *  - "read"  (tracker, receipt, history of this session): additionally allowed for
 *    KIOSK_TOKEN_GRACE_MINUTES after the session ended, so the guest can still
 *    see "Подан" and open the receipt; after that the secret is dead.
 *
 * Wrong, missing and unknown-session cases all answer the same 403 so session ids
 * cannot be probed.
 */
export async function assertKioskAccess(req: Request, sessionId: bigint, mode: KioskAccessMode): Promise<void> {
  if (!env.kioskTokenEnforced) {
    req.kioskSessionId = sessionId;
    return;
  }
  const raw = req.headers[KIOSK_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const denied = () =>
    new AppError(403, "INVALID_SESSION_ACCESS", "Нет доступа к сессии стола. Обновите страницу терминала.");
  if (!token) throw denied();

  const session = await prisma.restaurantSession.findUnique({
    where: { sessionId },
    select: { sessionId: true, status: true, completedAt: true, kioskTokenHash: true },
  });
  if (!session || !session.kioskTokenHash) throw denied();
  if (!safeEqual(sha256Hex(token), session.kioskTokenHash)) throw denied();

  if (session.status !== "ACTIVE") {
    if (mode === "write") {
      throw new AppError(409, "SESSION_ENDED", "Сессия стола завершена. Начните новый заказ.");
    }
    const graceMs = env.kioskTokenGraceMinutes * 60_000;
    const endedAt = session.completedAt?.getTime() ?? 0;
    if (Date.now() - endedAt > graceMs) {
      throw new AppError(409, "SESSION_ENDED", "Сессия стола завершена. Начните новый заказ.");
    }
  }
  req.kioskSessionId = sessionId;
}

/** Route middleware for routes shaped `/…/:sessionId/…`. */
export function requireKioskSession(mode: KioskAccessMode) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    await assertKioskAccess(req, sessionId, mode);
    next();
  });
}
