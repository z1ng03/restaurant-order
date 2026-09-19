import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { canTransitionOrderItem, ORDER_ITEM_STATUSES, type OrderItemStatus } from "../../types/status";

const kitchenOrderInclude = {
  table: true,
  items: {
    include: {
      dish: { include: { recipes: { include: { ingredient: true } } } },
      options: { include: { option: { include: { ingredients: { include: { ingredient: true } } } } } },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

/**
 * ТЗ §9: "Первый монитор на кухне показывает: Номер заказа - блюда - и
 * шеф может посмотреть ингредиенты." Nothing is written by this read.
 * Only orders the kitchen still has work on (SENT_TO_KITCHEN) are shown —
 * once every item is HANDED_TO_WAITER the order moves to
 * READY_FOR_DELIVERY and drops off this screen.
 */
export function getKitchenOrders() {
  return prisma.order.findMany({
    where: { orderStatus: "SENT_TO_KITCHEN" },
    include: kitchenOrderInclude,
    orderBy: { createdAt: "asc" },
  });
}

export async function getKitchenOrder(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, include: kitchenOrderInclude });
  if (!order) {
    throw new NotFoundError("Order");
  }
  return order;
}

/**
 * ТЗ §10 (WAITING -> PREPARING -> READY) and §11 (READY -> HANDED_TO_WAITER,
 * with the order rolling to READY_FOR_DELIVERY once every item has been
 * handed off). ТЗ: "При фактическом начале/подтверждении приготовления:
 * reserved_quantity -= quantity; stock_quantity -= quantity" — read as "at
 * the start of cooking", i.e. the WAITING -> PREPARING transition, which is
 * where this function finalizes (consumes) that item's reservations.
 */
export async function updateOrderItemStatus(orderItemId: bigint, nextStatus: OrderItemStatus) {
  if (!ORDER_ITEM_STATUSES.includes(nextStatus)) {
    throw new ValidationError(`status must be one of: ${ORDER_ITEM_STATUSES.join(", ")}`);
  }

  const item = await prisma.orderItem.findUnique({ where: { orderItemId } });
  if (!item) {
    throw new NotFoundError("Order item");
  }
  const currentStatus = item.status as OrderItemStatus;
  if (!canTransitionOrderItem(currentStatus, nextStatus)) {
    throw new ConflictError(`Can't move an item from ${currentStatus} to ${nextStatus}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.update({ where: { orderItemId }, data: { status: nextStatus } });

    if (nextStatus === "PREPARING") {
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderItemId, status: "RESERVED" },
      });
      for (const reservation of reservations) {
        await tx.inventory.update({
          where: { ingredientId: reservation.ingredientId },
          data: {
            stockQuantity: { decrement: reservation.quantity },
            reservedQuantity: { decrement: reservation.quantity },
          },
        });
        await tx.inventoryReservation.update({
          where: { reservationId: reservation.reservationId },
          data: { status: "CONSUMED", consumedAt: new Date() },
        });
      }
    }

    if (nextStatus === "HANDED_TO_WAITER") {
      const remaining = await tx.orderItem.count({
        where: { orderId: item.orderId, status: { notIn: ["HANDED_TO_WAITER", "DELIVERED"] } },
      });
      if (remaining === 0) {
        await tx.order.update({ where: { orderId: item.orderId }, data: { orderStatus: "READY_FOR_DELIVERY" } });
      }
    }
  });

  return getKitchenOrder(item.orderId);
}
