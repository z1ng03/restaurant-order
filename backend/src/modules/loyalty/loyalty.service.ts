import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { AppError } from "../../lib/errors";
import { floorToInt, money, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";

/**
 * FR-06 - cashback.
 *
 *  - 1 bonus = 1 KZT, whole numbers only. Earn: 5 % of the MONEY actually paid, rounded DOWN.
 *    Spend: at most 50 % of the order, never more than the balance.
 *  - `loyalty_ledger` is append-only and is the source of truth; `client_users.bonus_balance` is a
 *    cache that is updated in the same transaction (a CHECK keeps it >= 0).
 *  - SPEND is written at checkout, so bonuses are blocked immediately - a CASH order that is still
 *    WAITING_FOR_CASH cannot have its bonuses spent a second time in a parallel order. If that order
 *    is cancelled, REFUND_SPEND returns them (exactly once).
 *  - EARN is written only when the payment really becomes PAID (demo Kaspi: at the backend
 *    confirmation; cash: in markCashReceived). A guest order never earns anything.
 *  - Every operation has a deterministic idempotency key and a unique (order_id, type), so a retried
 *    request / double click can never write it twice.
 */

export type LoyaltyPreview = {
  authenticated: boolean;
  balance: number;
  /** min(balance, floor(subtotal * cap)) */
  maxRedeem: number;
  /** bonuses that WILL be earned if the order is paid as previewed */
  earnPreview: number;
  /** bonuses the preview deducts (0 unless useCashback was requested) */
  discount: number;
  subtotal: string;
  payableTotal: string;
  cashbackRate: number;
  redemptionCap: number;
};

export function computeMaxRedeem(balance: number, subtotal: Decimal): number {
  const cap = floorToInt(subtotal.times(env.cashbackRedemptionCap));
  return Math.max(0, Math.min(balance, cap));
}

/** Earned on the money actually paid (after the bonus discount), rounded down. */
export function computeEarn(paidMoney: Decimal): number {
  if (paidMoney.lte(0)) return 0;
  return Math.max(0, floorToInt(paidMoney.times(env.cashbackRate)));
}

/** Balance = SUM of the ledger (the cache column is never trusted for decisions). */
export async function getBalance(db: Tx, clientUserId: bigint): Promise<number> {
  const rows = await db.$queryRaw<{ balance: number }[]>(
    Prisma.sql`SELECT COALESCE(SUM("amount"), 0)::int AS "balance" FROM "loyalty_ledger" WHERE "client_user_id" = ${clientUserId}`,
  );
  return Number(rows[0]?.balance ?? 0);
}

/**
 * Serialises everything that touches one client's balance. Take it BEFORE reading the balance in a
 * transaction that will spend: two parallel checkouts of the same client then run one after the
 * other and the second sees the first one's SPEND.
 */
export async function lockClient(tx: Tx, clientUserId: bigint): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "client_user_id" FROM "client_users" WHERE "client_user_id" = ${clientUserId} FOR UPDATE`);
}

export async function previewLoyalty(
  db: Tx,
  clientUserId: bigint | null,
  subtotal: Decimal,
  useCashback: boolean,
): Promise<LoyaltyPreview> {
  const base = {
    cashbackRate: env.cashbackRate,
    redemptionCap: env.cashbackRedemptionCap,
    subtotal: money(subtotal),
  };
  if (clientUserId === null) {
    return { authenticated: false, balance: 0, maxRedeem: 0, earnPreview: 0, discount: 0, payableTotal: money(subtotal), ...base };
  }
  const balance = await getBalance(db, clientUserId);
  const maxRedeem = computeMaxRedeem(balance, subtotal);
  const discount = useCashback ? maxRedeem : 0;
  const payable = subtotal.minus(discount);
  return {
    authenticated: true,
    balance,
    maxRedeem,
    earnPreview: computeEarn(payable),
    discount,
    payableTotal: money(payable),
    ...base,
  };
}

// ----------------------------------------------------------------------------
// ledger writes
// ----------------------------------------------------------------------------

async function insertLedger(
  tx: Tx,
  row: { clientUserId: bigint; orderId: bigint; type: string; amount: number; key: string; note: string },
): Promise<boolean> {
  // ON CONFLICT DO NOTHING covers both unique constraints (idempotency_key, (order_id, type)).
  const inserted = await tx.$queryRaw<{ ledger_id: bigint }[]>(
    Prisma.sql`INSERT INTO "loyalty_ledger" ("client_user_id","order_id","type","amount","note","idempotency_key")
               VALUES (${row.clientUserId}, ${row.orderId}, ${row.type}, ${row.amount}::int, ${row.note}, ${row.key})
               ON CONFLICT DO NOTHING
               RETURNING "ledger_id"`,
  );
  if (inserted.length === 0) return false;
  await tx.$executeRaw(
    Prisma.sql`UPDATE "client_users" SET "bonus_balance" = "bonus_balance" + ${row.amount}::int WHERE "client_user_id" = ${row.clientUserId}`,
  );
  return true;
}

/** Blocks `amount` bonuses for an order. The caller must already hold lockClient(). */
export async function spendBonuses(
  tx: Tx,
  args: { clientUserId: bigint; orderId: bigint; amount: number; paymentMethod: string },
): Promise<void> {
  if (args.amount <= 0) return;
  const balance = await getBalance(tx, args.clientUserId);
  if (args.amount > balance) {
    throw new AppError(409, "CASHBACK_INSUFFICIENT", "Недостаточно бонусов для списания", { balance });
  }
  const note =
    args.paymentMethod === "CASH"
      ? `Списано при оформлении заказа №${args.orderId}; бонусы заблокированы до оплаты наличными`
      : `Списано при оплате заказа №${args.orderId}`;
  await insertLedger(tx, {
    clientUserId: args.clientUserId,
    orderId: args.orderId,
    type: "SPEND",
    amount: -args.amount,
    key: `spend:${args.orderId}`,
    note,
  });
}

/** EARN for a PAID order. Returns the bonuses written (0 if none / already written). */
export async function earnBonuses(
  tx: Tx,
  args: { clientUserId: bigint; orderId: bigint; paidMoney: Decimal },
): Promise<number> {
  const amount = computeEarn(args.paidMoney);
  if (amount <= 0) return 0;
  const client = await tx.clientUser.findUnique({
    where: { clientUserId: args.clientUserId },
    select: { isActive: true, deletedAt: true },
  });
  if (!client || !client.isActive || client.deletedAt) return 0;
  const written = await insertLedger(tx, {
    clientUserId: args.clientUserId,
    orderId: args.orderId,
    type: "EARN",
    amount,
    key: `earn:${args.orderId}`,
    note: `Начислено за оплаченный заказ №${args.orderId}`,
  });
  return written ? amount : 0;
}

/** Gives back the bonuses blocked by a SPEND (once). */
export async function refundSpend(tx: Tx, orderId: bigint, reason: string): Promise<number> {
  const spend = await tx.loyaltyLedger.findUnique({ where: { orderId_type: { orderId, type: "SPEND" } } });
  if (!spend) return 0;
  const written = await insertLedger(tx, {
    clientUserId: spend.clientUserId,
    orderId,
    type: "REFUND_SPEND",
    amount: -spend.amount,
    key: `refund-spend:${orderId}`,
    note: `Возврат бонусов по заказу №${orderId}: ${reason}`,
  });
  return written ? -spend.amount : 0;
}

/**
 * Takes back the bonuses earned for an order that was paid and then refunded. A balance can
 * never go negative, so if the client already spent part of it only what is still there is
 * reversed; the uncovered part is reported (and visible in the loyalty audit).
 */
export async function reverseEarn(
  tx: Tx,
  orderId: bigint,
  reason: string,
): Promise<{ reversed: number; shortfall: number }> {
  const earn = await tx.loyaltyLedger.findUnique({ where: { orderId_type: { orderId, type: "EARN" } } });
  if (!earn) return { reversed: 0, shortfall: 0 };
  await lockClient(tx, earn.clientUserId);
  const balance = await getBalance(tx, earn.clientUserId);
  const reversible = Math.min(earn.amount, Math.max(0, balance));
  const shortfall = earn.amount - reversible;
  if (reversible > 0) {
    await insertLedger(tx, {
      clientUserId: earn.clientUserId,
      orderId,
      type: "REVERSE_EARN",
      amount: -reversible,
      key: `reverse-earn:${orderId}`,
      note: `Списание начисления по заказу №${orderId}: ${reason}${shortfall > 0 ? ` (часть бонусов уже потрачена: ${shortfall})` : ""}`,
    });
  }
  return { reversed: reversible, shortfall };
}

// ----------------------------------------------------------------------------
// reading
// ----------------------------------------------------------------------------

export const LEDGER_TYPE_LABELS: Record<string, string> = {
  EARN: "Начисление",
  SPEND: "Списание",
  REVERSE_EARN: "Отмена начисления",
  REFUND_SPEND: "Возврат списания",
};

export async function getLoyaltyHistory(clientUserId: bigint, opts: { limit?: number; cursor?: bigint | undefined } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const [balance, rows] = await Promise.all([
    getBalance(prisma, clientUserId),
    prisma.loyaltyLedger.findMany({
      where: { clientUserId, ...(opts.cursor ? { ledgerId: { lt: opts.cursor } } : {}) },
      orderBy: { ledgerId: "desc" },
      take: limit + 1,
    }),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    balance,
    entries: page.map((r) => ({
      ledgerId: r.ledgerId,
      orderId: r.orderId,
      type: r.type,
      typeLabel: LEDGER_TYPE_LABELS[r.type] ?? r.type,
      amount: r.amount,
      note: r.note,
      createdAt: r.createdAt,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.ledgerId ?? null) : null,
  };
}

/**
 * Read-only consistency report for the admin panel: cache vs ledger per client and the order-level
 * invariants. Nothing here changes data.
 */
export async function auditLoyalty(db: Tx = prisma) {
  const cacheMismatch = await db.$queryRaw<{ client_user_id: bigint; cache: number; ledger: number }[]>(
    Prisma.sql`SELECT c."client_user_id", c."bonus_balance" AS "cache", COALESCE(SUM(l."amount"), 0)::int AS "ledger"
               FROM "client_users" c LEFT JOIN "loyalty_ledger" l ON l."client_user_id" = c."client_user_id"
               GROUP BY c."client_user_id", c."bonus_balance"
               HAVING c."bonus_balance" <> COALESCE(SUM(l."amount"), 0)`,
  );
  const spendNotRefundedOnCancelled = await db.$queryRaw<{ order_id: bigint; spent: number }[]>(
    Prisma.sql`SELECT s."order_id", -s."amount" AS "spent"
               FROM "loyalty_ledger" s JOIN "orders" o ON o."order_id" = s."order_id"
               WHERE s."type" = 'SPEND' AND o."order_status" = 'CANCELLED' AND o."payment_status" <> 'PAID'
                 AND NOT EXISTS (SELECT 1 FROM "loyalty_ledger" r WHERE r."order_id" = s."order_id" AND r."type" = 'REFUND_SPEND')`,
  );
  const earnWithoutPaidPayment = await db.$queryRaw<{ order_id: bigint }[]>(
    Prisma.sql`SELECT e."order_id" FROM "loyalty_ledger" e JOIN "orders" o ON o."order_id" = e."order_id"
               WHERE e."type" = 'EARN' AND o."payment_status" <> 'PAID'`,
  );
  const partialReversals = await db.$queryRaw<{ order_id: bigint; earned: number; reversed: number }[]>(
    Prisma.sql`SELECT e."order_id", e."amount" AS "earned", COALESCE(-r."amount", 0) AS "reversed"
               FROM "loyalty_ledger" e LEFT JOIN "loyalty_ledger" r ON r."order_id" = e."order_id" AND r."type" = 'REVERSE_EARN'
               WHERE e."type" = 'EARN' AND EXISTS (SELECT 1 FROM "payments" p WHERE p."order_id" = e."order_id" AND p."refund_status" = 'REFUND_REQUIRED')
                 AND COALESCE(-r."amount", 0) < e."amount"`,
  );
  return {
    cacheMismatch: cacheMismatch.map((r) => ({ clientUserId: r.client_user_id.toString(), cache: r.cache, ledger: r.ledger })),
    spendNotRefundedOnCancelledOrders: spendNotRefundedOnCancelled.map((r) => ({ orderId: r.order_id.toString(), spent: r.spent })),
    earnWithoutPaidPayment: earnWithoutPaidPayment.map((r) => ({ orderId: r.order_id.toString() })),
    partialEarnReversals: partialReversals.map((r) => ({ orderId: r.order_id.toString(), earned: r.earned, reversed: r.reversed })),
    ok:
      cacheMismatch.length === 0 &&
      spendNotRefundedOnCancelled.length === 0 &&
      earnWithoutPaidPayment.length === 0,
  };
}

