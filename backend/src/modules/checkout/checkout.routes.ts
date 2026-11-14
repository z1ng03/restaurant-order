import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { optionalClient } from "../../middleware/clientAuth.middleware";
import { requireKioskSession } from "../../middleware/kiosk.middleware";
import { parseIdempotencyKey } from "../../lib/idempotency";
import { parseIdParam } from "../../lib/params";
import { PAYMENT_METHODS } from "../../types/status";
import * as checkoutService from "./checkout.service";

export const checkoutRouter = Router();

checkoutRouter.get(
  "/:sessionId/validate",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const result = await checkoutService.validateCheckout(sessionId, {
      clientUserId: req.client?.clientUserId ?? null,
      useCashback: req.query.useCashback === "true",
    });
    res.json(result);
  }),
);

const confirmSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** Only a yes/no. The amount is ALWAYS computed by the server within its own limit. */
  useCashback: z.boolean().optional(),
  /** The payable total the guest was shown; the server refuses (CASHBACK_CONFLICT) if it no longer matches. */
  expectedPayableTotal: z
    .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()])
    .transform((v) => String(v))
    .optional(),
});

checkoutRouter.post(
  "/:sessionId/confirm",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const body = confirmSchema.parse(req.body);
    const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"], false);
    const result = await checkoutService.confirmCheckout({
      sessionId,
      paymentMethod: body.paymentMethod,
      useCashback: body.useCashback,
      expectedPayableTotal: body.expectedPayableTotal,
      idempotencyKey,
      clientUserId: req.client?.clientUserId ?? null,
    });
    res.status(result.replay ? 200 : 201).json({
      order: result.order,
      idempotentReplay: result.replay,
      earnedBonus: result.earnedBonus,
    });
  }),
);
