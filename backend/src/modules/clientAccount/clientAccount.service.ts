import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { hashPassword, verifyPassword } from "../../lib/auth";
import { AppError, NotFoundError } from "../../lib/errors";
import { money, type Decimal } from "../../lib/decimal";
import { formatQuantityRu } from "../../lib/units";
import type { ClientContext } from "../../middleware/clientAuth.middleware";
import { addItemToCart, getCart } from "../cart/cart.service";
import { assertValidPassword, revokeAllClientSessions } from "../clientAuth/clientAuth.service";
import { deleteIdentityRecords, getIdentityStatus } from "../identity/identity.service";
import { purgeTelegramData, getTelegramStatus } from "../integrations/telegram.service";
import { getBalance } from "../loyalty/loyalty.service";
import { compositionSurcharge, loadDishConfigSource, resolveRecipeSelection, unitPriceWithOptions } from "../menu/recipeCalculation.service";
import { buildTrackingOrder } from "../orderTracking/orderTracking.service";
import { PAYMENT_METHOD_LABELS } from "../receipts/receipts.service";
import { assertSessionActive } from "../sessions/sessions.service";

const notOwned = () => new AppError(404, "ORDER_NOT_OWNED", "Заказ не найден");

// ============================================================================
// profile, password, deletion
// ============================================================================

export async function getProfile(clientUserId: bigint) {
  const client = await prisma.clientUser.findUnique({ where: { clientUserId } });
  if (!client) throw new NotFoundError("Account");
  const [balance, identity, telegram] = await Promise.all([
    getBalance(prisma, clientUserId),
    getIdentityStatus(clientUserId),
    getTelegramStatus(clientUserId),
  ]);
  return {
    clientUserId: client.clientUserId,
    name: client.name,
    email: client.email,
    createdAt: client.createdAt,
    bonusBalance: balance,
    /** status only - never a document number or an image */
    identity,
    telegram,
    loyalty: { cashbackRate: env.cashbackRate, redemptionCap: env.cashbackRedemptionCap },
  };
}

export async function changePassword(client: ClientContext, input: { oldPassword: string; newPassword: string }) {
  assertValidPassword(input.newPassword);
  const user = await prisma.clientUser.findUnique({ where: { clientUserId: client.clientUserId } });
  if (!user?.passwordHash || !(await verifyPassword(input.oldPassword, user.passwordHash))) {
    // 400, not 401: a wrong OLD password must not look like "your session expired" to the frontend.
    throw new AppError(400, "WRONG_PASSWORD", "Старый пароль указан неверно");
  }
  if (await verifyPassword(input.newPassword, user.passwordHash)) {
    throw new AppError(400, "VALIDATION_ERROR", "Новый пароль должен отличаться от старого");
  }
  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.clientUser.update({
      where: { clientUserId: client.clientUserId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    // Every session - including this one - is revoked: whoever knew the old password is out.
    await revokeAllClientSessions(client.clientUserId, tx);
  });
}

/**
 * Soft-delete + anonymisation: the person can no longer log in and no personal data remains, while the
 * operational/fiscal trail (orders, payments, receipts, the loyalty ledger) is kept without any link to a
 * named person. Every issued token stops working at once (requests after deletion get 401).
 */
export async function deleteAccount(client: ClientContext, input: { password: string }) {
  const user = await prisma.clientUser.findUnique({ where: { clientUserId: client.clientUserId } });
  if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError(400, "WRONG_PASSWORD", "Пароль указан неверно");
  }
  const active = await prisma.order.count({
    where: { clientUserId: client.clientUserId, orderStatus: { notIn: ["DELIVERED", "CANCELLED"] } },
  });
  if (active > 0) {
    throw new AppError(409, "ACCOUNT_HAS_ACTIVE_ORDERS", "Дождитесь завершения активных заказов, затем удалите аккаунт");
  }
  await prisma.$transaction(async (tx) => {
    await tx.clientUser.update({
      where: { clientUserId: client.clientUserId },
      data: { name: "Удалённый пользователь", email: null, passwordHash: null, isActive: false, deletedAt: new Date() },
    });
    await purgeTelegramData(tx, client.clientUserId);
    await deleteIdentityRecords(tx, client.clientUserId);
    await revokeAllClientSessions(client.clientUserId, tx);
  });
}

// ============================================================================
// order history
// ============================================================================

/** Only orders created by an authenticated checkout of THIS account - guest orders are never attached afterwards. */
export async function listOrders(clientUserId: bigint, opts: { limit: number; cursor?: bigint | undefined }) {
  const orders = await prisma.order.findMany({
    where: { clientUserId },
    orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { orderId: opts.cursor }, skip: 1 } : {}),
    include: {
      items: { include: { dish: { select: { name: true } } }, orderBy: { orderItemId: "asc" } },
      receipt: { select: { receiptNumber: true } },
      rating: { select: { rating: true } },
    },
  });
  const hasMore = orders.length > opts.limit;
  const page = hasMore ? orders.slice(0, opts.limit) : orders;
  return {
    orders: page.map((o) => ({
      orderId: o.orderId,
      createdAt: o.createdAt,
      deliveredAt: o.deliveredAt,
      orderStatus: o.orderStatus,
      paymentStatus: o.paymentStatus,
      subtotal: o.subtotal.toFixed(2),
      discountBonus: o.discountBonus,
      payableTotal: o.payableTotal.toFixed(2),
      itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
      itemsPreview: o.items.slice(0, 3).map((i) => ({ name: i.dish.name, quantity: i.quantity })),
      receiptAvailable: o.receipt !== null,
      rating: o.rating?.rating ?? null,
      canRate: o.orderStatus === "DELIVERED" && o.rating === null,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.orderId ?? null) : null,
  };
}

/** Full historical snapshot: what was ordered, at what price, with which composition, how it was paid. */
export async function getOrderDetail(clientUserId: bigint, orderId: bigint) {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: {
      table: { select: { tableNumber: true } },
      items: {
        orderBy: { orderItemId: "asc" },
        include: {
          dish: { select: { name: true } },
          options: { include: { option: { select: { name: true } } }, orderBy: { orderItemOptionId: "asc" } },
          ingredients: { orderBy: { orderItemIngredientId: "asc" } },
        },
      },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
      receipt: { select: { receiptNumber: true, kind: true } },
      rating: { select: { rating: true } },
      statusEvents: { select: { eventType: true, occurredAt: true } },
    },
  });
  if (!order || order.clientUserId !== clientUserId) throw notOwned();

  const tracking = buildTrackingOrder({
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    deliveredAt: order.deliveredAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    items: order.items.map((i) => ({ quantity: i.quantity })),
    statusEvents: order.statusEvents,
    receipt: order.receipt ? { receiptId: 0n } : null,
  });
  const payment = order.payments[0] ?? null;

  const items = order.items.map((item) => {
    const optionsPerServing = item.options.reduce((s, o) => s.plus(o.price.times(o.quantity)), new Prisma.Decimal(0));
    const unitPrice = item.price.plus(optionsPerServing);
    return {
      orderItemId: item.orderItemId,
      name: item.dish.name,
      quantity: item.quantity,
      unitPrice: money(unitPrice),
      lineTotal: money(unitPrice.times(item.quantity)),
      options: item.options.map((o) => ({ name: o.option.name, quantity: o.quantity, price: money(o.price) })),
      composition: item.ingredients
        .filter((i) => i.source === "RECIPE" && !i.selectedPerServing.equals(i.basePerServing))
        .map((i) => ({
          name: i.ingredientNameSnapshot,
          text: i.selectedPerServing.isZero()
            ? "убрать"
            : `${formatQuantityRu(i.selectedPerServing, i.unitSnapshot)} вместо ${formatQuantityRu(i.basePerServing, i.unitSnapshot)} на порцию`,
        })),
      snapshotAvailable: item.ingredients.length > 0,
    };
  });

  const receiptStatus = order.receipt
    ? { available: true, receiptNumber: order.receipt.receiptNumber, kind: order.receipt.kind, reason: null as string | null }
    : order.paymentStatus === "PAID"
      ? { available: true, receiptNumber: null, kind: null, reason: "Чек будет сформирован при открытии" }
      : { available: false, receiptNumber: null, kind: null, reason: "Чек появится после оплаты" };

  return {
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    statusLabel: tracking.statusLabel,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    deliveredAt: order.deliveredAt, // null -> the UI says «Ожидается»
    cancelled: tracking.cancelled,
    tableNumber: order.table?.tableNumber ?? null,
    comment: order.comment,
    items,
    subtotal: order.subtotal.toFixed(2),
    discountBonus: order.discountBonus,
    payableTotal: order.payableTotal.toFixed(2),
    payment: payment
      ? {
          method: payment.method,
          methodLabel: PAYMENT_METHOD_LABELS[payment.method] ?? payment.method,
          status: payment.status,
          amount: payment.amount.toFixed(2),
          bonusUsed: payment.bonusUsed,
          isDemo: payment.isDemo,
          paidAt: payment.paidAt,
          refundStatus: payment.refundStatus,
        }
      : null,
    receipt: receiptStatus,
    restaurant: { name: env.merchant.name, address: env.merchant.address },
    rating: order.rating?.rating ?? null,
    canRate: order.orderStatus === "DELIVERED" && order.rating === null,
    steps: tracking.steps,
  };
}

export async function rateOrder(clientUserId: bigint, orderId: bigint, rating: number) {
  const order = await prisma.order.findUnique({ where: { orderId }, select: { clientUserId: true, orderStatus: true } });
  if (!order || order.clientUserId !== clientUserId) throw notOwned();
  if (order.orderStatus !== "DELIVERED") {
    throw new AppError(409, "ORDER_NOT_RATEABLE", "Оценить можно только выданный заказ");
  }
  try {
    const created = await prisma.orderRating.create({ data: { orderId, clientUserId, rating } });
    return { orderId, rating: created.rating };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "ORDER_ALREADY_RATED", "Этот заказ уже оценён");
    }
    throw err;
  }
}

// ============================================================================
// reorder
// ============================================================================

export interface ReorderResult {
  addedItems: { dishName: string; quantity: number }[];
  unavailableItems: { dishName: string; quantity: number; reason: string; message: string }[];
  priceChanged: { dishId: string; dishName: string; previousUnitPrice: string; currentUnitPrice: string }[];
  warnings: string[];
  requiresPriceConfirmation: boolean;
  cart: Awaited<ReturnType<typeof getCart>>;
}

const COMPOSITION_CODES = new Set([
  "INGREDIENT_NOT_IN_DISH",
  "INVALID_INGREDIENT_STEP",
  "INGREDIENT_OUT_OF_RANGE",
  "INGREDIENT_NOT_CUSTOMIZABLE",
  "UNIT_MISMATCH",
]);

/**
 * Rebuilds a past order in the CURRENT table session's cart. It never creates an order or a payment and never
 * bypasses checkout (stock, 21+, cashback are all re-checked there). Every line goes through the same
 * validation as a normal "add to cart": the old snapshot is re-applied to the CURRENT recipe limits, the CURRENT
 * price and the CURRENT stock. What cannot be reproduced is reported, never silently dropped; if any price
 * changed, the cart is flagged and checkout stays blocked until the guest confirms the new total.
 */
export async function reorder(client: ClientContext, orderId: bigint, sessionId: bigint): Promise<ReorderResult> {
  await assertSessionActive(sessionId);
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: {
      items: {
        orderBy: { orderItemId: "asc" },
        include: {
          dish: { select: { name: true } },
          options: true,
          ingredients: true,
        },
      },
    },
  });
  if (!order || order.clientUserId !== client.clientUserId) throw notOwned();

  const ctx = { clientUserId: client.clientUserId };
  const result: Omit<ReorderResult, "cart" | "requiresPriceConfirmation"> = {
    addedItems: [],
    unavailableItems: [],
    priceChanged: [],
    warnings: [],
  };

  for (const item of order.items) {
    const dishName = item.dish.name;
    const src = await loadDishConfigSource(prisma, item.dishId);

    try {
      await addItemToCart(
        sessionId,
        {
          dishId: item.dishId,
          quantity: item.quantity,
          ingredients: item.ingredients
            .filter((i) => i.source === "RECIPE")
            .map((i) => ({ ingredientId: i.ingredientId, quantity: i.selectedPerServing })),
          options: item.options.map((o) => ({ optionId: o.optionId, quantity: o.quantity })),
        },
        ctx,
      );
      // Compute today's exact personalised price only after the recipe validation succeeds.
      let currentUnitPrice: Decimal | null = null;
      if (src) {
        const prices = new Map(src.options.map((o) => [o.optionId.toString(), o.price]));
        const selected = resolveRecipeSelection(
          src.recipeLines,
          item.ingredients.filter((i) => i.source === "RECIPE").map((i) => ({ ingredientId: i.ingredientId, quantity: i.selectedPerServing })),
        );
        currentUnitPrice = unitPriceWithOptions(
          src.dish.price.plus(compositionSurcharge(src.dish.price, selected)),
          item.options.map((o) => ({ price: prices.get(o.optionId.toString()) ?? o.price, quantity: o.quantity })),
        );
      }
      const previousUnitPrice = unitPriceWithOptions(item.price, item.options.map((o) => ({ price: o.price, quantity: o.quantity })));
      result.addedItems.push({ dishName, quantity: item.quantity });
      if (currentUnitPrice && !currentUnitPrice.equals(previousUnitPrice)) {
        result.priceChanged.push({
          dishId: item.dishId.toString(),
          dishName,
          previousUnitPrice: money(previousUnitPrice),
          currentUnitPrice: money(currentUnitPrice),
        });
      }
      if (src && item.ingredients.filter((i) => i.source === "RECIPE").length < src.recipeLines.length) {
        result.warnings.push(`Состав блюда «${dishName}» дополнен: в рецепте появились новые ингредиенты (взято стандартное количество).`);
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        result.unavailableItems.push({ dishName, quantity: item.quantity, reason: "DISH_INACTIVE", message: "Блюда больше нет в меню" });
      } else if (err instanceof AppError && COMPOSITION_CODES.has(err.code)) {
        result.unavailableItems.push({
          dishName,
          quantity: item.quantity,
          reason: "COMPOSITION_CHANGED",
          message: "Состав блюда изменился - выберите блюдо заново",
        });
      } else if (err instanceof AppError && (err.code === "OPTION_NOT_AVAILABLE" || err.code === "OPTION_UNAVAILABLE")) {
        result.unavailableItems.push({ dishName, quantity: item.quantity, reason: "OPTION_UNAVAILABLE", message: err.message });
      } else if (err instanceof AppError && (err.code === "INSUFFICIENT_INGREDIENTS" || err.code === "DISH_UNAVAILABLE")) {
        result.unavailableItems.push({ dishName, quantity: item.quantity, reason: err.code, message: err.message });
      } else {
        throw err;
      }
    }
  }

  if (result.priceChanged.length > 0) {
    const cart = await prisma.cart.findUnique({ where: { sessionId }, select: { cartId: true, pendingPriceChanges: true } });
    if (cart) {
      const previous = Array.isArray(cart.pendingPriceChanges) ? (cart.pendingPriceChanges as Prisma.JsonArray) : [];
      await prisma.cart.update({
        where: { cartId: cart.cartId },
        data: { pendingPriceChanges: [...previous, ...result.priceChanged] as unknown as Prisma.InputJsonArray },
      });
    }
  }

  const cart = await getCart(sessionId, ctx);
  return { ...result, requiresPriceConfirmation: result.priceChanged.length > 0, cart };
}

