import { prisma } from "../../db/prisma";
import type { Tx } from "../../lib/prismaTx";
import { AppError } from "../../lib/errors";
import { deliverReceiptToChat } from "../receipts/delivery.service";

export async function enqueueAutoReceipt(tx: Tx, orderId: bigint, clientUserId: bigint | null): Promise<void> {
  if (clientUserId === null) return;
  const link = await tx.clientTelegramLink.findUnique({ where: { clientUserId } });
  if (!link?.autoReceipts) return;
  const receipt = await tx.receipt.findUnique({ where: { orderId } });
  if (!receipt) return;
  await tx.telegramAutoDelivery.createMany({ data: [{ receiptId: receipt.receiptId, clientUserId }], skipDuplicates: true });
}

/** Persistent outbox: never coupled to payment transactions. No external queue dependency. */
export async function processAutoReceipts(limit = 10): Promise<void> {
  const now = new Date();
  const pending = await prisma.telegramAutoDelivery.findMany({
    where: { OR: [
      { status: "PENDING", nextAttemptAt: { lte: now } },
      { status: "RETRY", nextAttemptAt: { lte: now } },
      { status: "PROCESSING", lockedAt: { lt: new Date(now.getTime() - 120_000) } },
    ] }, orderBy: { nextAttemptAt: "asc" }, take: Math.min(30, Math.max(1, limit)),
  });
  for (const row of pending) {
    const claim = await prisma.telegramAutoDelivery.updateMany({
      where: { receiptId: row.receiptId, status: row.status, attempts: row.attempts },
      data: { status: "PROCESSING", lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claim.count) continue;
    try {
      const [link, receipt] = await Promise.all([
        prisma.clientTelegramLink.findUnique({ where: { clientUserId: row.clientUserId } }),
        prisma.receipt.findUnique({ where: { receiptId: row.receiptId }, select: { orderId: true } }),
      ]);
      if (!link?.autoReceipts || !receipt) {
        await prisma.telegramAutoDelivery.update({ where: { receiptId: row.receiptId }, data: { status: "CANCELLED", lockedAt: null } });
        continue;
      }
      await deliverReceiptToChat({ orderId: receipt.orderId, chatId: link.telegramChatId, requestedByClientId: row.clientUserId });
      await prisma.telegramAutoDelivery.update({ where: { receiptId: row.receiptId },
        data: { status: "SENT", sentAt: new Date(), lockedAt: null, lastError: null } });
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.telegramAutoDelivery.update({ where: { receiptId: row.receiptId }, data: {
        status: attempts >= 5 ? "FAILED" : "RETRY", lockedAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** attempts)),
        lastError: (err instanceof AppError ? err.code : "TELEGRAM_DELIVERY_ERROR").slice(0, 300),
      } });
    }
  }
}

