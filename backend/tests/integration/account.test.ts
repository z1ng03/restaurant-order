import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/db/prisma";
import { setEmailSender, setTelegramSender, type EmailMessage } from "../../src/modules/receipts/delivery.service";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient, type Kiosk } from "../helpers/http";

const s = (v: bigint) => v.toString();
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]).toString("base64");

describe.skipIf(!hasTestDatabase)("client account: history, rating, reorder, identity, receipt delivery, Telegram", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });
  afterEach(() => {
    setEmailSender({ isConfigured: () => false, send: async () => undefined });
    setTelegramSender({ isConfigured: () => false, sendMessage: async () => undefined });
  });

  async function order(k: Kiosk, token: string | null, lines: Record<string, unknown>[], payment: "CASH" | "KASPI_QR" = "KASPI_QR") {
    for (const l of lines) expect((await addToCart(k, l)).status).toBe(201);
    const res = await checkout(k, { paymentMethod: payment }, token ? auth(token) : {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return String(res.body.order.orderId);
  }
  const carbonara = (over: Record<string, unknown> = {}) => ({ dishId: s(cat.dish.carbonara!), quantity: 1, ...over });
  const lemonade = () => ({ dishId: s(cat.dish.lemonade!), quantity: 1 });

  describe("history and detail", () => {
    it("shows only the account's own orders, newest first, with a stable cursor; guest orders are never attached", async () => {
      const k1 = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k1);
      const first = await order(k1, a.token, [lemonade()]);
      const second = await order(k1, a.token, [lemonade(), lemonade()]);
      const k2 = await openKiosk(2);
      await order(k2, null, [lemonade()]); // a guest order at another table
      const b = await registerClient("b@example.com", "password-123", k2);

      const page1 = await api().get("/api/client-account/orders?limit=1").set(auth(a.token));
      expect(page1.status).toBe(200);
      expect(page1.body.orders.map((o: { orderId: string }) => o.orderId)).toEqual([second]);
      expect(page1.body.nextCursor).toBe(second); // the cursor is the LAST item of the page; the next page starts after it
      const page2 = await api().get(`/api/client-account/orders?limit=1&cursor=${page1.body.nextCursor}`).set(auth(a.token));
      expect(page2.body.orders.map((o: { orderId: string }) => o.orderId)).toEqual([first]);
      expect(page2.body.nextCursor).toBeNull();
      expect((await api().get("/api/client-account/orders").set(auth(b.token))).body.orders).toEqual([]);
      expect(page1.body.orders[0]).toMatchObject({ itemCount: 2, receiptAvailable: true, canRate: false });
    });

    it("the detail is the historical snapshot; another account gets the same 404 as a missing order", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [carbonara({ quantity: 2, ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.060" }, { ingredientId: s(cat.ing.bacon!), quantity: 0 }], options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }] })]);
      // later the dish gets more expensive and renamed: the history must not change
      await prisma.dish.update({ where: { dishId: cat.dish.carbonara! }, data: { price: 9999 } });

      const d = await api().get(`/api/client-account/orders/${id}`).set(auth(a.token));
      expect(d.status).toBe(200);
      const o = d.body.order;
      expect(o).toMatchObject({ orderStatus: "SENT_TO_KITCHEN", statusLabel: "Заказ принят", deliveredAt: null, tableNumber: 1, subtotal: "8200.00", payableTotal: "8200.00", discountBonus: 0 });
      expect(o.items[0]).toMatchObject({ name: "Паста Карбонара", quantity: 2, unitPrice: "4100.00", lineTotal: "8200.00" });
      expect(o.items[0].options).toEqual([{ name: "Доп. бекон", quantity: 1, price: "500.00" }]);
      expect(o.items[0].composition).toEqual([
        { name: "parmesan", text: "60 г вместо 40 г на порцию" },
        { name: "bacon", text: "убрать" },
      ]);
      expect(o.payment).toMatchObject({ method: "KASPI_QR", methodLabel: "Kaspi QR (демо-симуляция)", status: "PAID", isDemo: true, amount: "8200.00" });
      expect(o.receipt).toMatchObject({ available: true, receiptNumber: "DEMO-000001" });
      expect(o.restaurant.name).toBe(env.merchant.name);
      expect(JSON.stringify(d.body)).not.toMatch(/clientUserId|passwordHash/);

      const b = await registerClient("b@example.com");
      const other = await api().get(`/api/client-account/orders/${id}`).set(auth(b.token));
      const missing = await api().get("/api/client-account/orders/999999").set(auth(b.token));
      expect([other.status, missing.status]).toEqual([404, 404]);
      expect(other.body.error).toEqual(missing.body.error);
    });

    it("an unpaid cash order has no receipt yet, and says why", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()], "CASH");
      const d = await api().get(`/api/client-account/orders/${id}`).set(auth(a.token));
      expect(d.body.order.receipt).toEqual({ available: false, receiptNumber: null, kind: null, reason: "Чек появится после оплаты" });
      expect(d.body.order.payment).toMatchObject({ methodLabel: "Наличные", status: "WAITING_FOR_CASH" });
    });
  });

  describe("rating", () => {
    it("only the owner, only a delivered order, once, 1..5", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()]);
      const rate = (token: string, rating: unknown) => api().post(`/api/client-account/orders/${id}/rating`).set(auth(token)).send({ rating });
      expect((await rate(a.token, 5)).body.error.code).toBe("ORDER_NOT_RATEABLE"); // not delivered yet
      await prisma.order.update({ where: { orderId: BigInt(id) }, data: { orderStatus: "DELIVERED", deliveredAt: new Date() } });
      const b = await registerClient("b@example.com");
      expect((await rate(b.token, 5)).body.error.code).toBe("ORDER_NOT_OWNED");
      for (const bad of [0, 6, 2.5, "5", null]) expect((await rate(a.token, bad)).status).toBe(400);
      expect((await rate(a.token, 4)).status).toBe(201);
      expect((await rate(a.token, 5)).body.error.code).toBe("ORDER_ALREADY_RATED");
      expect((await api().get("/api/client-account/orders").set(auth(a.token))).body.orders[0]).toMatchObject({ rating: 4, canRate: false });
    });
  });

  describe("reorder", () => {
    const placeOriginal = async (k: Kiosk, token: string) =>
      order(k, token, [carbonara({ quantity: 2, ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.060" }], options: [{ optionId: s(cat.option.extraBacon!), quantity: 1 }] })]);
    const reorder = (k: Kiosk, token: string, orderId: string, headers: Record<string, string> = k.h) =>
      api().post(`/api/client-account/orders/${orderId}/reorder`).set({ ...headers, ...auth(token) }).send({ sessionId: k.sessionId });

    it("rebuilds the SAME personalised lines in the cart - without creating an order or a payment", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await placeOriginal(k, a.token);
      const orders = await prisma.order.count();
      const payments = await prisma.payment.count();
      const res = await reorder(k, a.token, id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ addedItems: [{ dishName: "Паста Карбонара", quantity: 2 }], unavailableItems: [], priceChanged: [], requiresPriceConfirmation: false });
      const item = res.body.cart.items[0];
      expect(item.options).toHaveLength(1);
      expect(item.ingredients.find((i: { name: string }) => i.name === "parmesan")).toMatchObject({ selectedQuantity: "0.060", totalQuantity: "0.120" });
      expect([await prisma.order.count(), await prisma.payment.count()]).toEqual([orders, payments]);
      expect((await checkout(k, { paymentMethod: "CASH" }, auth(a.token))).status).toBe(201); // and it goes through the normal checkout
    });

    it("a changed price is shown, blocks checkout until the guest confirms the new total, then goes through at the new price", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await placeOriginal(k, a.token);
      await prisma.dish.update({ where: { dishId: cat.dish.carbonara! }, data: { price: 3500 } });
      const res = await reorder(k, a.token, id);
      expect(res.body.priceChanged).toEqual([{ dishId: s(cat.dish.carbonara!), dishName: "Паста Карбонара", previousUnitPrice: "4100.00", currentUnitPrice: "4437.50" }]);
      expect(res.body.requiresPriceConfirmation).toBe(true);
      expect(res.body.cart.subtotal).toBe("8875"); // the CURRENT price, never the old one
      const v = await api().get(`/api/checkout/${k.sessionId}/validate`).set({ ...k.h, ...auth(a.token) });
      expect(v.body.issues.map((i: { type: string }) => i.type)).toEqual(["PRICE_CONFIRMATION_REQUIRED"]);
      expect((await checkout(k, { paymentMethod: "CASH" }, auth(a.token))).body.error.details.issues[0].type).toBe("PRICE_CONFIRMATION_REQUIRED");
      expect((await api().post(`/api/cart/${k.sessionId}/price-confirmation`).set({ ...k.h, ...auth(a.token) })).body.cart.requiresPriceConfirmation).toBe(false);
      const done = await checkout(k, { paymentMethod: "CASH" }, auth(a.token));
      expect(done.status).toBe(201);
      expect(done.body.order.subtotal).toBe("8875");
    });

    it("what cannot be reproduced is reported, never silently dropped: stock, changed composition, removed dish", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await placeOriginal(k, a.token);

      // 0.12 of parmesan is still reserved by the original order, so stock cannot drop below that (the CHECK would refuse)
      await prisma.inventory.update({ where: { ingredientId: cat.ing.parmesan! }, data: { stockQuantity: "0.130" } });
      let res = await reorder(k, a.token, id);
      expect(res.body.addedItems).toEqual([]);
      expect(res.body.unavailableItems[0]).toMatchObject({ dishName: "Паста Карбонара", reason: "INSUFFICIENT_INGREDIENTS" });
      expect(res.body.cart.items).toEqual([]);

      await prisma.inventory.update({ where: { ingredientId: cat.ing.parmesan! }, data: { stockQuantity: "5.000" } });
      await prisma.recipe.updateMany({ where: { dishId: cat.dish.carbonara!, ingredientId: cat.ing.parmesan! }, data: { adjustmentStep: "0.025" } });
      res = await reorder(k, a.token, id);
      expect(res.body.unavailableItems[0]).toMatchObject({ reason: "COMPOSITION_CHANGED" }); // 0.060 is no longer a valid step

      await prisma.dish.update({ where: { dishId: cat.dish.carbonara! }, data: { isActive: false } });
      res = await reorder(k, a.token, id);
      expect(res.body.unavailableItems[0]).toMatchObject({ reason: "DISH_INACTIVE" });
    });

    it("needs the terminal's secret and the account's own order", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await placeOriginal(k, a.token);
      expect((await reorder(k, a.token, id, {})).status).toBe(403);
      const k2 = await openKiosk(2);
      const b = await registerClient("b@example.com", "password-123", k2);
      const r = await reorder(k2, b.token, id, k2.h);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("ORDER_NOT_OWNED");
    });
  });

  describe("identity verification and 21+", () => {
    const beerOrder = async (k: Kiosk, token: string | null) => {
      await addToCart(k, { dishId: s(cat.dish.beer!), quantity: 1 });
      return checkout(k, { paymentMethod: "CASH" }, token ? auth(token) : {});
    };

    it("demo flow: submit -> pending -> demo-confirm -> verified; it then replaces the waiter's 21+ check; the document is never stored", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const me = () => api().get("/api/client-account/identity-verification").set(auth(a.token));
      expect((await me()).body.identity).toMatchObject({ status: "UNVERIFIED", ageVerified: false, demoModeAvailable: true });

      const post = (body: Record<string, unknown>) => api().post("/api/client-account/identity-verification").set(auth(a.token)).send(body);
      expect((await post({})).status).toBe(400);
      expect((await post({ fileBase64: Buffer.from("not an image at all").toString("base64") })).body.error.code).toBe("INVALID_FILE");
      expect((await post({ fileBase64: png(), verified: true })).status).toBe(400); // a client can never declare itself verified
      expect((await api().post("/api/client-account/identity-verification/demo-confirm").set(auth(a.token))).body.error.code).toBe("IDENTITY_VERIFICATION_REQUIRED");

      const sent = await post({ fileBase64: png() });
      expect(sent.status).toBe(202);
      expect(sent.body.identity).toMatchObject({ status: "PENDING", mode: "DEMO", ageVerified: false });
      expect((await post({ fileBase64: png() })).body.identity.status).toBe("PENDING");
      expect(await prisma.clientIdentityVerification.count()).toBe(1); // idempotent
      const row = await prisma.clientIdentityVerification.findFirstOrThrow();
      expect(row.providerReference).toMatch(/^demo:[0-9a-f]{16}$/);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith("ro-identity-"))).toEqual([]); // the temp file is gone

      expect((await beerOrder(k, a.token)).body.error.details.issues.map((i: { type: string }) => i.type)).toContain("AGE_VERIFICATION_REQUIRED");
      const ok = await api().post("/api/client-account/identity-verification/demo-confirm").set(auth(a.token));
      expect(ok.body.identity).toMatchObject({ status: "VERIFIED", mode: "DEMO", ageVerified: true });
      expect(ok.body.identity.expiresAt).toBeTruthy();
      const placed = await checkout(k, { paymentMethod: "CASH" }, auth(a.token));
      expect(placed.status).toBe(201);
      // a guest at the same table without the account still needs the waiter
      const k2 = await openKiosk(2);
      expect((await beerOrder(k2, null)).status).toBe(409);
    });

    it("outside demo mode (production) the demo is refused and a DEMO verification never waives 21+", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      await prisma.clientIdentityVerification.create({ data: { clientUserId: BigInt(a.clientUserId), status: "VERIFIED", mode: "DEMO", verifiedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), providerReference: "demo:x" } });
      const flag = env as { demoIdentityVerification: boolean };
      flag.demoIdentityVerification = false;
      try {
        expect((await api().post("/api/client-account/identity-verification").set(auth(a.token)).send({ fileBase64: png() })).body.error.code).toBe("IDENTITY_PROVIDER_NOT_CONFIGURED");
        expect((await api().post("/api/client-account/identity-verification/demo-confirm").set(auth(a.token))).body.error.code).toBe("DEMO_MODE_DISABLED");
        expect((await api().get("/api/client-account/identity-verification").set(auth(a.token))).body.identity).toMatchObject({ status: "VERIFIED", ageVerified: false });
        expect((await beerOrder(k, a.token)).status).toBe(409); // not accepted as a waiver
        await prisma.clientIdentityVerification.updateMany({ data: { mode: "PROVIDER" } }); // a real provider result is honoured
        expect((await checkout(k, { paymentMethod: "CASH" }, auth(a.token))).status).toBe(201);
      } finally {
        flag.demoIdentityVerification = true;
      }
    });
  });

  describe("receipt delivery", () => {
    const emailLog: EmailMessage[] = [];
    const configureEmail = (fail = 0) => {
      emailLog.length = 0;
      let failures = fail;
      setEmailSender({
        isConfigured: () => true,
        send: async (m) => {
          if (failures > 0) { failures--; throw new Error("SMTP connection refused password=hunter2"); }
          emailLog.push(m);
        },
      });
    };

    it("e-mail: only to the account's own address, logged with a masked destination; not configured -> 503", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("anna.petrova@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()]);
      const send = (body: Record<string, unknown> = {}, token = a.token) => api().post(`/api/client-account/orders/${id}/receipt/email`).set(auth(token)).send(body);

      const off = await send();
      expect(off.status).toBe(503);
      expect(off.body.error.code).toBe("DELIVERY_PROVIDER_NOT_CONFIGURED");
      expect((await prisma.receiptDispatch.findFirstOrThrow()).status).toBe("NOT_CONFIGURED");

      configureEmail();
      expect((await send({ email: "someone.else@example.com" })).body.error.code).toBe("RECIPIENT_NOT_VERIFIED");
      const ok = await send({ email: "ANNA.PETROVA@example.com" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ channel: "EMAIL", destinationMasked: "a***@e***.com", status: "SENT" });
      expect(emailLog).toHaveLength(1);
      expect(emailLog[0]).toMatchObject({ to: "anna.petrova@example.com" });
      expect(emailLog[0]!.subject).toContain("DEMO-000001");
      expect(emailLog[0]!.text).toContain("Демонстрационный нефискальный чек");
      const dispatches = await prisma.receiptDispatch.findMany({ orderBy: { dispatchId: "asc" } });
      expect(dispatches.map((d) => [d.status, d.attempts])).toEqual([["NOT_CONFIGURED", 0], ["SENT", 1]]);
      expect(dispatches.every((d) => !JSON.stringify(d).includes("anna.petrova"))).toBe(true); // the address is never stored in clear

      const stranger = await registerClient("b@example.com");
      expect((await send({}, stranger.token)).body.error.code).toBe("ORDER_NOT_OWNED");
    });

    it("a failing provider answers 502 without leaking details; a retry is a new attempt of the SAME receipt and never touches payments", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()]);
      const payments = await prisma.payment.count();
      configureEmail(2); // both attempts of the first request fail
      const bad = await api().post(`/api/client-account/orders/${id}/receipt/email`).set(auth(a.token)).send({});
      expect(bad.status).toBe(502);
      expect(bad.body.error.code).toBe("RECEIPT_SEND_FAILED");
      const failed = await prisma.receiptDispatch.findFirstOrThrow();
      expect(failed).toMatchObject({ status: "FAILED", attempts: 2 });
      expect(failed.lastError).not.toContain("hunter2"); // credentials never reach the log
      const retry = await api().post(`/api/client-account/orders/${id}/receipt/email`).set(auth(a.token)).send({});
      expect(retry.status).toBe(200);
      expect(await prisma.receipt.count()).toBe(1);
      expect(await prisma.payment.count()).toBe(payments);
      expect(await prisma.receiptDispatch.count()).toBe(2);
    });

    it("no receipt can be sent before the order is paid", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()], "CASH");
      configureEmail();
      expect((await api().post(`/api/client-account/orders/${id}/receipt/email`).set(auth(a.token)).send({})).body.error.code).toBe("PAYMENT_NOT_SETTLED");
      expect(emailLog).toEqual([]);
    });

    it("Telegram: a one-time link binds the chat that pressed Start; the chat id is never taken from a request", async () => {
      const k = await openKiosk(1);
      const a = await registerClient("a@example.com", "password-123", k);
      const id = await order(k, a.token, [lemonade()]);
      const sendTg = (body: Record<string, unknown> = {}) => api().post(`/api/client-account/orders/${id}/receipt/telegram`).set(auth(a.token)).send(body);

      expect((await api().post("/api/client-account/telegram/link").set(auth(a.token))).body.error.code).toBe("DELIVERY_PROVIDER_NOT_CONFIGURED");
      const sent: { chatId: string; text: string }[] = [];
      setTelegramSender({ isConfigured: () => true, sendMessage: async (chatId, text) => void sent.push({ chatId, text }) });
      const prev = env.telegram;
      env.telegram = { botToken: "123:abc", botUsername: "demo_bot", webhookSecret: "hook-secret-1234" };
      try {
        const notLinked = await sendTg();
        expect(notLinked.status).toBe(409);
        expect(notLinked.body.error).toMatchObject({ code: "TELEGRAM_NOT_LINKED", details: { linkRequired: true } });

        const link = await api().post("/api/client-account/telegram/link").set(auth(a.token));
        expect(link.status).toBe(201);
        const token = String(link.body.deepLink).split("start=")[1]!;
        expect(link.body.deepLink).toMatch(/^https:\/\/t\.me\/demo_bot\?start=/);
        expect(await prisma.clientTelegramLinkToken.findFirstOrThrow()).toMatchObject({ usedAt: null }); // stored hashed
        expect((await prisma.clientTelegramLinkToken.findFirstOrThrow()).tokenHash).not.toBe(token);

        const update = (text: string, chatId = 777001) => ({ message: { text, chat: { id: chatId, type: "private" } } });
        const hook = (body: unknown, secret = "hook-secret-1234") => api().post("/api/integrations/telegram/webhook").set({ "X-Telegram-Bot-Api-Secret-Token": secret }).send(body as object);
        expect((await hook(update(`/start ${token}`), "wrong")).status).toBe(401);
        expect((await api().post("/api/integrations/telegram/webhook").send(update(`/start ${token}`))).status).toBe(401);
        expect((await hook(update("/start not-a-valid-token-at-all-123"))).status).toBe(200);
        expect(await prisma.clientTelegramLink.count()).toBe(0);
        expect((await hook({ message: { text: `/start ${token}`, chat: { id: 5, type: "group" } } })).status).toBe(200);
        expect(await prisma.clientTelegramLink.count()).toBe(0); // groups are ignored
        expect((await hook(update(`/start ${token}`))).status).toBe(200);
        expect(await prisma.clientTelegramLink.findFirstOrThrow()).toMatchObject({ telegramChatId: "777001" });
        expect(await hook(update(`/start ${token}`, 999)).then((r) => r.status)).toBe(200); // the token is single-use
        expect((await prisma.clientTelegramLink.findFirstOrThrow()).telegramChatId).toBe("777001");
        expect((await api().get("/api/client-account/me").set(auth(a.token))).body.client.telegram).toMatchObject({ linked: true, chatIdMasked: "···001" });

        sent.length = 0;
        const ok = await sendTg({ chatId: "123456" }); // a chat id in the body is ignored
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ channel: "TELEGRAM", status: "SENT" });
        expect(sent).toHaveLength(1);
        expect(sent[0]!.chatId).toBe("777001");
        expect(sent[0]!.text).toContain("DEMO-000001");

        // a Telegram account that already belongs to somebody else cannot be bound twice
        const k2 = await openKiosk(2);
        const b = await registerClient("b@example.com", "password-123", k2);
        const link2 = await api().post("/api/client-account/telegram/link").set(auth(b.token));
        await hook(update(`/start ${String(link2.body.deepLink).split("start=")[1]}`, 777001));
        expect(await prisma.clientTelegramLink.count()).toBe(1);
        expect((await api().delete("/api/client-account/telegram").set(auth(a.token))).status).toBe(204);
        expect(await prisma.clientTelegramLink.count()).toBe(0);
      } finally {
        env.telegram = prev;
      }
    });
  });

  describe("tracker (FR-09)", () => {
    it("shows only real stages with real times", async () => {
      const k = await openKiosk(1);
      const id = BigInt(await order(k, null, [lemonade()], "CASH"));
      const steps = async () => (await api().get(`/api/order-tracking/session/${k.sessionId}`).set(k.h)).body.orders[0];
      let t = await steps();
      expect(t).toMatchObject({ statusLabel: "Заказ принят", itemCount: 1, receiptAvailable: false });
      expect(t.steps.map((x: { state: string }) => x.state)).toEqual(["completed", "pending", "pending", "pending"]);
      expect(t.steps[0].occurredAt).toBeTruthy();
      const item = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: id } })).orderItemId;
      await api().patch(`/api/kitchen/order-items/${item}/status`).set(auth(cat.staff.chef.token)).send({ status: "PREPARING" });
      t = await steps();
      expect(t.statusLabel).toBe("Готовится");
      expect(t.steps.map((x: { state: string }) => x.state)).toEqual(["completed", "active", "pending", "pending"]);
      expect(t.steps[1].occurredAt).toBeTruthy();
      // the guest endpoint carries no account, payment or receipt content
      expect(JSON.stringify(t)).not.toMatch(/clientUserId|email|passwordHash|payments/);
    });
  });
});
