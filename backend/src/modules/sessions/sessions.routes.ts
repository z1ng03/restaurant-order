import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { KIOSK_TOKEN_HEADER, requireKioskSession } from "../../middleware/kiosk.middleware";
import { rateLimit } from "../../lib/rateLimit";
import { parseIdParam } from "../../lib/params";
import * as sessionsService from "./sessions.service";

export const sessionsRouter = Router();

const openSessionSchema = z.object({
  monitorNumber: z.number().int().positive(),
});

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

sessionsRouter.post(
  "/open",
  rateLimit({ name: "sessions-open", windowMs: 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    const { monitorNumber } = openSessionSchema.parse(req.body);
    const result = await sessionsService.openSessionForMonitor(monitorNumber, {
      deviceSecret: first(req.headers["x-device-secret"]),
      presentedToken: first(req.headers[KIOSK_TOKEN_HEADER]),
    });
    res.status(result.reused ? 200 : 201).json(result);
  }),
);

sessionsRouter.get(
  "/:sessionId",
  requireKioskSession("read"),
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const session = await sessionsService.getSession(sessionId);
    res.json({ session });
  }),
);

sessionsRouter.get(
  "/:sessionId/orders",
  requireKioskSession("read"),
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const orders = await sessionsService.getSessionOrders(sessionId);
    res.json({ orders });
  }),
);
