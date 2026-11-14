import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient } from "../helpers/http";

const s = (v: bigint) => v.toString();

describe.skipIf(!hasTestDatabase)("receipts (FR-07): access, content, immutability", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });

  async function paidOrder(monitor = 1) {
    const k = await openKiosk(monitor);
    const client = await registerClient(`c${monitor}@example.com`, "password-123", k);
    await addToCart(k, {
      dishId: s(cat.dish.carbonara!), quantity: 2,
      ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.060" }, { ingredientId: s(cat.ing.bacon!), quantity: 0 }],
      options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }],
    });
    const res = await checkout(k, { paymentMethod: "KASPI_QR" }, auth(client.token));
    return { k, client, orderId: String(res.body.order.orderId) };
  }

  it("contains every required field, explains variants, and says plainly that it is a DEMO document", async () => {
    const { k, orderId } = await paidOrder();
    const r = (await api().get(`/api/orders/${orderId}/receipt`).set(k.h)).body.receipt;
    expect(r).toMatchObject({
      receiptNumber: "DEMO-000001", kind: "DEMO", orderId, tableNumber: 1, timeZone: "Asia/Almaty",
      subtotal: "8200.00", bonusDiscount: "0.00", paidTotal: "8200.00", paymentMethod: "KASPI_QR",
      fiscalSign: null, fiscalSignLabel: "Не присвоен", ofdName: null, ofdLabel: "Отсутствует", fiscalStatus: "NOT_CONFIGURED",
      message: "Демонстрационный нефискальный чек - не предназначен для проверки в ОФД",
      vat: { applicable: false, ratePercent: null, amount: null },
      barcode: { type: "DEMO_ILLUSTRATION", value: "DEMO-000001" },
    });
    expect(r.merchant).toMatchObject({ name: expect.stringContaining("Демо"), address: expect.stringContaining("Алматы"), taxId: expect.stringContaining("не действителен") });
    expect(r.merchant.kkmSerial).toContain("DEMO");
    expect(r.paidAtLocal).toMatch(/^\d{2}\.\d{2}\.\d{4}/);
    expect(r.items).toEqual([{
      lineNo: 1, name: "Паста Карбонара", quantity: 2, unit: "порц.", unitPrice: "4100.00", lineTotal: "8200.00",
      nktCode: null, nktLabel: "Не настроено (DEMO)",
      details: ["parmesan: 60 г вместо 40 г на порцию", "bacon: убрать на порцию".replace(" на порцию", ""), "+ Доп. бекон ×1"],
    }]);
    expect(r.legacySnapshot).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/clientUserId|email|passwordHash/);
  });

  it("who may read it: the table's own terminal, the owning account, waiter/admin - nobody else", async () => {
    const { k, client, orderId } = await paidOrder(1);
    const other = await openKiosk(2);
    const stranger = await registerClient("stranger@example.com");
    const get = (h: Record<string, string>) => api().get(`/api/orders/${orderId}/receipt`).set(h);
    expect((await get(k.h)).status).toBe(200);
    expect((await get(auth(client.token))).status).toBe(200);
    expect((await get(auth(cat.staff.waiter.token))).status).toBe(200);
    expect((await get(auth(cat.staff.admin.token))).status).toBe(200);
    expect((await get(auth(cat.staff.chef.token))).status).toBe(403);
    expect((await get({})).status).toBe(403);
    expect((await get({ "X-Kiosk-Session-Token": "nope" })).status).toBe(403);
    expect((await get(other.h)).status).toBe(403); // another table's secret
    const notOwner = await get(auth(stranger.token));
    expect([notOwner.status, notOwner.body.error.code]).toEqual([404, "ORDER_NOT_OWNED"]);
    expect((await api().get("/api/orders/999999/receipt").set(auth(stranger.token))).body.error.code).toBe("ORDER_NOT_OWNED");
  });

  it("is issued once: same number on every read, sequential numbers across orders", async () => {
    const a = await paidOrder(1);
    const first = (await api().get(`/api/orders/${a.orderId}/receipt`).set(a.k.h)).body.receipt.receiptNumber;
    const again = (await api().get(`/api/orders/${a.orderId}/receipt`).set(a.k.h)).body.receipt.receiptNumber;
    expect([first, again]).toEqual(["DEMO-000001", "DEMO-000001"]);
    const b = await paidOrder(2);
    expect((await api().get(`/api/orders/${b.orderId}/receipt`).set(b.k.h)).body.receipt.receiptNumber).toBe("DEMO-000002");
    expect(await prisma.receipt.count()).toBe(2);
  });

  it("the snapshot is immutable in the database; only the fiscal result may change later", async () => {
    const { orderId } = await paidOrder();
    await expect(prisma.$executeRawUnsafe(`UPDATE receipts SET payload_json = '{}'::jsonb`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE receipts SET receipt_number = 'X-1'`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE receipts SET issued_at = now()`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM receipts`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE receipts SET fiscal_status = 'SUCCEEDED', fiscal_reference = 'ref-1'`)).resolves.toBe(1);
    // renaming a dish afterwards does not change an issued receipt
    await prisma.dish.update({ where: { dishId: cat.dish.carbonara! }, data: { name: "Renamed" } });
    const r = (await prisma.receipt.findFirstOrThrow({ where: { orderId: BigInt(orderId) } })).payloadJson as { items: { name: string }[] };
    expect(r.items[0]!.name).toBe("Паста Карбонара");
  });

  it("an order paid before receipts existed gets one on first view, clearly flagged as reconstructed", async () => {
    const k = await openKiosk(1);
    const order = await prisma.order.create({
      data: { sessionId: BigInt(k.sessionId), tableId: BigInt(k.tableId), totalPrice: 1200, subtotal: 1200, payableTotal: 1200, orderStatus: "DELIVERED", paymentStatus: "PAID", deliveredAt: new Date(),
        items: { create: [{ dishId: cat.dish.lemonade!, quantity: 1, price: 1200, status: "DELIVERED" }] },
        payments: { create: [{ method: "CASH", status: "PAID", amount: 1200, paidAt: new Date("2026-09-20T10:00:00Z") }] } },
    });
    expect(await prisma.receipt.count()).toBe(0);
    const r = (await api().get(`/api/orders/${order.orderId}/receipt`).set(k.h)).body.receipt;
    expect(r).toMatchObject({ legacySnapshot: true, paidTotal: "1200.00", receiptNumber: "DEMO-000001" });
    expect(r.items[0].details).toEqual([]); // no composition was recorded back then, and none is invented
    expect((await api().get(`/api/orders/${order.orderId}/receipt`).set(k.h)).body.receipt.receiptNumber).toBe("DEMO-000001");
  });

  it("admin sees receipts with delivery attempts, without personal data", async () => {
    await paidOrder();
    const list = await api().get("/api/admin/receipts").set(auth(cat.staff.admin.token));
    expect(list.status).toBe(200);
    expect(list.body.receipts[0]).toMatchObject({ receiptNumber: "DEMO-000001", kind: "DEMO", fiscalStatus: "NOT_CONFIGURED", paidTotal: "8200.00", dispatches: [] });
    expect((await api().get("/api/admin/receipts").set(auth(cat.staff.chef.token))).status).toBe(403);
  });
});
