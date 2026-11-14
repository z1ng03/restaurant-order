import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { parseIdParam } from "../../lib/params";
import { parseDecimalInput } from "../../lib/decimal";
import * as menuService from "./menu.service";

export const menuRouter = Router();

menuRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const categories = await menuService.getMenu();
    res.json({ categories });
  }),
);

menuRouter.get(
  "/dishes/:dishId",
  asyncHandler(async (req, res) => {
    const dishId = parseIdParam(req.params.dishId, "dishId");
    const dish = await menuService.getDishDetail(dishId);
    res.json({ dish });
  }),
);

const idString = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((v) => BigInt(v));

/** Shared by POST /menu/dishes/:id/check-configuration and POST /cart/:sessionId/items. */
export const compositionSchema = {
  quantity: z.number().int().min(1).max(50).default(1),
  ingredients: z
    .array(
      z.object({
        ingredientId: idString,
        quantity: z.union([z.number(), z.string()]),
        unit: z.string().min(1).max(20).optional(),
      }),
    )
    .max(100)
    .optional(),
  options: z
    .array(z.object({ optionId: idString, quantity: z.number().int().min(1).max(20).default(1) }))
    .max(30)
    .optional(),
};

const checkConfigSchema = z.object(compositionSchema);

/**
 * Read-only: "can THIS exact configuration be made right now?" (+ allergen groups for it).
 * Public like the menu itself - it exposes only availability, never stock numbers beyond what
 * the shortfall message needs.
 */
menuRouter.post(
  "/dishes/:dishId/check-configuration",
  asyncHandler(async (req, res) => {
    const dishId = parseIdParam(req.params.dishId, "dishId");
    const body = checkConfigSchema.parse(req.body);
    const result = await menuService.checkDishConfiguration(dishId, {
      quantity: body.quantity,
      ingredients: body.ingredients?.map((i) => ({
        ingredientId: i.ingredientId,
        quantity: parseDecimalInput(i.quantity, "quantity"),
        ...(i.unit ? { unit: i.unit } : {}),
      })),
      options: body.options?.map((o) => ({ optionId: o.optionId, quantity: o.quantity })),
    });
    res.json(result);
  }),
);
