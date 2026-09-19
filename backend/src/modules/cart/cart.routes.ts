import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { parseIdParam } from "../../lib/params";
import * as cartService from "./cart.service";

export const cartRouter = Router();

const addItemSchema = z.object({
  dishId: z.string().regex(/^\d+$/),
  quantity: z.number().int().positive(),
  options: z
    .array(
      z.object({
        optionId: z.string().regex(/^\d+$/),
        quantity: z.number().int().positive().default(1),
      }),
    )
    .optional(),
  notes: z.string().max(500).optional(),
});

const updateQuantitySchema = z.object({
  quantity: z.number().int(),
});

cartRouter.get(
  "/:sessionId",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const cart = await cartService.getCart(sessionId);
    res.json({ cart });
  }),
);

cartRouter.post(
  "/:sessionId/items",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const body = addItemSchema.parse(req.body);
    const cart = await cartService.addItemToCart(sessionId, {
      dishId: BigInt(body.dishId),
      quantity: body.quantity,
      notes: body.notes,
      options: body.options?.map((o) => ({ optionId: BigInt(o.optionId), quantity: o.quantity })),
    });
    res.status(201).json({ cart });
  }),
);

cartRouter.patch(
  "/items/:cartItemId",
  asyncHandler(async (req, res) => {
    const cartItemId = parseIdParam(req.params.cartItemId, "cartItemId");
    const { quantity } = updateQuantitySchema.parse(req.body);
    const cart = await cartService.updateCartItemQuantity(cartItemId, quantity);
    res.json({ cart });
  }),
);

cartRouter.delete(
  "/items/:cartItemId",
  asyncHandler(async (req, res) => {
    const cartItemId = parseIdParam(req.params.cartItemId, "cartItemId");
    const cart = await cartService.removeCartItem(cartItemId);
    res.json({ cart });
  }),
);

cartRouter.delete(
  "/:sessionId",
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const cart = await cartService.clearCart(sessionId);
    res.json({ cart });
  }),
);
