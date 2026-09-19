import { Router } from "express";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { parseIdParam } from "../../lib/params";
import { UnauthorizedError } from "../../lib/errors";
import * as waiterService from "./waiter.service";

export const waiterRouter = Router();

waiterRouter.use(requireAuth, requireRole("WAITER", "ADMIN"));

function currentWaiterId(req: import("express").Request): bigint {
  if (!req.staff) throw new UnauthorizedError();
  return BigInt(req.staff.userId);
}

waiterRouter.get(
  "/orders",
  asyncHandler(async (_req, res) => {
    const orders = await waiterService.getWaiterOrders();
    res.json({ orders });
  }),
);

waiterRouter.patch(
  "/orders/:orderId/pickup",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const order = await waiterService.pickupOrder(orderId, currentWaiterId(req));
    res.json({ order });
  }),
);

waiterRouter.patch(
  "/orders/:orderId/cash-received",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const order = await waiterService.markCashReceived(orderId, currentWaiterId(req));
    res.json({ order });
  }),
);

waiterRouter.patch(
  "/orders/:orderId/delivered",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const order = await waiterService.markDelivered(orderId);
    res.json({ order });
  }),
);
