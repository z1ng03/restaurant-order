import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/db/prisma";
import { sha256Hex } from "../../src/lib/crypto";
import { handleBotUpdate } from "../../src/modules/integrations/telegram.bot";
import { processAutoReceipts } from "../../src/modules/integrations/telegram.outbox";
import { setTelegramSender, type TelegramKeyboard } from "../../src/modules/receipts/delivery.service";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient } from "../helpers/http";

const chatId = 44771233;
const messages: { text: string; keyboard?: TelegramKeyboard }[] = [];
let shouldFail = false;
const fakeSender = {
  isConfigured: () => true,
  sendMessage: async (_chat: string, text: string) => {
    if (shouldFail) throw new Error("simulated blocked bot");
    messages.push({ text });
  },
  sendInteractive: async (_chat: string, text: string, keyboard: TelegramKeyboard) => {
    if (shouldFail) throw new Error("simulated blocked bot");
    messages.push({ text, keyboard });
  },
  answerCallback: async (_id: string) => {},
};
const update = (text: string, id: number, from = chatId) => ({
  update_id: id,
  message: { text, chat: { id: chatId, type: "private" }, from: { id: from } },
});
const click = (data: string, id: number) => ({
  update_id: id,
  callback_query: { id: `callback-${id}`, data, from: { id: chatId }, message: { chat: { id: chatId, type: "private" } } },
});

describe.skipIf(!hasTestDatabase)("Telegram bot with isolated PostgreSQL", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(async () => { setTelegramSender({ isConfigured: () => false, sendMessage: async () => {} }); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetDatabase();
    messages.length = 0;
    shouldFail = false;
    Object.assign(env.telegram, { botToken: "fake-testing-only", botUsername: "RestaurantTestBot", webhookSecret: "test-secret" });
    setTelegramSender(fakeSender);
    cat = await seedCatalog();
  });

  async function createOrder(guest: boolean, cash = false) {
    const k = await openKiosk(1);
    const client = guest ? null : await registerClient("tgtest@example.com", "password-123", k);
    await addToCart(k, { dishId: String(cat.dish.lemonade!), quantity: 1 });
    const placed = await checkout(k, { paymentMethod: cash ? "CASH" : "KASPI_QR" }, client ? auth(client.token) : undefined);
    return { k, client, orderId: String(placed.body.order.orderId) };
  }

  it("shows menu, ignores forgery of chat sender, de-duplicates webhooks", async () => {
    expect((await handleBotUpdate(update("/start", 10))).handled).toBe(true);
    expect(messages.at(-1)?.text).toContain("Restaurant Order");
    expect((await handleBotUpdate(update("/start", 10))).duplicate).toBe(true);
    expect(messages.length).toBe(1);
    expect((await handleBotUpdate(update("/start", 11, chatId + 1))).handled).toBe(false);
  });

  it("guest receives only one paid receipt with valid kiosk authorization", async () => {
    const { k, orderId } = await createOrder(true);
    const forbidden = await api().post(`/api/orders/${orderId}/receipt/telegram-link`);
    expect(forbidden.status).toBe(403);
    const link = await api().post(`/api/orders/${orderId}/receipt/telegram-link`).set(k.h);
    expect(link.status).toBe(201);
    const token = new URL(link.body.deepLink).searchParams.get("start");
    expect(token).toMatch(/^g_/);
    await handleBotUpdate(update(`/start ${token}`, 20));
    expect(messages.some((m) => m.text.includes("Демонстрационный нефискальный чек"))).toBe(true);
    const count = await prisma.receiptDispatch.count({ where: { status: "SENT", channel: "TELEGRAM" } });
    await handleBotUpdate(update(`/start ${token}`, 21));
    expect(await prisma.receiptDispatch.count({ where: { status: "SENT", channel: "TELEGRAM" } })).toBe(count);
    expect(await prisma.clientTelegramLink.count()).toBe(0); // guest access is not login
  });

  it("rejects expired guest links and receipts for unpaid cash orders", async () => {
    const { k, orderId } = await createOrder(true, true);
    const response = await api().post(`/api/orders/${orderId}/receipt/telegram-link`).set(k.h);
    expect(response.status).toBe(409);
    const token = "g_" + "x".repeat(32);
    await prisma.telegramReceiptClaim.create({ data: { tokenHash: sha256Hex(token), orderId: BigInt(orderId), expiresAt: new Date(0) } });
    await handleBotUpdate(update(`/start ${token}`, 22));
    expect(messages.at(-1)?.text).toContain("устарела");
  });

  it("bot login, orders, receipts, logout and permission boundaries", async () => {
    const { client, orderId } = await createOrder(false);
    expect(client).not.toBeNull();
    await handleBotUpdate(update("/login", 30));
    const url = messages.at(-1)?.keyboard?.[0]?.[0]?.url;
    expect(url).toContain("#telegram_login=l_");
    const token = url!.split("#telegram_login=")[1]!;
    const login = await api().post("/api/client-account/telegram/confirm-bot-login")
      .set(auth(client!.token)).send({ token });
    expect(login.status).toBe(200);
    const replay = await api().post("/api/client-account/telegram/confirm-bot-login")
      .set(auth(client!.token)).send({ token });
    expect(replay.status).toBe(410);
    await handleBotUpdate(update("/orders", 31));
    expect(messages.at(-1)?.text).toContain(orderId);
    await handleBotUpdate(click(`order:${orderId}`, 32));
    expect(messages.at(-1)?.text).toContain(`Заказ №${orderId}`);
    await handleBotUpdate(update("/receipts", 33));
    expect(messages.at(-1)?.text).toContain("Ваши чеки");
    await handleBotUpdate(click(`receipt-order:${orderId}`, 34));
    expect(messages.some((m) => m.text.includes("Демонстрационный нефискальный чек"))).toBe(true);
    await handleBotUpdate(update("/logout", 35));
    expect(await prisma.clientTelegramLink.count()).toBe(0);
    await handleBotUpdate(update("/orders", 36));
    expect(messages.at(-1)?.text).toContain("Сначала войдите");
  });

  it("provider failure does not create new payments and guest token can be retried", async () => {
    const { k, orderId } = await createOrder(true);
    const link = await api().post(`/api/orders/${orderId}/receipt/telegram-link`).set(k.h);
    const token = new URL(link.body.deepLink).searchParams.get("start")!;
    shouldFail = true;
    await expect(handleBotUpdate(update(`/start ${token}`, 40))).rejects.toThrow();
    expect((await prisma.telegramReceiptClaim.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } })).usedAt).toBeNull();
    shouldFail = false;
    await handleBotUpdate(update(`/start ${token}`, 40));
    expect(await prisma.payment.count({ where: { orderId: BigInt(orderId) } })).toBe(1);
    expect(await prisma.receipt.count({ where: { orderId: BigInt(orderId) } })).toBe(1);
  });

  it("opt-in automatic delivery has a durable outbox, no duplicate payment", async () => {
    const k = await openKiosk(1);
    const client = await registerClient("auto@example.com", "password-123", k);
    await prisma.clientTelegramLink.create({ data: { clientUserId: BigInt(client.clientUserId), telegramChatId: String(chatId), verifiedAt: new Date(), autoReceipts: true } });
    await addToCart(k, { dishId: String(cat.dish.lemonade!), quantity: 1 });
    const order = await checkout(k, { paymentMethod: "KASPI_QR" }, auth(client.token));
    expect(await prisma.telegramAutoDelivery.count({ where: { status: "PENDING" } })).toBe(1);
    await processAutoReceipts();
    expect(await prisma.telegramAutoDelivery.count({ where: { status: "SENT" } })).toBe(1);
    await processAutoReceipts();
    expect(await prisma.receiptDispatch.count({ where: { status: "SENT", channel: "TELEGRAM" } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: BigInt(order.body.order.orderId) } })).toBe(1);
  });
});
