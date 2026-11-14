import { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { ZERO, qtyStr, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";
import { formatQuantityRu } from "../../lib/units";

/**
 * ТЗ §2: "available лучше рассчитывать системой, основываясь на: Recipe +
 * Inventory + Inventory_Reservations."
 *
 * "Free" stock for an ingredient is stock_quantity - reserved_quantity -
 * reservations already committed to other orders don't count as available
 * for a new one.
 *
 * TZ v2 changes (§FR-02/FR-08/FR-12):
 *  - a TRACKED dish with an empty recipe is UNAVAILABLE, never "free" - only an
 *    explicit `inventoryTracked = false` skips the stock check;
 *  - an inactive ingredient makes every dish that needs it unavailable;
 *  - reservation is ONE conditional UPDATE per ingredient (never read-then-write),
 *    in ascending ingredient-id order so concurrent checkouts cannot deadlock;
 *  - consuming / releasing flip the reservation row first with a conditional UPDATE,
 *    which both serialises concurrent attempts and makes them idempotent.
 */

// ============================================================================
// stock lookup + shortfalls
// ============================================================================

export interface StockEntry {
  ingredientId: bigint;
  name: string;
  unit: string;
  isActive: boolean;
  hasInventoryRow: boolean;
  free: Decimal;
}

export async function loadStockMap(db: Tx, ingredientIds: bigint[]): Promise<Map<string, StockEntry>> {
  const unique = [...new Set(ingredientIds.map((i) => i.toString()))].map((s) => BigInt(s));
  if (unique.length === 0) return new Map();
  const rows = await db.ingredient.findMany({
    where: { ingredientId: { in: unique } },
    include: { inventory: true },
  });
  return new Map(
    rows.map((r) => [
      r.ingredientId.toString(),
      {
        ingredientId: r.ingredientId,
        name: r.name,
        unit: r.unit,
        isActive: r.isActive,
        hasInventoryRow: r.inventory !== null,
        free: r.inventory ? r.inventory.stockQuantity.minus(r.inventory.reservedQuantity) : ZERO,
      },
    ]),
  );
}

export type ShortfallReason = "INSUFFICIENT" | "INGREDIENT_INACTIVE";

export interface Shortfall {
  ingredientId: bigint;
  ingredientName: string;
  unit: string;
  needed: Decimal;
  free: Decimal;
  reason: ShortfallReason;
}

/** Pure: compares needs with a stock map. An ingredient with no stock record has free = 0. */
export function findShortfalls(needs: Map<string, Decimal>, stock: Map<string, StockEntry>): Shortfall[] {
  const out: Shortfall[] = [];
  for (const [key, needed] of needs) {
    if (needed.lte(0)) continue;
    const entry = stock.get(key);
    if (!entry) {
      out.push({ ingredientId: BigInt(key), ingredientName: key, unit: "", needed, free: ZERO, reason: "INSUFFICIENT" });
    } else if (!entry.isActive) {
      out.push({
        ingredientId: entry.ingredientId,
        ingredientName: entry.name,
        unit: entry.unit,
        needed,
        free: entry.free,
        reason: "INGREDIENT_INACTIVE",
      });
    } else if (entry.free.lt(needed)) {
      out.push({
        ingredientId: entry.ingredientId,
        ingredientName: entry.name,
        unit: entry.unit,
        needed,
        free: entry.free,
        reason: "INSUFFICIENT",
      });
    }
  }
  return out;
}

export function shortfallMessage(s: Shortfall): string {
  if (s.reason === "INGREDIENT_INACTIVE") return `Ингредиент «${s.ingredientName}» временно недоступен`;
  return `Не хватает ингредиента «${s.ingredientName}»: нужно ${formatQuantityRu(s.needed, s.unit)}, доступно ${formatQuantityRu(
    Prisma.Decimal.max(s.free, 0),
    s.unit,
  )}`;
}

export function shortfallDetails(s: Shortfall) {
  return {
    ingredientId: s.ingredientId.toString(),
    ingredientName: s.ingredientName,
    unit: s.unit,
    needed: qtyStr(s.needed),
    free: qtyStr(Prisma.Decimal.max(s.free, 0)),
    reason: s.reason,
  };
}

/** Loads current stock and returns what is missing for `needs` (empty = everything is available). */
export async function checkNeeds(db: Tx, needs: Map<string, Decimal>): Promise<Shortfall[]> {
  if (needs.size === 0) return [];
  const stock = await loadStockMap(db, [...needs.keys()].map((k) => BigInt(k)));
  return findShortfalls(needs, stock);
}

/** Throws a 409 for the first shortfall (used for add-to-cart / quantity edits). */
export function throwIfShort(shortfalls: Shortfall[]): void {
  const first = shortfalls[0];
  if (!first) return;
  throw new AppError(
    409,
    first.reason === "INGREDIENT_INACTIVE" ? "DISH_UNAVAILABLE" : "INSUFFICIENT_INGREDIENTS",
    shortfallMessage(first),
    { ingredients: shortfalls.map(shortfallDetails) },
  );
}

// ============================================================================
// dish availability for the menu
// ============================================================================

export type DishUnavailableReason =
  | "DISH_INACTIVE"
  | "CATEGORY_INACTIVE"
  | "NO_RECIPE"
  | "INGREDIENT_INACTIVE"
  | "INSUFFICIENT_STOCK";

export interface DishAvailability {
  available: boolean;
  reason?: DishUnavailableReason;
  ingredientName?: string;
  message?: string;
}

/**
 * Batch availability for the menu screen (one set of queries for every dish shown).
 * Availability is evaluated for the DEFAULT recipe (1 serving); a personalised
 * configuration is checked separately (checkConfiguration / add-to-cart).
 */
export async function computeAvailabilityForDishes(
  db: Tx,
  dishIds: bigint[],
): Promise<Map<string, DishAvailability>> {
  const result = new Map<string, DishAvailability>();
  if (dishIds.length === 0) return result;

  const dishes = await db.dish.findMany({
    where: { dishId: { in: dishIds } },
    include: {
      category: { select: { isActive: true } },
      recipes: { include: { ingredient: { include: { inventory: true } } } },
    },
  });

  for (const dish of dishes) {
    const key = dish.dishId.toString();
    if (!dish.isActive) {
      result.set(key, { available: false, reason: "DISH_INACTIVE", message: "Блюдо недоступно" });
      continue;
    }
    if (!dish.category.isActive) {
      result.set(key, { available: false, reason: "CATEGORY_INACTIVE", message: "Категория недоступна" });
      continue;
    }
    if (!dish.inventoryTracked) {
      result.set(key, { available: true });
      continue;
    }
    if (dish.recipes.length === 0) {
      // A tracked dish with no recipe cannot be proven to be makeable.
      result.set(key, { available: false, reason: "NO_RECIPE", message: "Состав блюда не задан" });
      continue;
    }
    let verdict: DishAvailability = { available: true };
    for (const r of dish.recipes) {
      if (!r.ingredient.isActive) {
        verdict = {
          available: false,
          reason: "INGREDIENT_INACTIVE",
          ingredientName: r.ingredient.name,
          message: `Нет в наличии: ${r.ingredient.name}`,
        };
        break;
      }
      const inv = r.ingredient.inventory;
      const free = inv ? inv.stockQuantity.minus(inv.reservedQuantity) : ZERO;
      if (free.lt(r.quantity)) {
        verdict = {
          available: false,
          reason: "INSUFFICIENT_STOCK",
          ingredientName: r.ingredient.name,
          message: `Нет в наличии: ${r.ingredient.name}`,
        };
        break;
      }
    }
    result.set(key, verdict);
  }
  // ids that don't exist
  for (const id of dishIds) {
    if (!result.has(id.toString())) {
      result.set(id.toString(), { available: false, reason: "DISH_INACTIVE", message: "Блюдо недоступно" });
    }
  }
  return result;
}

// ============================================================================
// reservation / consumption / release
// ============================================================================

function byIngredientIdAsc(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Atomically reserves `needs`. Each ingredient is ONE conditional UPDATE
 *
 *   UPDATE inventory SET reserved = reserved + :need
 *   WHERE ingredient_id = :id AND stock - reserved >= :need  [AND ingredient is active]
 *
 * so two simultaneous checkouts can never both pass a stale "free >= need" read
 * (the TZ's example: stock 0.5 kg, orders for 0.15 + 0.40 -> exactly one succeeds).
 * Ascending id order keeps concurrent multi-ingredient reservations deadlock-free.
 * A refused ingredient raises 409 and the surrounding transaction rolls back every
 * earlier ingredient of the same checkout.
 */
export async function reserveNeeds(tx: Tx, needs: Map<string, Decimal>): Promise<void> {
  const keys = [...needs.keys()].sort(byIngredientIdAsc);
  for (const key of keys) {
    const need = needs.get(key) as Decimal;
    if (need.lte(0)) continue;
    const id = BigInt(key);
    const amount = need.toFixed();
    const updated = await tx.$executeRaw(
      Prisma.sql`UPDATE "inventory" inv
                 SET "reserved_quantity" = inv."reserved_quantity" + ${amount}::numeric
                 WHERE inv."ingredient_id" = ${id}
                   AND inv."stock_quantity" - inv."reserved_quantity" >= ${amount}::numeric
                   AND EXISTS (SELECT 1 FROM "ingredients" i WHERE i."ingredient_id" = inv."ingredient_id" AND i."is_active")`,
    );
    if (updated === 0) {
      const stock = await loadStockMap(tx, [id]);
      const shortfalls = findShortfalls(new Map([[key, need]]), stock);
      const shortfall: Shortfall = shortfalls[0] ?? {
        ingredientId: id,
        ingredientName: stock.get(key)?.name ?? key,
        unit: stock.get(key)?.unit ?? "",
        needed: need,
        free: ZERO,
        reason: "INSUFFICIENT",
      };
      throwIfShort([shortfall]);
    }
  }
}

/**
 * Turns an item's RESERVED rows into CONSUMED (stock and reserved both drop).
 * Flipping the reservation row first, conditionally, is what makes this safe
 * under concurrency and idempotent: a second attempt finds nothing RESERVED.
 * Returns how many reservation rows this call consumed.
 */
export async function consumeReservationsForItem(tx: Tx, orderItemId: bigint): Promise<number> {
  const rows = await tx.inventoryReservation.findMany({
    where: { orderItemId, status: "RESERVED" },
    orderBy: { ingredientId: "asc" },
  });
  let consumed = 0;
  for (const row of rows) {
    const flipped = await tx.inventoryReservation.updateMany({
      where: { reservationId: row.reservationId, status: "RESERVED" },
      data: { status: "CONSUMED", consumedAt: new Date() },
    });
    if (flipped.count === 0) continue; // somebody else consumed or released it first
    const amount = row.quantity.toFixed();
    const updated = await tx.$executeRaw(
      Prisma.sql`UPDATE "inventory"
                 SET "stock_quantity" = "stock_quantity" - ${amount}::numeric,
                     "reserved_quantity" = "reserved_quantity" - ${amount}::numeric
                 WHERE "ingredient_id" = ${row.ingredientId}
                   AND "reserved_quantity" >= ${amount}::numeric
                   AND "stock_quantity" >= ${amount}::numeric`,
    );
    if (updated === 0) {
      // Never silently continue: the books would no longer balance.
      throw new AppError(
        500,
        "INVENTORY_INCONSISTENT",
        "Остатки не сходятся с резервами. Обратитесь к администратору (npm run audit:inventory).",
        { ingredientId: row.ingredientId.toString(), reservationId: row.reservationId.toString() },
      );
    }
    consumed += 1;
  }
  return consumed;
}

/** Releases every still-RESERVED row of an order back to free stock (cancellation). */
export async function releaseReservationsForOrder(tx: Tx, orderId: bigint): Promise<number> {
  const rows = await tx.inventoryReservation.findMany({
    where: { orderId, status: "RESERVED" },
    orderBy: { ingredientId: "asc" },
  });
  let released = 0;
  for (const row of rows) {
    const flipped = await tx.inventoryReservation.updateMany({
      where: { reservationId: row.reservationId, status: "RESERVED" },
      data: { status: "RELEASED", releasedAt: new Date() },
    });
    if (flipped.count === 0) continue;
    const amount = row.quantity.toFixed();
    const updated = await tx.$executeRaw(
      Prisma.sql`UPDATE "inventory"
                 SET "reserved_quantity" = "reserved_quantity" - ${amount}::numeric
                 WHERE "ingredient_id" = ${row.ingredientId}
                   AND "reserved_quantity" >= ${amount}::numeric`,
    );
    if (updated === 0) {
      throw new AppError(
        500,
        "INVENTORY_INCONSISTENT",
        "Остатки не сходятся с резервами. Обратитесь к администратору (npm run audit:inventory).",
        { ingredientId: row.ingredientId.toString(), reservationId: row.reservationId.toString() },
      );
    }
    released += 1;
  }
  return released;
}
