import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { CheckoutValidationError, NotFoundError, type CheckoutIssue } from "../../lib/errors";
import type { Tx } from "../../lib/prismaTx";
import { assertSessionActive } from "../sessions/sessions.service";
import { sessionHasVerifiedAge, linkAgeVerificationToOrder } from "../ageVerification/ageVerification.service";
import {
  getDishIngredientNeeds,
  getOptionIngredientNeeds,
  sumIngredientNeeds,
  findInsufficientIngredients,
  type IngredientNeed,
} from "../menu/inventory.service";
import type { PaymentMethod } from "../../types/status";

const cartWithFreshDataInclude = {
  items: {
    include: {
      dish: true,
      options: { include: { option: true } },
    },
  },
};

type CartWithFreshData = Prisma.CartGetPayload<{ include: typeof cartWithFreshDataInclude }>;

async function loadCartForValidation(sessionId: bigint): Promise<CartWithFreshData | null> {
  return prisma.cart.findUnique({ where: { sessionId }, include: cartWithFreshDataInclude });
}

export interface CheckoutValidationResult {
  ok: boolean;
  requiresAgeVerification: boolean;
  issues: CheckoutIssue[];
  total: Prisma.Decimal;
  itemCount: number;
}

/**
 * ТЗ §5's checklist, run before an order can be placed:
 *   - корзина не пустая
 *   - блюда всё ещё доступны (still active)
 *   - хватает ингредиентов (aggregate, across the whole cart)
 *   - столик всё ещё закреплён за этой сессией (thrown, not listed as an
 *     issue — there's no cart edit that fixes a stale session)
 *   - для всех блюд корректно рассчитана цена (satisfied by construction:
 *     the total below is always recomputed server-side from price_at_add,
 *     never trusted from the client)
 *   - если есть 21+ — требуется подтверждение возраста
 */
export async function validateCheckout(sessionId: bigint): Promise<CheckoutValidationResult> {
  await assertSessionActive(sessionId);

  const cart = await loadCartForValidation(sessionId);
  const issues: CheckoutIssue[] = [];

  if (!cart || cart.items.length === 0) {
    return {
      ok: false,
      requiresAgeVerification: false,
      issues: [{ type: "EMPTY_CART", message: "Cart is empty" }],
      total: new Prisma.Decimal(0),
      itemCount: 0,
    };
  }

  for (const item of cart.items) {
    if (!item.dish.isActive) {
      issues.push({
        type: "DISH_INACTIVE",
        cartItemId: item.cartItemId.toString(),
        dishName: item.dish.name,
        message: `${item.dish.name} is no longer on the menu`,
      });
    }
  }

  const needLists: IngredientNeed[][] = [];
  for (const item of cart.items) {
    if (!item.dish.isActive) continue;
    needLists.push(await getDishIngredientNeeds(item.dishId, item.quantity));
    for (const opt of item.options) {
      needLists.push(await getOptionIngredientNeeds(opt.optionId, opt.quantity));
    }
  }
  const shortfalls = await findInsufficientIngredients(sumIngredientNeeds(needLists));
  for (const shortfall of shortfalls) {
    issues.push({
      type: "INSUFFICIENT_INGREDIENTS",
      message: `Not enough ${shortfall.ingredientName}: need ${shortfall.needed.toString()} ${shortfall.unit}, have ${shortfall.free.toString()} ${shortfall.unit}`,
    });
  }

  const requiresAgeVerification = cart.items.some((item) => item.dish.is21Plus);
  if (requiresAgeVerification) {
    const verified = await sessionHasVerifiedAge(sessionId);
    if (!verified) {
      issues.push({
        type: "AGE_VERIFICATION_REQUIRED",
        message: "This order contains a 21+ item and needs staff age verification first",
      });
    }
  }

  const total = cart.items.reduce((sum, item) => {
    const optionsTotal = item.options.reduce((s, o) => s.plus(o.priceAtAdd.times(o.quantity)), new Prisma.Decimal(0));
    return sum.plus(item.priceAtAdd.times(item.quantity)).plus(optionsTotal);
  }, new Prisma.Decimal(0));
  const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);

  return { ok: issues.length === 0, requiresAgeVerification, issues, total, itemCount };
}

/** Reserves inventory for one order item (recipe ingredients + any chosen options), inside a transaction. */
async function reserveIngredientsForOrderItem(
  tx: Tx,
  orderId: bigint,
  orderItemId: bigint,
  dishId: bigint,
  quantity: number,
  options: { optionId: bigint; quantity: number }[],
) {
  const needLists: IngredientNeed[][] = [await getDishIngredientNeeds(dishId, quantity)];
  for (const opt of options) {
    needLists.push(await getOptionIngredientNeeds(opt.optionId, opt.quantity));
  }
  // ADDED: reservations are kept granular per order_item (see schema header
  // note #2) so a later per-item PREPARING transition knows exactly which
  // reservation rows are "its" ingredients, even when another item in the
  // same order needs the same ingredient.
  for (const need of needLists.flat()) {
    if (need.quantity.lessThanOrEqualTo(0)) continue;
    await tx.inventoryReservation.create({
      data: {
        orderId,
        orderItemId,
        ingredientId: need.ingredientId,
        quantity: need.quantity,
        status: "RESERVED",
      },
    });
    await tx.inventory.update({
      where: { ingredientId: need.ingredientId },
      data: { reservedQuantity: { increment: need.quantity } },
    });
  }
}

export interface ConfirmCheckoutInput {
  sessionId: bigint;
  paymentMethod: PaymentMethod;
}

/**
 * ТЗ §§7-10, bundled into one transaction because the pipeline has no user
 * action between "формируется заказ" and "отправка на кухню": create the
 * order + items (+ options) with price snapshots, reserve every ingredient
 * they need, record the payment, and clear the cart for its next round.
 *
 * Concurrency note: `validateCheckout` runs just before this, but there is
 * a small window between that read and this write where another checkout
 * on the same ingredients could interleave (no SELECT ... FOR UPDATE /
 * serializable retry loop here). For a single-restaurant, few-tables-at-once
 * school project this is an acceptable simplification — flagged here in
 * case this ever needs to hold up under heavier concurrent load.
 */
export async function confirmCheckout(input: ConfirmCheckoutInput) {
  const validation = await validateCheckout(input.sessionId);
  if (!validation.ok) {
    throw new CheckoutValidationError(validation.issues);
  }

  const session = await assertSessionActive(input.sessionId);
  const cart = await loadCartForValidation(input.sessionId);
  if (!cart || cart.items.length === 0) {
    throw new CheckoutValidationError([{ type: "EMPTY_CART", message: "Cart is empty" }]);
  }

  const isCash = input.paymentMethod === "CASH";

  const order = await prisma.$transaction(async (tx) => {
    const createdOrder = await tx.order.create({
      data: {
        sessionId: session.sessionId,
        tableId: session.tableId,
        totalPrice: validation.total,
        // Created and dispatched to the kitchen in the same step — see the
        // note on ORDER_TRANSITIONS in types/status.ts.
        orderStatus: "SENT_TO_KITCHEN",
        paymentStatus: isCash ? "WAITING_FOR_CASH" : "PAID",
      },
    });

    for (const item of cart.items) {
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: createdOrder.orderId,
          dishId: item.dishId,
          quantity: item.quantity,
          price: item.priceAtAdd,
          status: "WAITING",
          notes: item.notes,
        },
      });

      if (item.options.length > 0) {
        await tx.orderItemOption.createMany({
          data: item.options.map((o) => ({
            orderItemId: orderItem.orderItemId,
            optionId: o.optionId,
            quantity: o.quantity,
            price: o.priceAtAdd,
          })),
        });
      }

      await reserveIngredientsForOrderItem(
        tx,
        createdOrder.orderId,
        orderItem.orderItemId,
        item.dishId,
        item.quantity,
        item.options.map((o) => ({ optionId: o.optionId, quantity: o.quantity })),
      );
    }

    await tx.payment.create({
      data: {
        orderId: createdOrder.orderId,
        method: input.paymentMethod,
        status: isCash ? "WAITING_FOR_CASH" : "PAID",
        amount: validation.total,
        paidAt: isCash ? null : new Date(),
      },
    });

    // Cart rows are unique per session (one persistent cart across however
    // many orders a table places in a visit), so "converted" here means
    // "cleared and ready for the next round" rather than a dead end — see
    // the longer note in cart.service.ts's getOrCreateCart.
    await tx.cartItem.deleteMany({ where: { cartId: cart.cartId } });
    await tx.cart.update({ where: { cartId: cart.cartId }, data: { status: "ACTIVE" } });

    return createdOrder;
  });

  if (validation.requiresAgeVerification) {
    await linkAgeVerificationToOrder(session.sessionId, order.orderId);
  }

  return getOrderWithDetails(order.orderId);
}

export async function getOrderWithDetails(orderId: bigint) {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: {
      table: true,
      waiter: true,
      items: { include: { dish: true, options: { include: { option: true } } } },
      payments: true,
    },
  });
  if (!order) {
    throw new NotFoundError("Order");
  }
  return order;
}
