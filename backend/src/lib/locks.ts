import { Prisma } from "@prisma/client";
import { NotFoundError } from "./errors";
import type { Tx } from "./prismaTx";

/**
 * Row lock on an order. Kitchen transitions, waiter actions and admin cancellation all take it first, so
 * "start cooking" racing "cancel" (or a double click on the same button) resolves to exactly ONE outcome:
 * the loser waits, then re-reads the state and either no-ops (same transition) or answers 409.
 *
 * Lock order used everywhere (prevents deadlocks): order row -> reservation rows -> inventory rows in
 * ascending ingredient id. Checkout never locks an existing order row (it creates a new one).
 */
export async function lockOrderRow(tx: Tx, orderId: bigint): Promise<void> {
  const rows = await tx.$queryRaw<{ order_id: bigint }[]>(
    Prisma.sql`SELECT "order_id" FROM "orders" WHERE "order_id" = ${orderId} FOR UPDATE`,
  );
  if (rows.length === 0) throw new NotFoundError("Order");
}
