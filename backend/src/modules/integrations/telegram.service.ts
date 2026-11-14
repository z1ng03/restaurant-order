import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { notifyTelegram } from "../receipts/delivery.service";

/**
 * Binding a Telegram chat to a client account (FR-07).
 *
 * The chat id is NEVER accepted from a request: the account asks for a one-time deep link
 * (https://t.me/<bot>?start=<token>), the user opens it in Telegram and presses Start, and Telegram calls our
 * webhook with the chat id of the person who actually did that. Only the token's hash is stored; it expires in
 * 15 minutes and can be used once.
 */
const LINK_TOKEN_TTL_MS = 15 * 60_000;
const START_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;

export function telegramLinkAvailable(): boolean {
  return Boolean(env.telegram.botToken && env.telegram.botUsername);
}

export async function getTelegramStatus(clientUserId: bigint) {
  const link = await prisma.clientTelegramLink.findUnique({ where: { clientUserId } });
  return {
    linked: link !== null,
    autoReceipts: link?.autoReceipts ?? false,
    linkedAt: link?.verifiedAt ?? null,
    chatIdMasked: link ? `···${link.telegramChatId.slice(-3)}` : null,
    linkAvailable: telegramLinkAvailable(),
  };
}

export async function createTelegramLinkToken(clientUserId: bigint) {
  if (!telegramLinkAvailable()) {
    throw new AppError(503, "DELIVERY_PROVIDER_NOT_CONFIGURED", "Telegram-бот не настроен на сервере");
  }
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  await prisma.$transaction(async (tx) => {
    // only the newest link works
    await tx.clientTelegramLinkToken.deleteMany({ where: { clientUserId, usedAt: null } });
    await tx.clientTelegramLinkToken.create({ data: { tokenHash: sha256Hex(token), clientUserId, expiresAt } });
  });
  return { deepLink: `https://t.me/${env.telegram.botUsername}?start=${token}`, expiresAt };
}

export async function unlinkTelegram(clientUserId: bigint): Promise<void> {
  await prisma.clientTelegramLink.deleteMany({ where: { clientUserId } });
  await prisma.telegramAutoDelivery.updateMany({ where: { clientUserId, status: { in: ["PENDING", "RETRY"] } }, data: { status: "CANCELLED" } });
}

/** Removes the link and pending tokens of an account (account deletion). */
export async function purgeTelegramData(tx: Pick<typeof prisma, "clientTelegramLink" | "clientTelegramLinkToken">, clientUserId: bigint) {
  await tx.clientTelegramLink.deleteMany({ where: { clientUserId } });
  await tx.clientTelegramLinkToken.deleteMany({ where: { clientUserId } });
}

type TelegramUpdate = {
  message?: { text?: unknown; chat?: { id?: unknown; type?: unknown } };
};

/** Handles one webhook update. Only `/start <token>` in a PRIVATE chat does anything. */
export async function handleTelegramUpdate(update: unknown): Promise<{ handled: boolean }> {
  const message = (update as TelegramUpdate | null)?.message;
  const text = typeof message?.text === "string" ? message.text : "";
  const chatIdRaw = message?.chat?.id;
  if (message?.chat?.type !== "private" || (typeof chatIdRaw !== "number" && typeof chatIdRaw !== "string")) {
    return { handled: false };
  }
  const chatId = String(chatIdRaw);
  const match = START_RE.exec(text);
  if (!match || !match[1]) return { handled: false };

  const tokenHash = sha256Hex(match[1]);
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await tx.clientTelegramLinkToken.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return "INVALID" as const;

    const client = await tx.clientUser.findUnique({ where: { clientUserId: row.clientUserId } });
    if (!client || !client.isActive || client.deletedAt) return "INVALID" as const;

    const chatOwner = await tx.clientTelegramLink.findUnique({ where: { telegramChatId: chatId } });
    if (chatOwner && chatOwner.clientUserId !== row.clientUserId) return "TAKEN" as const;

    const claimed = await tx.clientTelegramLinkToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 0) return "INVALID" as const;

    await tx.clientTelegramLink.upsert({
      where: { clientUserId: row.clientUserId },
      create: { clientUserId: row.clientUserId, telegramChatId: chatId, verifiedAt: new Date() },
      update: { telegramChatId: chatId, verifiedAt: new Date(), autoReceipts: false },
    });
    return "LINKED" as const;
  });

  if (outcome === "LINKED") await notifyTelegram(chatId, "Готово! Telegram привязан к вашему аккаунту. Теперь чеки можно получать здесь.");
  else if (outcome === "TAKEN") await notifyTelegram(chatId, "Этот Telegram уже привязан к другому аккаунту.");
  else await notifyTelegram(chatId, "Ссылка недействительна или устарела. Создайте новую в профиле.");
  return { handled: true };
}
