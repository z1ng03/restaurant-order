import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/db/prisma";
import { isAllowedQuantity } from "../../src/modules/menu/recipeCalculation.service";
import { seedReference } from "../../prisma/seed.reference";
import { ALLERGEN_CATEGORIES, CATEGORIES, INGREDIENTS, OPTIONS } from "../../prisma/seed.data";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { addToCart, api, checkout, openKiosk } from "../helpers/http";

const counts = async () => ({
  tables: await prisma.restaurantTable.count(),
  allergens: await prisma.allergen.count(),
  synonyms: await prisma.allergenSynonym.count(),
  ingredients: await prisma.ingredient.count(),
  inventory: await prisma.inventory.count(),
  tags: await prisma.ingredientAllergen.count(),
  categories: await prisma.category.count(),
  dishes: await prisma.dish.count(),
  recipes: await prisma.recipe.count(),
  options: await prisma.dishOption.count(),
  optionLinks: await prisma.dishAvailableOption.count(),
  users: await prisma.user.count(),
  manual: await prisma.dishAllergen.count(),
});

describe.skipIf(!hasTestDatabase)("seed:reference is idempotent and history-safe", () => {
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase());

  it("builds the full reference data; every dish is described; every recipe line has a valid step", async () => {
    await seedReference();
    const c = await counts();
    expect(c).toMatchObject({ tables: 6, allergens: 20, ingredients: INGREDIENTS.length, inventory: INGREDIENTS.length, categories: CATEGORIES.length, dishes: 18, options: OPTIONS.length, users: 3 });
    expect(ALLERGEN_CATEGORIES).toHaveLength(20);

    const dishes = await prisma.dish.findMany({ include: { recipes: { include: { ingredient: true } } } });
    for (const d of dishes) {
      expect(d.description?.trim().length ?? 0, d.name).toBeGreaterThan(20);
      expect(d.recipes.length, d.name).toBeGreaterThan(0);
      for (const r of d.recipes) {
        expect(r.adjustmentStep.gt(0), `${d.name}/${r.ingredient.name}`).toBe(true);
        expect(isAllowedQuantity(r.quantity, r.quantity, r.adjustmentStep), `${d.name}/${r.ingredient.name}: base must be an allowed point`).toBe(true);
        expect(r.quantity.mul(3).gte(r.adjustmentStep), `${d.name}/${r.ingredient.name}`).toBe(true);
      }
    }
    expect(new Set(dishes.map((d) => d.description)).size).toBe(18); // no two dishes share a text
    // 21+ products are flagged, alcohol and hookah lines are not guest-customizable
    expect(dishes.filter((d) => d.is21Plus).map((d) => d.name).sort()).toEqual(["Авторский коктейль", "Кальян Classic", "Кальян Fruit", "Кальян Premium", "Красное вино", "Светлое пиво"]);
    expect((await prisma.recipe.findFirstOrThrow({ where: { dish: { name: "Светлое пиво" } } })).isCustomizable).toBe(false);
    // an ingredient is tagged where it belongs: milk on parmesan, gluten on spaghetti, traces as MAY_CONTAIN
    const tagOf = async (ingredient: string, key: string) => {
      const a = ALLERGEN_CATEGORIES.find((x) => x.key === key)!;
      return prisma.ingredientAllergen.findFirst({ where: { ingredient: { name: ingredient }, allergen: { name: a.name } } });
    };
    expect(await tagOf("Сыр пармезан", "milk")).toMatchObject({ kind: "CONTAINS" });
    expect(await tagOf("Спагетти", "gluten")).toMatchObject({ kind: "CONTAINS" });
    expect(await tagOf("Бекон", "soy")).toMatchObject({ kind: "MAY_CONTAIN" });
    // every ingredient has its stock record and the initial stock is journaled
    expect(await prisma.inventoryAdjustment.count({ where: { reason: "INITIAL" } })).toBe(INGREDIENTS.length);
  });

  it("running it again changes nothing", async () => {
    await seedReference();
    const before = await counts();
    const second = await seedReference();
    expect(second).toEqual({ tablesCreated: 0, allergenCategoriesCreated: 0, allergenCategoriesRenamed: 0, ingredientsCreated: 0, dishesCreated: 0, descriptionsFilled: 0, recipeLinesCreated: 0, staffCreated: [] });
    expect(await counts()).toEqual(before);
  });

  it("keeps history and live stock: an existing order, its reservations and the stock are untouched by a re-seed", async () => {
    await seedReference();
    const k = await openKiosk(1);
    const carbonara = (await prisma.dish.findFirstOrThrow({ where: { name: "Паста Карбонара" } })).dishId;
    expect((await addToCart(k, { dishId: carbonara.toString(), quantity: 2 })).status).toBe(201);
    expect((await checkout(k, { paymentMethod: "CASH" })).status).toBe(201);
    const snapshot = async () => ({
      inventory: (await prisma.inventory.findMany({ orderBy: { ingredientId: "asc" } })).map((i) => [i.ingredientId, i.stockQuantity.toFixed(3), i.reservedQuantity.toFixed(3)]),
      orders: await prisma.order.count(),
      reservations: await prisma.inventoryReservation.count({ where: { status: "RESERVED" } }),
      table: (await prisma.restaurantTable.findFirstOrThrow({ where: { tableNumber: 1 } })).status,
    });
    const before = await snapshot();
    await seedReference();
    expect(await snapshot()).toEqual(before);
    expect(before.table).toBe("OCCUPIED"); // the seed never frees a table
  });

  it("an old allergen category is renamed IN PLACE (no duplicate, links survive); administrator texts survive; old texts are upgraded", async () => {
    await seedReference();
    // simulate a database created by the previous seed: category "Глютен" with a manual dish link
    const glutenName = ALLERGEN_CATEGORIES.find((a) => a.key === "gluten")!.name;
    const gluten = await prisma.allergen.findUniqueOrThrow({ where: { name: glutenName } });
    await prisma.allergen.update({ where: { allergenId: gluten.allergenId }, data: { name: "Глютен" } });
    await prisma.allergenSynonym.deleteMany(); // as if synonyms did not exist yet
    const dish = await prisma.dish.findFirstOrThrow({ where: { name: "Паста Карбонара" } });
    await prisma.dishAllergen.create({ data: { dishId: dish.dishId, allergenId: gluten.allergenId } });

    const custom = await prisma.dish.findFirstOrThrow({ where: { name: "Картофель фри" } });
    await prisma.dish.update({ where: { dishId: custom.dishId }, data: { description: "Наш фирменный текст." } });
    await prisma.dish.update({ where: { dishId: dish.dishId }, data: { description: "Классическая паста в нежном сливочном соусе с беконом и сыром." } }); // the OLD seed text

    const report = await seedReference();
    expect(report.allergenCategoriesRenamed).toBe(1);
    expect(report.allergenCategoriesCreated).toBe(0);
    expect(await prisma.allergen.count()).toBe(20);
    expect(await prisma.allergen.findUniqueOrThrow({ where: { allergenId: gluten.allergenId } })).toMatchObject({ name: glutenName });
    expect(await prisma.dishAllergen.count({ where: { allergenId: gluten.allergenId } })).toBe(1); // the link kept its category
    expect((await prisma.dish.findUniqueOrThrow({ where: { dishId: custom.dishId } })).description).toBe("Наш фирменный текст."); // never overwritten
    expect((await prisma.dish.findUniqueOrThrow({ where: { dishId: dish.dishId } })).description).toContain("Спагетти в сливочном соусе"); // upgraded
    expect(report.descriptionsFilled).toBe(1);
  });

  it("an edited recipe line, price or ingredient state is never reset by the seed", async () => {
    await seedReference();
    const dish = await prisma.dish.findFirstOrThrow({ where: { name: "Паста Карбонара" } });
    const parmesan = await prisma.ingredient.findFirstOrThrow({ where: { name: "Сыр пармезан" } });
    await prisma.recipe.update({ where: { dishId_ingredientId: { dishId: dish.dishId, ingredientId: parmesan.ingredientId } }, data: { quantity: "0.100", adjustmentStep: "0.050", isCustomizable: false } });
    await prisma.dish.update({ where: { dishId: dish.dishId }, data: { price: 9999, isActive: false } });
    await prisma.ingredient.update({ where: { ingredientId: parmesan.ingredientId }, data: { isActive: false } });
    await prisma.inventory.update({ where: { ingredientId: parmesan.ingredientId }, data: { stockQuantity: "0.250" } });
    await seedReference();
    expect(await prisma.recipe.findUniqueOrThrow({ where: { dishId_ingredientId: { dishId: dish.dishId, ingredientId: parmesan.ingredientId } } })).toMatchObject({ isCustomizable: false });
    expect((await prisma.dish.findUniqueOrThrow({ where: { dishId: dish.dishId } })).price.toFixed(0)).toBe("9999");
    expect((await prisma.dish.findUniqueOrThrow({ where: { dishId: dish.dishId } })).isActive).toBe(false);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { ingredientId: parmesan.ingredientId } })).isActive).toBe(false);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { ingredientId: parmesan.ingredientId } })).stockQuantity.toFixed(3)).toBe("0.250");
  });

  it("production: no well-known passwords and no invented stock", async () => {
    const flag = env as { isProduction: boolean };
    const previous = process.env.SEED_ADMIN_PASSWORD;
    flag.isProduction = true;
    try {
      delete process.env.SEED_ADMIN_PASSWORD;
      const first = await seedReference();
      expect(first.staffCreated).toEqual([]);
      expect(await prisma.user.count()).toBe(0);
      expect((await prisma.inventory.findMany()).every((i) => i.stockQuantity.isZero())).toBe(true);
      expect(await prisma.inventoryAdjustment.count()).toBe(0);
      process.env.SEED_ADMIN_PASSWORD = "a-strong-production-password-1";
      const second = await seedReference();
      expect(second.staffCreated).toEqual(["admin"]); // only the admin, with the password the operator chose
      const login = await api().post("/api/auth/login").send({ login: "admin", password: "a-strong-production-password-1" });
      expect(login.status).toBe(200);
      expect((await api().post("/api/auth/login").send({ login: "admin", password: "admin123" })).status).toBe(401);
    } finally {
      flag.isProduction = false;
      if (previous === undefined) delete process.env.SEED_ADMIN_PASSWORD;
      else process.env.SEED_ADMIN_PASSWORD = previous;
    }
  });
});
