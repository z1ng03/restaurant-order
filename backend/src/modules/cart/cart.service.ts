import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import { ZERO, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";
import { previewLoyalty } from "../loyalty/loyalty.service";
import { checkNeeds, throwIfShort } from "../menu/inventory.service";
import { pickOptions } from "../menu/menu.service";
import {
  calculateOrderItemNeeds,
  compositionSurcharge,
  lineTotal,
  loadDishConfigSource,
  resolveRecipeSelection,
  unitPriceWithOptions,
  type RequestedIngredient,
} from "../menu/recipeCalculation.service";
import { assertSessionActive } from "../sessions/sessions.service";

export interface AddToCartOptionInput {
  optionId: bigint;
  quantity: number;
}

export interface AddToCartInput {
  dishId: bigint;
  quantity: number;
  options?: AddToCartOptionInput[] | undefined;
  /** chosen composition per serving; omitted lines keep the recipe default */
  ingredients?: RequestedIngredient[] | undefined;
  /** legacy per-line note - the order-level comment (PATCH …/comment) is the supported way */
  notes?: string | undefined;
}

export const MAX_COMMENT_LENGTH = 500;

/** Gets the session's cart, creating an empty ACTIVE one on first use (race-safe upsert). */
async function getOrCreateCart(db: Tx, sessionId: bigint) {
  return db.cart.upsert({
    where: { sessionId },
    create: { sessionId, status: "ACTIVE" },
    update: {},
  });
}

export const cartInclude = {
  items: {
    include: {
      dish: true,
      options: { include: { option: true }, orderBy: { cartItemOptionId: "asc" as const } },
      ingredients: { include: { ingredient: true }, orderBy: { cartItemIngredientId: "asc" as const } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.CartInclude;

type FullCart = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

export interface PriceChange {
  dishId: string;
  dishName: string;
  previousUnitPrice: string;
  currentUnitPrice: string;
}

function readPriceChanges(json: Prisma.JsonValue | null): PriceChange[] {
  if (!Array.isArray(json)) return [];
  return (json as unknown[]).filter((x): x is PriceChange => typeof x === "object" && x !== null && "dishId" in (x as object));
}

function serializeCart(cart: FullCart, loyaltyPreview: Awaited<ReturnType<typeof previewLoyalty>> | null) {
  const items = cart.items.map((item) => {
    const optionPrices = item.options.map((o) => ({ price: o.priceAtAdd, quantity: o.quantity }));
    const unitPrice = unitPriceWithOptions(item.priceAtAdd, optionPrices);
    const total = lineTotal(item.priceAtAdd, item.quantity, optionPrices);
    return {
      cartItemId: item.cartItemId,
      dishId: item.dishId,
      dishName: item.dish.name,
      dishImageUrl: item.dish.imageUrl,
      is21Plus: item.dish.is21Plus,
      quantity: item.quantity,
      priceAtAdd: item.priceAtAdd,
      notes: item.notes,
      options: item.options.map((o) => ({
        cartItemOptionId: o.cartItemOptionId,
        optionId: o.optionId,
        name: o.option.name,
        /** units of the option per serving */
        quantity: o.quantity,
        priceAtAdd: o.priceAtAdd,
      })),
      /** Composition for ONE serving and for the WHOLE line (selected × servings), server-calculated. */
      ingredients: item.ingredients.map((i) => ({
        ingredientId: i.ingredientId,
        name: i.ingredient.name,
        unit: i.unitSnapshot,
        baseQuantity: i.baseQuantity.toFixed(3),
        selectedQuantity: i.selectedQuantity.toFixed(3),
        totalQuantity: i.selectedQuantity.times(item.quantity).toFixed(3),
        changed: !i.selectedQuantity.equals(i.baseQuantity),
        removed: i.selectedQuantity.isZero(),
      })),
      /** price of ONE serving including its options */
      unitPrice,
      lineTotal: total,
    };
  });

  const subtotal = items.reduce((sum, item) => sum.plus(item.lineTotal), ZERO);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const priceChanges = readPriceChanges(cart.pendingPriceChanges);

  return {
    cartId: cart.cartId,
    sessionId: cart.sessionId,
    status: cart.status,
    items,
    total: subtotal,
    subtotal,
    itemCount,
    comment: cart.comment,
    priceChanges,
    requiresPriceConfirmation: priceChanges.length > 0,
    loyaltyPreview,
  };
}

export interface CartViewContext {
  clientUserId?: bigint | null;
  useCashback?: boolean;
}

export async function getCart(sessionId: bigint, ctx: CartViewContext = {}) {
  const cart = await getOrCreateCart(prisma, sessionId);
  const full = await prisma.cart.findUniqueOrThrow({ where: { cartId: cart.cartId }, include: cartInclude });
  const subtotal = full.items.reduce((sum, i) => {
    const opts = i.options.map((o) => ({ price: o.priceAtAdd, quantity: o.quantity }));
    return sum.plus(lineTotal(i.priceAtAdd, i.quantity, opts));
  }, ZERO);
  const preview = await previewLoyalty(prisma, ctx.clientUserId ?? null, subtotal, ctx.useCashback ?? false);
  return serializeCart(full, preview);
}

/** Normalises a user comment: LF newlines, trimmed, null when blank, hard length cap. */
export function normalizeComment(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") return null;
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new ValidationError(`Комментарий не должен превышать ${MAX_COMMENT_LENGTH} символов`);
  }
  return text;
}

export async function addItemToCart(sessionId: bigint, input: AddToCartInput, ctx: CartViewContext = {}) {
  await assertSessionActive(sessionId);

  if (input.quantity <= 0) {
    throw new ValidationError("quantity must be greater than 0");
  }

  const src = await loadDishConfigSource(prisma, input.dishId);
  if (!src || !src.dish.isActive || !src.dish.categoryActive) {
    throw new NotFoundError("Dish");
  }

  // Composition and options are validated against the dish itself: unknown / duplicate / negative /
  // wrong-step / non-customizable lines are refused with stable codes (see resolveRecipeSelection).
  const resolved = resolveRecipeSelection(src.recipeLines, input.ingredients);
  const options = pickOptions(
    src,
    (input.options ?? []).map((o) => {
      if (o.quantity <= 0) throw new ValidationError("option quantity must be greater than 0");
      return o;
    }),
  );

  if (src.dish.inventoryTracked) {
    if (src.recipeLines.length === 0) {
      throw new AppError(409, "DISH_UNAVAILABLE", "Состав блюда не задан - блюдо временно недоступно", {
        reason: "NO_RECIPE",
      });
    }
    // Availability of THIS configuration (a double portion of cheese may be missing even if the
    // standard dish is fine, and vice versa).
    const needs = calculateOrderItemNeeds({
      quantity: input.quantity,
      ingredients: resolved.map((r) => ({ ingredientId: r.line.ingredientId, selectedPerServing: r.selected })),
      options: options.map((o) => ({
        optionId: o.def.optionId,
        quantity: o.quantity,
        ingredients: o.def.ingredients.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity })),
      })),
    });
    throwIfShort(await checkNeeds(prisma, needs));
  }

  await prisma.$transaction(async (tx) => {
    const cart = await getOrCreateCart(tx, sessionId);
    // ТЗ §4: "Добавил: price_at_add. Почему: если ресторан поменяет цену бургера после того как
    // клиент положил его в корзину, система должна понимать по какой цене он был добавлен."
    // Snapshot dish price (and each option's price) at the moment of adding, not at read time.
    await tx.cartItem.create({
      data: {
        cartId: cart.cartId,
        dishId: src.dish.dishId,
        quantity: input.quantity,
        priceAtAdd: src.dish.price.plus(compositionSurcharge(src.dish.price, resolved)),
        notes: input.notes ?? null,
        options: {
          create: options.map((o) => ({ optionId: o.def.optionId, quantity: o.quantity, priceAtAdd: o.def.price })),
        },
        ingredients: {
          create: resolved.map((r) => ({
            ingredientId: r.line.ingredientId,
            baseQuantity: r.line.base,
            selectedQuantity: r.selected,
            unitSnapshot: r.line.unit,
          })),
        },
      },
    });
    await tx.cart.update({ where: { cartId: cart.cartId }, data: { updatedAt: new Date() } });
  });

  return getCart(sessionId, ctx);
}

/** The ingredient needs of one existing cart line at a given quantity (uses its own snapshot). */
async function needsForCartItem(
  db: Tx,
  item: FullCart["items"][number],
  quantity: number,
): Promise<Map<string, Decimal>> {
  let ingredients = item.ingredients.map((i) => ({ ingredientId: i.ingredientId, selectedPerServing: i.selectedQuantity }));
  if (ingredients.length === 0) {
    // Line created before snapshots existed: fall back to the current recipe.
    const recipes = await db.recipe.findMany({ where: { dishId: item.dishId } });
    ingredients = recipes.map((r) => ({ ingredientId: r.ingredientId, selectedPerServing: r.quantity }));
  }
  const optionRows = await db.dishOptionIngredient.findMany({
    where: { optionId: { in: item.options.map((o) => o.optionId) } },
  });
  return calculateOrderItemNeeds({
    quantity,
    ingredients,
    options: item.options.map((o) => ({
      optionId: o.optionId,
      quantity: o.quantity,
      ingredients: optionRows.filter((r) => r.optionId === o.optionId).map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })),
    })),
  });
}

export async function updateCartItemQuantity(cartItemId: bigint, quantity: number, ctx: CartViewContext = {}) {
  const item = await prisma.cartItem.findUnique({ where: { cartItemId }, include: { cart: true } });
  if (!item) {
    throw new NotFoundError("Cart item");
  }
  await assertSessionActive(item.cart.sessionId);

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { cartItemId } }); // options + ingredient snapshot cascade
  } else {
    const full = await prisma.cartItem.findUniqueOrThrow({
      where: { cartItemId },
      include: {
        dish: true,
        options: { include: { option: true } },
        ingredients: { include: { ingredient: true } },
      },
    });
    if (quantity > full.quantity && full.dish.inventoryTracked) {
      // Re-validate the whole composition (options scale with servings too) before accepting more.
      throwIfShort(await checkNeeds(prisma, await needsForCartItem(prisma, full as FullCart["items"][number], quantity)));
    }
    await prisma.cartItem.update({ where: { cartItemId }, data: { quantity } });
  }
  await prisma.cart.update({ where: { cartId: item.cartId }, data: { updatedAt: new Date() } });
  return getCart(item.cart.sessionId, ctx);
}

export async function removeCartItem(cartItemId: bigint, ctx: CartViewContext = {}) {
  const item = await prisma.cartItem.findUnique({ where: { cartItemId }, include: { cart: true } });
  if (!item) {
    throw new NotFoundError("Cart item");
  }
  await assertSessionActive(item.cart.sessionId);
  await prisma.cartItem.delete({ where: { cartItemId } });
  return getCart(item.cart.sessionId, ctx);
}

/** Resolves a cart item to its session so the route can verify the kiosk secret BEFORE touching it. */
export async function getCartItemSessionId(cartItemId: bigint): Promise<bigint> {
  const item = await prisma.cartItem.findUnique({ where: { cartItemId }, select: { cart: { select: { sessionId: true } } } });
  if (!item) throw new NotFoundError("Cart item");
  return item.cart.sessionId;
}

/** ТЗ §4: "В КОРЗИНЕ ЕСТЬ КНОПКИ ... ОЧИСТКА КОРЗИНЫ". Also drops the comment and any price warning. */
export async function clearCart(sessionId: bigint, ctx: CartViewContext = {}) {
  await assertSessionActive(sessionId);
  const cart = await getOrCreateCart(prisma, sessionId);
  await prisma.$transaction(async (tx) => {
    await tx.cartItem.deleteMany({ where: { cartId: cart.cartId } });
    await tx.cart.update({
      where: { cartId: cart.cartId },
      data: { comment: null, pendingPriceChanges: Prisma.DbNull },
    });
  });
  return getCart(sessionId, ctx);
}

/** FR-10: ONE comment for the whole order. */
export async function setCartComment(sessionId: bigint, comment: string | null, ctx: CartViewContext = {}) {
  await assertSessionActive(sessionId);
  const normalized = normalizeComment(comment);
  const cart = await getOrCreateCart(prisma, sessionId);
  await prisma.cart.update({ where: { cartId: cart.cartId }, data: { comment: normalized } });
  return getCart(sessionId, ctx);
}

/** The guest explicitly accepted the new totals shown after a reorder with changed prices. */
export async function confirmPriceChanges(sessionId: bigint, ctx: CartViewContext = {}) {
  await assertSessionActive(sessionId);
  const cart = await getOrCreateCart(prisma, sessionId);
  await prisma.cart.update({ where: { cartId: cart.cartId }, data: { pendingPriceChanges: Prisma.DbNull } });
  return getCart(sessionId, ctx);
}

