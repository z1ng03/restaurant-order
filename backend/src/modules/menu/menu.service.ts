import { prisma } from "../../db/prisma";
import { AppError, NotFoundError } from "../../lib/errors";
import { ZERO, type Decimal } from "../../lib/decimal";
import { checkNeeds, computeAvailabilityForDishes, shortfallDetails, shortfallMessage } from "./inventory.service";
import {
  calculateOrderItemNeeds,
  compositionSurcharge,
  computeAllergenGroups,
  loadDishConfigSource,
  maxQuantity,
  resolveRecipeSelection,
  type AllergenKind,
  type DishConfigSource,
  type OptionDef,
  type RequestedIngredient,
} from "./recipeCalculation.service";

/** Three fixed decimals, as in the TZ examples ("0.040"). */
const q3 = (d: Decimal) => d.toFixed(3);

/**
 * ТЗ §2: menu list shows name, price, photo, description, category, 21+
 * flag, and computed availability. Nothing in the DB changes here.
 */
export async function getMenu() {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    include: {
      dishes: {
        where: { isActive: true },
        orderBy: { name: "asc" },
      },
    },
  });

  const allDishIds = categories.flatMap((c) => c.dishes.map((d) => d.dishId));
  const availability = await computeAvailabilityForDishes(prisma, allDishIds);

  return categories.map((category) => ({
    categoryId: category.categoryId,
    name: category.name,
    description: category.description,
    imageUrl: category.imageUrl,
    sortOrder: category.sortOrder,
    dishes: category.dishes.map((dish) => {
      const a = availability.get(dish.dishId.toString());
      return {
        dishId: dish.dishId,
        name: dish.name,
        price: dish.price,
        imageUrl: dish.imageUrl,
        description: dish.description,
        is21Plus: dish.is21Plus,
        available: a?.available ?? false,
        unavailableReason: a?.available ? null : (a?.reason ?? null),
        unavailableMessage: a?.available ? null : (a?.message ?? null),
      };
    }),
  }));
}

// ----------------------------------------------------------------------------
// allergen lookups shared by dish detail and configuration checks
// ----------------------------------------------------------------------------

async function loadAllergenContext(ingredientIds: bigint[]) {
  const unique = [...new Set(ingredientIds.map((i) => i.toString()))].map((s) => BigInt(s));
  const [tagRows, allergenRows] = await Promise.all([
    unique.length
      ? prisma.ingredientAllergen.findMany({ where: { ingredientId: { in: unique } } })
      : Promise.resolve([]),
    prisma.allergen.findMany(),
  ]);
  const tags = new Map<string, { allergenId: bigint; kind: AllergenKind }[]>();
  for (const t of tagRows) {
    const key = t.ingredientId.toString();
    const list = tags.get(key) ?? [];
    list.push({ allergenId: t.allergenId, kind: t.kind === "MAY_CONTAIN" ? "MAY_CONTAIN" : "CONTAINS" });
    tags.set(key, list);
  }
  const allergens = new Map(allergenRows.map((a) => [a.allergenId.toString(), { name: a.name, sortOrder: a.sortOrder }]));
  return { tags, allergens };
}

function optionAvailability(option: OptionDef): { available: boolean; reason: string | null } {
  if (!option.isActive) return { available: false, reason: "OPTION_INACTIVE" };
  if (option.inventoryTracked && option.ingredients.length === 0) return { available: false, reason: "NO_RECIPE" };
  if (option.ingredients.some((i) => !i.isActive)) return { available: false, reason: "INGREDIENT_INACTIVE" };
  return { available: true, reason: null };
}

/**
 * ТЗ §3 + TZ v2 FR-02/FR-03: dish detail adds ingredients (with the personalisation
 * limits), allergens (manual warnings AND ingredient-derived groups) and options.
 * "ингредиенты здесь только показываются. Они не списываются и не
 * резервируются" - this is a pure read, nothing is written.
 */
export async function getDishDetail(dishId: bigint) {
  const src = await loadDishConfigSource(prisma, dishId);
  if (!src || !src.dish.isActive || !src.dish.categoryActive) {
    throw new NotFoundError("Dish");
  }
  const manual = await prisma.dishAllergen.findMany({ where: { dishId }, include: { allergen: true } });
  const availability = (await computeAvailabilityForDishes(prisma, [dishId])).get(dishId.toString());

  const ingredientIds = [
    ...src.recipeLines.map((l) => l.ingredientId),
    ...src.options.flatMap((o) => o.ingredients.map((i) => i.ingredientId)),
  ];
  const { tags, allergens } = await loadAllergenContext(ingredientIds);

  // The default composition (what the guest gets without touching anything).
  const groups = computeAllergenGroups({
    present: src.recipeLines.filter((l) => l.base.gt(0)).map((l) => ({ ingredientId: l.ingredientId, name: l.name })),
    tags,
    allergens,
  });

  return {
    dishId: src.dish.dishId,
    name: src.dish.name,
    price: src.dish.price,
    imageUrl: (await prisma.dish.findUnique({ where: { dishId }, select: { imageUrl: true } }))?.imageUrl ?? null,
    description: src.dish.description,
    is21Plus: src.dish.is21Plus,
    category: { categoryId: src.dish.categoryId, name: src.dish.categoryName },
    available: availability?.available ?? false,
    unavailableReason: availability?.available ? null : (availability?.reason ?? null),
    unavailableMessage: availability?.available ? null : (availability?.message ?? null),
    ingredients: src.recipeLines.map((l) => ({
      ingredientId: l.ingredientId,
      name: l.name,
      unit: l.unit,
      /** legacy field kept for old clients = the base quantity */
      quantity: q3(l.base),
      baseQuantity: q3(l.base),
      stepQuantity: q3(l.step),
      selectedQuantity: q3(l.base),
      minQuantity: "0.000",
      maxQuantity: q3(maxQuantity(l.base)),
      customizable: l.customizable,
      allergens: (tags.get(l.ingredientId.toString()) ?? []).map((t) => ({
        categoryId: t.allergenId.toString(),
        categoryName: allergens.get(t.allergenId.toString())?.name ?? "",
        kind: t.kind,
      })),
    })),
    /** Administrator's manual dish-level warnings (kept as before; never dropped by personalisation). */
    allergens: manual.map((a) => ({
      allergenId: a.allergen.allergenId,
      name: a.allergen.name,
      description: a.allergen.description,
    })),
    allergenGroups: groups,
    options: src.options
      .filter((o) => o.isActive)
      .map((o) => {
        const av = optionAvailability(o);
        return {
          optionId: o.optionId,
          name: o.name,
          description: o.description,
          price: o.price,
          available: av.available,
          unavailableReason: av.reason,
          ingredients: o.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            name: i.name,
            unit: i.unit,
            quantity: q3(i.quantity),
            allergens: (tags.get(i.ingredientId.toString()) ?? []).map((t) => ({
              categoryId: t.allergenId.toString(),
              categoryName: allergens.get(t.allergenId.toString())?.name ?? "",
              kind: t.kind,
            })),
          })),
        };
      }),
  };
}

// ----------------------------------------------------------------------------
// configuration check (live availability of a personalised dish)
// ----------------------------------------------------------------------------

export interface ConfigurationInput {
  quantity: number;
  ingredients?: RequestedIngredient[];
  options?: { optionId: bigint; quantity: number }[];
}

/**
 * Same validation + maths as add-to-cart, but read-only: tells the modal whether this exact
 * configuration can be made right now ("даже если обычное блюдо есть, добавленные 200% сыра или
 * опции могут быть недоступны"), and returns the allergen groups for it. Invalid composition
 * (wrong step, unknown ingredient …) throws the same stable 400 codes as POST /cart.
 */
export async function checkDishConfiguration(dishId: bigint, input: ConfigurationInput) {
  const src = await loadDishConfigSource(prisma, dishId);
  if (!src || !src.dish.isActive || !src.dish.categoryActive) throw new NotFoundError("Dish");

  const resolved = resolveRecipeSelection(src.recipeLines, input.ingredients);
  const compositionPrice = src.dish.price.plus(compositionSurcharge(src.dish.price, resolved));
  const optionDefs = pickOptions(src, input.options ?? []);

  const needs = calculateOrderItemNeeds({
    quantity: input.quantity,
    ingredients: resolved.map((r) => ({ ingredientId: r.line.ingredientId, selectedPerServing: r.selected })),
    options: optionDefs.map((o) => ({
      optionId: o.def.optionId,
      quantity: o.quantity,
      ingredients: o.def.ingredients.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity })),
    })),
  });

  const baseAvailability = (await computeAvailabilityForDishes(prisma, [dishId])).get(dishId.toString());
  const shortfalls = src.dish.inventoryTracked ? await checkNeeds(prisma, needs) : [];

  const present = [
    ...resolved.filter((r) => r.selected.gt(0)).map((r) => ({ ingredientId: r.line.ingredientId, name: r.line.name })),
    ...optionDefs.flatMap((o) => o.def.ingredients.map((i) => ({ ingredientId: i.ingredientId, name: i.name }))),
  ];
  const { tags, allergens } = await loadAllergenContext(present.map((p) => p.ingredientId));
  const allergenGroups = computeAllergenGroups({ present, tags, allergens });

  return {
    configurationAvailable: shortfalls.length === 0,
    compositionPrice: compositionPrice.toFixed(2),
    totalUnitPrice: compositionPrice.plus(optionDefs.reduce((sum, o) => sum.plus(o.def.price.times(o.quantity)), ZERO)).toFixed(2),
    baseAvailable: baseAvailability?.available ?? false,
    issues: shortfalls.map((s) => ({ ...shortfallDetails(s), message: shortfallMessage(s) })),
    allergenGroups,
  };
}

/** Matches requested options against the ones this dish actually offers; rejects the rest. */
export function pickOptions(
  src: DishConfigSource,
  requested: { optionId: bigint; quantity: number }[],
): { def: OptionDef; quantity: number }[] {
  const byId = new Map(src.options.map((o) => [o.optionId.toString(), o]));
  const seen = new Set<string>();
  const out: { def: OptionDef; quantity: number }[] = [];
  for (const r of requested) {
    const key = r.optionId.toString();
    const def = byId.get(key);
    if (!def || !def.isActive) {
      throw new AppError(400, "OPTION_NOT_AVAILABLE", "Эта опция недоступна для выбранного блюда", { optionId: key });
    }
    if (seen.has(key)) {
      throw new AppError(400, "VALIDATION_ERROR", `Опция «${def.name}» указана дважды`, { optionId: key });
    }
    seen.add(key);
    const av = optionAvailability(def);
    if (!av.available) {
      throw new AppError(409, "OPTION_UNAVAILABLE", `Опция «${def.name}» сейчас недоступна`, { optionId: key });
    }
    out.push({ def, quantity: r.quantity });
  }
  return out;
}

