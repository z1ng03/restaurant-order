import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireClient } from "../../middleware/clientAuth.middleware";
import { assertKioskAccess } from "../../middleware/kiosk.middleware";
import { rateLimit } from "../../lib/rateLimit";
import * as clientAuthService from "./clientAuth.service";

export const clientAuthRouter = Router();

const emailSchema = z.string().trim().min(3).max(254).email("Введите корректный email");

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: z.string().min(1).max(200),
  /** the table session this login is made on (shared-kiosk binding) - optional */
  kioskSessionId: z.string().regex(/^\d+$/).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  kioskSessionId: z.string().regex(/^\d+$/).optional(),
});

/**
 * A login made on a table terminal is bound to that table session - but only after the terminal proved
 * it owns the session with its kiosk secret, otherwise anyone could bind accounts to somebody else's table.
 */
async function resolveKioskBinding(req: import("express").Request, kioskSessionId: string | undefined): Promise<bigint | null> {
  if (!kioskSessionId) return null;
  const id = BigInt(kioskSessionId);
  await assertKioskAccess(req, id, "write");
  return id;
}

clientAuthRouter.post(
  "/register",
  rateLimit({ name: "client-register", windowMs: 60 * 60_000, max: 20, message: "Слишком много регистраций с этого адреса. Попробуйте позже." }),
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const kioskSessionId = await resolveKioskBinding(req, body.kioskSessionId);
    const result = await clientAuthService.registerClient({
      name: body.name,
      email: body.email,
      password: body.password,
      kioskSessionId,
    });
    res.status(201).json(result);
  }),
);

clientAuthRouter.post(
  "/login",
  rateLimit({ name: "client-login", windowMs: 15 * 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const kioskSessionId = await resolveKioskBinding(req, body.kioskSessionId);
    const result = await clientAuthService.loginClient({
      email: body.email,
      password: body.password,
      ip: req.ip ?? "unknown",
      kioskSessionId,
    });
    res.json(result);
  }),
);

clientAuthRouter.post(
  "/logout",
  requireClient,
  asyncHandler(async (req, res) => {
    await clientAuthService.logoutClient(req.client!.jti);
    res.status(204).end();
  }),
);
