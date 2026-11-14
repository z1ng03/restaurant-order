import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { auditInventory, repairInventory } from "../../src/modules/admin/admin.audit.service";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, stock, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk } from "../helpers/http";

const s = (v: bigint) => v.toString();

describe.skipIf(!hasTestDatabase)("menu availability, configuration check and the admin catalog", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
  });
  const admin = () => auth(cat.staff.admin.token);

  describe("menu", () => {
    it("availability is computed from recipe + stock + reservations; an empty recipe is NOT 'free'", async () => {
      const menu = (await api().get("/api/menu")).body.categories as { dishes: { name: string; available: boolean; unavailableReason: string | null; unavailableMessage: string | null }[] }[];
      const dish = (name: string) => menu.flatMap((c) => c.dishes).find((d) => d.name === name)!;
      expect(dish("Паста Карбонара")).toMatchObject({ available: true, unavailableReason: null });
      expect(dish("Лимонад").available).toBe(true);
      expect(dish("Вода")).toMatchObject({ available: true }); // stock explicitly not tracked
      expect(dish("Загадка")).toMatchObject({ available: false, unavailableReason: "NO_RECIPE" }); // tracked + no recipe
      expect(dish("Джелато")).toMatchObject({ available: false, unavailableReason: "INSUFFICIENT_STOCK", unavailableMessage: "Нет в наличии: cream" });
      expect(dish("Суп с шафраном")).toMatchObject({ available: false, unavailableReason: "INGREDIENT_INACTIVE" });
    });

    it("reservations reduce availability: free = stock − reserved", async () => {
      await prisma.inventory.update({ where: { ingredientId: cat.ing.lemon! }, data: { stockQuantity: "1.000" } }); // 2 lemonades
      const k = await openKiosk(1);
      await addToCart(k, { dishId: s(cat.dish.lemonade!), quantity: 2 });
      expect((await checkout(k, { paymentMethod: "CASH" })).status).toBe(201);
      const menu = (await api().get("/api/menu")).body.categories as { dishes: { name: string; available: boolean }[] }[];
      expect(menu.flatMap((c) => c.dishes).find((d) => d.name === "Лимонад")!.available).toBe(false);
    });

    it("dish detail exposes the personalisation limits, allergens (manual AND derived) and option availability", async () => {
      await prisma.dishAllergen.create({ data: { dishId: cat.dish.carbonara!, allergenId: cat.allergen.egg! } }); // manual administrator warning
      const d = (await api().get(`/api/menu/dishes/${cat.dish.carbonara}`)).body.dish;
      expect(d.available).toBe(true);
      const parmesan = d.ingredients.find((i: { name: string }) => i.name === "parmesan");
      expect(parmesan).toMatchObject({ unit: "kg", baseQuantity: "0.040", stepQuantity: "0.020", selectedQuantity: "0.040", minQuantity: "0.000", maxQuantity: "0.120", customizable: true, quantity: "0.040" });
      expect(d.ingredients.find((i: { name: string }) => i.name === "egg")).toMatchObject({ customizable: false });
      expect(d.allergens.map((a: { name: string }) => a.name)).toEqual(["Яйца"]); // legacy manual list is kept
      expect(d.allergenGroups.map((g: { categoryName: string }) => g.categoryName)).toEqual(["Молоко и молочные продукты", "Яйца", "Пшеница и другие злаки с глютеном"]);
      expect(d.allergenGroups[0]).toMatchObject({ ingredients: [{ name: "parmesan", kind: "CONTAINS" }] });
      expect(d.options.map((o: { name: string; available: boolean }) => [o.name, o.available])).toEqual([["Доп. бекон", true], ["Салфетки", true]]);
      expect((await api().get("/api/menu/dishes/999999")).status).toBe(404);
    });

    it("check-configuration: this exact composition may be unavailable even if the standard dish is fine; allergen groups follow the choice", async () => {
      await prisma.inventory.update({ where: { ingredientId: cat.ing.parmesan! }, data: { stockQuantity: "0.100" } });
      const check = (body: Record<string, unknown>) => api().post(`/api/menu/dishes/${cat.dish.carbonara}/check-configuration`).send(body);
      const std = await check({ quantity: 1 });
      expect(std.body).toMatchObject({ configurationAvailable: true, baseAvailable: true, issues: [] });
      const heavy = await check({ quantity: 1, ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.120" }] });
      // 4 recipe ingredients: extra 2x the original parmesan adds 3200 / 4 * 2 = 1600.
      expect(heavy.body.totalUnitPrice).toBe("4800.00");
      expect(heavy.body.configurationAvailable).toBe(false);
      expect(heavy.body.issues[0]).toMatchObject({ ingredientName: "parmesan", needed: "0.12", free: "0.1", message: expect.stringContaining("Не хватает") });
      // removing the parmesan removes the milk group
      const noCheese = await check({ quantity: 1, ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: 0 }] });
      expect(noCheese.body.allergenGroups.map((g: { categoryName: string }) => g.categoryName)).not.toContain("Молоко и молочные продукты");
      expect((await check({ quantity: 1, ingredients: [{ ingredientId: s(cat.ing.parmesan!), quantity: "0.030" }] })).body.error.code).toBe("INVALID_INGREDIENT_STEP");
    });

    it("no tracked stock check for an explicitly untracked dish; a tracked dish with no recipe cannot be added to a cart", async () => {
      const k = await openKiosk(1);
      expect((await addToCart(k, { dishId: s(cat.dish.water!), quantity: 3 })).status).toBe(201);
      const mystery = await addToCart(k, { dishId: s(cat.dish.mystery!), quantity: 1 });
      expect([mystery.status, mystery.body.error.code]).toEqual([409, "DISH_UNAVAILABLE"]);
      const soup = await addToCart(k, { dishId: s(cat.dish.soup!), quantity: 1 });
      expect([soup.status, soup.body.error.code]).toEqual([409, "DISH_UNAVAILABLE"]);
      expect((await checkout(k, { paymentMethod: "CASH" })).status).toBe(201); // water needs no stock
    });
  });

  describe("admin: stock", () => {
    it("never lets stock fall below what is reserved, and journals every change", async () => {
      const k = await openKiosk(1);
      await addToCart(k, { dishId: s(cat.dish.carbonara!), quantity: 2 }); // pasta 0.3
      await checkout(k, { paymentMethod: "CASH" });
      const set = (v: unknown, extra: Record<string, unknown> = {}) => api().patch(`/api/admin/ingredients/${cat.ing.pasta}/stock`).set(admin()).send({ stockQuantity: v, ...extra });
      const refused = await set(0.2);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: "STOCK_BELOW_RESERVED", details: { reserved: "0.3", requested: "0.2" } });
      expect(refused.body.error.message).toContain("300 г");
      expect(await stock(cat.ing.pasta!)).toEqual({ stock: "10.000", reserved: "0.300" });
      expect((await set(-1)).status).toBe(400);
      expect((await set("abc")).status).toBe(400);
      expect((await set(0.3, { reason: "CORRECTION", comment: "пересчёт" })).status).toBe(200);
      expect((await api().post(`/api/admin/ingredients/${cat.ing.pasta}/stock/write-off`).set(admin()).send({ quantity: 0.1, comment: "порча" })).status).toBe(409);
      expect((await api().post(`/api/admin/ingredients/${cat.ing.pasta}/stock/receive`).set(admin()).send({ quantity: "2.5", comment: "поставка" })).status).toBe(200);
      expect(await stock(cat.ing.pasta!)).toEqual({ stock: "2.800", reserved: "0.300" });

      const journal = (await api().get(`/api/admin/inventory-adjustments?ingredientId=${cat.ing.pasta}`).set(admin())).body.adjustments;
      expect(journal.map((j: { reason: string; delta: string; stockBefore: string; stockAfter: string }) => [j.reason, j.delta, j.stockBefore, j.stockAfter])).toEqual([
        ["RECEIPT", "2.500", "0.300", "2.800"],
        ["CORRECTION", "-9.700", "10.000", "0.300"],
      ]);
      expect(journal[1]).toMatchObject({ comment: "пересчёт", actorName: "Test admin", ingredientName: "pasta" });
      expect((await auditInventory()).ok).toBe(true);
    });

    it("the unit of an ingredient that is in use cannot be changed", async () => {
      const res = await api().patch(`/api/admin/ingredients/${cat.ing.pasta}`).set(admin()).send({ unit: "g" });
      expect([res.status, res.body.error.code]).toEqual([409, "UNIT_CHANGE_FORBIDDEN"]);
      // a brand-new ingredient WITH stock is also protected (1 "kg" must not silently become 1 "g")...
      const salt = (await api().post("/api/admin/ingredients").set(admin()).send({ name: "salt", unit: "kg", initialStock: 1 })).body.ingredient;
      expect((await api().patch(`/api/admin/ingredients/${salt.ingredientId}`).set(admin()).send({ unit: "g" })).body.error.code).toBe("UNIT_CHANGE_FORBIDDEN");
      expect((await api().get(`/api/admin/inventory-adjustments?ingredientId=${salt.ingredientId}`).set(admin())).body.adjustments[0]).toMatchObject({ reason: "INITIAL", delta: "1.000" });
      // ... while one nothing refers to yet (no stock, no recipe) can still be corrected
      const pepper = (await api().post("/api/admin/ingredients").set(admin()).send({ name: "pepper", unit: "kg", initialStock: 0 })).body.ingredient;
      expect((await api().patch(`/api/admin/ingredients/${pepper.ingredientId}`).set(admin()).send({ unit: "g" })).status).toBe(200);
    });

    it("the audit finds drift but only repairs what is provably safe, and only when asked to", async () => {
      expect((await api().get("/api/admin/inventory-audit").set(admin())).body.ok).toBe(true);
      await prisma.inventory.update({ where: { ingredientId: cat.ing.beer! }, data: { reservedQuantity: "0.500" } }); // no matching reservation
      const bad = (await api().get("/api/admin/inventory-audit").set(admin())).body;
      expect(bad.ok).toBe(false);
      expect(bad.mismatches[0]).toMatchObject({ name: "beer", reserved: "0.5", reservedFromReservations: "0", difference: "0.5" });
      const dry = await repairInventory(false);
      expect(dry).toMatchObject({ applied: false, steps: [{ name: "beer", from: "0.5", to: "0" }] });
      expect((await stock(cat.ing.beer!)).reserved).toBe("0.500"); // a dry run changes nothing
      expect((await repairInventory(true)).applied).toBe(true);
      expect((await stock(cat.ing.beer!)).reserved).toBe("0.000");
      expect((await auditInventory()).ok).toBe(true);
    });
  });

  describe("admin: dishes, recipes, allergens", () => {
    const dishBody = (over: Record<string, unknown> = {}) => ({
      categoryId: s(cat.tables[0]!.tableId) === "1" ? undefined : undefined,
      name: "Новое блюдо", price: 1000, description: "Нежное блюдо из сливок и трав.", ...over,
    });
    const categoryId = async () => s((await prisma.category.findFirstOrThrow()).categoryId);

    it("an active dish must have a description; a recipe needs valid, unique lines and gets a default step", async () => {
      const base = { categoryId: await categoryId(), name: "Новое", price: 1000 };
      const noDesc = await api().post("/api/admin/dishes").set(admin()).send(base);
      expect([noDesc.status, noDesc.body.error.code]).toEqual([400, "VALIDATION_ERROR"]);
      expect((await api().post("/api/admin/dishes").set(admin()).send({ ...base, description: "   " })).status).toBe(400);
      expect((await api().post("/api/admin/dishes").set(admin()).send({ ...base, isActive: false })).status).toBe(201); // a draft may be empty

      const dup = await api().post("/api/admin/dishes").set(admin()).send({ ...base, name: "Д2", description: "Ок.", recipe: [{ ingredientId: s(cat.ing.pasta!), quantity: 0.1 }, { ingredientId: s(cat.ing.pasta!), quantity: 0.2 }] });
      expect(dup.status).toBe(400);
      const badStep = await api().post("/api/admin/dishes").set(admin()).send({ ...base, name: "Д3", description: "Ок.", recipe: [{ ingredientId: s(cat.ing.egg!), quantity: 1, adjustmentStep: 0.5 }] });
      expect(badStep.status).toBe(400); // whole pieces must move in whole steps
      expect((await api().post("/api/admin/dishes").set(admin()).send({ ...base, name: "Д4", description: "Ок.", recipe: [{ ingredientId: s(cat.ing.pasta!), quantity: 0 }] })).status).toBe(400);

      const ok = await api().post("/api/admin/dishes").set(admin()).send({ ...base, name: "Д5", description: "Ок.", recipe: [{ ingredientId: s(cat.ing.pasta!), quantity: 0.2 }, { ingredientId: s(cat.ing.egg!), quantity: 2, isCustomizable: false }] });
      expect(ok.status).toBe(201);
      const rows = await prisma.recipe.findMany({ where: { dishId: BigInt(ok.body.dish.dishId) }, orderBy: { recipeId: "asc" } });
      expect(rows.map((r) => [r.quantity.toFixed(3), r.adjustmentStep.toFixed(3), r.isCustomizable])).toEqual([["0.200", "0.100", true], ["2.000", "1.000", false]]);
      // deactivating needs no description change, but re-activating a blank one is refused
      const blank = await prisma.dish.create({ data: { categoryId: BigInt(await categoryId()), name: "Пустое", price: 1, isActive: false } });
      expect((await api().patch(`/api/admin/dishes/${blank.dishId}`).set(admin()).send({ isActive: true })).status).toBe(400);
    });

    it("ingredient allergen tags: list, add, replace - with contains / may-contain", async () => {
      const list = (await api().get("/api/admin/ingredient-allergens").set(admin())).body.ingredients;
      expect(list.find((i: { name: string }) => i.name === "parmesan").allergens).toEqual([{ allergenId: cat.allergen.milk!.toString(), name: "Молоко и молочные продукты", kind: "CONTAINS" }]);
      expect((await api().post("/api/admin/ingredient-allergens").set(admin()).send({ ingredientId: s(cat.ing.bacon!), allergenId: s(cat.allergen.gluten!), kind: "MAY_CONTAIN" })).status).toBe(201);
      const replaced = await api().patch(`/api/admin/ingredient-allergens/${cat.ing.bacon}`).set(admin()).send({ allergens: [{ allergenId: s(cat.allergen.milk!), kind: "CONTAINS" }] });
      expect(replaced.body.allergens).toEqual([{ allergenId: s(cat.allergen.milk!), name: "Молоко и молочные продукты", kind: "CONTAINS" }]);
      expect((await api().patch(`/api/admin/ingredient-allergens/${cat.ing.bacon}`).set(admin()).send({ allergens: [{ allergenId: "999999" }] })).status).toBe(400);
      expect((await api().patch(`/api/admin/ingredient-allergens/${cat.ing.bacon}`).set(admin()).send({ allergens: [{ allergenId: s(cat.allergen.milk!) }, { allergenId: s(cat.allergen.milk!) }] })).status).toBe(400);
      expect((await api().get("/api/admin/ingredient-allergens").set(auth(cat.staff.waiter.token))).status).toBe(403);
    });

    it("every new admin endpoint is admin-only", async () => {
      for (const [method, path] of [["get", "/api/admin/inventory-audit"], ["get", "/api/admin/loyalty-audit"], ["get", "/api/admin/receipts"], ["get", "/api/admin/inventory-adjustments"], ["get", "/api/admin/ingredient-allergens"]] as const) {
        expect((await api()[method](path)).status, path).toBe(401);
        expect((await api()[method](path).set(auth(cat.staff.chef.token))).status, path).toBe(403);
      }
      void dishBody;
    });
  });
});
