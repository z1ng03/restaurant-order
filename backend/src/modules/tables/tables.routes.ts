import { Router } from "express";
import { asyncHandler } from "../../middleware/error.middleware";
import { ValidationError } from "../../lib/errors";
import * as tablesService from "./tables.service";

export const tablesRouter = Router();

/**
 * Lists every physical table. Used by the local dev "pick a table" screen
 * (see frontend/monitor-select.html) so the client app can be exercised
 * without six physical kiosks — in production each monitor would instead
 * be configured once with its own `?monitor=N` URL and never call this.
 */
tablesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const tables = await tablesService.listTables();
    res.json({ tables });
  }),
);

tablesRouter.get(
  "/by-monitor/:monitorNumber",
  asyncHandler(async (req, res) => {
    const monitorNumber = Number(req.params.monitorNumber);
    if (!Number.isInteger(monitorNumber)) {
      throw new ValidationError("monitorNumber must be an integer");
    }
    const table = await tablesService.getTableByMonitorNumber(monitorNumber);
    res.json({ table });
  }),
);
