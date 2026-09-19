import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { parseIdParam } from "../../lib/params";
import * as sessionsService from "./sessions.service";

export const sessionsRouter = Router();

const openSessionSchema = z.object({
  monitorNumber: z.number().int().positive(),
});

sessionsRouter.post(
  "/open",
  asyncHandler(async (req, res) => {
    const { monitorNumber } = openSessionSchema.parse(req.body);
    const result = await sessionsService.openSessionForMonitor(monitorNumber);
    res.status(result.reused ? 200 : 201).json(result);
  }),
);

sessionsRouter.get(
  "/:sessionId",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const session = await sessionsService.getSession(sessionId);
    res.json({ session });
  }),
);

sessionsRouter.get(
  "/:sessionId/orders",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const orders = await sessionsService.getSessionOrders(sessionId);
    res.json({ orders });
  }),
);
