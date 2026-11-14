import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError } from "../../lib/errors";
import { lockOrderRow } from "../../lib/locks";
import { earnBonuses } from "../loyalty/loyalty.service";
import { recordOrderEvent } from "../orderTracking/orderTracking.service";
import { ensureReceipt } from "../receipts/receipts.service";
import { enqueueAutoReceipt } from "../integrations/telegram.outbox";
import { closeSessionIfNoActiveOrders } from "../sessions/sessions.service";

const waiterOrderInclude = {
  table: true,
  // Never `waiter: true` - that serialised the whole staff row including its password hash.
  waiter: { select: { userId: true, name: true } },
  items: { include: { dish: true, options: { include: { option: true } } }, orderBy: { createdAt: "asc" as const } },
  payments: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

/** The waiter screen does not need to know who owns the order, only whether bonuses are involved. */
function stripOwner<T extends { clientUserId: bigint | null }>(order: T) {
  const { clientUserId, ...rest } = order;
  return { ...rest, ownedByClient: clientUserId !== null };
}

/**
 * ТЗ §12: "Показывается: номер заказа, блюда, столик, статус заказа,
 * оплата." Orders a waiter still has to act on: ready to carry, or already
 * carrying (so the same screen can show the "mark delivered" / "cash
 * received" actions too). Order.comment (the single order-level note) is a plain column and comes along.
 */
export async function getWaiterOrders() {
  const orders = await prisma.order.findMany({
    where: { orderStatus: { in: ["READY_FOR_DELIVERY", "OUT_FOR_DELIVERY"] } },
    include: waiterOrderInclude,
    orderBy: { createdAt: "asc" },
  });
  return orders.map(stripOwner);
}

async function getOrderOrThrow(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, include: waiterOrderInclude });
  if (!order) {
    throw new NotFoundError("Order");
  }
  return stripOwner(order);
}

/** ТЗ §13: "Официант ставит статус - Официант несёт вам" -> OUT_FOR_DELIVERY, waiter_id assigned. */
export async function pickupOrder(orderId: bigint, waiterId: bigint) {
  await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { orderId }, select: { orderStatus: true } });
    if (order.orderStatus !== "READY_FOR_DELIVERY") {
      throw new ConflictError(`Order must be READY_FOR_DELIVERY to be picked up (currently ${order.orderStatus})`);
    }
    await tx.order.update({ where: { orderId }, data: { orderStatus: "OUT_FOR_DELIVERY", waiterId } });
    await recordOrderEvent(tx, {
      orderId,
      eventType: "OUT_FOR_DELIVERY",
      status: "OUT_FOR_DELIVERY",
      actorType: "STAFF",
      actorId: waiterId,
    });
  });
  return getOrderOrThrow(orderId);
}

/**
 * ТЗ §13: cash collected from the client -> Payment.status = PAID,
 * paid_at, paid_by. "Важно: я бы не менял Order.status на PAID - оплата
 * это отдельный статус" - only Order.payment_status changes here, never
 * order_status.
 *
 * TZ v2 (FR-06/FR-07): the moment the cash is really received is also when the money-based cashback is
 * EARNED (once - the ledger key is unique per order) and when the receipt snapshot is created. A repeated
 * call changes nothing (the conditional UPDATE finds no WAITING_FOR_CASH payment) and answers 409.
 */
export async function markCashReceived(orderId: bigint, waiterId: bigint) {
  await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({
      where: { orderId },
      include: { payments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (order.orderStatus === "CANCELLED") {
      throw new ConflictError("Заказ отменён - оплату принять нельзя");
    }
    const payment = order.payments[0];
    if (!payment || payment.method !== "CASH") {
      throw new ConflictError("This order isn't waiting on a cash payment");
    }
    if (payment.status === "PAID") {
      throw new ConflictError("This payment was already marked as received");
    }

    const now = new Date();
    const paid = await tx.payment.updateMany({
      where: { paymentId: payment.paymentId, status: "WAITING_FOR_CASH" },
      data: { status: "PAID", paidAt: now, paidBy: waiterId },
    });
    if (paid.count === 0) throw new ConflictError("This payment was already marked as received");
    await tx.order.update({ where: { orderId }, data: { paymentStatus: "PAID" } });

    if (order.clientUserId !== null) {
      await earnBonuses(tx, { clientUserId: order.clientUserId, orderId, paidMoney: payment.amount });
    }
    await recordOrderEvent(tx, {
      orderId,
      eventType: "PAYMENT_CONFIRMED",
      status: "PAID",
      actorType: "STAFF",
      actorId: waiterId,
      occurredAt: now,
    });
    await ensureReceipt(tx, orderId);
    await enqueueAutoReceipt(tx, orderId, order.clientUserId);
  });
  return getOrderOrThrow(orderId);
}

/**
 * ТЗ §14: "После того как официант отдал заказ - ставит статус ВЫДАНО" ->
 * Order.status = DELIVERED, every Order_Item -> DELIVERED, and if this was
 * the session's last non-delivered order, the session completes and the
 * table frees up (ТЗ: "иначе система будет считать столик занятым
 * бесконечно"). Cash must be settled first - handing over food that was
 * never paid for isn't a state the ТЗ describes, so this is a defensive
 * business rule rather than something spelled out explicitly.
 */
export async function markDelivered(orderId: bigint, waiterId: bigint | null = null) {
  await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { orderId } });
    if (order.orderStatus !== "OUT_FOR_DELIVERY") {
      throw new ConflictError(`Order must be OUT_FOR_DELIVERY to be marked delivered (currently ${order.orderStatus})`);
    }
    if (order.paymentStatus !== "PAID") {
      throw new ConflictError("Payment must be settled (collect cash first) before delivering the order");
    }

    const now = new Date();
    await tx.order.update({ where: { orderId }, data: { orderStatus: "DELIVERED", deliveredAt: now } });
    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "DELIVERED", deliveredAt: now } });
    await recordOrderEvent(tx, {
      orderId,
      eventType: "DELIVERED",
      status: "DELIVERED",
      actorType: "STAFF",
      actorId: waiterId,
      occurredAt: now,
    });
    await closeSessionIfNoActiveOrders(tx, order.sessionId, order.tableId, orderId);
  });
  return getOrderOrThrow(orderId);
}
