import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { AppError, CheckoutValidationError, NotFoundError, type CheckoutIssue } from "../../lib/errors";
import { money, qtyStr, ZERO, dec, type Decimal } from "../../lib/decimal";
import { sha256Hex, stableHash } from "../../lib/crypto";
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  IDEMPOTENCY_SCOPE_CHECKOUT,
} from "../../lib/idempotency";
import type { Tx } from "../../lib/prismaTx";
import { assertSessionActive } from "../sessions/sessions.service";
import { sessionHasVerifiedAge, linkAgeVerificationToOrder } from "../ageVerification/ageVerification.service";
import { isClientAgeVerified } from "../identity/identity.service";
import {
  computeMaxRedeem,
  earnBonuses,
  getBalance,
  lockClient,
  previewLoyalty,
  spendBonuses,
} from "../loyalty/loyalty.service";
import {
  findShortfalls,
  loadStockMap,
  reserveNeeds,
  shortfallMessage,
} from "../menu/inventory.service";
import {
  buildOrderItemIngredientRows,
  calculateOrderItemNeeds,
  lineTotal as computeLineTotal,
  mergeNeeds,
  type OrderItemIngredientRowInput,
} from "../menu/recipeCalculation.service";
import { ensureReceipt } from "../receipts/receipts.service";
import { enqueueAutoReceipt } from "../integrations/telegram.outbox";
import { recordOrderEvent } from "../orderTracking/orderTracking.service";
import type { PaymentMethod } from "../../types/status";

const checkoutCartInclude = {
  items: {
    orderBy: { cartItemId: "asc" as const },
    include: {
      dish: { include: { category: { select: { isActive: true } } } },
      options: { include: { option: true }, orderBy: { cartItemOptionId: "asc" as const } },
      ingredients: { include: { ingredient: true }, orderBy: { cartItemIngredientId: "asc" as const } },
    },
  },
} satisfies Prisma.CartInclude;

type CheckoutCart = Prisma.CartGetPayload<{ include: typeof checkoutCartInclude }>;
type CheckoutItem = CheckoutCart["items"][number];

interface PreparedItem {
  item: CheckoutItem;
  lineTotal: Decimal;
  /** what stock this line needs (empty for untracked dishes) */
  needs: Map<string, Decimal>;
  ingredientRows: OrderItemIngredientRowInput[];
}

interface Evaluation {
  prepared: PreparedItem[];
  issues: CheckoutIssue[];
  subtotal: Decimal;
  itemCount: number;
  requiresAgeVerification: boolean;
  mergedNeeds: Map<string, Decimal>;
}

const BLOCKING_AVAILABILITY_ISSUES: CheckoutIssue["type"][] = [
  "DISH_INACTIVE",
  "DISH_UNAVAILABLE",
  "INGREDIENT_INACTIVE",
  "INSUFFICIENT_INGREDIENTS",
];

/**
 * ТЗ §5's checklist (+ TZ v2), evaluated against a cart - used both by the read-only validate endpoint
 * (db = prisma) and, authoritatively, INSIDE the confirm transaction (db = tx):
 *   - корзина не пустая
 *   - блюда всё ещё доступны (active dish, active category, options still available)
 *   - хватает ингредиентов - the PERSONALISED composition of every line, summed over the whole cart
 *   - если есть 21+ - подтверждение возраста: staff check for the session OR a verified client identity
 *   - новые цены после «повторить заказ» подтверждены гостем
 *   - итоговая сумма > 0
 * Prices are always recomputed from price_at_add; nothing numeric is ever trusted from the client.
 */
async function evaluateCart(
  db: Tx,
  cart: CheckoutCart,
  sessionId: bigint,
  clientUserId: bigint | null,
): Promise<Evaluation> {
  const issues: CheckoutIssue[] = [];
  const prepared: PreparedItem[] = [];

  const optionIds = [...new Set(cart.items.flatMap((i) => i.options.map((o) => o.optionId.toString())))].map((s) => BigInt(s));
  const optionIngredients = optionIds.length
    ? await db.dishOptionIngredient.findMany({ where: { optionId: { in: optionIds } }, include: { ingredient: true } })
    : [];

  // Lines created before snapshots existed fall back to the current recipe.
  const legacyDishIds = [...new Set(cart.items.filter((i) => i.ingredients.length === 0).map((i) => i.dishId.toString()))].map((s) => BigInt(s));
  const legacyRecipes = legacyDishIds.length
    ? await db.recipe.findMany({ where: { dishId: { in: legacyDishIds } }, include: { ingredient: true } })
    : [];

  for (const item of cart.items) {
    const itemId = item.cartItemId.toString();
    const optionPrices = item.options.map((o) => ({ price: o.priceAtAdd, quantity: o.quantity }));
    const total = computeLineTotal(item.priceAtAdd, item.quantity, optionPrices);

    const recipeLines =
      item.ingredients.length > 0
        ? item.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            name: i.ingredient.name,
            unit: i.unitSnapshot,
            base: i.baseQuantity,
            selected: i.selectedQuantity,
          }))
        : legacyRecipes
            .filter((r) => r.dishId === item.dishId)
            .map((r) => ({
              ingredientId: r.ingredientId,
              name: r.ingredient.name,
              unit: r.ingredient.unit,
              base: r.quantity,
              selected: r.quantity,
            }));

    const optionDefs = item.options.map((o) => ({
      optionId: o.optionId,
      quantity: o.quantity,
      name: o.option.name,
      isActive: o.option.isActive,
      tracked: o.option.inventoryTracked,
      ingredients: optionIngredients
        .filter((oi) => oi.optionId === o.optionId)
        .map((oi) => ({ ingredientId: oi.ingredientId, name: oi.ingredient.name, unit: oi.ingredient.unit, quantity: oi.quantity })),
    }));

    const ingredientRows = buildOrderItemIngredientRows({
      quantity: item.quantity,
      recipe: recipeLines,
      options: optionDefs.map((o) => ({ quantity: o.quantity, ingredients: o.ingredients })),
    });

    let needs = new Map<string, Decimal>();
    let blocked = false;

    if (!item.dish.isActive || !item.dish.category.isActive) {
      blocked = true;
      issues.push({
        type: "DISH_INACTIVE",
        cartItemId: itemId,
        dishName: item.dish.name,
        message: `«${item.dish.name}» больше нет в меню - удалите блюдо из корзины`,
      });
    } else {
      for (const o of optionDefs) {
        if (!o.isActive || (o.tracked && o.ingredients.length === 0)) {
          blocked = true;
          issues.push({
            type: "DISH_UNAVAILABLE",
            cartItemId: itemId,
            dishName: item.dish.name,
            message: `Опция «${o.name}» для блюда «${item.dish.name}» больше недоступна`,
          });
        }
      }
      if (item.dish.inventoryTracked && recipeLines.length === 0) {
        blocked = true;
        issues.push({
          type: "DISH_UNAVAILABLE",
          cartItemId: itemId,
          dishName: item.dish.name,
          message: `Состав блюда «${item.dish.name}» не задан - блюдо временно недоступно`,
        });
      }
    }

    if (!blocked && item.dish.inventoryTracked) {
      needs = calculateOrderItemNeeds({
        quantity: item.quantity,
        ingredients: recipeLines.map((r) => ({ ingredientId: r.ingredientId, selectedPerServing: r.selected })),
        options: optionDefs.map((o) => ({
          optionId: o.optionId,
          quantity: o.quantity,
          ingredients: o.ingredients.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity })),
        })),
      });
    }
    prepared.push({ item, lineTotal: total, needs, ingredientRows });
  }

  // Aggregate need across the whole cart: three lines using parmesan compete for the same stock.
  const mergedNeeds = mergeNeeds(prepared.map((p) => p.needs));
  if (mergedNeeds.size > 0) {
    const stock = await loadStockMap(db, [...mergedNeeds.keys()].map((k) => BigInt(k)));
    for (const s of findShortfalls(mergedNeeds, stock)) {
      const key = s.ingredientId.toString();
      const affected = prepared.filter((p) => p.needs.has(key));
      issues.push({
        type: s.reason === "INGREDIENT_INACTIVE" ? "INGREDIENT_INACTIVE" : "INSUFFICIENT_INGREDIENTS",
        cartItemIds: affected.map((p) => p.item.cartItemId.toString()),
        ...(affected[0] ? { cartItemId: affected[0].item.cartItemId.toString(), dishName: affected[0].item.dish.name } : {}),
        ingredientId: key,
        ingredientName: s.ingredientName,
        unit: s.unit,
        needed: qtyStr(s.needed),
        free: qtyStr(Prisma.Decimal.max(s.free, 0)),
        message: shortfallMessage(s),
      });
    }
  }

  const subtotal = prepared.reduce((sum, p) => sum.plus(p.lineTotal), ZERO);
  const itemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);

  const requiresAgeVerification = cart.items.some((i) => i.dish.is21Plus);
  if (requiresAgeVerification) {
    const verified =
      (await sessionHasVerifiedAge(sessionId)) || (clientUserId !== null && (await isClientAgeVerified(db, clientUserId)));
    if (!verified) {
      issues.push({
        type: "AGE_VERIFICATION_REQUIRED",
        message: "В заказе есть позиции 21+. Подтвердите возраст у официанта или пройдите проверку в личном кабинете.",
      });
    }
  }

  const pending = cart.pendingPriceChanges;
  if (Array.isArray(pending) && pending.length > 0) {
    issues.push({
      type: "PRICE_CONFIRMATION_REQUIRED",
      message: "Цены изменились с момента прошлого заказа. Подтвердите новую сумму, чтобы продолжить.",
    });
  }

  if (cart.items.length > 0 && subtotal.lte(0)) {
    issues.push({ type: "ZERO_TOTAL", message: "Итоговая сумма заказа должна быть больше нуля" });
  }

  return { prepared, issues, subtotal, itemCount, requiresAgeVerification, mergedNeeds };
}

export interface CheckoutContext {
  clientUserId?: bigint | null | undefined;
  useCashback?: boolean | undefined;
}

export interface CheckoutValidationResult {
  ok: boolean;
  requiresAgeVerification: boolean;
  issues: CheckoutIssue[];
  /** = subtotal (kept for the existing client) */
  total: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  /** money to pay after the cashback preview (equals subtotal unless ?useCashback=true) */
  payableTotal: string;
  itemCount: number;
  /** false when ANY line cannot be made right now in its CHOSEN configuration */
  configurationAvailable: boolean;
  loyaltyPreview: Awaited<ReturnType<typeof previewLoyalty>>;
}

export async function validateCheckout(sessionId: bigint, ctx: CheckoutContext = {}): Promise<CheckoutValidationResult> {
  await assertSessionActive(sessionId);

  const cart = await prisma.cart.findUnique({ where: { sessionId }, include: checkoutCartInclude });
  const clientUserId = ctx.clientUserId ?? null;

  if (!cart || cart.items.length === 0) {
    return {
      ok: false,
      requiresAgeVerification: false,
      issues: [{ type: "EMPTY_CART", message: "Корзина пуста" }],
      total: new Prisma.Decimal(0),
      subtotal: new Prisma.Decimal(0),
      payableTotal: "0.00",
      itemCount: 0,
      configurationAvailable: true,
      loyaltyPreview: await previewLoyalty(prisma, clientUserId, ZERO, false),
    };
  }

  const ev = await evaluateCart(prisma, cart, sessionId, clientUserId);
  const preview = await previewLoyalty(prisma, clientUserId, ev.subtotal, ctx.useCashback === true);
  return {
    ok: ev.issues.length === 0,
    requiresAgeVerification: ev.requiresAgeVerification,
    issues: ev.issues,
    total: ev.subtotal,
    subtotal: ev.subtotal,
    payableTotal: preview.payableTotal,
    itemCount: ev.itemCount,
    configurationAvailable: !ev.issues.some((i) => BLOCKING_AVAILABILITY_ISSUES.includes(i.type)),
    loyaltyPreview: preview,
  };
}

export interface ConfirmCheckoutInput extends CheckoutContext {
  sessionId: bigint;
  paymentMethod: PaymentMethod;
  /** the payable total the guest saw; a mismatch is a CASHBACK_CONFLICT, never a silent surprise */
  expectedPayableTotal?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface ConfirmCheckoutResult {
  order: Awaited<ReturnType<typeof getOrderWithDetails>>;
  /** true when this call only returned the result of an earlier identical request */
  replay: boolean;
  earnedBonus: number;
}

/**
 * ТЗ §§7-10 as ONE transaction (the pipeline has no user action between "формируется заказ" and
 * "отправка на кухню"):
 *   idempotency key -> lock the cart -> lock the client -> authoritative validation -> price + cashback ->
 *   order + items + options + COMPOSITION SNAPSHOT -> atomic reservation of every ingredient ->
 *   payment -> bonus spend / earn -> status events -> receipt (when PAID) -> clear the cart.
 *
 * Concurrency: reservation is a conditional UPDATE per ingredient, so two tables ordering the last of an
 * ingredient at the same moment can never both succeed or push stock negative; the cart row lock plus the
 * idempotency key make a double click / network retry produce exactly one order, one spend, one earn and
 * one receipt. A failure of ANY step rolls the whole thing back - nothing is half-created.
 */
export async function confirmCheckout(input: ConfirmCheckoutInput): Promise<ConfirmCheckoutResult> {
  const clientUserId = input.clientUserId ?? null;
  const isCash = input.paymentMethod === "CASH";
  const key = input.idempotencyKey ?? null;
  const ownerId = `session:${input.sessionId}`;
  const requestHash = stableHash({
    sessionId: input.sessionId.toString(),
    paymentMethod: input.paymentMethod,
    useCashback: input.useCashback === true,
    clientUserId: clientUserId?.toString() ?? null,
    expectedPayableTotal: input.expectedPayableTotal ?? null,
  });

  const outcome = await prisma.$transaction(
    async (tx) => {
      if (key) {
        const started = await beginIdempotentRequest(tx, { key, scope: IDEMPOTENCY_SCOPE_CHECKOUT, ownerId, requestHash });
        if (started.replay) return { kind: "replay" as const, orderId: BigInt(started.responseRef) };
      }

      const cartRow = await tx.cart.findUnique({ where: { sessionId: input.sessionId }, select: { cartId: true } });
      if (!cartRow) throw new CheckoutValidationError([{ type: "EMPTY_CART", message: "Корзина пуста" }]);
      // A second checkout of the same cart waits here and then finds it empty.
      await tx.$queryRaw(Prisma.sql`SELECT "cart_id" FROM "carts" WHERE "cart_id" = ${cartRow.cartId} FOR UPDATE`);

      const session = await assertSessionActive(input.sessionId, tx);
      const cart = await tx.cart.findUniqueOrThrow({ where: { cartId: cartRow.cartId }, include: checkoutCartInclude });
      if (cart.items.length === 0) throw new CheckoutValidationError([{ type: "EMPTY_CART", message: "Корзина пуста" }]);

      if (clientUserId !== null) await lockClient(tx, clientUserId);

      const ev = await evaluateCart(tx, cart, session.sessionId, clientUserId);
      if (ev.issues.length > 0) throw new CheckoutValidationError(ev.issues);

      // ---- cashback: the server decides, never the client ----------------------------------------
      let discount = 0;
      let balanceBefore = 0;
      if (input.useCashback) {
        if (clientUserId === null) {
          throw new AppError(401, "CLIENT_UNAUTHORIZED", "Войдите в личный кабинет, чтобы списать кэшбэк");
        }
        balanceBefore = await getBalance(tx, clientUserId);
        discount = computeMaxRedeem(balanceBefore, ev.subtotal);
        if (discount <= 0) {
          throw new AppError(409, "CASHBACK_INSUFFICIENT", "Нет бонусов, доступных для списания", { balance: balanceBefore });
        }
      }
      const payable = ev.subtotal.minus(discount);
      if (payable.lte(0)) {
        throw new CheckoutValidationError([{ type: "ZERO_TOTAL", message: "Итоговая сумма заказа должна быть больше нуля" }]);
      }
      if (input.expectedPayableTotal !== undefined && !dec(input.expectedPayableTotal).equals(payable)) {
        throw new AppError(409, "CASHBACK_CONFLICT", "Сумма к оплате изменилась. Проверьте итог и подтвердите заказ ещё раз.", {
          payableTotal: money(payable),
          subtotal: money(ev.subtotal),
          discount,
          balance: balanceBefore,
        });
      }

      const now = new Date();
      const order = await tx.order.create({
        data: {
          sessionId: session.sessionId,
          tableId: session.tableId,
          clientUserId,
          totalPrice: ev.subtotal,
          subtotal: ev.subtotal,
          discountBonus: discount,
          payableTotal: payable,
          comment: cart.comment,
          // Created and dispatched to the kitchen in the same step - see the
          // note on ORDER_TRANSITIONS in types/status.ts.
          orderStatus: "SENT_TO_KITCHEN",
          paymentStatus: isCash ? "WAITING_FOR_CASH" : "PAID",
          acceptedAt: now,
        },
      });

      for (const p of ev.prepared) {
        const orderItem = await tx.orderItem.create({
          data: {
            orderId: order.orderId,
            dishId: p.item.dishId,
            quantity: p.item.quantity,
            price: p.item.priceAtAdd,
            status: "WAITING",
            notes: p.item.notes,
            options: {
              create: p.item.options.map((o) => ({ optionId: o.optionId, quantity: o.quantity, price: o.priceAtAdd })),
            },
            ingredients: {
              create: p.ingredientRows.map((r) => ({
                ingredientId: r.ingredientId,
                ingredientNameSnapshot: r.name,
                unitSnapshot: r.unit,
                basePerServing: r.basePerServing,
                selectedPerServing: r.selectedPerServing,
                requiredTotal: r.requiredTotal,
                source: r.source,
              })),
            },
          },
        });

        // ADDED: reservations are kept granular per order_item (see schema header note #2) so a later
        // per-item PREPARING transition knows exactly which rows are "its" ingredients; ONE aggregated
        // row per (item, ingredient) - recipe and option amounts of the same ingredient are summed.
        const rows = [...p.needs.entries()].map(([ingredientId, quantity]) => ({
          orderId: order.orderId,
          orderItemId: orderItem.orderItemId,
          ingredientId: BigInt(ingredientId),
          quantity,
          status: "RESERVED",
        }));
        if (rows.length > 0) await tx.inventoryReservation.createMany({ data: rows });
      }

      // The authoritative stock guard: conditional UPDATEs, ascending ingredient id.
      await reserveNeeds(tx, ev.mergedNeeds);

      await tx.payment.create({
        data: {
          orderId: order.orderId,
          method: input.paymentMethod,
          status: isCash ? "WAITING_FOR_CASH" : "PAID",
          amount: payable,
          bonusUsed: discount,
          isDemo: input.paymentMethod === "KASPI_QR",
          providerRef: isCash ? null : `DEMO-KASPI-${sha256Hex(key ?? `${order.orderId}`).slice(0, 24)}`,
          paidAt: isCash ? null : now,
        },
      });

      let earned = 0;
      if (clientUserId !== null) {
        if (discount > 0) {
          await spendBonuses(tx, { clientUserId, orderId: order.orderId, amount: discount, paymentMethod: input.paymentMethod });
        }
        if (!isCash) earned = await earnBonuses(tx, { clientUserId, orderId: order.orderId, paidMoney: payable });
      }

      const actorType = clientUserId !== null ? "CLIENT" : "GUEST";
      await recordOrderEvent(tx, {
        orderId: order.orderId,
        eventType: "ORDER_CREATED",
        status: "SENT_TO_KITCHEN",
        actorType,
        actorId: clientUserId,
        occurredAt: now,
      });
      if (!isCash) {
        await recordOrderEvent(tx, {
          orderId: order.orderId,
          eventType: "PAYMENT_CONFIRMED",
          status: "PAID",
          actorType,
          actorId: clientUserId,
          occurredAt: now,
        });
        await ensureReceipt(tx, order.orderId);
        await enqueueAutoReceipt(tx, order.orderId, clientUserId);
      }

      // Cart rows are unique per session (one persistent cart across however many orders a table places in
      // a visit), so "converted" means "cleared and ready for the next round". The comment goes with it:
      // it was copied into the order and must not leak into the next cart.
      await tx.cartItem.deleteMany({ where: { cartId: cart.cartId } });
      await tx.cart.update({
        where: { cartId: cart.cartId },
        data: { status: "ACTIVE", comment: null, pendingPriceChanges: Prisma.DbNull },
      });

      if (key) await completeIdempotentRequest(tx, { key, scope: IDEMPOTENCY_SCOPE_CHECKOUT, ownerId }, order.orderId.toString());

      return { kind: "created" as const, orderId: order.orderId, earned, requiresAge: ev.requiresAgeVerification };
    },
    { maxWait: 5_000, timeout: 30_000 },
  );

  if (outcome.kind === "replay") {
    const order = await getOrderWithDetails(outcome.orderId);
    const earnRow = await prisma.loyaltyLedger.findUnique({
      where: { orderId_type: { orderId: outcome.orderId, type: "EARN" } },
    });
    return { order, replay: true, earnedBonus: earnRow?.amount ?? 0 };
  }

  if (outcome.requiresAge) {
    await linkAgeVerificationToOrder(input.sessionId, outcome.orderId);
  }
  return { order: await getOrderWithDetails(outcome.orderId), replay: false, earnedBonus: outcome.earned };
}

export async function getOrderWithDetails(orderId: bigint) {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: {
      table: true,
      // Never `waiter: true` - that would serialise the staff row including its password hash.
      waiter: { select: { userId: true, name: true } },
      items: { include: { dish: true, options: { include: { option: true } } } },
      payments: true,
      receipt: { select: { receiptNumber: true } },
    },
  });
  if (!order) {
    throw new NotFoundError("Order");
  }
  const { clientUserId, ...rest } = order;
  return { ...rest, ownedByClient: clientUserId !== null };
}

