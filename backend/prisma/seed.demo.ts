/**
 * DEMO seed - development / classroom only. Refuses to run in production.
 *
 *   npm run seed:demo                                         adds demo data once (idempotent)
 *   CONFIRM_DEMO_RESET=yes npm run seed:demo -- --reset       wipes ALL operational data first (orders, sessions, carts,
 *                                                             receipts, loyalty, client accounts), sets every table FREE
 *                                                             and every reserved quantity to 0. Catalog, staff and the
 *                                                             stock levels are kept (stock consumed by earlier orders is
 *                                                             not restored - adjust it in the admin panel).
 *
 * The demo orders are created through the SAME services the HTTP API uses (checkout, kitchen, waiter), so they obey every
 * invariant: reservations, status events, bonuses, receipts. Requires `npm run seed:reference` to have been run.
 *
 * Demo account:  demo.client@example.com / Demo-12345
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db/prisma";
import { env } from "../src/config/env";
import { hashPassword } from "../src/lib/auth";
import { addItemToCart } from "../src/modules/cart/cart.service";
import { confirmCheckout } from "../src/modules/checkout/checkout.service";
import { updateOrderItemStatus } from "../src/modules/kitchen/kitchen.service";
import { rateOrderForSeed } from "./seed.demo.helpers";
import { openSessionForMonitor } from "../src/modules/sessions/sessions.service";
import { markDelivered, pickupOrder } from "../src/modules/waiter/waiter.service";

const DEMO_EMAIL = "demo.client@example.com";
const DEMO_PASSWORD = "Demo-12345";

async function reset() {
  if (process.env.CONFIRM_DEMO_RESET !== "yes") {
    throw new Error("--reset wipes operational data. Re-run with CONFIRM_DEMO_RESET=yes to confirm.");
  }
  await prisma.$executeRawUnsafe(`
    TRUNCATE "receipt_dispatches","receipts","order_ratings","order_status_events","loyalty_ledger","order_item_ingredients",
             "order_item_options","order_items","inventory_reservations","payments","age_verifications","orders",
             "cart_item_ingredients","cart_item_options","cart_items","carts","client_auth_sessions",
             "client_identity_verifications","client_telegram_link_tokens","client_telegram_links","client_users",
             "idempotency_requests","restaurant_sessions"
    RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`UPDATE "inventory" SET "reserved_quantity" = 0`);
  await prisma.$executeRawUnsafe(`UPDATE "tables" SET "status" = 'FREE'`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE receipt_number_seq RESTART WITH 1`);
  console.log("Operational data wiped."); // eslint-disable-line no-console
}

async function main() {
  if (env.isProduction) throw new Error("seed:demo refuses to run in production.");
  if (process.argv.includes("--reset")) await reset();

  const existing = await prisma.clientUser.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log("Demo data is already present (use --reset with CONFIRM_DEMO_RESET=yes to rebuild)."); // eslint-disable-line no-console
    return;
  }

  const [waiter, chef] = await Promise.all([
    prisma.user.findFirst({ where: { role: "WAITER" } }),
    prisma.user.findFirst({ where: { role: "CHEF" } }),
  ]);
  const dish = async (name: string) => (await prisma.dish.findFirstOrThrow({ where: { name } })).dishId;
  const ingredient = async (name: string) => (await prisma.ingredient.findFirstOrThrow({ where: { name } })).ingredientId;
  if (!waiter || !chef) throw new Error("Run `npm run seed:reference` first (no waiter/chef accounts found).");

  const client = await prisma.clientUser.create({
    data: { name: "Демо Гость", email: DEMO_EMAIL, passwordHash: await hashPassword(DEMO_PASSWORD) },
  });

  // 1) A fully delivered, paid and rated order with a personalised composition - receipt, bonuses, history.
  const first = await openSessionForMonitor(1);
  const s1 = first.session.sessionId;
  await addItemToCart(s1, {
    dishId: await dish("Паста Карбонара"), quantity: 2,
    ingredients: [{ ingredientId: await ingredient("Сыр пармезан"), quantity: new Prisma.Decimal("0.06") }],
    options: [{ optionId: (await prisma.dishOption.findFirstOrThrow({ where: { name: "Доп. бекон" } })).optionId, quantity: 1 }],
  });
  const paid = await confirmCheckout({ sessionId: s1, paymentMethod: "KASPI_QR", clientUserId: client.clientUserId, idempotencyKey: "demo-seed-order-1" });
  const items = await prisma.orderItem.findMany({ where: { orderId: paid.order.orderId } });
  for (const status of ["PREPARING", "READY", "HANDED_TO_WAITER"] as const) {
    for (const item of items) await updateOrderItemStatus(item.orderItemId, status, chef.userId);
  }
  await pickupOrder(paid.order.orderId, waiter.userId);
  await markDelivered(paid.order.orderId, waiter.userId);
  await rateOrderForSeed(client.clientUserId, paid.order.orderId, 5);

  // 2) An order still in the kitchen, paid in cash - demonstrates the tracker and the waiter's cash screen.
  const second = await openSessionForMonitor(2);
  const s2 = second.session.sessionId;
  await addItemToCart(s2, { dishId: await dish("Домашний лимонад"), quantity: 2 });
  await addItemToCart(s2, { dishId: await dish("Салат Цезарь"), quantity: 1 });
  const cash = await confirmCheckout({ sessionId: s2, paymentMethod: "CASH", idempotencyKey: "demo-seed-order-2" });
  const cashItems = await prisma.orderItem.findMany({ where: { orderId: cash.order.orderId }, orderBy: { orderItemId: "asc" } });
  const firstItem = cashItems[0];
  if (firstItem) await updateOrderItemStatus(firstItem.orderItemId, "PREPARING", chef.userId);

  console.log("Demo data created:"); // eslint-disable-line no-console
  console.log(`  account  ${DEMO_EMAIL} / ${DEMO_PASSWORD}  (bonuses, history, a receipt and a rating)`); // eslint-disable-line no-console
  console.log("  table 1  free again (its order was delivered)"); // eslint-disable-line no-console
  console.log("  table 2  an order in the kitchen paid in cash: open kitchen.html / waiter.html"); // eslint-disable-line no-console
}

main()
  .catch((err) => {
    console.error(err); // eslint-disable-line no-console
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
