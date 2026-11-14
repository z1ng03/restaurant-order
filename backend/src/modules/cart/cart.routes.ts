import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { optionalClient } from "../../middleware/clientAuth.middleware";
import { assertKioskAccess, requireKioskSession } from "../../middleware/kiosk.middleware";
import { parseIdParam } from "../../lib/params";
import { parseDecimalInput } from "../../lib/decimal";
import { compositionSchema } from "../menu/menu.routes";
import * as cartService from "./cart.service";

export const cartRouter = Router();

const addItemSchema = z.object({
  dishId: z.string().regex(/^\d+$/),
  ...compositionSchema,
  quantity: z.number().int().positive().max(50),
  notes: z.string().max(500).optional(),
});

const updateQuantitySchema = z.object({
  quantity: z.number().int(),
});

const commentSchema = z.object({
  comment: z.string().nullable(),
});

/** Optional client token -> loyaltyPreview is personalised; query ?useCashback=true previews the discount. */
function viewContext(req: import("express").Request): cartService.CartViewContext {
  return {
    clientUserId: req.client?.clientUserId ?? null,
    useCashback: req.query.useCashback === "true",
  };
}

cartRouter.get(
  "/:sessionId",
  requireKioskSession("read"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const cart = await cartService.getCart(sessionId, viewContext(req));
    res.json({ cart });
  }),
);

cartRouter.post(
  "/:sessionId/items",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const body = addItemSchema.parse(req.body);
    const cart = await cartService.addItemToCart(
      sessionId,
      {
        dishId: BigInt(body.dishId),
        quantity: body.quantity,
        notes: body.notes,
        ingredients: body.ingredients?.map((i) => ({
          ingredientId: i.ingredientId,
          quantity: parseDecimalInput(i.quantity, "quantity"),
          ...(i.unit ? { unit: i.unit } : {}),
        })),
        options: body.options?.map((o) => ({ optionId: o.optionId, quantity: o.quantity })),
      },
      viewContext(req),
    );
    res.status(201).json({ cart });
  }),
);

cartRouter.patch(
  "/:sessionId/comment",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const { comment } = commentSchema.parse(req.body);
    const cart = await cartService.setCartComment(sessionId, comment, viewContext(req));
    res.json({ cart });
  }),
);

cartRouter.post(
  "/:sessionId/price-confirmation",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const cart = await cartService.confirmPriceChanges(sessionId, viewContext(req));
    res.json({ cart });
  }),
);

cartRouter.patch(
  "/items/:cartItemId",
  optionalClient,
  asyncHandler(async (req, res) => {
    const cartItemId = parseIdParam(req.params.cartItemId, "cartItemId");
    const { quantity } = updateQuantitySchema.parse(req.body);
    await assertKioskAccess(req, await cartService.getCartItemSessionId(cartItemId), "write");
    const cart = await cartService.updateCartItemQuantity(cartItemId, quantity, viewContext(req));
    res.json({ cart });
  }),
);

cartRouter.delete(
  "/items/:cartItemId",
  optionalClient,
  asyncHandler(async (req, res) => {
    const cartItemId = parseIdParam(req.params.cartItemId, "cartItemId");
    await assertKioskAccess(req, await cartService.getCartItemSessionId(cartItemId), "write");
    const cart = await cartService.removeCartItem(cartItemId, viewContext(req));
    res.json({ cart });
  }),
);

cartRouter.delete(
  "/:sessionId",
  requireKioskSession("write"),
  optionalClient,
  asyncHandler(async (req, res) => {
    const sessionId = parseIdParam(req.params.sessionId, "sessionId");
    const cart = await cartService.clearCart(sessionId, viewContext(req));
    res.json({ cart });
  }),
);
