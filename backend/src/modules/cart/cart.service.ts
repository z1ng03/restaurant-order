import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { assertSessionActive } from "../sessions/sessions.service";

export interface AddToCartOptionInput {
  optionId: bigint;
  quantity: number;
}

export interface AddToCartInput {
  dishId: bigint;
  quantity: number;
  options?: AddToCartOptionInput[];
  notes?: string;
}

/** Gets the session's cart, creating an empty ACTIVE one on first use. */
async function getOrCreateCart(sessionId: bigint) {
  const existing = await prisma.cart.findUnique({ where: { sessionId } });
  if (existing) return existing;
  return prisma.cart.create({ data: { sessionId, status: "ACTIVE" } });
}

function serializeCart(
  cart: Prisma.CartGetPayload<{
    include: { items: { include: { dish: true; options: { include: { option: true } } } } };
  }>,
) {
  const items = cart.items.map((item) => {
    const optionsTotal = item.options.reduce(
      (sum, o) => sum.plus(o.priceAtAdd.times(o.quantity)),
      new Prisma.Decimal(0),
    );
    const unitPrice = item.priceAtAdd.plus(optionsTotal.dividedBy(item.quantity || 1));
    const lineTotal = item.priceAtAdd.times(item.quantity).plus(optionsTotal);
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
        quantity: o.quantity,
        priceAtAdd: o.priceAtAdd,
      })),
      unitPrice,
      lineTotal,
    };
  });

  const total = items.reduce((sum, item) => sum.plus(item.lineTotal), new Prisma.Decimal(0));
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return { cartId: cart.cartId, sessionId: cart.sessionId, status: cart.status, items, total, itemCount };
}

const cartInclude = {
  items: { include: { dish: true, options: { include: { option: true } } }, orderBy: { createdAt: "asc" as const } },
};

export async function getCart(sessionId: bigint) {
  const cart = await getOrCreateCart(sessionId);
  const full = await prisma.cart.findUniqueOrThrow({ where: { cartId: cart.cartId }, include: cartInclude });
  return serializeCart(full);
}

export async function addItemToCart(sessionId: bigint, input: AddToCartInput) {
  await assertSessionActive(sessionId);

  if (input.quantity <= 0) {
    throw new ValidationError("quantity must be greater than 0");
  }

  const dish = await prisma.dish.findUnique({
    where: { dishId: input.dishId },
    include: { availableOptions: { include: { option: true } } },
  });
  if (!dish || !dish.isActive) {
    throw new NotFoundError("Dish");
  }

  const chosenOptions: { optionId: bigint; quantity: number; price: Prisma.Decimal }[] = [];
  for (const requested of input.options ?? []) {
    if (requested.quantity <= 0) {
      throw new ValidationError("option quantity must be greater than 0");
    }
    const allowed = dish.availableOptions.find((o) => o.optionId === requested.optionId);
    if (!allowed || !allowed.option.isActive) {
      throw new ValidationError(`Option ${requested.optionId} is not available for this dish`);
    }
    chosenOptions.push({ optionId: requested.optionId, quantity: requested.quantity, price: allowed.option.price });
  }

  const cart = await getOrCreateCart(sessionId);

  // ТЗ §4: "Добавил: price_at_add. Почему: если ресторан поменяет цену
  // бургера после того как клиент положил его в корзину, система должна
  // понимать по какой цене он был добавлен." Snapshot dish price (and each
  // option's price) at the moment of adding, not at read time.
  const cartItem = await prisma.cartItem.create({
    data: {
      cartId: cart.cartId,
      dishId: dish.dishId,
      quantity: input.quantity,
      priceAtAdd: dish.price,
      notes: input.notes,
      options: {
        create: chosenOptions.map((o) => ({
          optionId: o.optionId,
          quantity: o.quantity,
          priceAtAdd: o.price,
        })),
      },
    },
  });

  await prisma.cart.update({ where: { cartId: cart.cartId }, data: { updatedAt: new Date() } });
  void cartItem; // created above; the response reuses the same shape as GET /cart

  return getCart(sessionId);
}

export async function updateCartItemQuantity(cartItemId: bigint, quantity: number) {
  const item = await prisma.cartItem.findUnique({ where: { cartItemId }, include: { cart: true } });
  if (!item) {
    throw new NotFoundError("Cart item");
  }
  await assertSessionActive(item.cart.sessionId);

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { cartItemId } });
  } else {
    await prisma.cartItem.update({ where: { cartItemId }, data: { quantity } });
  }
  await prisma.cart.update({ where: { cartId: item.cartId }, data: { updatedAt: new Date() } });
  return getCart(item.cart.sessionId);
}

export async function removeCartItem(cartItemId: bigint) {
  const item = await prisma.cartItem.findUnique({ where: { cartItemId }, include: { cart: true } });
  if (!item) {
    throw new NotFoundError("Cart item");
  }
  await assertSessionActive(item.cart.sessionId);
  await prisma.cartItem.delete({ where: { cartItemId } });
  return getCart(item.cart.sessionId);
}

/** ТЗ §4: "В КОРЗИНЕ ЕСТЬ КНОПКИ ... ОЧИСТКА КОРЗИНЫ". */
export async function clearCart(sessionId: bigint) {
  const cart = await getOrCreateCart(sessionId);
  await prisma.cartItem.deleteMany({ where: { cartId: cart.cartId } });
  return getCart(sessionId);
}
