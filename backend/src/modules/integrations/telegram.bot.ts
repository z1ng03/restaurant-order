import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import * as account from "../clientAccount/clientAccount.service";
import { answerTelegramCallback, deliverReceiptToChat, sendTelegramInteractive, type TelegramKeyboard } from "../receipts/delivery.service";
import { getReceiptForOrder } from "../receipts/receipts.service";
import { handleTelegramUpdate as handleLegacyLink } from "./telegram.service";
import { parseBotAction } from "./telegram.contract";

const TTL_MS = 15 * 60_000;
const PAGE_SIZE = 5;
const MENU: TelegramKeyboard = [
  [{ text: "📋 Мои заказы", callback_data: "orders:0" }, { text: "🧾 Мои чеки", callback_data: "receipts:0" }],
  [{ text: "🔐 Войти", callback_data: "login" }, { text: "🚪 Выйти", callback_data: "logout" }],
  [{ text: "❔ Помощь", callback_data: "help" }],
];


export async function createGuestReceiptLink(orderId: bigint): Promise<{ deepLink: string; expiresAt: Date }> {
  if (!env.telegram.botUsername || !env.telegram.botToken) {
    throw new AppError(503, "DELIVERY_PROVIDER_NOT_CONFIGURED", "Telegram-бот не настроен");
  }
  const receipt = await getReceiptForOrder(orderId);
  if (receipt.isPaymentPreview) {
    throw new AppError(409, "PAYMENT_NOT_SETTLED", "Чек доступен после оплаты заказа");
  }
  const token = `g_${randomToken(24)}`;
  const expiresAt = new Date(Date.now() + TTL_MS);
  await prisma.telegramReceiptClaim.create({ data: { tokenHash: sha256Hex(token), orderId, expiresAt } });
  return { deepLink: `https://t.me/${env.telegram.botUsername}?start=${token}`, expiresAt };
}

/** A web session that is already signed in must explicitly confirm this login request. */
export async function confirmBotLogin(clientUserId: bigint, token: string): Promise<void> {
  if (!/^l_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new AppError(400, "INVALID_TOKEN", "Некорректный код входа");
  const tokenHash = sha256Hex(token);
  const chatId = await prisma.$transaction(async (tx) => {
    const row = await tx.telegramBotLoginRequest.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt || row.expiresAt <= new Date()) throw new AppError(410, "LINK_EXPIRED", "Ссылка входа устарела");
    const client = await tx.clientUser.findUnique({ where: { clientUserId } });
    if (!client || !client.isActive || client.deletedAt) throw new AppError(403, "ACCOUNT_INACTIVE", "Аккаунт недоступен");
    const owner = await tx.clientTelegramLink.findUnique({ where: { telegramChatId: row.chatId } });
    if (owner && owner.clientUserId !== clientUserId) throw new AppError(409, "CHAT_ALREADY_LINKED", "Telegram уже связан с другим аккаунтом. Сначала выйдите из него в боте.");
    const used = await tx.telegramBotLoginRequest.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (!used.count) throw new AppError(410, "LINK_EXPIRED", "Ссылка уже использована");
    await tx.clientTelegramLink.upsert({ where: { clientUserId },
      create: { clientUserId, telegramChatId: row.chatId, verifiedAt: new Date() },
      update: { telegramChatId: row.chatId, verifiedAt: new Date(), autoReceipts: false },
    });
    return row.chatId;
  });
  // The account link is committed even if Telegram is currently unreachable.
  try { await sendTelegramInteractive(chatId, "✅ Вход выполнен. Можете просматривать свои заказы и чеки.", MENU); } catch { /* next command will work */ }
}

export async function setAutoReceiptPreference(clientUserId: bigint, enabled: boolean) {
  const result = await prisma.clientTelegramLink.updateMany({ where: { clientUserId }, data: { autoReceipts: enabled } });
  if (!result.count) throw new AppError(409, "TELEGRAM_NOT_LINKED", "Сначала привяжите Telegram");
  return { autoReceipts: enabled };
}

async function chatAccount(chatId: string): Promise<bigint | null> {
  const link = await prisma.clientTelegramLink.findUnique({ where: { telegramChatId: chatId },
    include: { clientUser: { select: { isActive: true, deletedAt: true } } } });
  return link?.clientUser.isActive && !link.clientUser.deletedAt ? link.clientUserId : null;
}

async function showMenu(chatId: string) {
  const owner = await chatAccount(chatId);
  await sendTelegramInteractive(chatId, owner
    ? "🍽 Restaurant Order. Вы вошли в аккаунт. Выберите раздел:"
    : "🍽 Restaurant Order. Добро пожаловать! Для истории заказов войдите в аккаунт ресторана. Гостевой чек доступен по одноразовой ссылке после оплаты.", MENU);
}

async function login(chatId: string) {
  if (await chatAccount(chatId)) {
    await sendTelegramInteractive(chatId, "Вы уже авторизованы. Для другого аккаунта сначала нажмите «Выйти».", MENU);
    return;
  }
  const token = `l_${randomToken(24)}`;
  await prisma.telegramBotLoginRequest.deleteMany({ where: { chatId, usedAt: null } });
  await prisma.telegramBotLoginRequest.create({ data: { tokenHash: sha256Hex(token), chatId, expiresAt: new Date(Date.now() + TTL_MS) } });
  const url = `${env.frontendBaseUrl}/profile.html#telegram_login=${token}`;
  await sendTelegramInteractive(chatId, "Для входа откройте сайт, авторизуйтесь и подтвердите привязку на странице профиля. Ссылка действительна 15 минут. Не отправляйте пароль в Telegram.", [[{ text: "🔐 Войти на сайте", url }], [{ text: "Главное меню", callback_data: "menu" }]]);
}

async function orders(chatId: string, page: number) {
  const owner = await chatAccount(chatId);
  if (!owner) return sendTelegramInteractive(chatId, "Сначала войдите в аккаунт командой /login.", MENU);
  const records = await prisma.order.findMany({ where: { clientUserId: owner },
    orderBy: [{ createdAt: "desc" }, { orderId: "desc" }], skip: page * PAGE_SIZE, take: PAGE_SIZE + 1,
    select: { orderId: true, createdAt: true, payableTotal: true, orderStatus: true, paymentStatus: true } });
  if (!records.length) return sendTelegramInteractive(chatId, "Заказов на этой странице нет.", MENU);
  const keyboard: TelegramKeyboard = records.slice(0, PAGE_SIZE).map((o) => [{ text: `Заказ №${o.orderId} · ${o.payableTotal} ₸`, callback_data: `order:${o.orderId}` }]);
  const nav: TelegramKeyboard[number] = [];
  if (page > 0) nav.push({ text: "⬅️ Назад", callback_data: `orders:${page - 1}` });
  if (records.length > PAGE_SIZE) nav.push({ text: "Далее ➡️", callback_data: `orders:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "Главное меню", callback_data: "menu" }]);
  await sendTelegramInteractive(chatId, `📋 Ваши заказы · страница ${page + 1}\n` + records.slice(0, PAGE_SIZE)
    .map((o) => `№${o.orderId} · ${o.createdAt.toLocaleDateString("ru-RU")} · ${o.payableTotal} ₸\nСтатус: ${o.orderStatus}; оплата: ${o.paymentStatus}`).join("\n\n"), keyboard);
}

async function orderDetail(chatId: string, orderId: bigint) {
  const owner = await chatAccount(chatId);
  if (!owner) return sendTelegramInteractive(chatId, "Для просмотра заказов необходимо войти.", MENU);
  const detail = await account.getOrderDetail(owner, orderId); // existing ownership check
  const items = detail.items.map((x) => `${x.quantity} × ${x.name}: ${x.lineTotal} ₸`).join("\n");
  const text = `📋 Заказ №${orderId}\nСтатус: ${detail.orderStatus}; оплата: ${detail.paymentStatus}\n\n${items}`;
  const keyboard: TelegramKeyboard = [];
  if (detail.paymentStatus === "PAID") keyboard.push([{ text: "🧾 Получить чек", callback_data: `receipt-order:${orderId}` }]);
  keyboard.push([{ text: "К заказам", callback_data: "orders:0" }]);
  await sendTelegramInteractive(chatId, text, keyboard);
}

async function receipts(chatId: string, page: number) {
  const owner = await chatAccount(chatId);
  if (!owner) return sendTelegramInteractive(chatId, "Сначала войдите в аккаунт.", MENU);
  const rows = await prisma.receipt.findMany({ where: { order: { clientUserId: owner, paymentStatus: "PAID" } },
    orderBy: { issuedAt: "desc" }, skip: page * PAGE_SIZE, take: PAGE_SIZE + 1,
    select: { orderId: true, receiptNumber: true, issuedAt: true } });
  if (!rows.length) return sendTelegramInteractive(chatId, "Оплаченных чеков на этой странице нет.", MENU);
  const keyboard: TelegramKeyboard = rows.slice(0, PAGE_SIZE).map((r) => [{ text: `${r.receiptNumber} · заказ №${r.orderId}`, callback_data: `receipt-order:${r.orderId}` }]);
  const nav: TelegramKeyboard[number] = [];
  if (page > 0) nav.push({ text: "⬅️ Назад", callback_data: `receipts:${page - 1}` });
  if (rows.length > PAGE_SIZE) nav.push({ text: "Далее ➡️", callback_data: `receipts:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: "Главное меню", callback_data: "menu" }]);
  await sendTelegramInteractive(chatId, `🧾 Ваши чеки · страница ${page + 1}`, keyboard);
}

async function sendOwnedReceipt(chatId: string, orderId: bigint) {
  const owner = await chatAccount(chatId);
  if (!owner) return sendTelegramInteractive(chatId, "Необходимо войти в аккаунт.", MENU);
  const order = await prisma.order.findFirst({ where: { orderId, clientUserId: owner, paymentStatus: "PAID" }, select: { orderId: true } });
  if (!order) return sendTelegramInteractive(chatId, "Чек не найден или заказ ещё не оплачен.", MENU);
  await deliverReceiptToChat({ orderId, chatId, requestedByClientId: owner });
  await sendTelegramInteractive(chatId, "Чек отправлен. Его можно получить повторно из раздела «Мои чеки».", [[{ text: "Мои чеки", callback_data: "receipts:0" }]]);
}

async function claimGuestReceipt(chatId: string, rawToken: string) {
  const tokenHash = sha256Hex(rawToken);
  // Claim atomically BEFORE sending. A failed send releases the claim; a successful one consumes it.
  const row = await prisma.telegramReceiptClaim.findUnique({ where: { tokenHash } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) return sendTelegramInteractive(chatId, "Ссылка на чек недействительна, уже использована или устарела.", MENU);
  const claim = await prisma.telegramReceiptClaim.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
  if (!claim.count) return sendTelegramInteractive(chatId, "Эта ссылка уже была использована.", MENU);
  try {
    await deliverReceiptToChat({ orderId: row.orderId, chatId });
  } catch (err) {
    await prisma.telegramReceiptClaim.update({ where: { tokenHash }, data: { usedAt: null } });
    throw err;
  }
  // The capability is now permanently consumed; failure of a follow-up message cannot release it.
  try { await sendTelegramInteractive(chatId, "✅ Гостевой чек получен. Для истории заказов войдите в аккаунт.", MENU); }
  catch { /* The receipt was delivered successfully. */ }
}

async function doLogout(chatId: string) {
  await prisma.clientTelegramLink.deleteMany({ where: { telegramChatId: chatId } });
  await prisma.telegramBotLoginRequest.deleteMany({ where: { chatId, usedAt: null } });
  await sendTelegramInteractive(chatId, "Вы вышли из аккаунта. Доступ к истории и личным чекам закрыт.", MENU);
}

async function dispatchAction(chatId: string, action: string, argument = "") {
  if (action === "menu" || action === "start") return showMenu(chatId);
  if (action === "login") return login(chatId);
  if (action === "logout") return doLogout(chatId);
  if (action === "help") return sendTelegramInteractive(chatId,
    "Команды: /start — меню, /login — вход, /orders — заказы, /receipts — чеки, /logout — выход, /help — помощь. Чек гостя открывается только по одноразовой ссылке, выданной сайтом после оплаты.", MENU);
  if (action === "orders" || action === "receipts") {
    if (!/^(0|[1-9]\d{0,3})$/.test(argument || "0")) return;
    const page = Number(argument || "0");
    return action === "orders" ? orders(chatId, page) : receipts(chatId, page);
  }
  if (action === "order" || action === "receipt-order") {
    if (!/^[1-9]\d{0,18}$/.test(argument)) return;
    return action === "order" ? orderDetail(chatId, BigInt(argument)) : sendOwnedReceipt(chatId, BigInt(argument));
  }
  return showMenu(chatId);
}

type Update = {
  update_id?: unknown;
  message?: { text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown } };
  callback_query?: { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { chat?: { id?: unknown; type?: unknown } } };
};

export async function handleBotUpdate(input: unknown): Promise<{ handled: boolean; duplicate?: boolean }> {
  if (!input || typeof input !== "object") return { handled: false };
  const update = input as Update;
  if (typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return { handled: false };
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (chat?.type !== "private" || (typeof chat.id !== "number" && typeof chat.id !== "string")) return { handled: false };
  const chatId = String(chat.id);
  if (String(update.message?.from?.id ?? update.callback_query?.from?.id ?? "") !== chatId) return { handled: false };
  const inserted = await prisma.telegramProcessedUpdate.createMany({ data: [{ updateId: BigInt(update.update_id) }], skipDuplicates: true });
  if (!inserted.count) return { handled: true, duplicate: true };
  try {
    const callback = update.callback_query;
    if (callback && typeof callback.data === "string") {
      if (typeof callback.id === "string") await answerTelegramCallback(callback.id);
      const [action = "menu", argument = ""] = callback.data.split(":", 2);
      try {
        await dispatchAction(chatId, action, argument);
      } catch (err) {
        if (err instanceof AppError && [401, 403, 404, 409].includes(err.status)) {
          await sendTelegramInteractive(chatId, "Заказ не найден или доступ к нему запрещён.", MENU);
        } else throw err;
      }
    } else {
      const text = typeof update.message?.text === "string" ? update.message.text : "";
      const command = parseBotAction(text);
      if (command?.command === "start" && /^g_[A-Za-z0-9_-]{20,64}$/.test(command.argument)) {
        await claimGuestReceipt(chatId, command.argument);
      } else if (command?.command === "start" && /^[A-Za-z0-9_-]{16,64}$/.test(command.argument)) {
        // Retain the profile's original deep-link authorization semantics.
        await handleLegacyLink(update);
      } else if (command) {
        await dispatchAction(chatId, command.command, command.argument);
      } else {
        await showMenu(chatId);
      }
    }
    return { handled: true };
  } catch (err) {
    // If processing fails before acknowledging Telegram, permit a retry.
    await prisma.telegramProcessedUpdate.deleteMany({ where: { updateId: BigInt(update.update_id) } });
    throw err;
  }
}

export async function cleanupBotRecords(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600_000);
  await prisma.telegramProcessedUpdate.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } } });
  await prisma.telegramReceiptClaim.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] } });
  await prisma.telegramBotLoginRequest.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] } });
}
