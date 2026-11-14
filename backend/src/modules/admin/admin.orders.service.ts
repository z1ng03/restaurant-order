import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { lockOrderRow } from "../../lib/locks";
import { refundSpend, reverseEarn } from "../loyalty/loyalty.service";
import { releaseReservationsForOrder } from "../menu/inventory.service";
import { recordOrderEvent } from "../orderTracking/orderTracking.service";
import { closeSessionIfNoActiveOrders } from "../sessions/sessions.service";
import { canCancelOrder, ORDER_STATUSES, type OrderStatus } from "../../types/status";

const adminOrderListInclude = {
  table: true,
  // Never `waiter: true` - it would include the staff member's password hash.
  waiter: { select: { userId: true, name: true } },
  clientUser: { select: { clientUserId: true, name: true } },
  items: { include: { dish: true, options: { include: { option: true } } } },
  payments: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.OrderInclude;

const adminOrderDetailInclude = {
  ...adminOrderListInclude,
  items: { include: { dish: true, options: { include: { option: true } }, ingredients: true } },
  statusEvents: { orderBy: { occurredAt: "asc" as const } },
  receipt: { select: { receiptId: true, receiptNumber: true, kind: true, fiscalStatus: true, issuedAt: true } },
  loyaltyEntries: { orderBy: { ledgerId: "asc" as const } },
  inventoryReservations: { include: { ingredient: true } },
} satisfies Prisma.OrderInclude;

export interface ListOrdersFilter {
  status?: OrderStatus | undefined;
  tableId?: bigint | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  cursor?: bigint | undefined;
}

/**
 * Unlike the kitchen/waiter screens (each filtered to the slice of orders
 * they act on), this is every order regardless of status - that's the
 * "control over all orders" the admin panel is for.
 */
export async function listOrders(filter: ListOrdersFilter) {
  const where = {
    ...(filter.status ? { orderStatus: filter.status } : {}),
    ...(filter.tableId ? { tableId: filter.tableId } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const orders = await prisma.order.findMany({
    where,
    include: adminOrderListInclude,
    orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { orderId: filter.cursor }, skip: 1 } : {}),
  });

  const hasMore = orders.length > filter.limit;
  const page = hasMore ? orders.slice(0, filter.limit) : orders;
  return { orders: page, nextCursor: hasMore ? page[page.length - 1]?.orderId ?? null : null };
}

export async function getOrder(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, include: adminOrderDetailInclude });
  if (!order) throw new NotFoundError("Order");
  return order;
}

export interface CancelOrderOptions {
  actorUserId?: bigint | null;
  reason?: string | null;
  /**
   * What to do about money that was ALREADY paid (PAID orders only):
   *   REFUND    - bonuses spent are returned, earned bonuses are taken back, and the payment is flagged
   *               REFUND_REQUIRED: the money itself must be returned through the real payment channel
   *               (this system never pretends to refund a card/cash payment);
   *   NO_REFUND - the order is cancelled, the money stays (default).
   * An UNPAID order never needs a decision: bonuses blocked for it are simply released.
   */
  refundDecision?: "REFUND" | "NO_REFUND";
}

/**
 * Admin-only escape hatch - the ТЗ's pipeline never describes cancelling an
 * order (see types/status.ts). Ingredients already CONSUMED (cooking
 * started) stay consumed - that food is made and can't be un-made; only
 * still-RESERVED reservations are released back to free stock.
 *
 * One transaction under the order's row lock: a cancel racing "start cooking" has exactly one winner,
 * and a second cancel is a clean 409 - reservations, bonuses and the timeline are each touched once.
 */
export async function cancelOrder(orderId: bigint, opts: CancelOrderOptions = {}) {
  const reason = opts.reason?.trim() ? opts.reason.trim().slice(0, 500) : null;
  const actorUserId = opts.actorUserId ?? null;

  const cancellation = await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({
      where: { orderId },
      include: { payments: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!canCancelOrder(order.orderStatus as OrderStatus)) {
      throw new ConflictError(`Order can't be cancelled from status ${order.orderStatus}`);
    }

    const now = new Date();
    await releaseReservationsForOrder(tx, orderId);

    await tx.order.update({
      where: { orderId },
      data: { orderStatus: "CANCELLED", cancelledAt: now, cancelReason: reason },
    });
    await recordOrderEvent(tx, {
      orderId,
      eventType: "CANCELLED",
      status: "CANCELLED",
      actorType: "STAFF",
      actorId: actorUserId,
      occurredAt: now,
    });

    const payment = order.payments[0];
    const wasPaid = order.paymentStatus === "PAID";
    let bonusesReturned = 0;
    let bonusesReversed = 0;
    let bonusShortfall = 0;
    let paymentRefundRequired = false;

    if (!wasPaid) {
      // Nothing was paid: bonuses blocked for this order simply come back.
      bonusesReturned = await refundSpend(tx, orderId, "заказ отменён до оплаты");
    } else if (opts.refundDecision === "REFUND") {
      bonusesReturned = await refundSpend(tx, orderId, "возврат оплаченного заказа");
      const rev = await reverseEarn(tx, orderId, "возврат оплаченного заказа");
      bonusesReversed = rev.reversed;
      bonusShortfall = rev.shortfall;
      if (payment) {
        await tx.payment.update({ where: { paymentId: payment.paymentId }, data: { refundStatus: "REFUND_REQUIRED" } });
        paymentRefundRequired = true;
      }
    }

    await closeSessionIfNoActiveOrders(tx, order.sessionId, order.tableId, orderId);
    return { wasPaid, refundDecision: opts.refundDecision ?? null, bonusesReturned, bonusesReversed, bonusShortfall, paymentRefundRequired };
  });

  return { order: await getOrder(orderId), cancellation };
}

export function assertValidOrderStatusFilter(value: unknown): OrderStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ORDER_STATUSES.includes(value as OrderStatus)) {
    throw new ValidationError(`status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }
  return value as OrderStatus;
}
