import { Router } from "express";
import { env } from "../../config/env";
import { safeEqual } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { asyncHandler } from "../../middleware/error.middleware";
import { handleBotUpdate } from "./telegram.bot";

/** Mounted at /api/integrations/telegram. Called by Telegram only, authenticated by the webhook secret. */
export const telegramRouter = Router();

telegramRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const expected = env.telegram.webhookSecret;
    if (!expected) throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook is not configured");
    const raw = req.headers["x-telegram-bot-api-secret-token"];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided || !safeEqual(provided, expected)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid webhook secret");
    }
    await handleBotUpdate(req.body);
    // Telegram only needs a 2xx; never reveal whether the update was understood.
    res.json({ ok: true });
  }),
);
