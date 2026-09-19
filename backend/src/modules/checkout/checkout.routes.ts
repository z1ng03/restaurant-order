import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { parseIdParam } from "../../lib/params";
import { PAYMENT_METHODS } from "../../types/status";
import * as checkoutService from "./checkout.service";

export const checkoutRouter = Router();

checkoutRouter.get(
  "/:sessionId/validate",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const result = await checkoutService.validateCheckout(sessionId);
    res.json(result);
  }),
);

const confirmSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
});

checkoutRouter.post(
  "/:sessionId/confirm",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const { paymentMethod } = confirmSchema.parse(req.body);
    const order = await checkoutService.confirmCheckout({ sessionId, paymentMethod });
    res.status(201).json({ order });
  }),
);
