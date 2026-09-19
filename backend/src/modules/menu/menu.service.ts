import { prisma } from "../../db/prisma";
import { NotFoundError } from "../../lib/errors";
import { computeAvailabilityForDishes } from "./inventory.service";

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
  const availability = await computeAvailabilityForDishes(allDishIds);

  return categories.map((category) => ({
    categoryId: category.categoryId,
    name: category.name,
    description: category.description,
    imageUrl: category.imageUrl,
    sortOrder: category.sortOrder,
    dishes: category.dishes.map((dish) => ({
      dishId: dish.dishId,
      name: dish.name,
      price: dish.price,
      imageUrl: dish.imageUrl,
      description: dish.description,
      is21Plus: dish.is21Plus,
      available: availability.get(dish.dishId.toString()) ?? true,
    })),
  }));
}

/**
 * ТЗ §3: dish detail adds ingredients, allergens and available options.
 * "ингредиенты здесь только показываются. Они не списываются и не
 * резервируются" — this is a pure read, nothing is written.
 */
export async function getDishDetail(dishId: bigint) {
  const dish = await prisma.dish.findUnique({
    where: { dishId },
    include: {
      category: true,
      recipes: { include: { ingredient: true } },
      allergens: { include: { allergen: true } },
      availableOptions: { include: { option: true } },
    },
  });

  if (!dish || !dish.isActive) {
    throw new NotFoundError("Dish");
  }

  const [available] = [(await computeAvailabilityForDishes([dishId])).get(dishId.toString()) ?? true];

  return {
    dishId: dish.dishId,
    name: dish.name,
    price: dish.price,
    imageUrl: dish.imageUrl,
    description: dish.description,
    is21Plus: dish.is21Plus,
    category: { categoryId: dish.category.categoryId, name: dish.category.name },
    available,
    ingredients: dish.recipes.map((r) => ({
      ingredientId: r.ingredient.ingredientId,
      name: r.ingredient.name,
      quantity: r.quantity,
      unit: r.ingredient.unit,
    })),
    allergens: dish.allergens.map((a) => ({
      allergenId: a.allergen.allergenId,
      name: a.allergen.name,
      description: a.allergen.description,
    })),
    options: dish.availableOptions
      .filter((o) => o.option.isActive)
      .map((o) => ({
        optionId: o.option.optionId,
        name: o.option.name,
        description: o.option.description,
        price: o.option.price,
      })),
  };
}
