import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { lockOrderRow } from "../../lib/locks";
import { formatQuantityRu } from "../../lib/units";
import { canTransitionOrderItem, ORDER_ITEM_STATUSES, type OrderItemStatus } from "../../types/status";
import { consumeReservationsForItem } from "../menu/inventory.service";
import { recordOrderEvent } from "../orderTracking/orderTracking.service";

const kitchenOrderInclude = {
  table: true,
  items: {
    include: {
      // Kept ONLY as a labelled fallback for orders placed before composition snapshots existed.
      dish: { include: { recipes: { include: { ingredient: true } } } },
      options: { include: { option: { include: { ingredients: { include: { ingredient: true } } } } } },
      ingredients: { orderBy: { orderItemIngredientId: "asc" as const } },
    },
    orderBy: [{ createdAt: "asc" as const }, { orderItemId: "asc" as const }],
  },
  statusEvents: { orderBy: { occurredAt: "asc" as const } },
} satisfies Prisma.OrderInclude;

type KitchenOrder = Prisma.OrderGetPayload<{ include: typeof kitchenOrderInclude }>;

/**
 * FR-10: what the chef sees is the REAL ordered composition (order_item_ingredients), never the current
 * recipe. Each line says what it is relative to the recipe at order time:
 *   REMOVED   - selected 0 ("Лук - убрать")
 *   CHANGED   - selected differs from the recipe amount ("Сыр - 75 г × 2 = 150 г")
 *   ADDED     - amount contributed by a chosen option ("Доп. бекон - 50 г × 2 = 100 г")
 *   UNCHANGED - as in the recipe
 */
function shapeKitchenOrder(order: KitchenOrder) {
  return {
    ...order,
    items: order.items.map((item) => ({
      ...item,
      snapshotAvailable: item.ingredients.length > 0,
      ingredientsActual: item.ingredients.map((i) => {
        const change =
          i.source === "OPTION"
            ? "ADDED"
            : i.selectedPerServing.isZero() && !i.basePerServing.isZero()
              ? "REMOVED"
              : !i.selectedPerServing.equals(i.basePerServing)
                ? "CHANGED"
                : "UNCHANGED";
        return {
          ingredientId: i.ingredientId,
          name: i.ingredientNameSnapshot,
          unit: i.unitSnapshot,
          source: i.source,
          change,
          basePerServing: i.basePerServing.toFixed(3),
          selectedPerServing: i.selectedPerServing.toFixed(3),
          requiredTotal: i.requiredTotal.toFixed(3),
          servings: item.quantity,
          display: {
            perServing: formatQuantityRu(i.selectedPerServing, i.unitSnapshot),
            base: formatQuantityRu(i.basePerServing, i.unitSnapshot),
            total: formatQuantityRu(i.requiredTotal, i.unitSnapshot),
          },
        };
      }),
    })),
  };
}

/**
 * ТЗ §9: "Первый монитор на кухне показывает: Номер заказа - блюда - и
 * шеф может посмотреть ингредиенты." Nothing is written by this read.
 * Only orders the kitchen still has work on (SENT_TO_KITCHEN) are shown -
 * once every item is HANDED_TO_WAITER the order moves to
 * READY_FOR_DELIVERY and drops off this screen.
 */
export async function getKitchenOrders() {
  const orders = await prisma.order.findMany({
    where: { orderStatus: "SENT_TO_KITCHEN" },
    include: kitchenOrderInclude,
    orderBy: { createdAt: "asc" },
  });
  return orders.map(shapeKitchenOrder);
}

export async function getKitchenOrder(orderId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, include: kitchenOrderInclude });
  if (!order) {
    throw new NotFoundError("Order");
  }
  return shapeKitchenOrder(order);
}

/**
 * ТЗ §10 (WAITING -> PREPARING -> READY) and §11 (READY -> HANDED_TO_WAITER,
 * with the order rolling to READY_FOR_DELIVERY once every item has been
 * handed off). ТЗ: "При фактическом начале/подтверждении приготовления:
 * reserved_quantity -= quantity; stock_quantity -= quantity" - read as "at
 * the start of cooking", i.e. the WAITING -> PREPARING transition, which is
 * where this function finalizes (consumes) that item's reservations.
 *
 * Concurrency (TZ §FR-09/FR-12): everything runs in ONE transaction under a row lock on the order, so
 *   - a double click / network retry of the same transition is a harmless no-op (consumed exactly once);
 *   - "start cooking" racing an admin cancellation has exactly one winner;
 *   - the status change and its order_status_events row can never disagree.
 */
export async function updateOrderItemStatus(orderItemId: bigint, nextStatus: OrderItemStatus, actorUserId: bigint | null = null) {
  if (!ORDER_ITEM_STATUSES.includes(nextStatus)) {
    throw new ValidationError(`status must be one of: ${ORDER_ITEM_STATUSES.join(", ")}`);
  }

  const found = await prisma.orderItem.findUnique({ where: { orderItemId }, select: { orderId: true } });
  if (!found) {
    throw new NotFoundError("Order item");
  }
  const orderId = found.orderId;

  await prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, orderId);

    const order = await tx.order.findUniqueOrThrow({ where: { orderId }, select: { orderStatus: true } });
    if (order.orderStatus !== "SENT_TO_KITCHEN") {
      throw new ConflictError(`Заказ уже не в работе на кухне (статус ${order.orderStatus})`);
    }

    const item = await tx.orderItem.findUniqueOrThrow({ where: { orderItemId } });
    const currentStatus = item.status as OrderItemStatus;
    if (currentStatus === nextStatus) return; // a retry of the transition that already happened
    if (!canTransitionOrderItem(currentStatus, nextStatus)) {
      throw new ConflictError(`Can't move an item from ${currentStatus} to ${nextStatus}`);
    }

    const moved = await tx.orderItem.updateMany({
      where: { orderItemId, status: currentStatus },
      data: { status: nextStatus },
    });
    if (moved.count === 0) throw new ConflictError("Статус позиции уже изменён, обновите экран");

    const actor = { actorType: "STAFF" as const, actorId: actorUserId };

    if (nextStatus === "PREPARING") {
      await consumeReservationsForItem(tx, orderItemId);
      // only the FIRST item that starts cooking creates the event (unique per order + type)
      await recordOrderEvent(tx, { orderId, eventType: "COOKING_STARTED", status: "PREPARING", ...actor });
    }

    if (nextStatus === "HANDED_TO_WAITER") {
      const remaining = await tx.orderItem.count({
        where: { orderId, status: { notIn: ["HANDED_TO_WAITER", "DELIVERED"] } },
      });
      if (remaining === 0) {
        await tx.order.updateMany({
          where: { orderId, orderStatus: "SENT_TO_KITCHEN" },
          data: { orderStatus: "READY_FOR_DELIVERY" },
        });
        await recordOrderEvent(tx, { orderId, eventType: "READY_FOR_DELIVERY", status: "READY_FOR_DELIVERY", ...actor });
      }
    }
  });

  return getKitchenOrder(orderId);
}
