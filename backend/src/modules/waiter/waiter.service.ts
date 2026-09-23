import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError } from "../../lib/errors";
import { closeSessionIfNoActiveOrders } from "../sessions/sessions.service";

const waiterOrderInclude = {
  table: true,
  waiter: true,
  items: { include: { dish: true, options: { include: { option: true } } }, orderBy: { createdAt: "asc" as const } },
  payments: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

/**
 * ТЗ §12: "Показывается: номер заказа, блюда, столик, статус заказа,
 * оплата." Orders a waiter still has to act on: ready to carry, or already
 * carrying (so the same screen can show the "mark delivered" / "cash
 * received" actions too).
 */
export function getWaiterOrders() {
  return prisma.order.findMany({
    where: { orderStatus: { in: ["READY_FOR_DELIVERY", "OUT_FOR_DELIVERY"] } },
    include: waiterOrderInclude,
    orderBy: { createdAt: "asc" },
  });
}

async function getOrderOrThrow(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, include: waiterOrderInclude });
  if (!order) {
    throw new NotFoundError("Order");
  }
  return order;
}

/** ТЗ §13: "Официант ставит статус - Официант несёт вам" -> OUT_FOR_DELIVERY, waiter_id assigned. */
export async function pickupOrder(orderId: bigint, waiterId: bigint) {
  const order = await getOrderOrThrow(orderId);
  if (order.orderStatus !== "READY_FOR_DELIVERY") {
    throw new ConflictError(`Order must be READY_FOR_DELIVERY to be picked up (currently ${order.orderStatus})`);
  }
  await prisma.order.update({
    where: { orderId },
    data: { orderStatus: "OUT_FOR_DELIVERY", waiterId },
  });
  return getOrderOrThrow(orderId);
}

/**
 * ТЗ §13: cash collected from the client -> Payment.status = PAID,
 * paid_at, paid_by. "Важно: я бы не менял Order.status на PAID — оплата
 * это отдельный статус" — only Order.payment_status changes here, never
 * order_status.
 */
export async function markCashReceived(orderId: bigint, waiterId: bigint) {
  const order = await getOrderOrThrow(orderId);
  const payment = order.payments[0];
  if (!payment || payment.method !== "CASH") {
    throw new ConflictError("This order isn't waiting on a cash payment");
  }
  if (payment.status === "PAID") {
    throw new ConflictError("This payment was already marked as received");
  }

  await prisma.$transaction([
    prisma.payment.update({
      where: { paymentId: payment.paymentId },
      data: { status: "PAID", paidAt: new Date(), paidBy: waiterId },
    }),
    prisma.order.update({ where: { orderId }, data: { paymentStatus: "PAID" } }),
  ]);

  return getOrderOrThrow(orderId);
}

/**
 * ТЗ §14: "После того как официант отдал заказ - ставит статус ВЫДАНО" ->
 * Order.status = DELIVERED, every Order_Item -> DELIVERED, and if this was
 * the session's last non-delivered order, the session completes and the
 * table frees up (ТЗ: "иначе система будет считать столик занятым
 * бесконечно"). Cash must be settled first — handing over food that was
 * never paid for isn't a state the ТЗ describes, so this is a defensive
 * business rule rather than something spelled out explicitly.
 */
export async function markDelivered(orderId: bigint) {
  const order = await getOrderOrThrow(orderId);
  if (order.orderStatus !== "OUT_FOR_DELIVERY") {
    throw new ConflictError(`Order must be OUT_FOR_DELIVERY to be marked delivered (currently ${order.orderStatus})`);
  }
  if (order.paymentStatus !== "PAID") {
    throw new ConflictError("Payment must be settled (collect cash first) before delivering the order");
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.order.update({ where: { orderId }, data: { orderStatus: "DELIVERED", deliveredAt: now } });
    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "DELIVERED", deliveredAt: now } });
    await closeSessionIfNoActiveOrders(tx, order.sessionId, order.tableId, orderId);
  });

  return getOrderOrThrow(orderId);
}
