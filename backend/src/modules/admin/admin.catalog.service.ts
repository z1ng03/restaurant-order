import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { NotFoundError, ValidationError } from "../../lib/errors";
import type { Tx } from "../../lib/prismaTx";

/**
 * Nothing here does a hard DELETE on catalog entities (categories, dishes,
 * ingredients, options, allergens) — all of them can be referenced by past
 * orders (ON DELETE RESTRICT in the schema), so a real delete would either
 * fail once the entity has any history, or silently succeed and corrupt
 * that history if it didn't. "Deactivate" (isActive = false, already part
 * of the schema for exactly this) is the realistic restaurant equivalent
 * of 86'ing a dish — it drops off the live menu without touching history.
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
  return prisma.$transaction(async (tx) => {
    const ingredient = await tx.ingredient.create({ data: { name: input.name, unit: input.unit } });
    await tx.inventory.create({
      data: { ingredientId: ingredient.ingredientId, stockQuantity: new Prisma.Decimal(input.initialStock) },
    });
    return ingredient;
  });
}

export async function updateIngredient(ingredientId: bigint, input: { name?: string; unit?: string; isActive?: boolean }) {
  const ingredient = await prisma.ingredient.findUnique({ where: { ingredientId } });
  if (!ingredient) throw new NotFoundError("Ingredient");
  return prisma.ingredient.update({ where: { ingredientId }, data: input });
}

/**
 * Sets the *counted* stock level directly (a delivery arrived, a physical
 * count corrected drift, etc.) — this is the only inventory field an admin
 * edits by hand. `reserved_quantity` is deliberately not editable here: it
 * is only ever written by the checkout/kitchen reservation flow
 * (checkout.service.ts, kitchen.service.ts) and hand-editing it would let
 * it drift out of sync with the reservation rows that are supposed to add
 * up to it.
 */
export async function setIngredientStock(ingredientId: bigint, stockQuantity: number) {
  const inventory = await prisma.inventory.findUnique({ where: { ingredientId } });
  if (!inventory) throw new NotFoundError("Inventory record for this ingredient");
  if (stockQuantity < 0) throw new ValidationError("stockQuantity can't be negative");
  return prisma.inventory.update({ where: { ingredientId }, data: { stockQuantity: new Prisma.Decimal(stockQuantity) } });
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
  quantity: number;
}

export interface DishWriteInput {
  categoryId?: bigint;
  name?: string;
  price?: number;
  imageUrl?: string;
  description?: string;
  is21Plus?: boolean;
  isActive?: boolean;
  recipe?: DishRecipeInput[]; // when provided, fully replaces the dish's recipe
  allergenIds?: bigint[]; // when provided, fully replaces dish_allergens
  availableOptionIds?: bigint[]; // when provided, fully replaces dish_available_options
}

export async function createDish(input: Required<Pick<DishWriteInput, "categoryId" | "name" | "price">> & DishWriteInput) {
  const category = await prisma.category.findUnique({ where: { categoryId: input.categoryId } });
  if (!category) throw new ValidationError("categoryId does not refer to an existing category");

  const dish = await prisma.$transaction(async (tx) => {
    const created = await tx.dish.create({
      data: {
        categoryId: input.categoryId,
        name: input.name,
        price: new Prisma.Decimal(input.price),
        imageUrl: input.imageUrl,
        description: input.description,
        is21Plus: input.is21Plus ?? false,
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

  await prisma.$transaction(async (tx) => {
    await tx.dish.update({
      where: { dishId },
      data: {
        categoryId: input.categoryId,
        name: input.name,
        price: input.price !== undefined ? new Prisma.Decimal(input.price) : undefined,
        imageUrl: input.imageUrl,
        description: input.description,
        is21Plus: input.is21Plus,
        isActive: input.isActive,
      },
    });
    await applyDishAssociations(tx, dishId, input);
  });

  return getDish(dishId);
}

async function applyDishAssociations(tx: Tx, dishId: bigint, input: DishWriteInput) {
  if (input.recipe) {
    await tx.recipe.deleteMany({ where: { dishId } });
    if (input.recipe.length) {
      await tx.recipe.createMany({
        data: input.recipe.map((r) => ({ dishId, ingredientId: r.ingredientId, quantity: new Prisma.Decimal(r.quantity) })),
      });
    }
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
  ingredients?: { ingredientId: bigint; quantity: number }[]; // fully replaces dish_option_ingredients when provided
}

export async function createOption(input: Required<Pick<DishOptionWriteInput, "name" | "price">> & DishOptionWriteInput) {
  const option = await prisma.$transaction(async (tx) => {
    const created = await tx.dishOption.create({
      data: { name: input.name, price: new Prisma.Decimal(input.price), description: input.description },
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
  return prisma.allergen.findMany({ orderBy: { name: "asc" } });
}

export function createAllergen(input: { name: string; description?: string }) {
  return prisma.allergen.create({ data: input });
}

export async function updateAllergen(allergenId: bigint, input: { name?: string; description?: string }) {
  const allergen = await prisma.allergen.findUnique({ where: { allergenId } });
  if (!allergen) throw new NotFoundError("Allergen");
  return prisma.allergen.update({ where: { allergenId }, data: input });
}
