import { AppError, ValidationError } from "../../lib/errors";
import { dec, ZERO, qtyStr, type Decimal } from "../../lib/decimal";
import { convertQuantity } from "../../lib/units";
import type { Tx } from "../../lib/prismaTx";

/**
 * Personalisation maths (TZ FR-02) in one place, so that the cart, checkout,
 * reservation, kitchen display and receipt can never disagree on what a
 * "50 g instead of 40 g" order means.
 *
 *  - Quantities are PER ONE SERVING of the dish line, in Ingredient.unit.
 *  - Allowed values for an ingredient: 0, step, 2*step ... 3*base (and `base`
 *    itself as an anchor, so legacy data whose base is not a multiple of the
 *    step stays selectable).
 *  - Chosen options are also per serving: a line of 2 servings with 1 "extra
 *    bacon" uses 2 portions of bacon.
 *
 * Everything below the "pure functions" banner has no database access, which is
 * what makes it unit-testable (tests/unit).
 */

export const MAX_FACTOR = 3;

// ============================================================================
// shapes
// ============================================================================

export interface RecipeLine {
  ingredientId: bigint;
  name: string;
  /** Ingredient.unit - the base unit of storage and of every API payload. */
  unit: string;
  isActive: boolean;
  /** recipe quantity per ONE serving */
  base: Decimal;
  step: Decimal;
  customizable: boolean;
}

export interface OptionIngredientDef {
  ingredientId: bigint;
  name: string;
  unit: string;
  isActive: boolean;
  /** quantity per ONE unit of the option */
  quantity: Decimal;
}

export interface OptionDef {
  optionId: bigint;
  name: string;
  description: string | null;
  price: Decimal;
  isActive: boolean;
  inventoryTracked: boolean;
  ingredients: OptionIngredientDef[];
}

export interface RequestedIngredient {
  ingredientId: bigint;
  quantity: Decimal;
  /** optional; when present and different from the base unit it is converted (g<->kg, ml<->l) */
  unit?: string;
}

export interface ResolvedLine {
  line: RecipeLine;
  selected: Decimal;
}

// ============================================================================
// pure functions
// ============================================================================

export function maxQuantity(base: Decimal): Decimal {
  return base.times(MAX_FACTOR);
}

/**
 * Default personalisation step for a recipe line. MUST stay in sync with the
 * backfill in migration 20261011000000 (see the UPDATE "recipes" ... CASE).
 *   pcs   : integer base -> 1;  fractional base (half a lemon) -> the base itself
 *   other : half of the base when representable with 3 decimals, else the base
 */
export function defaultAdjustmentStep(base: Decimal, unit: string): Decimal {
  if (base.lte(0)) return dec("0.001");
  if (unit === "pcs") return base.isInteger() ? dec(1) : base;
  const half = base.dividedBy(2);
  return half.decimalPlaces() <= 3 ? half : base;
}

/** A recipe line is only valid for personalisation when step > 0 and it divides the range sensibly. */
export function isValidStep(base: Decimal, step: Decimal, unit: string): boolean {
  if (step.lte(0) || step.decimalPlaces() > 3) return false;
  // integer piece counts must move in whole pieces
  if (unit === "pcs" && base.isInteger() && !step.isInteger()) return false;
  return true;
}

export function isAllowedQuantity(selected: Decimal, base: Decimal, step: Decimal): boolean {
  if (selected.lt(0) || selected.gt(maxQuantity(base))) return false;
  if (selected.equals(base)) return true; // the anchor is always valid
  return selected.mod(step).isZero();
}

/** Ordered list of every allowed value (used by tests and by the admin preview). */
export function allowedQuantities(base: Decimal, step: Decimal, limit = 500): Decimal[] {
  const values = new Map<string, Decimal>();
  const max = maxQuantity(base);
  let v = ZERO;
  for (let i = 0; i < limit && v.lte(max); i++) {
    values.set(v.toFixed(), v);
    v = v.plus(step);
  }
  values.set(base.toFixed(), base);
  return [...values.values()].sort((a, b) => a.comparedTo(b));
}

/**
 * Validates a guest's requested composition against the dish recipe and returns the
 * resolved selection for EVERY recipe line (lines the guest did not touch keep
 * their base amount). Every rule has its own stable error code.
 */
export function resolveRecipeSelection(lines: RecipeLine[], requested: RequestedIngredient[] | undefined): ResolvedLine[] {
  const byId = new Map(lines.map((l) => [l.ingredientId.toString(), l]));
  const picked = new Map<string, Decimal>();

  for (const r of requested ?? []) {
    const key = r.ingredientId.toString();
    const line = byId.get(key);
    if (!line) {
      throw new AppError(400, "INGREDIENT_NOT_IN_DISH", "Этот ингредиент не входит в состав блюда", {
        ingredientId: key,
      });
    }
    if (picked.has(key)) {
      throw new ValidationError(`Ингредиент «${line.name}» указан дважды`, { ingredientId: key });
    }
    // 25 g must never be compared with 0.04 kg: convert into the base unit first.
    const qty = r.unit && r.unit !== line.unit ? convertQuantity(r.quantity, r.unit, line.unit) : r.quantity;

    if (qty.lt(0) || qty.gt(maxQuantity(line.base))) {
      throw new AppError(
        400,
        "INGREDIENT_OUT_OF_RANGE",
        `«${line.name}»: допустимо от 0 до ${qtyStr(maxQuantity(line.base))} ${line.unit} на порцию`,
        { ingredientId: key, min: "0", max: qtyStr(maxQuantity(line.base)) },
      );
    }
    if (!line.customizable && !qty.equals(line.base)) {
      throw new AppError(400, "INGREDIENT_NOT_CUSTOMIZABLE", `«${line.name}» нельзя изменить`, { ingredientId: key });
    }
    if (!isAllowedQuantity(qty, line.base, line.step)) {
      throw new AppError(
        400,
        "INVALID_INGREDIENT_STEP",
        `«${line.name}»: количество должно меняться с шагом ${qtyStr(line.step)} ${line.unit}`,
        { ingredientId: key, step: qtyStr(line.step) },
      );
    }
    picked.set(key, qty);
  }

  return lines.map((line) => ({ line, selected: picked.get(line.ingredientId.toString()) ?? line.base }));
}

// ----------------------------------------------------------------------------
// needs
// ----------------------------------------------------------------------------

export interface ItemNeedsInput {
  /** servings of the dish line */
  quantity: number;
  /** what was chosen per ONE serving */
  ingredients: { ingredientId: bigint; selectedPerServing: Decimal }[];
  options: {
    optionId: bigint;
    /** units of the option PER serving */
    quantity: number;
    ingredients: { ingredientId: bigint; quantity: Decimal }[];
  }[];
}

/**
 * Ingredient totals one order line needs:
 *   need(i) = servings * selected(i)  +  sum over options of servings * optionQty * optionIngredientQty(i)
 * Zero amounts are dropped ("Убрать" reserves nothing).
 */
export function calculateOrderItemNeeds(input: ItemNeedsInput): Map<string, Decimal> {
  const needs = new Map<string, Decimal>();
  const add = (id: bigint, amount: Decimal) => {
    if (amount.lte(0)) return;
    const key = id.toString();
    needs.set(key, (needs.get(key) ?? ZERO).plus(amount));
  };
  for (const ing of input.ingredients) add(ing.ingredientId, ing.selectedPerServing.times(input.quantity));
  for (const opt of input.options) {
    for (const oi of opt.ingredients) add(oi.ingredientId, oi.quantity.times(opt.quantity).times(input.quantity));
  }
  return needs;
}

export function mergeNeeds(maps: Iterable<Map<string, Decimal>>): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const m of maps) {
    for (const [k, v] of m) out.set(k, (out.get(k) ?? ZERO).plus(v));
  }
  return out;
}

export interface OrderItemIngredientRowInput {
  ingredientId: bigint;
  name: string;
  unit: string;
  source: "RECIPE" | "OPTION";
  basePerServing: Decimal;
  selectedPerServing: Decimal;
  requiredTotal: Decimal;
}

/**
 * Rows for order_item_ingredients: one RECIPE row per recipe line (kept even at 0 so the
 * kitchen sees "removed") and ONE aggregated OPTION row per ingredient the options add.
 */
export function buildOrderItemIngredientRows(input: {
  quantity: number;
  recipe: { ingredientId: bigint; name: string; unit: string; base: Decimal; selected: Decimal }[];
  options: {
    quantity: number;
    ingredients: { ingredientId: bigint; name: string; unit: string; quantity: Decimal }[];
  }[];
}): OrderItemIngredientRowInput[] {
  const rows: OrderItemIngredientRowInput[] = input.recipe.map((r) => ({
    ingredientId: r.ingredientId,
    name: r.name,
    unit: r.unit,
    source: "RECIPE" as const,
    basePerServing: r.base,
    selectedPerServing: r.selected,
    requiredTotal: r.selected.times(input.quantity),
  }));

  const optionPerServing = new Map<string, OrderItemIngredientRowInput>();
  for (const opt of input.options) {
    for (const oi of opt.ingredients) {
      const key = oi.ingredientId.toString();
      const perServing = oi.quantity.times(opt.quantity);
      const prev = optionPerServing.get(key);
      const selected = (prev?.selectedPerServing ?? ZERO).plus(perServing);
      optionPerServing.set(key, {
        ingredientId: oi.ingredientId,
        name: oi.name,
        unit: oi.unit,
        source: "OPTION",
        basePerServing: ZERO,
        selectedPerServing: selected,
        requiredTotal: selected.times(input.quantity),
      });
    }
  }
  return [...rows, ...optionPerServing.values()];
}

// ----------------------------------------------------------------------------
// money
// ----------------------------------------------------------------------------

/**
 * Extra recipe ingredients are charged at a proportional share of the base dish price.
 * The standard recipe is included, and reducing/removing an ingredient gives no discount.
 * No catalog migration or manually entered price is required for existing dishes.
 * IMPORTANT: both the configuration preview and cart must use this SAME function.
 */
export function compositionSurcharge(dishPrice: Decimal, selected: ResolvedLine[]): Decimal {
  const priced = selected.filter((r) => r.line.base.gt(0));
  if (priced.length === 0) return ZERO;
  const share = dishPrice.dividedBy(priced.length);
  const surcharge = priced.reduce((sum, r) => {
    const extra = r.selected.minus(r.line.base);
    return extra.gt(0) ? sum.plus(share.times(extra.dividedBy(r.line.base))) : sum;
  }, ZERO);
  return surcharge.toDecimalPlaces(2, 4); // half-up, matching money amounts
}

/** Price of ONE serving including its options (options are charged per serving). */
export function unitPriceWithOptions(price: Decimal, options: { price: Decimal; quantity: number }[]): Decimal {
  return options.reduce((sum, o) => sum.plus(o.price.times(o.quantity)), price);
}

export function lineTotal(price: Decimal, quantity: number, options: { price: Decimal; quantity: number }[]): Decimal {
  return unitPriceWithOptions(price, options).times(quantity);
}

// ----------------------------------------------------------------------------
// allergens
// ----------------------------------------------------------------------------

export type AllergenKind = "CONTAINS" | "MAY_CONTAIN";

/** Shape from TZ §5.3: { categoryId, categoryName, ingredients: [{ ingredientId, name }] } (+ kind). */
export interface AllergenGroup {
  categoryId: string;
  categoryName: string;
  sortOrder: number;
  ingredients: { ingredientId: string; name: string; kind: AllergenKind }[];
}

/**
 * Groups the ingredients that are ACTUALLY present (selected > 0, plus those added by chosen
 * options) by allergen category. "Contains" and "may contain / cross-contact" stay distinguishable
 * through `kind`. The client mirrors this function (frontend/script.js computeAllergenGroups) to
 * update the modal instantly on every + / − press.
 */
export function computeAllergenGroups(args: {
  present: { ingredientId: bigint; name: string }[];
  tags: Map<string, { allergenId: bigint; kind: AllergenKind }[]>;
  allergens: Map<string, { name: string; sortOrder: number }>;
}): AllergenGroup[] {
  const groups = new Map<string, AllergenGroup>();
  const seen = new Set<string>();
  for (const ing of args.present) {
    const ingKey = ing.ingredientId.toString();
    for (const tag of args.tags.get(ingKey) ?? []) {
      const aKey = tag.allergenId.toString();
      const meta = args.allergens.get(aKey);
      if (!meta) continue;
      const dedupe = `${aKey}|${ingKey}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      let g = groups.get(aKey);
      if (!g) {
        g = { categoryId: aKey, categoryName: meta.name, sortOrder: meta.sortOrder, ingredients: [] };
        groups.set(aKey, g);
      }
      g.ingredients.push({ ingredientId: ingKey, name: ing.name, kind: tag.kind });
    }
  }
  return [...groups.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.categoryName.localeCompare(b.categoryName, "ru"));
}

// ============================================================================
// database loaders
// ============================================================================

export interface DishConfigSource {
  dish: {
    dishId: bigint;
    name: string;
    price: Decimal;
    description: string | null;
    isActive: boolean;
    inventoryTracked: boolean;
    is21Plus: boolean;
    categoryActive: boolean;
    categoryName: string;
    categoryId: bigint;
  };
  recipeLines: RecipeLine[];
  options: OptionDef[];
}

/** Loads everything needed to validate / price / reserve one dish configuration. */
export async function loadDishConfigSource(db: Tx, dishId: bigint): Promise<DishConfigSource | null> {
  const dish = await db.dish.findUnique({
    where: { dishId },
    include: {
      category: true,
      recipes: { include: { ingredient: true }, orderBy: { recipeId: "asc" } },
      availableOptions: {
        include: { option: { include: { ingredients: { include: { ingredient: true } } } } },
      },
    },
  });
  if (!dish) return null;
  return {
    dish: {
      dishId: dish.dishId,
      name: dish.name,
      price: dish.price,
      description: dish.description,
      isActive: dish.isActive,
      inventoryTracked: dish.inventoryTracked,
      is21Plus: dish.is21Plus,
      categoryActive: dish.category.isActive,
      categoryName: dish.category.name,
      categoryId: dish.category.categoryId,
    },
    recipeLines: dish.recipes.map((r) => ({
      ingredientId: r.ingredientId,
      name: r.ingredient.name,
      unit: r.ingredient.unit,
      isActive: r.ingredient.isActive,
      base: r.quantity,
      step: r.adjustmentStep,
      customizable: r.isCustomizable,
    })),
    options: dish.availableOptions.map(({ option }) => ({
      optionId: option.optionId,
      name: option.name,
      description: option.description,
      price: option.price,
      isActive: option.isActive,
      inventoryTracked: option.inventoryTracked,
      ingredients: option.ingredients.map((oi) => ({
        ingredientId: oi.ingredientId,
        name: oi.ingredient.name,
        unit: oi.ingredient.unit,
        isActive: oi.ingredient.isActive,
        quantity: oi.quantity,
      })),
    })),
  };
}

