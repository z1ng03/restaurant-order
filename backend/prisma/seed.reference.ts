/**
 * REFERENCE seed - idempotent, history-safe, repeatable (TZ §3).
 *
 *   npm run seed:reference
 *
 * It only CREATES what is missing and fills what is empty:
 *   - tables 1..6 (status is never touched),
 *   - the 20 allergen categories (+ synonyms; an old category such as "Глютен" is renamed IN PLACE, keeping its id
 *     and its links, instead of being duplicated),
 *   - ingredients with their allergen tags, a stock record only when none exists (existing stock/reserved is NEVER
 *     changed), categories, dishes, recipes (quantity/step/customizable of an existing recipe line are not
 *     overwritten), dish options,
 *   - a dish description only while it is empty or still the old one (an administrator's text is never replaced),
 *   - staff accounts: ONLY outside production, or in production when SEED_ADMIN_PASSWORD is set (admin only).
 *     An existing account - and its password - is never touched.
 * It never deletes anything, so it is safe to run on a database that already holds orders.
 *
 * In production no demo stock is invented: new ingredients start at 0 and the stock is entered through the admin panel
 * (goods receipt). Everywhere else they start with the quantities from seed.data.ts.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../src/db/prisma";
import { env } from "../src/config/env";
import { hashPassword } from "../src/lib/auth";
import { defaultAdjustmentStep } from "../src/modules/menu/recipeCalculation.service";
import { ALLERGEN_CATEGORIES, CATEGORIES, INGREDIENTS, OPTIONS, STAFF, type AllergenKey } from "./seed.data";

type Log = (message: string) => void;

export interface SeedReport {
  tablesCreated: number;
  allergenCategoriesCreated: number;
  allergenCategoriesRenamed: number;
  ingredientsCreated: number;
  dishesCreated: number;
  descriptionsFilled: number;
  recipeLinesCreated: number;
  staffCreated: string[];
}

export async function seedReference(db: PrismaClient = prisma, log: Log = () => undefined): Promise<SeedReport> {
  const report: SeedReport = {
    tablesCreated: 0, allergenCategoriesCreated: 0, allergenCategoriesRenamed: 0, ingredientsCreated: 0,
    dishesCreated: 0, descriptionsFilled: 0, recipeLinesCreated: 0, staffCreated: [],
  };

  // ---- tables ------------------------------------------------------------------------------
  for (let n = 1; n <= 6; n++) {
    const exists = await db.restaurantTable.findUnique({ where: { tableNumber: n } });
    if (!exists) {
      await db.restaurantTable.create({ data: { tableNumber: n, monitorNumber: n, status: "FREE" } });
      report.tablesCreated++;
    }
  }

  // ---- staff -------------------------------------------------------------------------------
  const adminPasswordFromEnv = process.env.SEED_ADMIN_PASSWORD?.trim();
  for (const staff of STAFF) {
    if (await db.user.findUnique({ where: { login: staff.login } })) continue;
    if (env.isProduction) {
      // Never ship well-known passwords: in production only an admin with an explicit password is created.
      if (staff.role !== "ADMIN" || !adminPasswordFromEnv) continue;
      await db.user.create({ data: { name: staff.name, login: staff.login, passwordHash: await hashPassword(adminPasswordFromEnv), role: staff.role } });
    } else {
      await db.user.create({ data: { name: staff.name, login: staff.login, passwordHash: await hashPassword(staff.password), role: staff.role } });
    }
    report.staffCreated.push(staff.login);
  }
  if (env.isProduction && !adminPasswordFromEnv) log("production: no staff created (set SEED_ADMIN_PASSWORD to create the first admin)");

  // ---- allergen categories -------------------------------------------------------------------
  const allergenId = new Map<AllergenKey, bigint>();
  for (const [index, def] of ALLERGEN_CATEGORIES.entries()) {
    let row = await db.allergen.findUnique({ where: { name: def.name } });
    if (!row) {
      // an older category under a previous name? rename it in place (ids and dish links survive)
      for (const synonym of def.synonyms) {
        const viaSynonym = await db.allergenSynonym.findUnique({ where: { synonym }, include: { allergen: true } });
        const byName = viaSynonym?.allergen ?? (await db.allergen.findUnique({ where: { name: synonym } }));
        if (byName) {
          row = await db.allergen.update({ where: { allergenId: byName.allergenId }, data: { name: def.name } });
          report.allergenCategoriesRenamed++;
          break;
        }
      }
    }
    if (!row) {
      row = await db.allergen.create({ data: { name: def.name, description: def.representatives, sortOrder: index + 1 } });
      report.allergenCategoriesCreated++;
    } else {
      // classification metadata is reference data; a description the administrator wrote is kept
      await db.allergen.update({
        where: { allergenId: row.allergenId },
        data: { sortOrder: index + 1, ...(row.description ? {} : { description: def.representatives }) },
      });
    }
    allergenId.set(def.key, row.allergenId);
    for (const synonym of [def.name, ...def.synonyms]) {
      await db.allergenSynonym.upsert({
        where: { synonym },
        create: { synonym, allergenId: row.allergenId },
        update: { allergenId: row.allergenId },
      });
    }
  }
  const allergen = (key: AllergenKey) => {
    const id = allergenId.get(key);
    if (id === undefined) throw new Error(`seed bug: allergen category "${key}" was not created`);
    return id;
  };

  // ---- ingredients + stock + allergen tags -------------------------------------------------------
  const ingredientId = new Map<string, bigint>();
  for (const def of INGREDIENTS) {
    let ingredient = await db.ingredient.findUnique({ where: { name: def.name } });
    if (!ingredient) {
      ingredient = await db.ingredient.create({ data: { name: def.name, unit: def.unit } });
      report.ingredientsCreated++;
    }
    ingredientId.set(def.name, ingredient.ingredientId);

    const inventory = await db.inventory.findUnique({ where: { ingredientId: ingredient.ingredientId } });
    if (!inventory) {
      const initial = new Prisma.Decimal(env.isProduction ? 0 : def.stock);
      await db.inventory.create({ data: { ingredientId: ingredient.ingredientId, stockQuantity: initial } });
      if (initial.gt(0)) {
        await db.inventoryAdjustment.create({
          data: { ingredientId: ingredient.ingredientId, delta: initial, stockBefore: 0, stockAfter: initial, reason: "INITIAL", comment: "seed:reference - начальный остаток" },
        });
      }
    }
    if (def.tags?.length) {
      await db.ingredientAllergen.createMany({
        data: def.tags.map(([key, kind]) => ({ ingredientId: ingredient.ingredientId, allergenId: allergen(key), kind })),
        skipDuplicates: true, // an administrator's re-tagging of an existing pair is not overwritten
      });
    }
  }
  const ing = (name: string) => {
    const id = ingredientId.get(name);
    if (id === undefined) throw new Error(`seed bug: ingredient "${name}" is not defined`);
    return id;
  };
  const unitOf = new Map(INGREDIENTS.map((i) => [i.name, i.unit]));

  // ---- categories, dishes, recipes ------------------------------------------------------------------
  let sortOrder = 0;
  const dishIdByName = new Map<string, bigint>();
  for (const categoryDef of CATEGORIES) {
    let category = await db.category.findUnique({ where: { name: categoryDef.name } });
    if (!category) {
      category = await db.category.create({ data: { name: categoryDef.name, imageUrl: categoryDef.image, sortOrder } });
    }
    sortOrder++;

    for (const dishDef of categoryDef.dishes) {
      let dish = await db.dish.findFirst({ where: { name: dishDef.name, categoryId: category.categoryId } });
      if (!dish) {
        dish = await db.dish.create({
          data: {
            categoryId: category.categoryId, name: dishDef.name, price: new Prisma.Decimal(dishDef.price), imageUrl: dishDef.image,
            description: dishDef.description, is21Plus: dishDef.is21Plus ?? false,
          },
        });
        report.dishesCreated++;
        for (const key of dishDef.manualAllergens ?? []) {
          await db.dishAllergen.create({ data: { dishId: dish.dishId, allergenId: allergen(key) } });
        }
      } else if (!dish.description || dish.description.trim() === "" || dishDef.legacyDescriptions.includes(dish.description)) {
        if (dish.description !== dishDef.description) {
          await db.dish.update({ where: { dishId: dish.dishId }, data: { description: dishDef.description } });
          report.descriptionsFilled++;
        }
      }
      dishIdByName.set(dishDef.name, dish.dishId);

      for (const line of dishDef.recipe) {
        const base = new Prisma.Decimal(line.quantity);
        const exists = await db.recipe.findUnique({ where: { dishId_ingredientId: { dishId: dish.dishId, ingredientId: ing(line.ingredient) } } });
        if (exists) continue; // never overwrite an existing recipe line
        const step = line.step !== undefined ? new Prisma.Decimal(line.step) : defaultAdjustmentStep(base, unitOf.get(line.ingredient) ?? "kg");
        await db.recipe.create({
          data: { dishId: dish.dishId, ingredientId: ing(line.ingredient), quantity: base, adjustmentStep: step, isCustomizable: line.customizable ?? true },
        });
        report.recipeLinesCreated++;
      }
    }
  }

  // ---- options ------------------------------------------------------------------------------------------
  for (const def of OPTIONS) {
    let option = await db.dishOption.findFirst({ where: { name: def.name } });
    if (!option) {
      option = await db.dishOption.create({
        data: { name: def.name, price: new Prisma.Decimal(def.price), ingredients: { create: [{ ingredientId: ing(def.ingredient), quantity: new Prisma.Decimal(def.quantity) }] } },
      });
    }
    for (const dishName of def.dishes) {
      const dishId = dishIdByName.get(dishName);
      if (dishId === undefined) continue;
      await db.dishAvailableOption.createMany({ data: [{ dishId, optionId: option.optionId }], skipDuplicates: true });
    }
  }

  log(
    `reference seed: +${report.tablesCreated} tables, +${report.allergenCategoriesCreated} allergen categories ` +
      `(${report.allergenCategoriesRenamed} renamed), +${report.ingredientsCreated} ingredients, +${report.dishesCreated} dishes ` +
      `(${report.descriptionsFilled} descriptions filled), +${report.recipeLinesCreated} recipe lines, staff: ${report.staffCreated.join(", ") || "none"}`,
  );
  return report;
}

// Run only when executed directly (`npm run seed:reference`), not when imported by the tests.
if (process.argv[1] && /seed\.reference\.(ts|js)$/.test(process.argv[1])) {
  seedReference(prisma, (m) => console.log(m)) // eslint-disable-line no-console
    .catch((err) => {
      console.error(err); // eslint-disable-line no-console
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
