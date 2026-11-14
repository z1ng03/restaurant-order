import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { auditInventory } from "../../src/modules/admin/admin.audit.service";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, stock, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient, type Kiosk } from "../helpers/http";

const s = (v: bigint) => v.toString();

describe.skipIf(!hasTestDatabase)("kitchen, waiter, cancellation and session lifecycle", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });

  const chef = () => auth(cat.staff.chef.token);
  const waiter = () => auth(cat.staff.waiter.token);
  const admin = () => auth(cat.staff.admin.token);

  async function placeOrder(k: Kiosk, payment: "CASH" | "KASPI_QR" = "CASH", lines: Record<string, unknown>[] = [{ dishId: s(cat.dish.carbonara!), quantity: 2 }], headers: Record<string, string> = {}) {
    for (const l of lines) expect((await addToCart(k, l)).status).toBe(201);
    const res = await checkout(k, { paymentMethod: payment }, headers);
    expect(res.status).toBe(201);
    const orderId = BigInt(res.body.order.orderId);
    const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { orderItemId: "asc" } });
    return { orderId, items };
  }
  const setItem = (id: bigint, status: string) => api().patch(`/api/kitchen/order-items/${id}/status`).set(chef()).send({ status });

  it("start cooking consumes the reservations exactly once even when the request is repeated at the same time", async () => {
    const k = await openKiosk(1);
    const { items } = await placeOrder(k);
    const rs = await Promise.all([1, 2, 3, 4].map(() => setItem(items[0]!.orderItemId, "PREPARING")));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]); // repeats are a harmless no-op
    // carbonara × 2: parmesan 0.08, pasta 0.3, bacon 0.16, eggs 2 - consumed ONCE
    expect(await stock(cat.ing.parmesan!)).toEqual({ stock: "0.920", reserved: "0.000" });
    expect(await stock(cat.ing.pasta!)).toEqual({ stock: "9.700", reserved: "0.000" });
    expect(await stock(cat.ing.egg!)).toEqual({ stock: "98.000", reserved: "0.000" });
    expect(await prisma.inventoryReservation.count({ where: { status: "CONSUMED" } })).toBe(4);
    expect(await prisma.orderStatusEvent.count({ where: { eventType: "COOKING_STARTED" } })).toBe(1);
    expect((await auditInventory()).ok).toBe(true);
  });

  it("COOKING_STARTED is written once per order; READY_FOR_DELIVERY only when every item is handed over", async () => {
    const k = await openKiosk(1);
    const { orderId, items } = await placeOrder(k, "CASH", [{ dishId: s(cat.dish.carbonara!), quantity: 1 }, { dishId: s(cat.dish.lemonade!), quantity: 1 }]);
    expect((await setItem(items[0]!.orderItemId, "PREPARING")).status).toBe(200);
    expect((await setItem(items[1]!.orderItemId, "PREPARING")).status).toBe(200);
    expect(await prisma.orderStatusEvent.count({ where: { orderId, eventType: "COOKING_STARTED" } })).toBe(1);

    expect((await setItem(items[0]!.orderItemId, "READY")).status).toBe(200);
    expect((await setItem(items[0]!.orderItemId, "HANDED_TO_WAITER")).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe("SENT_TO_KITCHEN");
    expect((await setItem(items[1]!.orderItemId, "READY")).status).toBe(200);
    expect((await setItem(items[1]!.orderItemId, "HANDED_TO_WAITER")).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe("READY_FOR_DELIVERY");
    expect(await prisma.orderStatusEvent.count({ where: { orderId, eventType: "READY_FOR_DELIVERY" } })).toBe(1);
    // an illegal jump is a 409, not a silent change
    const k2 = await openKiosk(2);
    const second = await placeOrder(k2);
    expect((await setItem(second.items[0]!.orderItemId, "READY")).status).toBe(409);
  });

  it("the kitchen sees the REAL ordered composition, with change markers and display units", async () => {
    const k = await openKiosk(1);
    await addToCart(k, {
      dishId: s(cat.dish.carbonara!), quantity: 2,
      ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.060" }, { ingredientId: s(cat.ing.bacon!), quantity: 0 }],
      options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }],
    });
    await api().patch(`/api/cart/${k.sessionId}/comment`).set(k.h).send({ comment: "без соли" });
    const res = await checkout(k, { paymentMethod: "CASH" });
    expect(res.status).toBe(201);
    const list = await api().get("/api/kitchen/orders").set(chef());
    expect(list.status).toBe(200);
    const order = list.body.orders[0];
    expect(order.comment).toBe("без соли");
    const lines: Record<string, { change: string; display: { perServing: string; base: string; total: string } }> = {};
    for (const l of order.items[0].ingredientsActual) lines[`${l.name}/${l.source}`] = l;
    expect(lines["parmesan/RECIPE"]).toMatchObject({ change: "CHANGED", display: { perServing: "60 г", base: "40 г", total: "120 г" } });
    expect(lines["bacon/RECIPE"]).toMatchObject({ change: "REMOVED" });
    expect(lines["bacon/OPTION"]).toMatchObject({ change: "ADDED", display: { perServing: "50 г", total: "100 г" } });
    expect(lines["pasta/RECIPE"]).toMatchObject({ change: "UNCHANGED" });
    expect(order.items[0].snapshotAvailable).toBe(true);
    expect(order.statusEvents.map((e: { eventType: string }) => e.eventType)).toEqual(["ORDER_CREATED"]);
  });

  it("a cancelled order can never be moved forward from the kitchen (it used to be resurrected)", async () => {
    const k = await openKiosk(1);
    const { orderId, items } = await placeOrder(k);
    expect((await api().post(`/api/admin/orders/${orderId}/cancel`).set(admin()).send({ reason: "гость ушёл" })).status).toBe(200);
    expect((await setItem(items[0]!.orderItemId, "PREPARING")).status).toBe(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe("CANCELLED");
  });

  it("admin cancel releases the reservations once; a second cancel is a 409; bonuses for an unpaid order come back", async () => {
    const k = await openKiosk(1);
    const { orderId } = await placeOrder(k);
    expect((await stock(cat.ing.pasta!)).reserved).toBe("0.300");
    const cancelled = await api().post(`/api/admin/orders/${orderId}/cancel`).set(admin()).send({ reason: "тест" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order.cancelReason).toBe("тест");
    expect(await stock(cat.ing.pasta!)).toEqual({ stock: "10.000", reserved: "0.000" });
    expect((await api().post(`/api/admin/orders/${orderId}/cancel`).set(admin()).send({})).status).toBe(409);
    expect(await prisma.orderStatusEvent.count({ where: { orderId, eventType: "CANCELLED" } })).toBe(1);
    expect((await prisma.restaurantSession.findFirstOrThrow()).status).toBe("COMPLETED"); // the table is freed
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { tableId: cat.tables[0]!.tableId } })).status).toBe("FREE");
  });

  it("cancel racing 'start cooking' has exactly one winner and the stock books always balance", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDatabase();
      cat = await seedCatalog();
      const k = await openKiosk(1);
      const { orderId, items } = await placeOrder(k);
      const [cook, cancel] = await Promise.all([
        setItem(items[0]!.orderItemId, "PREPARING"),
        api().post(`/api/admin/orders/${orderId}/cancel`).set(admin()).send({}),
      ]);
      expect(cancel.status).toBe(200);
      expect([200, 409]).toContain(cook.status);
      expect((await prisma.order.findUniqueOrThrow({ where: { orderId } })).orderStatus).toBe("CANCELLED");
      const audit = await auditInventory();
      expect(audit, `round ${round}`).toMatchObject({ ok: true });
      expect((await stock(cat.ing.pasta!)).reserved).toBe("0.000");
      // food already cooked stays consumed; otherwise the stock is untouched
      expect((await stock(cat.ing.pasta!)).stock).toBe(cook.status === 200 ? "9.700" : "10.000");
    }
  });

  it("the whole journey: delivery needs payment, closes the session and ends the guest's client login", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("flow@example.com", "password-123", guest);
    const { orderId, items } = await placeOrder(guest, "CASH", undefined, auth(client.token));
    for (const step of ["PREPARING", "READY", "HANDED_TO_WAITER"]) for (const it of items) expect((await setItem(it.orderItemId, step)).status).toBe(200);

    expect((await api().patch(`/api/waiter/orders/${orderId}/pickup`).set(waiter())).status).toBe(200);
    const unpaid = await api().patch(`/api/waiter/orders/${orderId}/delivered`).set(waiter());
    expect(unpaid.status).toBe(409); // cash not collected yet
    expect((await api().patch(`/api/waiter/orders/${orderId}/cash-received`).set(waiter())).status).toBe(200);

    const waiterList = await api().get("/api/waiter/orders").set(waiter());
    expect(JSON.stringify(waiterList.body)).not.toContain("passwordHash"); // the staff row used to leak its hash
    expect(waiterList.body.orders[0].ownedByClient).toBe(true);

    expect((await api().patch(`/api/waiter/orders/${orderId}/delivered`).set(waiter())).status).toBe(200);
    expect(await prisma.orderStatusEvent.findMany({ where: { orderId }, orderBy: { eventId: "asc" } }).then((r) => r.map((e) => e.eventType))).toEqual([
      "ORDER_CREATED", "COOKING_STARTED", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "PAYMENT_CONFIRMED", "DELIVERED",
    ]);

    // the table is free again, the client login bound to it is dead, the terminal's secret is read-only
    const session = await prisma.restaurantSession.findFirstOrThrow();
    expect(session.status).toBe("COMPLETED");
    expect((await api().get("/api/client-account/me").set(auth(client.token))).body.error.code).toBe("CLIENT_SESSION_ENDED");
    const tracker = await api().get(`/api/order-tracking/session/${guest.sessionId}`).set(guest.h);
    expect(tracker.status).toBe(200);
    // Receipt remains available to this kiosk for the post-delivery read grace.
    expect((await api().get(`/api/orders/${orderId}/receipt`).set(guest.h)).status).toBe(200);
    const tablePicker = await api().get("/api/tables");
    expect(tablePicker.body.tables.find((t: { tableNumber: number }) => t.tableNumber === 1).status).toBe("FREE");
    expect(tracker.body.orders[0].statusLabel).toBe("Подан");
    expect((await addToCart(guest, { dishId: s(cat.dish.carbonara!), quantity: 1 })).body.error.code).toBe("SESSION_ENDED");
    // after the grace period even reads stop
    await prisma.restaurantSession.update({ where: { sessionId: session.sessionId }, data: { completedAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await api().get(`/api/order-tracking/session/${guest.sessionId}`).set(guest.h)).body.error.code).toBe("SESSION_ENDED");
    // a new guest at the same monitor gets a NEW session and a new secret
    const next = await openKiosk(1);
    expect(next.sessionId).not.toBe(guest.sessionId);
    expect(next.token).not.toBe(guest.token);
  });

  it("cancelling a PAID order with a refund decision returns spent bonuses, takes back earned ones and flags the REAL refund", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("refund@example.com", "password-123", guest);
    // earn something first: a paid order of 3200 -> 160 bonuses
    const first = await placeOrder(guest, "KASPI_QR", [{ dishId: s(cat.dish.carbonara!), quantity: 1 }], auth(client.token));
    expect((await prisma.clientUser.findFirstOrThrow()).bonusBalance).toBe(160);
    // spend them: second order of 3200 with cashback -> 160 spent, 3040 paid, earn floor(3040 × 5%) = 152
    await addToCart(guest, { dishId: s(cat.dish.carbonara!), quantity: 1 });
    const second = await checkout(guest, { paymentMethod: "KASPI_QR", useCashback: true }, auth(client.token));
    expect(second.status).toBe(201);
    expect(second.body.order.discountBonus).toBe(160);
    expect(second.body.order.payableTotal).toBe("3040");
    expect((await prisma.clientUser.findFirstOrThrow()).bonusBalance).toBe(152);
    const secondId = BigInt(second.body.order.orderId);

    const cancelled = await api().post(`/api/admin/orders/${secondId}/cancel`).set(admin()).send({ refundDecision: "REFUND", reason: "возврат" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancellation).toMatchObject({ bonusesReturned: 160, bonusesReversed: 152, paymentRefundRequired: true });
    expect((await prisma.clientUser.findFirstOrThrow()).bonusBalance).toBe(160);
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: secondId } })).refundStatus).toBe("REFUND_REQUIRED");
    // the ledger is append-only: nothing was edited, compensating rows were added
    const types = (await prisma.loyaltyLedger.findMany({ where: { orderId: secondId }, orderBy: { ledgerId: "asc" } })).map((l) => `${l.type}:${l.amount}`);
    expect(types).toEqual(["SPEND:-160", "EARN:152", "REFUND_SPEND:160", "REVERSE_EARN:-152"]);
    void first;
  });
});
