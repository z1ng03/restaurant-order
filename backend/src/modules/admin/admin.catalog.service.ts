import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import { parseDecimalInput, qtyStr, ZERO, type Decimal } from "../../lib/decimal";
import type { Tx } from "../../lib/prismaTx";
import { formatQuantityRu } from "../../lib/units";
import type { InventoryAdjustmentReason } from "../../types/status";
import { defaultAdjustmentStep, isValidStep } from "../menu/recipeCalculation.service";

/**
 * Nothing here does a hard DELETE on catalog entities (categories, dishes,
 * ingredients, options, allergens) - all of them can be referenced by past
 * orders (ON DELETE RESTRICT in the schema), so a real delete would either
 * fail once the entity has any history, or silently succeed and corrupt
 * that history if it didn't. "Deactivate" (isActive = false, already part
 * of the schema for exactly this) is the realistic restaurant equivalent
 * of 86'ing a dish - it drops off the live menu without touching history.
 */

/* ------------------------------- Categories ------------------------------ */

export function listCategories() {
  return prisma.category.findMany({ orderBy: { sortOrder: "asc" } });
}

export function createCategory(input: {
  name: string;
  description?: string;
  imageUrl?: string;
  sortOrder?: number;
}) {
  return prisma.category.create({ data: input });
}

export async function updateCategory(
  categoryId: bigint,
  input: { name?: string; description?: string; imageUrl?: string; sortOrder?: number; isActive?: boolean },
) {
  const category = await prisma.category.findUnique({ where: { categoryId } });
  if (!category) throw new NotFoundError("Category");
  return prisma.category.update({ where: { categoryId }, data: input });
}

/* ------------------------------ Ingredients ------------------------------ */

export async function listIngredients() {
  const ingredients = await prisma.ingredient.findMany({
    orderBy: { name: "asc" },
    include: { inventory: true },
  });
  return ingredients.map((i) => ({
    ingredientId: i.ingredientId,
    name: i.name,
    unit: i.unit,
    isActive: i.isActive,
    stockQuantity: i.inventory?.stockQuantity ?? new Prisma.Decimal(0),
    reservedQuantity: i.inventory?.reservedQuantity ?? new Prisma.Decimal(0),
  }));
}

export async function createIngredient(input: { name: string; unit: string; initialStock: number }) {
  const initial = parseDecimalInput(input.initialStock, "initialStock");
  if (initial.lt(0)) throw new ValidationError("initialStock can't be negative");
  return prisma.$transaction(async (tx) => {
    const ingredient = await tx.ingredient.create({ data: { name: input.name, unit: input.unit } });
    await tx.inventory.create({ data: { ingredientId: ingredient.ingredientId, stockQuantity: initial } });
    if (initial.gt(0)) {
      await tx.inventoryAdjustment.create({
        data: {
          ingredientId: ingredient.ingredientId,
          delta: initial,
          stockBefore: ZERO,
          stockAfter: initial,
          reason: "INITIAL",
          comment: "Начальный остаток при создании ингредиента",
        },
      });
    }
    return ingredient;
  });
}

export async function updateIngredient(ingredientId: bigint, input: { name?: string; unit?: string; isActive?: boolean }) {
  const ingredient = await prisma.ingredient.findUnique({ where: { ingredientId }, include: { inventory: true } });
  if (!ingredient) throw new NotFoundError("Ingredient");

  // Changing the base unit would silently change the meaning of every recipe, option, reservation and the
  // stock itself (0.04 "kg" -> 0.04 "g"). Only an ingredient nothing refers to may change its unit.
  if (input.unit !== undefined && input.unit !== ingredient.unit) {
    const [recipes, optionLines, orderLines] = await Promise.all([
      prisma.recipe.count({ where: { ingredientId } }),
      prisma.dishOptionIngredient.count({ where: { ingredientId } }),
      prisma.orderItemIngredient.count({ where: { ingredientId } }),
    ]);
    const hasStock = ingredient.inventory && (ingredient.inventory.stockQuantity.gt(0) || ingredient.inventory.reservedQuantity.gt(0));
    if (recipes + optionLines + orderLines > 0 || hasStock) {
      throw new AppError(
        409,
        "UNIT_CHANGE_FORBIDDEN",
        "Нельзя менять единицу измерения ингредиента, который используется в рецептах, опциях, заказах или имеет остаток",
      );
    }
  }
  return prisma.ingredient.update({ where: { ingredientId }, data: input });
}

export interface StockChangeContext {
  actorUserId: bigint | null;
  reason?: InventoryAdjustmentReason | undefined;
  comment?: string | undefined;
}

/**
 * The ONE place stock is changed by hand. Under a row lock on the inventory record it
 *   - refuses to put stock below what is already RESERVED for placed orders (STOCK_BELOW_RESERVED) -
 *     the old call only checked >= 0, so an admin could silently break open orders;
 *   - writes an inventory_adjustments journal row (who / when / before / after / reason / comment).
 * `reserved_quantity` is deliberately not editable: it is only written by the reservation flow.
 */
async function changeStock(
  ingredientId: bigint,
  compute: (before: Decimal, reserved: Decimal) => Decimal,
  ctx: StockChangeContext,
  defaultReason: InventoryAdjustmentReason,
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ stock_quantity: Decimal; reserved_quantity: Decimal }[]>(
      Prisma.sql`SELECT "stock_quantity", "reserved_quantity" FROM "inventory" WHERE "ingredient_id" = ${ingredientId} FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Inventory record for this ingredient");
    const before = new Prisma.Decimal(row.stock_quantity);
    const reserved = new Prisma.Decimal(row.reserved_quantity);

    const after = compute(before, reserved);
    if (after.lt(0)) throw new ValidationError("Остаток не может быть отрицательным");
    if (after.lt(reserved)) {
      const ingredient = await tx.ingredient.findUniqueOrThrow({ where: { ingredientId }, select: { unit: true, name: true } });
      throw new AppError(
        409,
        "STOCK_BELOW_RESERVED",
        `Нельзя установить остаток «${ingredient.name}» ниже зарезервированного (${formatQuantityRu(reserved, ingredient.unit)}). ` +
          "Дождитесь выдачи или отмените заказы, которые держат резерв.",
        { reserved: qtyStr(reserved), requested: qtyStr(after) },
      );
    }

    const delta = after.minus(before);
    const inventory = await tx.inventory.update({ where: { ingredientId }, data: { stockQuantity: after } });
    if (!delta.isZero()) {
      await tx.inventoryAdjustment.create({
        data: {
          ingredientId,
          delta,
          stockBefore: before,
          stockAfter: after,
          reason: ctx.reason ?? defaultReason,
          comment: ctx.comment ?? null,
          actorUserId: ctx.actorUserId,
        },
      });
    }
    return inventory;
  });
}

/** Sets the *counted* stock level directly (a physical count corrected drift). */
export function setIngredientStock(ingredientId: bigint, stockQuantity: number | string, ctx: StockChangeContext) {
  const target = parseDecimalInput(stockQuantity, "stockQuantity");
  if (target.lt(0)) throw new ValidationError("stockQuantity can't be negative");
  return changeStock(ingredientId, () => target, ctx, "CORRECTION");
}

/** Goods receipt ("приёмка"): adds a positive amount to the stock. */
export function receiveIngredientStock(ingredientId: bigint, quantity: number | string, ctx: StockChangeContext) {
  const amount = parseDecimalInput(quantity, "quantity");
  if (amount.lte(0)) throw new ValidationError("quantity must be greater than 0");
  return changeStock(ingredientId, (before) => before.plus(amount), { ...ctx, reason: "RECEIPT" }, "RECEIPT");
}

/** Write-off (spoilage, breakage): subtracts, never below what is reserved. */
export function writeOffIngredientStock(ingredientId: bigint, quantity: number | string, ctx: StockChangeContext) {
  const amount = parseDecimalInput(quantity, "quantity");
  if (amount.lte(0)) throw new ValidationError("quantity must be greater than 0");
  return changeStock(ingredientId, (before) => before.minus(amount), { ...ctx, reason: "WRITE_OFF" }, "WRITE_OFF");
}

export async function listInventoryAdjustments(filter: { ingredientId?: bigint | undefined; limit: number }) {
  const rows = await prisma.inventoryAdjustment.findMany({
    where: filter.ingredientId ? { ingredientId: filter.ingredientId } : undefined,
    orderBy: [{ createdAt: "desc" }, { adjustmentId: "desc" }],
    take: filter.limit,
    include: { ingredient: { select: { name: true, unit: true } }, actor: { select: { name: true, login: true } } },
  });
  return rows.map((r) => ({
    adjustmentId: r.adjustmentId,
    ingredientId: r.ingredientId,
    ingredientName: r.ingredient.name,
    unit: r.ingredient.unit,
    delta: r.delta.toFixed(3),
    stockBefore: r.stockBefore.toFixed(3),
    stockAfter: r.stockAfter.toFixed(3),
    reason: r.reason,
    comment: r.comment,
    actorName: r.actor?.name ?? null,
    createdAt: r.createdAt,
  }));
}

/* ------------------------- Ingredient allergen tags ----------------------- */

export async function listIngredientAllergens() {
  const ingredients = await prisma.ingredient.findMany({
    orderBy: { name: "asc" },
    include: { allergens: { include: { allergen: true } } },
  });
  return ingredients.map((i) => ({
    ingredientId: i.ingredientId,
    name: i.name,
    unit: i.unit,
    isActive: i.isActive,
    allergens: i.allergens.map((a) => ({ allergenId: a.allergenId, name: a.allergen.name, kind: a.kind })),
  }));
}

/** Replaces the whole tag set of one ingredient (CONTAINS / MAY_CONTAIN per allergen category). */
export async function setIngredientAllergens(
  ingredientId: bigint,
  tags: { allergenId: bigint; kind: "CONTAINS" | "MAY_CONTAIN" }[],
) {
  const ingredient = await prisma.ingredient.findUnique({ where: { ingredientId } });
  if (!ingredient) throw new NotFoundError("Ingredient");
  const ids = tags.map((t) => t.allergenId.toString());
  if (new Set(ids).size !== ids.length) throw new ValidationError("Категория аллергена указана дважды");
  if (tags.length) {
    const known = await prisma.allergen.count({ where: { allergenId: { in: tags.map((t) => t.allergenId) } } });
    if (known !== tags.length) throw new ValidationError("Неизвестная категория аллергена");
  }
  await prisma.$transaction(async (tx) => {
    await tx.ingredientAllergen.deleteMany({ where: { ingredientId } });
    if (tags.length) {
      await tx.ingredientAllergen.createMany({
        data: tags.map((t) => ({ ingredientId, allergenId: t.allergenId, kind: t.kind })),
      });
    }
  });
  const updated = await prisma.ingredientAllergen.findMany({ where: { ingredientId }, include: { allergen: true } });
  return updated.map((a) => ({ allergenId: a.allergenId, name: a.allergen.name, kind: a.kind }));
}

export async function addIngredientAllergen(ingredientId: bigint, allergenId: bigint, kind: "CONTAINS" | "MAY_CONTAIN") {
  const [ingredient, allergen] = await Promise.all([
    prisma.ingredient.findUnique({ where: { ingredientId } }),
    prisma.allergen.findUnique({ where: { allergenId } }),
  ]);
  if (!ingredient) throw new NotFoundError("Ingredient");
  if (!allergen) throw new NotFoundError("Allergen");
  await prisma.ingredientAllergen.upsert({
    where: { ingredientId_allergenId: { ingredientId, allergenId } },
    create: { ingredientId, allergenId, kind },
    update: { kind },
  });
  return { ingredientId, allergenId, kind };
}

/* -------------------------------- Dishes --------------------------------- */

const dishDetailInclude = {
  category: true,
  recipes: { include: { ingredient: true } },
  allergens: { include: { allergen: true } },
  availableOptions: { include: { option: true } },
};

export function listDishes(filter: { categoryId?: bigint }) {
  return prisma.dish.findMany({
    where: filter.categoryId ? { categoryId: filter.categoryId } : undefined,
    orderBy: { name: "asc" },
    include: { category: true },
  });
}

export async function getDish(dishId: bigint) {
  const dish = await prisma.dish.findUnique({ where: { dishId }, include: dishDetailInclude });
  if (!dish) throw new NotFoundError("Dish");
  return dish;
}

export interface DishRecipeInput {
  ingredientId: bigint;
  quantity: number | string;
  /** personalisation step per serving (base unit); defaults to defaultAdjustmentStep() */
  adjustmentStep?: number | string | undefined;
  isCustomizable?: boolean | undefined;
}

export interface DishWriteInput {
  categoryId?: bigint | undefined;
  name?: string | undefined;
  price?: number | undefined;
  imageUrl?: string | undefined;
  description?: string | undefined;
  is21Plus?: boolean | undefined;
  isActive?: boolean | undefined;
  /** false = stock is not tracked for this dish (explicit; an empty recipe on a tracked dish means "unavailable") */
  inventoryTracked?: boolean | undefined;
  recipe?: DishRecipeInput[] | undefined; // when provided, fully replaces the dish's recipe
  allergenIds?: bigint[] | undefined; // when provided, fully replaces dish_allergens
  availableOptionIds?: bigint[] | undefined; // when provided, fully replaces dish_available_options
}

function assertDescriptionForActiveDish(isActive: boolean, description: string | null | undefined) {
  if (isActive && (!description || description.trim() === "")) {
    throw new ValidationError("У активного блюда должно быть описание (1–3 предложения: состав, вкус, способ приготовления)");
  }
}

export async function createDish(input: Required<Pick<DishWriteInput, "categoryId" | "name" | "price">> & DishWriteInput) {
  const category = await prisma.category.findUnique({ where: { categoryId: input.categoryId } });
  if (!category) throw new ValidationError("categoryId does not refer to an existing category");
  assertDescriptionForActiveDish(input.isActive ?? true, input.description);

  const dish = await prisma.$transaction(async (tx) => {
    const created = await tx.dish.create({
      data: {
        categoryId: input.categoryId,
        name: input.name,
        price: new Prisma.Decimal(input.price),
        imageUrl: input.imageUrl,
        description: input.description?.trim(),
        is21Plus: input.is21Plus ?? false,
        isActive: input.isActive ?? true,
        inventoryTracked: input.inventoryTracked ?? true,
      },
    });
    await applyDishAssociations(tx, created.dishId, input);
    return created;
  });

  return getDish(dish.dishId);
}

export async function updateDish(dishId: bigint, input: DishWriteInput) {
  const dish = await prisma.dish.findUnique({ where: { dishId } });
  if (!dish) throw new NotFoundError("Dish");

  if (input.categoryId) {
    const category = await prisma.category.findUnique({ where: { categoryId: input.categoryId } });
    if (!category) throw new ValidationError("categoryId does not refer to an existing category");
  }
  assertDescriptionForActiveDish(input.isActive ?? dish.isActive, input.description ?? dish.description);

  await prisma.$transaction(async (tx) => {
    await tx.dish.update({
      where: { dishId },
      data: {
        categoryId: input.categoryId,
        name: input.name,
        price: input.price !== undefined ? new Prisma.Decimal(input.price) : undefined,
        imageUrl: input.imageUrl,
        description: input.description?.trim(),
        is21Plus: input.is21Plus,
        isActive: input.isActive,
        inventoryTracked: input.inventoryTracked,
      },
    });
    await applyDishAssociations(tx, dishId, input);
  });

  return getDish(dishId);
}

async function applyDishAssociations(tx: Tx, dishId: bigint, input: DishWriteInput) {
  if (input.recipe) {
    const ingredientIds = input.recipe.map((r) => r.ingredientId.toString());
    if (new Set(ingredientIds).size !== ingredientIds.length) {
      throw new ValidationError("Один и тот же ингредиент указан в рецепте дважды");
    }
    const ingredients = await tx.ingredient.findMany({
      where: { ingredientId: { in: input.recipe.map((r) => r.ingredientId) } },
    });
    const byId = new Map(ingredients.map((i) => [i.ingredientId.toString(), i]));

    const rows = input.recipe.map((r) => {
      const ingredient = byId.get(r.ingredientId.toString());
      if (!ingredient) throw new ValidationError(`Ингредиент ${r.ingredientId} не найден`);
      const base = parseDecimalInput(r.quantity, `quantity (${ingredient.name})`);
      if (base.lte(0)) throw new ValidationError(`Количество «${ingredient.name}» должно быть больше нуля`);
      const step =
        r.adjustmentStep === undefined ? defaultAdjustmentStep(base, ingredient.unit) : parseDecimalInput(r.adjustmentStep, `adjustmentStep (${ingredient.name})`);
      if (!isValidStep(base, step, ingredient.unit)) {
        throw new ValidationError(
          `Шаг «${ingredient.name}» некорректен: он должен быть больше нуля, иметь не более 3 знаков и для целых штук быть целым`,
        );
      }
      return {
        dishId,
        ingredientId: r.ingredientId,
        quantity: base,
        adjustmentStep: step,
        isCustomizable: r.isCustomizable ?? true,
      };
    });

    await tx.recipe.deleteMany({ where: { dishId } });
    if (rows.length) await tx.recipe.createMany({ data: rows });
  }
  if (input.allergenIds) {
    await tx.dishAllergen.deleteMany({ where: { dishId } });
    if (input.allergenIds.length) {
      await tx.dishAllergen.createMany({ data: input.allergenIds.map((allergenId) => ({ dishId, allergenId })) });
    }
  }
  if (input.availableOptionIds) {
    await tx.dishAvailableOption.deleteMany({ where: { dishId } });
    if (input.availableOptionIds.length) {
      await tx.dishAvailableOption.createMany({
        data: input.availableOptionIds.map((optionId) => ({ dishId, optionId })),
      });
    }
  }
}

/* ----------------------------- Dish options ------------------------------ */

export function listOptions() {
  return prisma.dishOption.findMany({
    orderBy: { name: "asc" },
    include: { ingredients: { include: { ingredient: true } } },
  });
}

export interface DishOptionWriteInput {
  name?: string;
  price?: number;
  description?: string;
  isActive?: boolean;
  /** false = a non-stock option (e.g. "no straw"); true + no ingredient rows = unavailable */
  inventoryTracked?: boolean;
  ingredients?: { ingredientId: bigint; quantity: number }[]; // fully replaces dish_option_ingredients when provided
}

export async function createOption(input: Required<Pick<DishOptionWriteInput, "name" | "price">> & DishOptionWriteInput) {
  const option = await prisma.$transaction(async (tx) => {
    const created = await tx.dishOption.create({
      data: {
        name: input.name,
        price: new Prisma.Decimal(input.price),
        description: input.description,
        inventoryTracked: input.inventoryTracked ?? true,
      },
    });
    if (input.ingredients?.length) {
      await tx.dishOptionIngredient.createMany({
        data: input.ingredients.map((i) => ({
          optionId: created.optionId,
          ingredientId: i.ingredientId,
          quantity: new Prisma.Decimal(i.quantity),
        })),
      });
    }
    return created;
  });
  return prisma.dishOption.findUniqueOrThrow({
    where: { optionId: option.optionId },
    include: { ingredients: { include: { ingredient: true } } },
  });
}

export async function updateOption(optionId: bigint, input: DishOptionWriteInput) {
  const option = await prisma.dishOption.findUnique({ where: { optionId } });
  if (!option) throw new NotFoundError("Dish option");

  await prisma.$transaction(async (tx) => {
    await tx.dishOption.update({
      where: { optionId },
      data: {
        name: input.name,
        price: input.price !== undefined ? new Prisma.Decimal(input.price) : undefined,
        description: input.description,
        isActive: input.isActive,
        inventoryTracked: input.inventoryTracked,
      },
    });
    if (input.ingredients) {
      await tx.dishOptionIngredient.deleteMany({ where: { optionId } });
      if (input.ingredients.length) {
        await tx.dishOptionIngredient.createMany({
          data: input.ingredients.map((i) => ({
            optionId,
            ingredientId: i.ingredientId,
            quantity: new Prisma.Decimal(i.quantity),
          })),
        });
      }
    }
  });

  return prisma.dishOption.findUniqueOrThrow({
    where: { optionId },
    include: { ingredients: { include: { ingredient: true } } },
  });
}

/* -------------------------------- Allergens ------------------------------- */

export function listAllergens() {
  return prisma.allergen.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function createAllergen(input: { name: string; description?: string; sortOrder?: number }) {
  return prisma.allergen.create({ data: input });
}

export async function updateAllergen(allergenId: bigint, input: { name?: string; description?: string; sortOrder?: number }) {
  const allergen = await prisma.allergen.findUnique({ where: { allergenId } });
  if (!allergen) throw new NotFoundError("Allergen");
  return prisma.allergen.update({ where: { allergenId }, data: input });
}
