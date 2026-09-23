import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { closeSessionIfNoActiveOrders } from "../sessions/sessions.service";
import { canCancelOrder, ORDER_STATUSES, type OrderStatus } from "../../types/status";

const adminOrderInclude = {
  table: true,
  waiter: true,
  items: { include: { dish: true, options: { include: { option: true } } } },
  payments: { orderBy: { createdAt: "desc" as const } },
};

export interface ListOrdersFilter {
  status?: OrderStatus;
  tableId?: bigint;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: bigint;
}

/**
 * Unlike the kitchen/waiter screens (each filtered to the slice of orders
 * they act on), this is every order regardless of status — that's the
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
    include: adminOrderInclude,
    orderBy: { createdAt: "desc" },
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { orderId: filter.cursor }, skip: 1 } : {}),
  });

  const hasMore = orders.length > filter.limit;
  const page = hasMore ? orders.slice(0, filter.limit) : orders;
  return { orders: page, nextCursor: hasMore ? page[page.length - 1]?.orderId ?? null : null };
}

export async function getOrder(orderId: bigint) {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: { ...adminOrderInclude, inventoryReservations: { include: { ingredient: true } } },
  });
  if (!order) throw new NotFoundError("Order");
  return order;
}

/**
 * Admin-only escape hatch — the ТЗ's pipeline never describes cancelling an
 * order (see types/status.ts). Ingredients already CONSUMED (cooking
 * started) stay consumed — that food is made and can't be un-made; only
 * still-RESERVED reservations are released back to free stock.
 */
export async function cancelOrder(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId } });
  if (!order) throw new NotFoundError("Order");
  if (!canCancelOrder(order.orderStatus as OrderStatus)) {
    throw new ConflictError(`Order can't be cancelled from status ${order.orderStatus}`);
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const reservations = await tx.inventoryReservation.findMany({ where: { orderId, status: "RESERVED" } });
    for (const reservation of reservations) {
      await tx.inventory.update({
        where: { ingredientId: reservation.ingredientId },
        data: { reservedQuantity: { decrement: reservation.quantity } },
      });
      await tx.inventoryReservation.update({
        where: { reservationId: reservation.reservationId },
        data: { status: "RELEASED", releasedAt: now },
      });
    }

    await tx.order.update({ where: { orderId }, data: { orderStatus: "CANCELLED" } });
    await closeSessionIfNoActiveOrders(tx, order.sessionId, order.tableId, orderId);
  });

  return getOrder(orderId);
}

export function assertValidOrderStatusFilter(value: unknown): OrderStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ORDER_STATUSES.includes(value as OrderStatus)) {
    throw new ValidationError(`status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }
  return value as OrderStatus;
}
