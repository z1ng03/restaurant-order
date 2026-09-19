import { Router } from "express";
import { asyncHandler } from "../../middleware/error.middleware";
import { parseIdParam } from "../../lib/params";
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
