import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { parseIdParam } from "../../lib/params";
import { ORDER_ITEM_STATUSES } from "../../types/status";
import * as kitchenService from "./kitchen.service";

export const kitchenRouter = Router();

kitchenRouter.use(requireAuth, requireRole("CHEF", "ADMIN"));

kitchenRouter.get(
  "/orders",
  asyncHandler(async (_req, res) => {
    const orders = await kitchenService.getKitchenOrders();
    res.json({ orders });
  }),
);

kitchenRouter.get(
  "/orders/:orderId",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const order = await kitchenService.getKitchenOrder(orderId);
    res.json({ order });
  }),
);

const statusSchema = z.object({ status: z.enum(ORDER_ITEM_STATUSES) });

kitchenRouter.patch(
  "/order-items/:orderItemId/status",
  asyncHandler(async (req, res) => {
    const orderItemId = parseIdParam(req.params.orderItemId, "orderItemId");
    const { status } = statusSchema.parse(req.body);
    const order = await kitchenService.updateOrderItemStatus(orderItemId, status);
    res.json({ order });
  }),
);
