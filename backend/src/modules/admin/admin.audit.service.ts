import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { qtyStr, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";

/**
 * Read-only consistency audit of the stock books (TZ §FR-12). Uses plain SQL on the original inventory
 * tables only, so it also works before the v2 migration has been applied - which is exactly when the
 * migration's pre-flight guard tells the operator to run it.
 *
 * Invariants:
 *   0 <= reserved_quantity <= stock_quantity
 *   reserved_quantity == SUM(inventory_reservations.quantity WHERE status = 'RESERVED') per ingredient
 *   no RESERVED row belongs to an order that is already CANCELLED or DELIVERED
 */
export interface InventoryMismatch {
  ingredientId: string;
  name: string;
  unit: string;
  stock: string;
  reserved: string;
  reservedFromReservations: string;
  difference: string;
  problems: string[];
}

export async function auditInventory(db: Tx = prisma) {
  const rows = await db.$queryRaw<
    { ingredient_id: bigint; name: string; unit: string; stock: Decimal; reserved: Decimal; reserved_sum: Decimal }[]
  >(Prisma.sql`
    SELECT inv."ingredient_id", i."name", i."unit",
           inv."stock_quantity" AS "stock", inv."reserved_quantity" AS "reserved",
           COALESCE(SUM(r."quantity") FILTER (WHERE r."status" = 'RESERVED'), 0) AS "reserved_sum"
    FROM "inventory" inv
    JOIN "ingredients" i ON i."ingredient_id" = inv."ingredient_id"
    LEFT JOIN "inventory_reservations" r ON r."ingredient_id" = inv."ingredient_id"
    GROUP BY inv."ingredient_id", i."name", i."unit", inv."stock_quantity", inv."reserved_quantity"
    HAVING inv."reserved_quantity" <> COALESCE(SUM(r."quantity") FILTER (WHERE r."status" = 'RESERVED'), 0)
        OR inv."reserved_quantity" > inv."stock_quantity"
        OR inv."stock_quantity" < 0 OR inv."reserved_quantity" < 0
    ORDER BY inv."ingredient_id"`);

  const mismatches: InventoryMismatch[] = rows.map((r) => {
    const stock = new Prisma.Decimal(r.stock);
    const reserved = new Prisma.Decimal(r.reserved);
    const sum = new Prisma.Decimal(r.reserved_sum);
    const problems: string[] = [];
    if (!reserved.equals(sum)) problems.push("reserved_quantity не равен сумме активных резервов");
    if (reserved.gt(stock)) problems.push("reserved_quantity больше stock_quantity");
    if (stock.lt(0)) problems.push("отрицательный stock_quantity");
    if (reserved.lt(0)) problems.push("отрицательный reserved_quantity");
    return {
      ingredientId: r.ingredient_id.toString(),
      name: r.name,
      unit: r.unit,
      stock: qtyStr(stock),
      reserved: qtyStr(reserved),
      reservedFromReservations: qtyStr(sum),
      difference: qtyStr(reserved.minus(sum)),
      problems,
    };
  });

  const stale = await db.$queryRaw<
    { reservation_id: bigint; order_id: bigint; ingredient_id: bigint; quantity: Decimal; order_status: string }[]
  >(Prisma.sql`
    SELECT r."reservation_id", r."order_id", r."ingredient_id", r."quantity", o."order_status"
    FROM "inventory_reservations" r JOIN "orders" o ON o."order_id" = r."order_id"
    WHERE r."status" = 'RESERVED' AND o."order_status" IN ('CANCELLED', 'DELIVERED')
    ORDER BY r."reservation_id"`);

  return {
    ok: mismatches.length === 0 && stale.length === 0,
    mismatches,
    staleReservations: stale.map((r) => ({
      reservationId: r.reservation_id.toString(),
      orderId: r.order_id.toString(),
      ingredientId: r.ingredient_id.toString(),
      quantity: qtyStr(new Prisma.Decimal(r.quantity)),
      orderStatus: r.order_status,
    })),
  };
}

export interface RepairStep {
  ingredientId: string;
  name: string;
  unit: string;
  from: string;
  to: string;
}

/**
 * Plan (and optionally apply) the ONLY automatic repair that is provably safe: set reserved_quantity to the
 * sum of the still-RESERVED rows when that sum fits within stock. Anything else (reserved > stock, stale
 * rows of closed orders, negative numbers) needs a human decision and is only reported.
 * Never runs unless `apply` is true - the default is a dry run that changes nothing.
 */
export async function repairInventory(apply: boolean) {
  const audit = await auditInventory();
  const steps: RepairStep[] = [];
  const manual: string[] = [];

  for (const m of audit.mismatches) {
    const sum = new Prisma.Decimal(m.reservedFromReservations);
    const stock = new Prisma.Decimal(m.stock);
    if (sum.lte(stock) && m.problems.every((p) => p.includes("не равен сумме"))) {
      steps.push({ ingredientId: m.ingredientId, name: m.name, unit: m.unit, from: m.reserved, to: m.reservedFromReservations });
    } else {
      manual.push(`${m.name} (#${m.ingredientId}): ${m.problems.join("; ")} - требуется ручное решение`);
    }
  }
  for (const s of audit.staleReservations) {
    manual.push(`Резерв #${s.reservationId} заказа #${s.orderId} (${s.orderStatus}) всё ещё RESERVED - проверьте и освободите вручную`);
  }

  if (apply && steps.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const step of steps) {
        await tx.$executeRaw(
          Prisma.sql`UPDATE "inventory" SET "reserved_quantity" = ${step.to}::numeric WHERE "ingredient_id" = ${BigInt(step.ingredientId)}`,
        );
      }
    });
  }
  return { applied: apply && steps.length > 0, steps, manual };
}
