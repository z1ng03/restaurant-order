import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, stock, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient } from "../helpers/http";

const s = (v: bigint) => v.toString();

describe.skipIf(!hasTestDatabase)("checkout - personalisation, reservation, payment", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });

  const carbonara = (over: Record<string, unknown> = {}) => ({
    dishId: s(cat.dish.carbonara!),
    quantity: 1,
    ...over,
  });
  const parmesan = (qty: string | number, unit?: string) => ({ ingredientId: s(cat.ing.parmesan!), quantity: qty, ...(unit ? { unit } : {}) });

  it("reserves exactly servings × selected + servings × optionQty × optionIngredient (TZ example)", async () => {
    const k = await openKiosk(1);
    const added = await addToCart(k, carbonara({
      quantity: 2,
      ingredients: [parmesan("0.060")],
      options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }],
    }));
    expect(added.status).toBe(201);
    const line = added.body.cart.items[0];
    // (3200 + 500 per serving) × 2
    expect(added.body.cart.subtotal).toBe("8200");
    expect(line.unitPrice).toBe("4100");
    const p = line.ingredients.find((i: { name: string }) => i.name === "parmesan");
    expect(p).toMatchObject({ baseQuantity: "0.040", selectedQuantity: "0.060", totalQuantity: "0.120", changed: true });

    const res = await checkout(k, { paymentMethod: "KASPI_QR" }, { "Idempotency-Key": "11111111-aaaa-4bbb-8ccc-000000000001" });
    expect(res.status).toBe(201);
    expect(res.body.order.paymentStatus).toBe("PAID");
    expect(res.body.order.subtotal).toBe("8200");

    // parmesan 2 × 0.06; pasta 2 × 0.15; bacon 2 × 0.08 + 2 × 1 × 0.05; eggs 2
    expect(await stock(cat.ing.parmesan!)).toEqual({ stock: "1.000", reserved: "0.120" });
    expect(await stock(cat.ing.pasta!)).toEqual({ stock: "10.000", reserved: "0.300" });
    expect(await stock(cat.ing.bacon!)).toEqual({ stock: "2.000", reserved: "0.260" });
    expect(await stock(cat.ing.egg!)).toEqual({ stock: "100.000", reserved: "2.000" });

    // one aggregated reservation row per (item, ingredient) - bacon from recipe AND option is ONE row
    const rows = await prisma.inventoryReservation.findMany({ where: { ingredientId: cat.ing.bacon! } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity.toFixed(3)).toBe("0.260");

    // the composition snapshot keeps recipe and option contributions apart
    const snap = await prisma.orderItemIngredient.findMany({ where: { ingredientId: cat.ing.bacon! }, orderBy: { source: "asc" } });
    expect(snap.map((r) => [r.source, r.selectedPerServing.toFixed(3), r.requiredTotal.toFixed(3)])).toEqual([
      ["OPTION", "0.050", "0.100"],
      ["RECIPE", "0.080", "0.160"],
    ]);
    // the cart is gone after checkout and a cart-item delete with options no longer violates a foreign key
    expect((await api().get(`/api/cart/${k.sessionId}`).set(k.h)).body.cart.items).toEqual([]);
  });

  it("refuses an invalid composition with a stable code each", async () => {
    const k = await openKiosk(1);
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ingredients: [{ ingredientId: s(cat.ing.lemon!), quantity: 1 }] }, 400, "INGREDIENT_NOT_IN_DISH"],
      [{ ingredients: [parmesan("0.030")] }, 400, "INVALID_INGREDIENT_STEP"],
      [{ ingredients: [parmesan("0.140")] }, 400, "INGREDIENT_OUT_OF_RANGE"],
      [{ ingredients: [parmesan("-0.020")] }, 400, "INGREDIENT_OUT_OF_RANGE"],
      [{ ingredients: [parmesan("0.020"), parmesan("0.040")] }, 400, "VALIDATION_ERROR"],
      [{ ingredients: [{ ingredientId: s(cat.ing.egg!), quantity: 2 }] }, 400, "INGREDIENT_NOT_CUSTOMIZABLE"],
      [{ ingredients: [parmesan(40, "ml")] }, 400, "UNIT_MISMATCH"],
      [{ options: [{ optionId: "999999", quantity: 1 }] }, 400, "OPTION_NOT_AVAILABLE"],
    ];
    for (const [body, status, code] of cases) {
      const res = await addToCart(k, carbonara(body));
      expect([res.status, res.body.error?.code], JSON.stringify(body)).toEqual([status, code]);
    }
    // grams are converted into the base unit: 60 g of parmesan == 0.060 kg and is valid
    const ok = await addToCart(k, carbonara({ ingredients: [parmesan(60, "g")] }));
    expect(ok.status).toBe(201);
    expect(ok.body.cart.items[0].ingredients.find((i: { name: string }) => i.name === "parmesan").selectedQuantity).toBe("0.060");
    // removing an ingredient is a valid selection of 0
    const removed = await addToCart(k, carbonara({ ingredients: [parmesan(0)] }));
    expect(removed.status).toBe(201);
  });

  it("an ingredient shortage across the whole cart blocks checkout without any partial reservation", async () => {
    await prisma.inventory.update({ where: { ingredientId: cat.ing.parmesan! }, data: { stockQuantity: "0.100" } });
    const k = await openKiosk(1);
    // each line alone fits (0.06 <= 0.1) ...
    expect((await addToCart(k, carbonara({ ingredients: [parmesan("0.060")] }))).status).toBe(201);
    expect((await addToCart(k, carbonara({ ingredients: [parmesan("0.060")] }))).status).toBe(201);
    // ... but together they need 0.12
    const v = await api().get(`/api/checkout/${k.sessionId}/validate`).set(k.h);
    expect(v.body.ok).toBe(false);
    expect(v.body.configurationAvailable).toBe(false);
    const issue = v.body.issues.find((i: { type: string }) => i.type === "INSUFFICIENT_INGREDIENTS");
    expect(issue).toMatchObject({ ingredientName: "parmesan", needed: "0.12", free: "0.1" });
    expect(issue.cartItemIds).toHaveLength(2);

    const res = await checkout(k, { paymentMethod: "CASH" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHECKOUT_VALIDATION_FAILED");
    expect(await prisma.order.count()).toBe(0);
    expect((await stock(cat.ing.pasta!)).reserved).toBe("0.000"); // nothing leaked from the other ingredients
    // and a single over-large line is refused already when it is added
    const tooMuch = await addToCart(k, carbonara({ quantity: 2, ingredients: [parmesan("0.060")] }));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_INGREDIENTS");
  });

  it("two tables racing for the last stock: exactly one order wins, stock never goes negative", async () => {
    await prisma.inventory.update({ where: { ingredientId: cat.ing.parmesan! }, data: { stockQuantity: "0.200" } });
    const a = await openKiosk(1);
    const b = await openKiosk(2);
    for (const k of [a, b]) {
      expect((await addToCart(k, carbonara({ quantity: 2, ingredients: [parmesan("0.060")] }))).status).toBe(201); // needs 0.12
    }
    const [ra, rb] = await Promise.all([checkout(a, { paymentMethod: "CASH" }), checkout(b, { paymentMethod: "CASH" })]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect(await prisma.order.count()).toBe(1);
    expect(await stock(cat.ing.parmesan!)).toEqual({ stock: "0.200", reserved: "0.120" });
    // the loser kept its cart so the guest can adjust and retry
    const loser = ra.status === 409 ? a : b;
    expect((await api().get(`/api/cart/${loser.sessionId}`).set(loser.h)).body.cart.items).toHaveLength(1);
  });

  it("idempotency: a retried confirm returns the same order; a different body with the same key is refused", async () => {
    const k = await openKiosk(1);
    await addToCart(k, carbonara());
    const key = "22222222-aaaa-4bbb-8ccc-000000000002";
    const first = await checkout(k, { paymentMethod: "CASH" }, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const again = await checkout(k, { paymentMethod: "CASH" }, { "Idempotency-Key": key });
    expect(again.status).toBe(200);
    expect(again.body.idempotentReplay).toBe(true);
    expect(again.body.order.orderId).toBe(first.body.order.orderId);
    expect(await prisma.order.count()).toBe(1);
    const other = await checkout(k, { paymentMethod: "KASPI_QR" }, { "Idempotency-Key": key });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("concurrent confirms with the same key (double click) create ONE order", async () => {
    const k = await openKiosk(1);
    await addToCart(k, carbonara());
    const key = "33333333-aaaa-4bbb-8ccc-000000000003";
    const rs = await Promise.all([1, 2, 3].map(() => checkout(k, { paymentMethod: "KASPI_QR" }, { "Idempotency-Key": key })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.order.orderId)).size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.receipt.count()).toBe(1);
    expect(await stock(cat.ing.pasta!)).toEqual({ stock: "10.000", reserved: "0.150" });
  });

  it("without a key a double click still cannot create two orders (the cart is locked, then empty)", async () => {
    const k = await openKiosk(1);
    await addToCart(k, carbonara());
    const rs = await Promise.all([checkout(k, { paymentMethod: "CASH" }), checkout(k, { paymentMethod: "CASH" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.order.count()).toBe(1);
  });

  it("CASH: waiting for cash, no receipt, no bonuses; cash-received creates the receipt and the bonuses exactly once", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("c@example.com", "password-123", guest);
    await addToCart(guest, carbonara({ quantity: 3 })); // 9600
    const res = await checkout(guest, { paymentMethod: "CASH" }, auth(client.token));
    expect(res.status).toBe(201);
    const orderId = res.body.order.orderId;
    expect(res.body.order.paymentStatus).toBe("WAITING_FOR_CASH");
    expect(res.body.earnedBonus).toBe(0);
    expect(await prisma.receipt.count()).toBe(0);
    expect(await prisma.loyaltyLedger.count()).toBe(0);
    const preliminary = await api().get(`/api/orders/${orderId}/receipt`).set(guest.h);
    expect(preliminary.status).toBe(200);
    expect(preliminary.body.receipt).toMatchObject({ isPaymentPreview: true, kind: "PREVIEW", paymentStatus: "WAITING_FOR_CASH", paidTotal: "9600.00" });
    expect(await prisma.receipt.count()).toBe(0);

    // chef + waiter move the order forward
    const items = await prisma.orderItem.findMany({ where: { orderId: BigInt(orderId) } });
    for (const step of ["PREPARING", "READY", "HANDED_TO_WAITER"]) {
      for (const it of items) {
        const r = await api().patch(`/api/kitchen/order-items/${it.orderItemId}/status`).set(auth(cat.staff.chef.token)).send({ status: step });
        expect(r.status, step).toBe(200);
      }
    }
    expect((await api().patch(`/api/waiter/orders/${orderId}/pickup`).set(auth(cat.staff.waiter.token))).status).toBe(200);

    const first = await api().patch(`/api/waiter/orders/${orderId}/cash-received`).set(auth(cat.staff.waiter.token));
    expect(first.status).toBe(200);
    const second = await api().patch(`/api/waiter/orders/${orderId}/cash-received`).set(auth(cat.staff.waiter.token));
    expect(second.status).toBe(409);

    const receipt = await api().get(`/api/orders/${orderId}/receipt`).set(guest.h);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt).toMatchObject({ receiptNumber: "DEMO-000001", kind: "DEMO", paidTotal: "9600.00", subtotal: "9600.00", bonusDiscount: "0.00", fiscalSign: null });
    expect(receipt.body.receipt.isPaymentPreview).toBeUndefined();
    expect(await prisma.receipt.count()).toBe(1);
    const ledger = await prisma.loyaltyLedger.findMany();
    expect(ledger.map((l) => [l.type, l.amount])).toEqual([["EARN", 480]]); // floor(9600 × 5%)
    expect((await prisma.clientUser.findFirstOrThrow()).bonusBalance).toBe(480);
  });

  it("KASPI_QR (demo): paid at once, receipt + bonuses in the same transaction, provider reference is unique", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("k@example.com", "password-123", guest);
    await addToCart(guest, carbonara());
    const res = await checkout(guest, { paymentMethod: "KASPI_QR" }, auth(client.token));
    expect(res.status).toBe(201);
    expect(res.body.earnedBonus).toBe(160);
    const payment = await prisma.payment.findFirstOrThrow();
    expect(payment).toMatchObject({ status: "PAID", isDemo: true, bonusUsed: 0 });
    expect(payment.providerRef).toMatch(/^DEMO-KASPI-/);
    expect(res.body.order.receipt.receiptNumber).toBe("DEMO-000001");
    expect(await prisma.orderStatusEvent.findMany({ where: { orderId: payment.orderId }, orderBy: { eventId: "asc" } }).then((r) => r.map((e) => e.eventType))).toEqual(["ORDER_CREATED", "PAYMENT_CONFIRMED"]);
  });

  it("an order is refused while a 21+ dish is in the cart and nobody has confirmed the age", async () => {
    const k = await openKiosk(1);
    await addToCart(k, { dishId: s(cat.dish.beer!), quantity: 1 });
    const res = await checkout(k, { paymentMethod: "CASH" });
    expect(res.status).toBe(409);
    expect(res.body.error.details.issues.map((i: { type: string }) => i.type)).toContain("AGE_VERIFICATION_REQUIRED");
    // staff confirms at the table
    const ok = await api().post("/api/age-verification").set(k.h).send({ sessionId: k.sessionId, waiterLogin: "waiter", waiterPassword: cat.staff.waiter.password, verified: true });
    expect(ok.status).toBe(201);
    expect((await checkout(k, { paymentMethod: "CASH" })).status).toBe(201);
  });

  it("the single order comment is saved, trimmed, validated, copied into the order and cleared with the cart", async () => {
    const k = await openKiosk(1);
    await addToCart(k, carbonara());
    const put = await api().patch(`/api/cart/${k.sessionId}/comment`).set(k.h).send({ comment: "  без соли\r\nсоус отдельно <script>alert(1)</script>  " });
    expect(put.status).toBe(200);
    expect(put.body.cart.comment).toBe("без соли\nсоус отдельно <script>alert(1)</script>"); // trimmed, LF; escaping is the UI's job
    expect((await api().patch(`/api/cart/${k.sessionId}/comment`).set(k.h).send({ comment: "x".repeat(501) })).status).toBe(400);
    const res = await checkout(k, { paymentMethod: "CASH" });
    expect(res.body.order.comment).toContain("без соли");
    expect((await api().get(`/api/cart/${k.sessionId}`).set(k.h)).body.cart.comment).toBeNull();
    await addToCart(k, carbonara());
    expect((await api().patch(`/api/cart/${k.sessionId}/comment`).set(k.h).send({ comment: "   " })).body.cart.comment).toBeNull();
  });

  it("quantity edits re-validate the whole composition (options scale with servings)", async () => {
    const k = await openKiosk(1);
    await prisma.inventory.update({ where: { ingredientId: cat.ing.bacon! }, data: { stockQuantity: "0.300" } });
    const added = await addToCart(k, carbonara({ options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }] }));
    expect(added.status).toBe(201); // 0.08 + 0.05 = 0.13
    const itemId = added.body.cart.items[0].cartItemId;
    const ok = await api().patch(`/api/cart/items/${itemId}`).set(k.h).send({ quantity: 2 }); // 0.26 <= 0.3
    expect(ok.status).toBe(200);
    const bad = await api().patch(`/api/cart/items/${itemId}`).set(k.h).send({ quantity: 3 }); // 0.39 > 0.3
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("INSUFFICIENT_INGREDIENTS");
    expect((await api().patch(`/api/cart/items/${itemId}`).set(k.h).send({ quantity: 0 })).body.cart.items).toEqual([]); // remove (cascade works)
  });
});
