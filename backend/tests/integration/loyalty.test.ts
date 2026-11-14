import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient } from "../helpers/http";

const s = (v: bigint) => v.toString();

/** Gives an account a bonus balance the honest way round: a closed, paid order + an EARN ledger row. */
async function grantBonuses(cat: Catalog, clientUserId: string, amount: number) {
  const t = cat.tables[2]!;
  const session = await prisma.restaurantSession.create({ data: { tableId: t.tableId, status: "COMPLETED", completedAt: new Date() } });
  const order = await prisma.order.create({
    data: {
      sessionId: session.sessionId, tableId: t.tableId, clientUserId: BigInt(clientUserId),
      totalPrice: amount * 20, subtotal: amount * 20, payableTotal: amount * 20,
      orderStatus: "DELIVERED", paymentStatus: "PAID", deliveredAt: new Date(),
    },
  });
  await prisma.loyaltyLedger.create({ data: { clientUserId: BigInt(clientUserId), orderId: order.orderId, type: "EARN", amount, idempotencyKey: `seed:${order.orderId}` } });
  await prisma.clientUser.update({ where: { clientUserId: BigInt(clientUserId) }, data: { bonusBalance: { increment: amount } } });
}

describe.skipIf(!hasTestDatabase)("cashback (FR-06)", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });

  const lemonade = (qty = 1) => ({ dishId: s(cat.dish.lemonade!), quantity: qty }); // 1200 each

  it("the TZ example: 6400 total, 500 bonuses -> 500 off, 5900 to pay, 295 earned", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("a@example.com", "password-123", guest);
    await grantBonuses(cat, client.clientUserId, 500);
    await addToCart(guest, { dishId: s(cat.dish.carbonara!), quantity: 2 }); // 6400

    const v = await api().get(`/api/checkout/${guest.sessionId}/validate?useCashback=true`).set({ ...guest.h, ...auth(client.token) });
    expect(v.body.loyaltyPreview).toMatchObject({ authenticated: true, balance: 500, maxRedeem: 500, discount: 500, earnPreview: 295, subtotal: "6400.00", payableTotal: "5900.00" });
    const cart = await api().get(`/api/cart/${guest.sessionId}`).set({ ...guest.h, ...auth(client.token) });
    expect(cart.body.cart.loyaltyPreview).toMatchObject({ maxRedeem: 500, discount: 0, payableTotal: "6400.00" }); // not requested -> not applied

    const res = await checkout(guest, { paymentMethod: "KASPI_QR", useCashback: true, expectedPayableTotal: "5900.00" }, auth(client.token));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ subtotal: "6400", discountBonus: 500, payableTotal: "5900", paymentStatus: "PAID" });
    expect(res.body.earnedBonus).toBe(295);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: BigInt(res.body.order.orderId) } });
    expect(payment.amount.toFixed(2)).toBe("5900.00"); // MONEY only; the bonuses are not part of it
    expect(payment.bonusUsed).toBe(500);
    expect((await prisma.clientUser.findUniqueOrThrow({ where: { clientUserId: BigInt(client.clientUserId) } })).bonusBalance).toBe(295);
    const receipt = await api().get(`/api/orders/${res.body.order.orderId}/receipt`).set(guest.h);
    expect(receipt.body.receipt).toMatchObject({ subtotal: "6400.00", bonusDiscount: "500.00", paidTotal: "5900.00" });
  });

  it("never more than 50% of the order, never more than the balance, and the server owns the number", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("b@example.com", "password-123", guest);
    await grantBonuses(cat, client.clientUserId, 5000);
    await addToCart(guest, lemonade(1)); // 1200 -> cap 600
    const res = await checkout(guest, { paymentMethod: "CASH", useCashback: true }, auth(client.token));
    expect(res.status).toBe(201);
    expect(res.body.order.discountBonus).toBe(600);
    expect(res.body.order.payableTotal).toBe("600");
    // the body can only say yes/no - an invented amount is simply not part of the contract
    const sneaky = await api().post(`/api/checkout/${guest.sessionId}/confirm`).set({ ...guest.h, ...auth(client.token) }).send({ paymentMethod: "CASH", useCashback: true, cashbackAmount: 99999 });
    expect(sneaky.status).not.toBe(500);
  });

  it("refuses: cashback without a login, with nothing to spend, and when the shown total is stale", async () => {
    const guest = await openKiosk(1);
    await addToCart(guest, lemonade());
    expect((await checkout(guest, { paymentMethod: "CASH", useCashback: true })).body.error.code).toBe("CLIENT_UNAUTHORIZED");
    const client = await registerClient("c@example.com", "password-123", guest);
    expect((await checkout(guest, { paymentMethod: "CASH", useCashback: true }, auth(client.token))).body.error.code).toBe("CASHBACK_INSUFFICIENT");
    await grantBonuses(cat, client.clientUserId, 300);
    // the guest was shown 800.00 (e.g. 400 bonuses at that moment), but only 300 are there now -> 900.00
    const stale = await checkout(guest, { paymentMethod: "CASH", useCashback: true, expectedPayableTotal: "800.00" }, auth(client.token));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "CASHBACK_CONFLICT", details: { payableTotal: "900.00", discount: 300 } });
    expect(await prisma.order.count({ where: { sessionId: BigInt(guest.sessionId) } })).toBe(0); // nothing was created
  });

  it("two parallel orders cannot spend the same bonuses twice", async () => {
    const a = await openKiosk(1);
    const b = await openKiosk(2);
    const client = await registerClient("d@example.com", "password-123", a);
    await grantBonuses(cat, client.clientUserId, 600);
    await addToCart(a, lemonade());
    await addToCart(b, lemonade());
    const [ra, rb] = await Promise.all([
      checkout(a, { paymentMethod: "CASH", useCashback: true }, auth(client.token)),
      checkout(b, { paymentMethod: "CASH", useCashback: true }, auth(client.token)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    const spends = await prisma.loyaltyLedger.findMany({ where: { type: "SPEND" } });
    expect(spends).toHaveLength(1);
    expect(spends[0]!.amount).toBe(-600);
    expect((await prisma.clientUser.findUniqueOrThrow({ where: { clientUserId: BigInt(client.clientUserId) } })).bonusBalance).toBe(0);
  });

  it("a CASH order blocks the bonuses at once, earns only after the cash is received, and a cancel returns them", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("e@example.com", "password-123", guest);
    await grantBonuses(cat, client.clientUserId, 400);
    await addToCart(guest, lemonade(2)); // 2400 -> cap 1200, balance 400
    const res = await checkout(guest, { paymentMethod: "CASH", useCashback: true }, auth(client.token));
    expect(res.status).toBe(201);
    const orderId = BigInt(res.body.order.orderId);
    const bal = async () => (await prisma.clientUser.findUniqueOrThrow({ where: { clientUserId: BigInt(client.clientUserId) } })).bonusBalance;
    expect(await bal()).toBe(0); // blocked immediately: the same balance cannot be spent in a parallel order
    expect(await prisma.loyaltyLedger.count({ where: { orderId, type: "EARN" } })).toBe(0);

    const admin = auth(cat.staff.admin.token);
    expect((await api().post(`/api/admin/orders/${orderId}/cancel`).set(admin).send({})).status).toBe(200);
    expect(await bal()).toBe(400);
    expect((await prisma.loyaltyLedger.findMany({ where: { orderId }, orderBy: { ledgerId: "asc" } })).map((l) => l.type)).toEqual(["SPEND", "REFUND_SPEND"]);
    // the cancel freed the table, which (correctly) ended the kiosk-bound login; use a normal login for the history
    const phone = (await api().post("/api/client-auth/login").send({ email: "e@example.com", password: "password-123" })).body.token;
    // the history endpoint explains each operation
    const hist = await api().get("/api/client-account/loyalty").set(auth(phone));
    expect(hist.status, JSON.stringify(hist.body)).toBe(200);
    expect(hist.body.balance).toBe(400);
    expect(hist.body.entries.map((e: { typeLabel: string }) => e.typeLabel)).toEqual(["Возврат списания", "Списание", "Начисление"]);
  });

  it("the ledger is append-only in the database itself, and the audit finds a tampered cache", async () => {
    const guest = await openKiosk(1);
    const client = await registerClient("f@example.com", "password-123", guest);
    await grantBonuses(cat, client.clientUserId, 100);
    await expect(prisma.$executeRawUnsafe(`UPDATE loyalty_ledger SET amount = 999`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM loyalty_ledger`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE order_status_events SET status = 'X'`)).resolves.toBe(0); // no rows yet
    const admin = auth(cat.staff.admin.token);
    expect((await api().get("/api/admin/loyalty-audit").set(admin)).body.ok).toBe(true);
    await prisma.clientUser.update({ where: { clientUserId: BigInt(client.clientUserId) }, data: { bonusBalance: 5 } });
    const bad = await api().get("/api/admin/loyalty-audit").set(admin);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.cacheMismatch).toEqual([{ clientUserId: client.clientUserId, cache: 5, ledger: 100 }]);
  });
});
