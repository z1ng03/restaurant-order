import { Prisma } from "@prisma/client";
import { prisma } from "../../src/db/prisma";
import { hashPassword, signStaffToken, type StaffRole } from "../../src/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);

export interface Catalog {
  tables: { tableId: bigint; monitorNumber: number }[];
  staff: Record<"admin" | "chef" | "waiter", { userId: bigint; login: string; password: string; token: string }>;
  ing: Record<string, bigint>;
  dish: Record<string, bigint>;
  option: Record<string, bigint>;
  allergen: Record<string, bigint>;
}

/**
 * A small, deterministic catalog that exercises every rule of the TZ:
 *  carbonara  - tracked recipe with steps, one paid option that adds bacon, milk/egg/gluten allergens
 *  lemonade   - fractional pcs recipe (half a lemon)
 *  beer       - 21+, may-contain gluten
 *  water      - stock NOT tracked (explicit)          -> available without any recipe
 *  mystery    - tracked but NO recipe                  -> unavailable (NO_RECIPE)
 *  gelato     - recipe needs an ingredient with 0 stock -> unavailable (INSUFFICIENT_STOCK)
 *  soup       - recipe needs an INACTIVE ingredient     -> unavailable (INGREDIENT_INACTIVE)
 */
export async function seedCatalog(): Promise<Catalog> {
  const tables = [];
  for (const n of [1, 2, 3]) {
    const t = await prisma.restaurantTable.create({ data: { tableNumber: n, monitorNumber: n } });
    tables.push({ tableId: t.tableId, monitorNumber: n });
  }

  const staff = {} as Catalog["staff"];
  for (const [key, role] of [["admin", "ADMIN"], ["chef", "CHEF"], ["waiter", "WAITER"]] as const) {
    const password = `${key}-pass-1234`;
    const user = await prisma.user.create({
      data: { name: `Test ${key}`, login: key, passwordHash: await hashPassword(password), role },
    });
    staff[key] = {
      userId: user.userId,
      login: key,
      password,
      token: signStaffToken({ userId: user.userId.toString(), login: key, name: user.name, role: role as StaffRole }),
    };
  }

  const ingDefs: [string, string, string, boolean][] = [
    ["parmesan", "kg", "1.000", true],
    ["pasta", "kg", "10.000", true],
    ["bacon", "kg", "2.000", true],
    ["egg", "pcs", "100", true],
    ["lemon", "pcs", "20", true],
    ["beer", "l", "50.000", true],
    ["cream", "l", "0.000", true],
    ["saffron", "g", "100", false],
  ];
  const ing: Record<string, bigint> = {};
  for (const [name, unit, stock, active] of ingDefs) {
    const i = await prisma.ingredient.create({ data: { name, unit, isActive: active } });
    await prisma.inventory.create({ data: { ingredientId: i.ingredientId, stockQuantity: D(stock) } });
    ing[name] = i.ingredientId;
  }

  const cat = await prisma.category.create({ data: { name: "Паста", sortOrder: 1 } });
  const drinks = await prisma.category.create({ data: { name: "Напитки", sortOrder: 2 } });

  const dishDefs: [string, bigint, string, string, boolean, boolean][] = [
    ["carbonara", cat.categoryId, "Паста Карбонара", "3200", false, true],
    ["lemonade", drinks.categoryId, "Лимонад", "1200", false, true],
    ["beer", drinks.categoryId, "Пиво", "1500", true, true],
    ["water", drinks.categoryId, "Вода", "300", false, false],
    ["mystery", cat.categoryId, "Загадка", "1000", false, true],
    ["gelato", cat.categoryId, "Джелато", "900", false, true],
    ["soup", cat.categoryId, "Суп с шафраном", "2000", false, true],
  ];
  const dish: Record<string, bigint> = {};
  for (const [key, categoryId, name, price, is21, tracked] of dishDefs) {
    const d = await prisma.dish.create({
      data: {
        categoryId,
        name,
        price: D(price),
        description: `Тестовое описание блюда «${name}».`,
        is21Plus: is21,
        inventoryTracked: tracked,
      },
    });
    dish[key] = d.dishId;
  }

  const recipe = async (dishKey: string, ingKey: string, qty: string, step: string, customizable = true) =>
    prisma.recipe.create({
      data: { dishId: dish[dishKey]!, ingredientId: ing[ingKey]!, quantity: D(qty), adjustmentStep: D(step), isCustomizable: customizable },
    });
  await recipe("carbonara", "parmesan", "0.040", "0.020");
  await recipe("carbonara", "pasta", "0.150", "0.075");
  await recipe("carbonara", "bacon", "0.080", "0.040");
  await recipe("carbonara", "egg", "1", "1", false); // eggs are not customizable
  await recipe("lemonade", "lemon", "0.5", "0.5");
  await recipe("beer", "beer", "0.5", "0.25");
  await recipe("gelato", "cream", "0.1", "0.05");
  await recipe("soup", "saffron", "2", "1");

  const extraBacon = await prisma.dishOption.create({ data: { name: "Доп. бекон", price: D("500") } });
  await prisma.dishOptionIngredient.create({ data: { optionId: extraBacon.optionId, ingredientId: ing.bacon!, quantity: D("0.050") } });
  const napkins = await prisma.dishOption.create({ data: { name: "Салфетки", price: D("0"), inventoryTracked: false } });
  await prisma.dishAvailableOption.createMany({
    data: [
      { dishId: dish.carbonara!, optionId: extraBacon.optionId },
      { dishId: dish.carbonara!, optionId: napkins.optionId },
      { dishId: dish.lemonade!, optionId: napkins.optionId },
    ],
  });

  const allergen: Record<string, bigint> = {};
  for (const [i, name] of ["Молоко и молочные продукты", "Яйца", "Пшеница и другие злаки с глютеном"].entries()) {
    const a = await prisma.allergen.create({ data: { name, sortOrder: i + 1, description: `Категория: ${name}` } });
    allergen[["milk", "egg", "gluten"][i]!] = a.allergenId;
  }
  await prisma.ingredientAllergen.createMany({
    data: [
      { ingredientId: ing.parmesan!, allergenId: allergen.milk!, kind: "CONTAINS" },
      { ingredientId: ing.egg!, allergenId: allergen.egg!, kind: "CONTAINS" },
      { ingredientId: ing.pasta!, allergenId: allergen.gluten!, kind: "CONTAINS" },
      { ingredientId: ing.beer!, allergenId: allergen.gluten!, kind: "MAY_CONTAIN" },
    ],
  });

  return { tables, staff, ing, dish, option: { extraBacon: extraBacon.optionId, napkins: napkins.optionId }, allergen };
}

export async function stock(ingredientId: bigint) {
  const inv = await prisma.inventory.findUniqueOrThrow({ where: { ingredientId } });
  return { stock: inv.stockQuantity.toFixed(3), reserved: inv.reservedQuantity.toFixed(3) };
}
