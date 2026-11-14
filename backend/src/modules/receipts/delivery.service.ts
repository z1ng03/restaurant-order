import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { AppError } from "../../lib/errors";
import { getReceiptForOrder, type ReceiptPayload } from "./receipts.service";

/**
 * Receipt delivery (FR-07): e-mail and Telegram.
 *
 * - Only the OWNER of a PAID order can request it; the destination always comes from the account
 *   (its e-mail / its verified Telegram link) - a request can never name another address or chat id.
 * - Every attempt is logged in receipt_dispatches (masked destination, status, attempts, a short error).
 * - A provider that is not configured answers 503 DELIVERY_PROVIDER_NOT_CONFIGURED, a failed send 502
 *   RECEIPT_SEND_FAILED - never a fake success. Delivery has NO connection to payments: a failure here
 *   can never trigger another charge, and a retry is just a new delivery attempt of the SAME receipt.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<void>;
}

export interface TelegramSender {
  isConfigured(): boolean;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendInteractive?(chatId: string, text: string, keyboard: TelegramKeyboard): Promise<void>;
  answerCallback?(callbackId: string): Promise<void>;
}

export type TelegramKeyboard = Array<Array<{ text: string; callback_data?: string; url?: string }>>;

async function telegramApi(method: string, body: Record<string, unknown>): Promise<void> {
  if (!env.telegram.botToken) throw new Error("Telegram is not configured");
  const res = await fetch(`https://api.telegram.org/bot${env.telegram.botToken}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram API HTTP ${res.status}`);
  const json = (await res.json()) as { ok?: boolean };
  if (!json.ok) throw new Error("Telegram API returned ok=false");
}

class SmtpEmailSender implements EmailSender {
  isConfigured(): boolean {
    return Boolean(env.smtp.host && env.smtp.from);
  }

  async send(message: EmailMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await transport.sendMail({ from: env.smtp.from, ...message });
  }
}

class TelegramBotSender implements TelegramSender {
  isConfigured(): boolean {
    return Boolean(env.telegram.botToken);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await telegramApi("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }

  async sendInteractive(chatId: string, text: string, keyboard: TelegramKeyboard): Promise<void> {
    await telegramApi("sendMessage", {
      chat_id: chatId, text, disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async answerCallback(callbackId: string): Promise<void> {
    await telegramApi("answerCallbackQuery", { callback_query_id: callbackId });
  }
}

let emailSender: EmailSender = new SmtpEmailSender();
let telegramSender: TelegramSender = new TelegramBotSender();

/** Test seams (and the composition root, should another transport ever replace these). */
export function setEmailSender(sender: EmailSender): void {
  emailSender = sender;
}
export function setTelegramSender(sender: TelegramSender): void {
  telegramSender = sender;
}
/** Transport is replaceable in tests; failure is visible to callers (not a fake success). */
export async function sendTelegramInteractive(chatId: string, text: string, keyboard: TelegramKeyboard = []): Promise<void> {
  if (!telegramSender.isConfigured()) throw new Error("Telegram is not configured");
  // Telegram limits message text to 4096 characters. Split long receipts without dropping lines.
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 3900) {
    const end = remaining.lastIndexOf("\n", 3900);
    const splitAt = end > 1500 ? end + 1 : 3900;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining || " ");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (i === chunks.length - 1 && keyboard.length && telegramSender.sendInteractive) {
      await telegramSender.sendInteractive(chatId, chunk, keyboard);
    } else {
      await telegramSender.sendMessage(chatId, chunk);
    }
  }
}

export async function answerTelegramCallback(callbackId: string): Promise<void> {
  if (telegramSender.answerCallback) {
    try { await telegramSender.answerCallback(callbackId); } catch { /* callback may already be expired */ }
  }
}

export async function deliverReceiptToChat(args: {
  orderId: bigint; chatId: string; requestedByClientId?: bigint;
}): Promise<DeliveryResult> {
  const view = await getReceiptForOrder(args.orderId);
  if (view.isPaymentPreview) {
    throw new AppError(409, "PAYMENT_NOT_SETTLED", "Чек доступен только после оплаты");
  }
  const masked = `Telegram ···${args.chatId.slice(-3)}`;
  const dispatch = await prisma.receiptDispatch.create({
    data: { receiptId: view.receiptId, channel: "TELEGRAM", destinationMasked: masked,
      status: telegramSender.isConfigured() ? "PENDING" : "NOT_CONFIGURED",
      requestedByClientId: args.requestedByClientId ?? null },
  });
  if (!telegramSender.isConfigured()) throw new AppError(503, "DELIVERY_PROVIDER_NOT_CONFIGURED", "Telegram не настроен");
  try {
    await sendTelegramInteractive(args.chatId, renderReceiptText(view as unknown as ReceiptPayload));
    await prisma.receiptDispatch.update({ where: { dispatchId: dispatch.dispatchId },
      data: { status: "SENT", attempts: 1, sentAt: new Date() } });
    return { dispatchId: dispatch.dispatchId, channel: "TELEGRAM", destinationMasked: masked, status: "SENT" };
  } catch (err) {
    await prisma.receiptDispatch.update({ where: { dispatchId: dispatch.dispatchId },
      data: { status: "FAILED", attempts: 1, lastError: safeError(err) } });
    throw new AppError(502, "RECEIPT_SEND_FAILED", "Не удалось доставить чек в Telegram");
  }
}

export function isTelegramConfigured(): boolean {
  return telegramSender.isConfigured();
}

/** Best-effort bot reply (e.g. "account linked"). A failure here must never fail the webhook. */
export async function notifyTelegram(chatId: string, text: string): Promise<void> {
  if (!telegramSender.isConfigured()) return;
  try {
    await telegramSender.sendMessage(chatId, text);
  } catch {
    /* ignored on purpose */
  }
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const [host = "", ...tld] = domain.split(".");
  const m = (s: string) => (s.length <= 1 ? "*" : `${s[0]}***`);
  return `${m(local)}@${m(host)}${tld.length ? "." + tld.join(".") : ""}`;
}

// ----------------------------------------------------------------------------
// rendering
// ----------------------------------------------------------------------------

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderReceiptText(p: ReceiptPayload): string {
  const lines: string[] = [];
  lines.push(p.merchant.name, p.merchant.address, `БИН/ИИН: ${p.merchant.taxId}`);
  lines.push(`ККМ: ${p.merchant.kkmSerial} / рег. № ${p.merchant.kkmRegNumber}`);
  lines.push("", `Чек № ${p.receiptNumber}  (заказ №${p.orderId})`, `Оплата: ${p.paidAtLocal} (${p.timeZone})`, "");
  for (const it of p.items) {
    lines.push(`${it.lineNo}. ${it.name}`);
    for (const d of it.details) lines.push(`   ${d}`);
    lines.push(`   ${it.quantity} ${it.unit} × ${it.unitPrice} = ${it.lineTotal} ₸   (НКТ: ${it.nktLabel})`);
  }
  lines.push("", `Сумма: ${p.subtotal} ₸`, `Скидка бонусами: ${p.bonusDiscount} ₸`, `К оплате/оплачено: ${p.paidTotal} ₸`);
  lines.push(`Способ оплаты: ${p.paymentMethodLabel}`, p.vat.label);
  lines.push(`ОФД: ${p.ofdLabel}`, `Фискальный признак: ${p.fiscalSignLabel}`);
  if (p.message) lines.push("", p.message);
  return lines.join("\n");
}

export function renderReceiptHtml(p: ReceiptPayload): string {
  const rows = p.items
    .map(
      (it) =>
        `<tr><td>${it.lineNo}. ${escapeHtml(it.name)}${it.details.map((d) => `<br><small>${escapeHtml(d)}</small>`).join("")}</td>` +
        `<td style="text-align:right;white-space:nowrap">${it.quantity} ${escapeHtml(it.unit)} × ${escapeHtml(it.unitPrice)}</td>` +
        `<td style="text-align:right;white-space:nowrap">${escapeHtml(it.lineTotal)} ₸</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="ru"><body style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
<h2 style="margin-bottom:0">${escapeHtml(p.merchant.name)}</h2>
<div>${escapeHtml(p.merchant.address)}</div>
<div>БИН/ИИН: ${escapeHtml(p.merchant.taxId)}</div>
<div>ККМ: ${escapeHtml(p.merchant.kkmSerial)} / рег. № ${escapeHtml(p.merchant.kkmRegNumber)}</div>
<p><b>Чек № ${escapeHtml(p.receiptNumber)}</b> (заказ №${escapeHtml(p.orderId)})<br>Оплата: ${escapeHtml(p.paidAtLocal)} (${escapeHtml(p.timeZone)})</p>
<table style="width:100%;border-collapse:collapse" cellpadding="4">${rows}</table>
<hr>
<div>Сумма: ${escapeHtml(p.subtotal)} ₸</div>
<div>Скидка бонусами: ${escapeHtml(p.bonusDiscount)} ₸</div>
<div><b>Оплачено: ${escapeHtml(p.paidTotal)} ₸</b></div>
<div>Способ оплаты: ${escapeHtml(p.paymentMethodLabel)}</div>
<div>${escapeHtml(p.vat.label)}</div>
<div>ОФД: ${escapeHtml(p.ofdLabel)} · Фискальный признак: ${escapeHtml(p.fiscalSignLabel)}</div>
${p.message ? `<p style="color:#a33"><b>${escapeHtml(p.message)}</b></p>` : ""}
</body></html>`;
}

// ----------------------------------------------------------------------------
// sending
// ----------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // never persist anything that could contain a credential
  return text.replace(/(pass(word)?|token|secret)[^\s,;]*/gi, "[hidden]").slice(0, 300);
}

async function assertOwnedOrder(orderId: bigint, clientUserId: bigint) {
  const order = await prisma.order.findUnique({ where: { orderId }, select: { orderId: true, clientUserId: true } });
  if (!order || order.clientUserId === null || order.clientUserId !== clientUserId) {
    throw new AppError(404, "ORDER_NOT_OWNED", "Заказ не найден");
  }
}

export interface DeliveryResult {
  dispatchId: bigint;
  channel: "EMAIL" | "TELEGRAM";
  destinationMasked: string;
  status: "SENT";
}

export async function sendReceiptByEmail(args: {
  clientUserId: bigint;
  orderId: bigint;
  requestedEmail?: string | undefined;
}): Promise<DeliveryResult> {
  await assertOwnedOrder(args.orderId, args.clientUserId);
  const receipt = await getReceiptForOrder(args.orderId); // 409 PAYMENT_NOT_SETTLED until PAID

  const client = await prisma.clientUser.findUnique({ where: { clientUserId: args.clientUserId } });
  const accountEmail = client?.email ?? null;
  if (!accountEmail) {
    throw new AppError(400, "EMAIL_NOT_SET", "В учётной записи нет адреса электронной почты");
  }
  if (args.requestedEmail && args.requestedEmail.trim().toLowerCase() !== accountEmail) {
    // There is no e-mail ownership verification flow, so a receipt may only go to the address of the account itself.
    throw new AppError(400, "RECIPIENT_NOT_VERIFIED", "Чек можно отправить только на адрес вашей учётной записи");
  }

  const masked = maskEmail(accountEmail);
  const dispatch = await prisma.receiptDispatch.create({
    data: {
      receiptId: receipt.receiptId,
      channel: "EMAIL",
      destinationMasked: masked,
      status: emailSender.isConfigured() ? "PENDING" : "NOT_CONFIGURED",
      requestedByClientId: args.clientUserId,
    },
  });
  if (!emailSender.isConfigured()) {
    throw new AppError(503, "DELIVERY_PROVIDER_NOT_CONFIGURED", "Отправка по e-mail не настроена на сервере", {
      channel: "EMAIL",
    });
  }

  const payload = receipt as unknown as ReceiptPayload;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await emailSender.send({
        to: accountEmail,
        subject: `Чек ${payload.receiptNumber} - ${payload.merchant.name}`,
        text: renderReceiptText(payload),
        html: renderReceiptHtml(payload),
      });
      await prisma.receiptDispatch.update({
        where: { dispatchId: dispatch.dispatchId },
        data: { status: "SENT", attempts: attempt, sentAt: new Date(), lastError: null },
      });
      return { dispatchId: dispatch.dispatchId, channel: "EMAIL", destinationMasked: masked, status: "SENT" };
    } catch (err) {
      lastError = err;
      await prisma.receiptDispatch.update({
        where: { dispatchId: dispatch.dispatchId },
        data: { status: "FAILED", attempts: attempt, lastError: safeError(err) },
      });
    }
  }
  throw new AppError(502, "RECEIPT_SEND_FAILED", "Не удалось отправить чек на почту. Попробуйте позже.", {
    channel: "EMAIL",
    reason: safeError(lastError),
  });
}

export async function sendReceiptByTelegram(args: { clientUserId: bigint; orderId: bigint }): Promise<DeliveryResult> {
  await assertOwnedOrder(args.orderId, args.clientUserId);
  const receipt = await getReceiptForOrder(args.orderId);

  // The chat id comes ONLY from the account's verified link - never from the request.
  const link = await prisma.clientTelegramLink.findUnique({ where: { clientUserId: args.clientUserId } });
  if (!link) {
    throw new AppError(409, "TELEGRAM_NOT_LINKED", "Telegram не привязан. Привяжите его в профиле.", { linkRequired: true });
  }
  const masked = `Telegram ···${link.telegramChatId.slice(-3)}`;
  const configured = telegramSender.isConfigured();
  const dispatch = await prisma.receiptDispatch.create({
    data: {
      receiptId: receipt.receiptId,
      channel: "TELEGRAM",
      destinationMasked: masked,
      status: configured ? "PENDING" : "NOT_CONFIGURED",
      requestedByClientId: args.clientUserId,
    },
  });
  if (!configured) {
    throw new AppError(503, "DELIVERY_PROVIDER_NOT_CONFIGURED", "Отправка в Telegram не настроена на сервере", {
      channel: "TELEGRAM",
    });
  }

  const payload = receipt as unknown as ReceiptPayload;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await telegramSender.sendMessage(link.telegramChatId, renderReceiptText(payload));
      await prisma.receiptDispatch.update({
        where: { dispatchId: dispatch.dispatchId },
        data: { status: "SENT", attempts: attempt, sentAt: new Date(), lastError: null },
      });
      return { dispatchId: dispatch.dispatchId, channel: "TELEGRAM", destinationMasked: masked, status: "SENT" };
    } catch (err) {
      lastError = err;
      await prisma.receiptDispatch.update({
        where: { dispatchId: dispatch.dispatchId },
        data: { status: "FAILED", attempts: attempt, lastError: safeError(err) },
      });
    }
  }
  throw new AppError(502, "RECEIPT_SEND_FAILED", "Не удалось отправить чек в Telegram. Попробуйте позже.", {
    channel: "TELEGRAM",
    reason: safeError(lastError),
  });
}
