import { Router, type Request } from "express";
import { prisma } from "../../db/prisma";
import { AppError } from "../../lib/errors";
import { verifyStaffToken } from "../../lib/auth";
import { parseIdParam } from "../../lib/params";
import { asyncHandler } from "../../middleware/error.middleware";
import { authenticateClientToken } from "../../middleware/clientAuth.middleware";
import { assertKioskAccess } from "../../middleware/kiosk.middleware";
import { getReceiptForOrder } from "./receipts.service";
import { createGuestReceiptLink } from "../integrations/telegram.bot";
import { rateLimit } from "../../lib/rateLimit";

/** Mounted at /api/orders. */
export const ordersReceiptRouter = Router();

/**
 * Who may read a receipt (TZ FR-07):
 *   - a CLIENT only for an order they own (anyone else gets the same 404 as a missing order);
 *   - STAFF (ADMIN / WAITER) by role;
 *   - a GUEST only with the kiosk session secret of the table session the order belongs to.
 * The bearer header is tried as a client token first, then as a staff token (different secrets: at most one verifies).
 */
async function authorizeReceiptAccess(req: Request, orderId: bigint): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { orderId },
    select: { orderId: true, sessionId: true, clientUserId: true },
  });
  const notFound = () => new AppError(404, "ORDER_NOT_OWNED", "Заказ не найден");
  if (!order) throw notFound();

  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length);
    try {
      const staff = verifyStaffToken(token);
      if (staff.role === "ADMIN" || staff.role === "WAITER") return;
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав для просмотра чека");
    } catch (err) {
      if (err instanceof AppError) throw err;
      // not a staff token - fall through to the client check
    }
    const client = await authenticateClientToken(token); // 401 if invalid
    if (order.clientUserId === null || order.clientUserId !== client.clientUserId) throw notFound();
    return;
  }

  await assertKioskAccess(req, order.sessionId, "read");
}

ordersReceiptRouter.get(
  "/:orderId/receipt",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    await authorizeReceiptAccess(req, orderId);
    const receipt = await getReceiptForOrder(orderId);
    res.json({ receipt });
  }),
);

/** An account bearer OR the kiosk secret for THIS order is mandatory. No bare order id is an authority. */
ordersReceiptRouter.post(
  "/:orderId/receipt/telegram-link",
  rateLimit({ name: "guest-telegram-receipt-link", windowMs: 60_000, max: 5,
    key: (req) => `${req.ip}:${req.params.orderId}` }),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    await authorizeReceiptAccess(req, orderId);
    res.status(201).json(await createGuestReceiptLink(orderId));
  }),
);
