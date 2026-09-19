import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";

/**
 * ТЗ §2: "available лучше рассчитывать системой, основываясь на: Recipe +
 * Inventory + Inventory_Reservations. То есть: available = все необходимые
 * ингредиенты доступны в достаточном количестве."
 *
 * "Free" stock for an ingredient is stock_quantity - reserved_quantity —
 * reservations already committed to other orders don't count as available
 * for a new one.
 */

export interface IngredientNeed {
  ingredientId: bigint;
  quantity: Prisma.Decimal;
}

/** Ingredients required for `quantity` units of one dish, from its recipe. */
export async function getDishIngredientNeeds(dishId: bigint, quantity: number): Promise<IngredientNeed[]> {
  const recipes = await prisma.recipe.findMany({ where: { dishId } });
  return recipes.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity.times(quantity) }));
}

/** Ingredients required for `quantity` units of one chosen dish option. */
export async function getOptionIngredientNeeds(optionId: bigint, quantity: number): Promise<IngredientNeed[]> {
  const rows = await prisma.dishOptionIngredient.findMany({ where: { optionId } });
  return rows.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity.times(quantity) }));
}

/** Merges several ingredient-need lists into one map of ingredientId -> total needed. */
export function sumIngredientNeeds(lists: IngredientNeed[][]): Map<string, IngredientNeed> {
  const totals = new Map<string, IngredientNeed>();
  for (const list of lists) {
    for (const need of list) {
      const key = need.ingredientId.toString();
      const existing = totals.get(key);
      totals.set(key, {
        ingredientId: need.ingredientId,
        quantity: existing ? existing.quantity.plus(need.quantity) : need.quantity,
      });
    }
  }
  return totals;
}

export interface InsufficientIngredient {
  ingredientId: bigint;
  ingredientName: string;
  unit: string;
  needed: Prisma.Decimal;
  free: Prisma.Decimal;
}

/**
 * Compares a set of total ingredient needs against current free stock
 * (stock_quantity - reserved_quantity). Returns the ones that don't have
 * enough — an empty array means everything needed is available.
 */
export async function findInsufficientIngredients(
  needs: Map<string, IngredientNeed>,
): Promise<InsufficientIngredient[]> {
  if (needs.size === 0) return [];

  const ingredientIds = [...needs.values()].map((n) => n.ingredientId);
  const inventories = await prisma.inventory.findMany({
    where: { ingredientId: { in: ingredientIds } },
    include: { ingredient: true },
  });
  const byIngredientId = new Map(inventories.map((inv) => [inv.ingredientId.toString(), inv]));

  const shortfalls: InsufficientIngredient[] = [];
  for (const need of needs.values()) {
    const inv = byIngredientId.get(need.ingredientId.toString());
    // No inventory row at all for a tracked ingredient means nothing has
    // ever been stocked — treat as zero free stock rather than silently
    // ignoring the requirement.
    const free = inv ? inv.stockQuantity.minus(inv.reservedQuantity) : new Prisma.Decimal(0);
    if (free.lessThan(need.quantity)) {
      shortfalls.push({
        ingredientId: need.ingredientId,
        ingredientName: inv?.ingredient.name ?? need.ingredientId.toString(),
        unit: inv?.ingredient.unit ?? "",
        needed: need.quantity,
        free,
      });
    }
  }
  return shortfalls;
}

/** Can `quantity` units of this dish be made right now, ignoring options? */
export async function isDishAvailable(dishId: bigint, quantity = 1): Promise<boolean> {
  const needs = await getDishIngredientNeeds(dishId, quantity);
  if (needs.length === 0) return true; // untracked ingredients (e.g. bottled drinks) => always available
  const shortfalls = await findInsufficientIngredients(sumIngredientNeeds([needs]));
  return shortfalls.length === 0;
}

/**
 * Batch version for the menu list screen: one pair of queries for every
 * dish shown, rather than N+1 round trips per dish.
 */
export async function computeAvailabilityForDishes(dishIds: bigint[]): Promise<Map<string, boolean>> {
  if (dishIds.length === 0) return new Map();

  const recipes = await prisma.recipe.findMany({ where: { dishId: { in: dishIds } } });
  if (recipes.length === 0) {
    // No recipes at all for any of these dishes => all available.
    return new Map(dishIds.map((id) => [id.toString(), true]));
  }

  const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId.toString()))].map((s) => BigInt(s));
  const inventories = await prisma.inventory.findMany({ where: { ingredientId: { in: ingredientIds } } });
  const freeByIngredient = new Map(
    inventories.map((inv) => [inv.ingredientId.toString(), inv.stockQuantity.minus(inv.reservedQuantity)]),
  );

  const recipesByDish = new Map<string, typeof recipes>();
  for (const r of recipes) {
    const key = r.dishId.toString();
    const list = recipesByDish.get(key) ?? [];
    list.push(r);
    recipesByDish.set(key, list);
  }

  const result = new Map<string, boolean>();
  for (const dishId of dishIds) {
    const key = dishId.toString();
    const dishRecipes = recipesByDish.get(key);
    if (!dishRecipes || dishRecipes.length === 0) {
      result.set(key, true);
      continue;
    }
    const available = dishRecipes.every((r) => {
      const free = freeByIngredient.get(r.ingredientId.toString()) ?? new Prisma.Decimal(0);
      return free.greaterThanOrEqualTo(r.quantity);
    });
    result.set(key, available);
  }
  return result;
}
