import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { AppError, NotFoundError } from "../../lib/errors";
import { money, ZERO, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";
import { formatDateTimeAlmaty, RESTAURANT_TIME_ZONE } from "../../lib/time";
import { formatQuantityRu } from "../../lib/units";
import { getFiscalProvider } from "./fiscalProvider";

/**
 * FR-07 - receipts.
 *
 * A receipt is created ONCE, in the same transaction in which the payment becomes PAID, as an
 * immutable snapshot (a DB trigger forbids changing the snapshot columns). Repeating a GET, a page
 * refresh or a retried request returns the same receipt and the same number - the number comes from a
 * sequence and `receipts.order_id` is unique.
 *
 * Nothing here claims to be a legally valid fiscal document: without a configured provider the receipt
 * is kind = DEMO, fiscal_status = NOT_CONFIGURED, and says so on its face.
 */

export const DEMO_RECEIPT_MESSAGE = "Демонстрационный нефискальный чек - не предназначен для проверки в ОФД";
const NOT_CONFIGURED = "Не настроено (DEMO)";

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  KASPI_QR: "Kaspi QR (демо-симуляция)",
  CASH: "Наличные",
};

export interface ReceiptLine {
  lineNo: number;
  name: string;
  /** variants: changed composition ("Сыр: 60 г вместо 40 г", "Лук: убрать") and chosen options */
  details: string[];
  quantity: number;
  unit: string;
  unitPrice: string;
  lineTotal: string;
  nktCode: string | null;
  nktLabel: string;
}

export interface ReceiptPayload {
  schemaVersion: 1;
  receiptNumber: string;
  kind: "DEMO" | "FISCAL";
  orderId: string;
  tableNumber: number | null;
  issuedAt: string;
  paidAt: string;
  paidAtLocal: string;
  timeZone: string;
  merchant: { name: string; address: string; taxId: string; kkmSerial: string; kkmRegNumber: string };
  ofdName: string | null;
  ofdUrl: string | null;
  ofdLabel: string;
  items: ReceiptLine[];
  subtotal: string;
  bonusDiscount: string;
  paidTotal: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  vat: { applicable: boolean; ratePercent: string | null; amount: string | null; label: string };
  fiscalSign: string | null;
  fiscalSignLabel: string;
  barcode: { type: "DEMO_ILLUSTRATION" | "PROVIDER"; value: string; note: string };
  message: string;
  /** true for orders paid before receipts existed: reconstructed from stored order data, not a payment-time snapshot */
  legacySnapshot?: boolean;
}

const orderForReceiptInclude = {
  table: { select: { tableNumber: true } },
  payments: { orderBy: { createdAt: "asc" as const } },
  items: {
    orderBy: { orderItemId: "asc" as const },
    include: {
      dish: { select: { name: true } },
      options: { include: { option: { select: { name: true } } }, orderBy: { orderItemOptionId: "asc" as const } },
      ingredients: { orderBy: { orderItemIngredientId: "asc" as const } },
    },
  },
} satisfies Prisma.OrderInclude;

type OrderForReceipt = Prisma.OrderGetPayload<{ include: typeof orderForReceiptInclude }>;

/** Pure: builds the frozen payload from an order that is already paid. Exported for unit tests. */
export function buildReceiptPayload(args: {
  order: OrderForReceipt;
  receiptNumber: string;
  paidAt: Date;
  paidAmount: Decimal;
  paymentMethod: string;
  issuedAt: Date;
  legacySnapshot: boolean;
  fiscal: { kind: "DEMO" | "FISCAL"; ofdName: string | null; fiscalSign: string | null; verificationUrl: string | null };
}): ReceiptPayload {
  const { order } = args;
  const merchant = env.merchant;

  const items: ReceiptLine[] = order.items.map((item, idx) => {
    const optionsPerServing = item.options.reduce((s, o) => s.plus(o.price.times(o.quantity)), ZERO);
    const unitPrice = item.price.plus(optionsPerServing);
    const details: string[] = [];
    for (const ing of item.ingredients) {
      if (ing.source !== "RECIPE") continue;
      if (ing.selectedPerServing.isZero() && !ing.basePerServing.isZero()) {
        details.push(`${ing.ingredientNameSnapshot}: убрать`);
      } else if (!ing.selectedPerServing.equals(ing.basePerServing)) {
        details.push(
          `${ing.ingredientNameSnapshot}: ${formatQuantityRu(ing.selectedPerServing, ing.unitSnapshot)} вместо ${formatQuantityRu(
            ing.basePerServing,
            ing.unitSnapshot,
          )} на порцию`,
        );
      }
    }
    for (const o of item.options) details.push(`+ ${o.option.name} ×${o.quantity}`);
    return {
      lineNo: idx + 1,
      name: item.dish.name,
      details,
      quantity: item.quantity,
      unit: "порц.",
      unitPrice: money(unitPrice),
      lineTotal: money(unitPrice.times(item.quantity)),
      nktCode: null,
      nktLabel: NOT_CONFIGURED,
    };
  });

  const vatPercent = merchant.vatRatePercent;
  const vat = vatPercent
    ? (() => {
        const rate = new Prisma.Decimal(vatPercent);
        // VAT included in the paid price: paid * rate / (100 + rate)
        const amount = args.paidAmount.times(rate).dividedBy(rate.plus(100));
        return { applicable: true, ratePercent: rate.toFixed(), amount: money(amount), label: `НДС ${rate.toFixed()}%` };
      })()
    : { applicable: false, ratePercent: null, amount: null, label: "НДС: не указан (DEMO, ставка не настроена)" };

  const isFiscal = args.fiscal.kind === "FISCAL";
  return {
    schemaVersion: 1,
    receiptNumber: args.receiptNumber,
    kind: args.fiscal.kind,
    orderId: order.orderId.toString(),
    tableNumber: order.table?.tableNumber ?? null,
    issuedAt: args.issuedAt.toISOString(),
    paidAt: args.paidAt.toISOString(),
    paidAtLocal: formatDateTimeAlmaty(args.paidAt),
    timeZone: RESTAURANT_TIME_ZONE,
    merchant: {
      name: merchant.name,
      address: merchant.address,
      taxId: merchant.taxId,
      kkmSerial: merchant.kkmSerial,
      kkmRegNumber: merchant.kkmRegNumber,
    },
    ofdName: args.fiscal.ofdName,
    ofdUrl: args.fiscal.verificationUrl,
    ofdLabel: args.fiscal.ofdName ?? "Отсутствует",
    items,
    subtotal: money(order.subtotal),
    bonusDiscount: money(order.discountBonus),
    paidTotal: money(args.paidAmount),
    paymentMethod: args.paymentMethod,
    paymentMethodLabel: PAYMENT_METHOD_LABELS[args.paymentMethod] ?? args.paymentMethod,
    vat,
    fiscalSign: args.fiscal.fiscalSign,
    fiscalSignLabel: args.fiscal.fiscalSign ?? "Не присвоен",
    barcode: isFiscal
      ? { type: "PROVIDER", value: args.fiscal.verificationUrl ?? args.receiptNumber, note: "Код проверки от оператора" }
      : {
          type: "DEMO_ILLUSTRATION",
          value: args.receiptNumber,
          note: "Иллюстрация. Не является QR-кодом проверки в ОФД",
        },
    message: isFiscal ? "" : DEMO_RECEIPT_MESSAGE,
    ...(args.legacySnapshot ? { legacySnapshot: true } : {}),
  };
}

export function formatReceiptNumber(sequenceValue: bigint, kind: "DEMO" | "FISCAL"): string {
  return `${kind === "DEMO" ? "DEMO" : "FISC"}-${sequenceValue.toString().padStart(6, "0")}`;
}

/**
 * Creates the receipt of a PAID order inside `tx` (or returns the existing one). Safe to call from the
 * payment transition and, lazily, for orders paid before this feature existed.
 */
export async function ensureReceipt(tx: Tx, orderId: bigint, opts: { legacySnapshot?: boolean } = {}) {
  const existing = await tx.receipt.findUnique({ where: { orderId } });
  if (existing) return existing;

  const order = await tx.order.findUnique({ where: { orderId }, include: orderForReceiptInclude });
  if (!order) throw new NotFoundError("Order");
  const payment = order.payments.find((p) => p.status === "PAID");
  if (!payment || order.paymentStatus !== "PAID") {
    throw new AppError(409, "PAYMENT_NOT_SETTLED", "Чек будет доступен после оплаты заказа");
  }
  const paidAt = payment.paidAt ?? new Date();

  const provider = getFiscalProvider();
  const seq = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT nextval('receipt_number_seq') AS "n"`);
  const sequenceValue = seq[0]?.n;
  if (sequenceValue === undefined) throw new Error("receipt_number_seq returned no value");

  // Ask the provider first (demo: instant, no I/O) to learn the kind, then freeze the payload.
  const provisionalNumber = formatReceiptNumber(sequenceValue, "DEMO");
  const fiscal = await provider.issue({
    orderId,
    receiptNumber: provisionalNumber,
    paidTotal: money(payment.amount),
    paidAt,
    payload: {},
  });
  const receiptNumber = formatReceiptNumber(sequenceValue, fiscal.kind);
  const issuedAt = new Date();
  const payload = buildReceiptPayload({
    order,
    receiptNumber,
    paidAt,
    paidAmount: payment.amount,
    paymentMethod: payment.method,
    issuedAt,
    legacySnapshot: opts.legacySnapshot ?? false,
    fiscal: {
      kind: fiscal.kind,
      ofdName: fiscal.ofdName,
      fiscalSign: fiscal.fiscalSign,
      verificationUrl: fiscal.verificationUrl,
    },
  });

  // Sanity: the receipt can never disagree with the money that really moved.
  const linesSum = payload.items.reduce((s, i) => s.plus(i.lineTotal), ZERO);
  if (!linesSum.equals(order.subtotal) || !new Prisma.Decimal(payload.paidTotal).equals(payment.amount)) {
    throw new AppError(
      500,
      "RECEIPT_INCONSISTENT",
      "Сумма чека не совпадает с суммой заказа/платежа. Обратитесь к администратору.",
      { orderId: orderId.toString() },
    );
  }

  await tx.receipt.createMany({
    data: [
      {
        orderId,
        receiptNumber,
        kind: fiscal.kind,
        payloadJson: payload as unknown as Prisma.InputJsonObject,
        issuedAt,
        fiscalStatus: fiscal.fiscalStatus,
        fiscalReference: fiscal.fiscalReference,
        verificationUrl: fiscal.verificationUrl,
      },
    ],
    skipDuplicates: true,
  });
  return tx.receipt.findUniqueOrThrow({ where: { orderId } });
}

export type ReceiptView = {
  receiptId: bigint;
  orderId: string;
  fiscalStatus: string;
  fiscalReference: string | null;
  verificationUrl: string | null;
  [key: string]: unknown;
};

/** The public shape of a receipt (TZ §5.4): the frozen payload + receipt metadata. */
export function toReceiptView(receipt: Prisma.ReceiptGetPayload<object>): ReceiptView {
  const payload = receipt.payloadJson as unknown as ReceiptPayload;
  return {
    ...payload,
    receiptId: receipt.receiptId,
    orderId: receipt.orderId.toString(),
    kind: receipt.kind,
    receiptNumber: receipt.receiptNumber,
    issuedAt: receipt.issuedAt.toISOString(),
    fiscalStatus: receipt.fiscalStatus,
    fiscalReference: receipt.fiscalReference,
    verificationUrl: receipt.verificationUrl,
  };
}

/**
 * GET /api/orders/:orderId/receipt. A CASH order that is still WAITING_FOR_CASH has no receipt
 * (PAYMENT_NOT_SETTLED). A PAID order from before receipts existed gets one lazily, flagged
 * `legacySnapshot` - its content is reconstructed from stored order data, not a payment-time snapshot.
 */
export async function getReceiptForOrder(orderId: bigint): Promise<ReceiptView> {
  const order = await prisma.order.findUnique({
    where: { orderId },
    select: { orderId: true, paymentStatus: true, receipt: { select: { receiptId: true } } },
  });
  if (!order) throw new NotFoundError("Order");
  if (order.paymentStatus !== "PAID") {
    // An unpaid CASH order has an accessible preliminary bill, not a fiscal receipt.
    // This is computed from the frozen order lines; there is NO receipt row or fake fiscal number.
    const pending = await prisma.order.findUniqueOrThrow({ where: { orderId }, include: orderForReceiptInclude });
    const cashPayment = pending.payments.find((payment) => payment.method === "CASH" && payment.status === "WAITING_FOR_CASH");
    if (!cashPayment || pending.orderStatus === "CANCELLED") {
      throw new AppError(409, "PAYMENT_NOT_SETTLED", "Заказ ещё не оплачен - чек появится после оплаты");
    }
    const preview = buildReceiptPayload({
      order: pending,
      receiptNumber: `ORDER-${orderId}`,
      paidAt: pending.createdAt, // display labels replace this with order creation time
      paidAmount: cashPayment.amount,
      paymentMethod: "CASH",
      issuedAt: pending.createdAt,
      legacySnapshot: false,
      fiscal: { kind: "DEMO", ofdName: null, fiscalSign: null, verificationUrl: null },
    });
    return {
      ...preview,
      receiptId: 0n,
      kind: "PREVIEW",
      receiptNumber: `ORDER-${orderId}`,
      paymentStatus: "WAITING_FOR_CASH",
      isPaymentPreview: true,
      fiscalStatus: "NOT_PAID",
      fiscalReference: null,
      verificationUrl: null,
      message: "Предварительный счёт - оплата наличными ещё не получена. Не является фискальным чеком.",
      barcode: null,
    };
  }
  if (!order.receipt) {
    await prisma.$transaction((tx) => ensureReceipt(tx, orderId, { legacySnapshot: true }));
  }
  const receipt = await prisma.receipt.findUnique({ where: { orderId } });
  if (!receipt) {
    throw new AppError(409, "RECEIPT_NOT_READY", "Чек ещё формируется, повторите через несколько секунд");
  }
  return toReceiptView(receipt);
}

/** Admin: recent receipts with delivery attempts (no personal data beyond masked destinations). */
export async function listReceipts(limit = 50) {
  const rows = await prisma.receipt.findMany({
    orderBy: { receiptId: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { dispatches: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
  return rows.map((r) => {
    const p = r.payloadJson as unknown as ReceiptPayload;
    return {
      receiptId: r.receiptId,
      orderId: r.orderId,
      receiptNumber: r.receiptNumber,
      kind: r.kind,
      fiscalStatus: r.fiscalStatus,
      issuedAt: r.issuedAt,
      paidTotal: p.paidTotal,
      bonusDiscount: p.bonusDiscount,
      paymentMethod: p.paymentMethod,
      legacySnapshot: p.legacySnapshot === true,
      dispatches: r.dispatches.map((d) => ({
        dispatchId: d.dispatchId,
        channel: d.channel,
        destinationMasked: d.destinationMasked,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        createdAt: d.createdAt,
        sentAt: d.sentAt,
      })),
    };
  });
}
