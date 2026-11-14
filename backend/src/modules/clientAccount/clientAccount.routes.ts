import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireClient } from "../../middleware/clientAuth.middleware";
import { assertKioskAccess } from "../../middleware/kiosk.middleware";
import { parseIdParam } from "../../lib/params";
import { rateLimit } from "../../lib/rateLimit";
import { demoApproveIdentity, getIdentityStatus, submitIdentityVerification } from "../identity/identity.service";
import { createTelegramLinkToken, unlinkTelegram } from "../integrations/telegram.service";
import { confirmBotLogin, setAutoReceiptPreference } from "../integrations/telegram.bot";
import { getLoyaltyHistory } from "../loyalty/loyalty.service";
import { sendReceiptByEmail, sendReceiptByTelegram } from "../receipts/delivery.service";
import * as accountService from "./clientAccount.service";

export const clientAccountRouter = Router();

clientAccountRouter.use(requireClient);

const idString = z.string().regex(/^\d+$/, "must be a numeric id");

/* ------------------------------- profile -------------------------------- */

clientAccountRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json({ client: await accountService.getProfile(req.client!.clientUserId) });
  }),
);

const passwordSchema = z.object({ oldPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

clientAccountRouter.patch(
  "/password",
  rateLimit({ name: "client-password", windowMs: 15 * 60_000, max: 10, key: (req) => `${req.ip}` }),
  asyncHandler(async (req, res) => {
    const body = passwordSchema.parse(req.body);
    await accountService.changePassword(req.client!, body);
    res.status(204).end();
  }),
);

const deleteSchema = z.object({ password: z.string().min(1).max(200), confirm: z.literal(true) });

clientAccountRouter.delete(
  "/me",
  rateLimit({ name: "client-delete", windowMs: 15 * 60_000, max: 5, key: (req) => `${req.ip}` }),
  asyncHandler(async (req, res) => {
    const body = deleteSchema.parse(req.body);
    await accountService.deleteAccount(req.client!, { password: body.password });
    res.status(204).end();
  }),
);

/* ------------------------- identity verification ------------------------- */

// The document photo travels as base64 inside JSON; app.ts gives this one POST route a larger body limit.
clientAccountRouter.get(
  "/identity-verification",
  asyncHandler(async (req, res) => {
    res.json({ identity: await getIdentityStatus(req.client!.clientUserId) });
  }),
);

const identitySubmitSchema = z
  .object({ fileBase64: z.string().max(5_000_000).optional(), documentType: z.string().max(40).optional() })
  // `verified` / `status` are not part of the contract: a client can never declare itself verified.
  .strict();

clientAccountRouter.post(
  "/identity-verification",
  asyncHandler(async (req, res) => {
    const body = identitySubmitSchema.parse(req.body ?? {});
    const identity = await submitIdentityVerification({ clientUserId: req.client!.clientUserId, fileBase64: body.fileBase64 });
    res.status(202).json({ identity });
  }),
);

clientAccountRouter.post(
  "/identity-verification/demo-confirm",
  asyncHandler(async (req, res) => {
    res.json({ identity: await demoApproveIdentity(req.client!.clientUserId) });
  }),
);

/* -------------------------------- loyalty -------------------------------- */

clientAccountRouter.get(
  "/loyalty",
  asyncHandler(async (req, res) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(100).default(30), cursor: idString.optional() }).parse(req.query);
    res.json(await getLoyaltyHistory(req.client!.clientUserId, { limit: query.limit, cursor: query.cursor ? BigInt(query.cursor) : undefined }));
  }),
);

/* --------------------------------- orders -------------------------------- */

clientAccountRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(50).default(20), cursor: idString.optional() }).parse(req.query);
    res.json(
      await accountService.listOrders(req.client!.clientUserId, {
        limit: query.limit,
        cursor: query.cursor ? BigInt(query.cursor) : undefined,
      }),
    );
  }),
);

clientAccountRouter.get(
  "/orders/:orderId",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    res.json({ order: await accountService.getOrderDetail(req.client!.clientUserId, orderId) });
  }),
);

clientAccountRouter.post(
  "/orders/:orderId/rating",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).parse(req.body);
    res.status(201).json(await accountService.rateOrder(req.client!.clientUserId, orderId, rating));
  }),
);

clientAccountRouter.post(
  "/orders/:orderId/reorder",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const { sessionId } = z.object({ sessionId: idString }).parse(req.body);
    // The terminal must prove it owns the table session whose cart is about to be filled.
    await assertKioskAccess(req, BigInt(sessionId), "write");
    res.json(await accountService.reorder(req.client!, orderId, BigInt(sessionId)));
  }),
);

/* -------------------------- receipt delivery ----------------------------- */

clientAccountRouter.post(
  "/orders/:orderId/receipt/email",
  rateLimit({ name: "receipt-email", windowMs: 60_000, max: 6, key: (req) => `${req.client?.clientUserId}` }),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    const { email } = z.object({ email: z.string().email().max(254).optional() }).parse(req.body ?? {});
    const result = await sendReceiptByEmail({ clientUserId: req.client!.clientUserId, orderId, requestedEmail: email });
    res.json(result);
  }),
);

clientAccountRouter.post(
  "/orders/:orderId/receipt/telegram",
  rateLimit({ name: "receipt-telegram", windowMs: 60_000, max: 6, key: (req) => `${req.client?.clientUserId}` }),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    // Deliberately NO chat id in the body: the destination is the account's verified Telegram link.
    const result = await sendReceiptByTelegram({ clientUserId: req.client!.clientUserId, orderId });
    res.json(result);
  }),
);

/* ------------------------------- telegram -------------------------------- */

clientAccountRouter.post(
  "/telegram/link",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createTelegramLinkToken(req.client!.clientUserId));
  }),
);

clientAccountRouter.delete(
  "/telegram",
  asyncHandler(async (req, res) => {
    await unlinkTelegram(req.client!.clientUserId);
    res.status(204).end();
  }),
);

clientAccountRouter.post(
  "/telegram/confirm-bot-login",
  rateLimit({ name: "telegram-confirm-login", windowMs: 60_000, max: 6, key: (req) => `${req.client?.clientUserId}:${req.ip}` }),
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(20).max(90) }).strict().parse(req.body);
    await confirmBotLogin(req.client!.clientUserId, token);
    res.json({ linked: true });
  }),
);

clientAccountRouter.patch(
  "/telegram/auto-receipts",
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await setAutoReceiptPreference(req.client!.clientUserId, enabled));
  }),
);
