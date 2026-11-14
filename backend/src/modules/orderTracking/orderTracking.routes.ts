import { Router } from "express";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireKioskSession } from "../../middleware/kiosk.middleware";
import { parseIdParam } from "../../lib/params";
import * as trackingService from "./orderTracking.service";

export const orderTrackingRouter = Router();

/**
 * Polled every 5 s by the guest terminal. Guarded by the kiosk session secret; it exposes only
 * stage/time/count data - never accounts, receipts or payment details.
 */
orderTrackingRouter.get(
  "/session/:sessionId",
  requireKioskSession("read"),
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const orders = await trackingService.getSessionTracking(sessionId);
    res.json({ orders });
  }),
);
