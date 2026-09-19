/**
 * Seeds the database with:
 *  - 3 staff accounts (admin / waiter / chef) so the kitchen & waiter
 *    monitors and the age-verification flow are immediately testable
 *  - 6 tables (numbers 1-6, one monitor each)
 *  - The exact same 6 categories / 18 dishes already hardcoded in
 *    frontend/script.js's MENU constant, now backed by real
 *    ingredients/recipes/inventory so availability is computed instead of
 *    assumed, plus a few dish options and allergens
 *
 * Run with `npm run seed` after migrating. Safe to re-run: it clears the
 * catalog/staff/table tables first (never touches live orders/sessions —
 * this is meant for a fresh dev database, not production reseeding).
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";

const prisma = new PrismaClient();

async function main() {
  console.log("Clearing existing catalog/staff/table data...");
  await prisma.dishAllergen.deleteMany();
  await prisma.allergen.deleteMany();
  await prisma.dishAvailableOption.deleteMany();
  await prisma.dishOptionIngredient.deleteMany();
  await prisma.dishOption.deleteMany();
  await prisma.recipe.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.ingredient.deleteMany();
  await prisma.dish.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.restaurantTable.deleteMany();

  console.log("Creating staff users...");
  const [admin, waiter, chef] = await Promise.all([
    prisma.user.create({
      data: { name: "Админ", login: "admin", passwordHash: await hashPassword("admin123"), role: "ADMIN" },
    }),
    prisma.user.create({
      data: { name: "Айгерим", login: "aigerim", passwordHash: await hashPassword("waiter123"), role: "WAITER" },
    }),
    prisma.user.create({
      data: { name: "Марат", login: "marat", passwordHash: await hashPassword("chef123"), role: "CHEF" },
    }),
  ]);
  console.log(`  admin/admin123 (#${admin.userId}), aigerim/waiter123 (#${waiter.userId}), marat/chef123 (#${chef.userId})`);

  console.log("Creating tables...");
  for (let n = 1; n <= 6; n++) {
    await prisma.restaurantTable.create({ data: { tableNumber: n, monitorNumber: n, status: "FREE" } });
  }

  console.log("Creating ingredients + starting inventory...");
  const ingredientDefs: { name: string; unit: string; stock: number }[] = [
    { name: "Говядина", unit: "kg", stock: 15 },
    { name: "Куриное филе", unit: "kg", stock: 20 },
    { name: "Сладкий перец", unit: "kg", stock: 8 },
    { name: "Цукини", unit: "kg", stock: 6 },
    { name: "Томаты", unit: "kg", stock: 10 },
    { name: "Растительное масло", unit: "l", stock: 10 },
    { name: "Спагетти", unit: "kg", stock: 12 },
    { name: "Бекон", unit: "kg", stock: 6 },
    { name: "Сливки", unit: "l", stock: 8 },
    { name: "Яйцо", unit: "pcs", stock: 120 },
    { name: "Сыр пармезан", unit: "kg", stock: 5 },
    { name: "Чеснок", unit: "kg", stock: 3 },
    { name: "Паприка", unit: "kg", stock: 2 },
    { name: "Прованские травы", unit: "kg", stock: 1.5 },
    { name: "Салат романо", unit: "kg", stock: 6 },
    { name: "Сухарики", unit: "kg", stock: 3 },
    { name: "Соус Цезарь", unit: "l", stock: 4 },
    { name: "Огурцы", unit: "kg", stock: 8 },
    { name: "Красный лук", unit: "kg", stock: 4 },
    { name: "Маслины", unit: "kg", stock: 3 },
    { name: "Сыр фета", unit: "kg", stock: 5 },
    { name: "Оливковое масло", unit: "l", stock: 6 },
    { name: "Сыр моцарелла", unit: "kg", stock: 8 },
    { name: "Базилик", unit: "kg", stock: 1.5 },
    { name: "Бальзамический соус", unit: "l", stock: 2 },
    { name: "Картофель", unit: "kg", stock: 25 },
    { name: "Пшеничная панировка", unit: "kg", stock: 6 },
    { name: "Газированная вода Cola", unit: "l", stock: 20 },
    { name: "Лимон", unit: "pcs", stock: 60 },
    { name: "Лайм", unit: "pcs", stock: 60 },
    { name: "Мята", unit: "kg", stock: 1 },
    { name: "Сахарный сироп", unit: "l", stock: 5 },
    { name: "Апельсиновый сок", unit: "l", stock: 10 },
    { name: "Кальянная смесь Classic", unit: "kg", stock: 3 },
    { name: "Кальянная смесь Premium", unit: "kg", stock: 2 },
    { name: "Свежий фрукт для кальяна", unit: "kg", stock: 4 },
    { name: "Уголь", unit: "kg", stock: 10 },
    { name: "Красное вино", unit: "l", stock: 9 },
    { name: "Светлое пиво", unit: "l", stock: 15 },
    { name: "Джин", unit: "l", stock: 4 },
    { name: "Тоник", unit: "l", stock: 6 },
  ];
  const ingredients = new Map<string, { ingredientId: bigint }>();
  for (const def of ingredientDefs) {
    const ingredient = await prisma.ingredient.create({ data: { name: def.name, unit: def.unit } });
    await prisma.inventory.create({
      data: { ingredientId: ingredient.ingredientId, stockQuantity: new Prisma.Decimal(def.stock), reservedQuantity: 0 },
    });
    ingredients.set(def.name, ingredient);
  }
  const ing = (name: string) => {
    const found = ingredients.get(name);
    if (!found) throw new Error(`Seed bug: ingredient "${name}" was never created`);
    return found.ingredientId;
  };

  console.log("Creating allergens...");
  const allergenNames = ["Глютен", "Молоко", "Яйца", "Рыба", "Соя", "Горчица", "Сульфиты", "Сельдерей"];
  const allergens = new Map<string, { allergenId: bigint }>();
  for (const name of allergenNames) {
    allergens.set(name, await prisma.allergen.create({ data: { name } }));
  }
  const alg = (name: string) => {
    const found = allergens.get(name);
    if (!found) throw new Error(`Seed bug: allergen "${name}" was never created`);
    return found.allergenId;
  };

  console.log("Creating categories + dishes...");
  type DishDef = {
    name: string;
    price: number;
    image: string;
    description: string;
    is21Plus?: boolean;
    recipe: [string, number][]; // [ingredientName, quantityPerServing]
    allergens?: string[];
  };
  const categoryDefs: { name: string; image: string; dishes: DishDef[] }[] = [
    {
      name: "Горячие блюда",
      image: "/images/hot.svg",
      dishes: [
        {
          name: "Стейк с овощами",
          price: 4500,
          image: "/images/hot.svg",
          description: "Сочный говяжий стейк средней прожарки с ароматными овощами гриль.",
          recipe: [
            ["Говядина", 0.3],
            ["Сладкий перец", 0.1],
            ["Цукини", 0.1],
            ["Томаты", 0.08],
            ["Растительное масло", 0.02],
          ],
          allergens: ["Горчица", "Сельдерей"],
        },
        {
          name: "Паста Карбонара",
          price: 3200,
          image: "/images/hot.svg",
          description: "Классическая паста в нежном сливочном соусе с беконом и сыром.",
          recipe: [
            ["Спагетти", 0.2],
            ["Бекон", 0.08],
            ["Сливки", 0.1],
            ["Яйцо", 1],
            ["Сыр пармезан", 0.04],
            ["Чеснок", 0.01],
          ],
          allergens: ["Глютен", "Молоко", "Яйца", "Соя"],
        },
        {
          name: "Курица гриль",
          price: 3500,
          image: "/images/hot.svg",
          description: "Куриное филе на гриле с золотистой корочкой и лёгким травяным ароматом.",
          recipe: [
            ["Куриное филе", 0.3],
            ["Растительное масло", 0.02],
            ["Чеснок", 0.01],
            ["Паприка", 0.005],
            ["Прованские травы", 0.005],
          ],
          allergens: ["Горчица"],
        },
      ],
    },
    {
      name: "Холодные блюда",
      image: "/images/cold.svg",
      dishes: [
        {
          name: "Салат Цезарь",
          price: 2800,
          image: "/images/cold.svg",
          description: "Свежий салат с куриным филе, хрустящими листьями и фирменной заправкой.",
          recipe: [
            ["Куриное филе", 0.15],
            ["Салат романо", 0.1],
            ["Томаты", 0.05],
            ["Сухарики", 0.03],
            ["Сыр пармезан", 0.02],
            ["Соус Цезарь", 0.05],
          ],
          allergens: ["Глютен", "Молоко", "Яйца", "Рыба", "Горчица"],
        },
        {
          name: "Греческий салат",
          price: 2500,
          image: "/images/cold.svg",
          description: "Лёгкий салат из свежих овощей, маслин и рассольного сыра.",
          recipe: [
            ["Томаты", 0.12],
            ["Огурцы", 0.1],
            ["Сладкий перец", 0.05],
            ["Красный лук", 0.03],
            ["Маслины", 0.03],
            ["Сыр фета", 0.06],
            ["Оливковое масло", 0.02],
          ],
          allergens: ["Молоко"],
        },
        {
          name: "Капрезе",
          price: 2700,
          image: "/images/cold.svg",
          description: "Итальянская закуска из спелых томатов, моцареллы и свежего базилика.",
          recipe: [
            ["Томаты", 0.15],
            ["Сыр моцарелла", 0.12],
            ["Базилик", 0.01],
            ["Оливковое масло", 0.02],
            ["Бальзамический соус", 0.01],
          ],
          allergens: ["Молоко", "Сульфиты"],
        },
      ],
    },
    {
      name: "Закуски",
      image: "/images/snacks.svg",
      dishes: [
        {
          name: "Картофель фри",
          price: 1500,
          image: "/images/snacks.svg",
          description: "Золотистый хрустящий картофель, приготовленный во фритюре.",
          recipe: [
            ["Картофель", 0.25],
            ["Растительное масло", 0.03],
          ],
        },
        {
          name: "Куриные наггетсы",
          price: 1900,
          image: "/images/snacks.svg",
          description: "Кусочки нежного куриного филе в хрустящей золотистой панировке.",
          recipe: [
            ["Куриное филе", 0.18],
            ["Пшеничная панировка", 0.05],
            ["Яйцо", 1],
            ["Растительное масло", 0.03],
          ],
          allergens: ["Глютен", "Яйца", "Соя"],
        },
        {
          name: "Сырные палочки",
          price: 2100,
          image: "/images/snacks.svg",
          description: "Тягучий сыр в хрустящей панировке, обжаренный до золотистой корочки.",
          recipe: [
            ["Сыр моцарелла", 0.15],
            ["Пшеничная панировка", 0.05],
            ["Яйцо", 1],
            ["Растительное масло", 0.03],
          ],
          allergens: ["Молоко", "Глютен", "Яйца", "Соя"],
        },
      ],
    },
    {
      name: "Напитки",
      image: "/images/drinks.svg",
      dishes: [
        {
          name: "Coca-Cola",
          price: 800,
          image: "/images/drinks.svg",
          description: "Охлаждённый газированный безалкогольный напиток.",
          recipe: [["Газированная вода Cola", 0.33]],
        },
        {
          name: "Домашний лимонад",
          price: 1200,
          image: "/images/drinks.svg",
          description: "Освежающий лимонад с цитрусом, мятой и лёгкой сладостью.",
          recipe: [
            ["Лимон", 0.5],
            ["Лайм", 0.5],
            ["Сахарный сироп", 0.05],
            ["Мята", 0.005],
          ],
        },
        {
          name: "Апельсиновый сок",
          price: 1000,
          image: "/images/drinks.svg",
          description: "Натуральный апельсиновый сок с ярким цитрусовым вкусом.",
          recipe: [["Апельсиновый сок", 0.25]],
        },
      ],
    },
    {
      name: "Кальяны",
      image: "/images/hookah.svg",
      dishes: [
        {
          name: "Кальян Classic",
          price: 7000,
          image: "/images/hookah.svg",
          description: "Классический кальян с выбором вкуса и средней крепостью.",
          is21Plus: true,
          recipe: [
            ["Кальянная смесь Classic", 0.15],
            ["Уголь", 0.2],
          ],
        },
        {
          name: "Кальян Premium",
          price: 9000,
          image: "/images/hookah.svg",
          description: "Премиальная кальянная смесь с насыщенным вкусом и индивидуальной настройкой крепости.",
          is21Plus: true,
          recipe: [
            ["Кальянная смесь Premium", 0.15],
            ["Уголь", 0.2],
          ],
        },
        {
          name: "Кальян Fruit",
          price: 11000,
          image: "/images/hookah.svg",
          description: "Ароматный кальян, приготовленный на свежем фрукте.",
          is21Plus: true,
          recipe: [
            ["Кальянная смесь Classic", 0.1],
            ["Свежий фрукт для кальяна", 0.4],
            ["Уголь", 0.2],
          ],
        },
      ],
    },
    {
      name: "Алкоголь",
      image: "/images/alcohol.svg",
      dishes: [
        {
          name: "Красное вино",
          price: 3200,
          image: "/images/alcohol.svg",
          description: "Бокал сухого красного вина с насыщенным ягодным ароматом (150 мл).",
          is21Plus: true,
          recipe: [["Красное вино", 0.15]],
          allergens: ["Сульфиты"],
        },
        {
          name: "Светлое пиво",
          price: 1800,
          image: "/images/alcohol.svg",
          description: "Охлаждённое светлое пиво с мягким солодовым вкусом (500 мл).",
          is21Plus: true,
          recipe: [["Светлое пиво", 0.5]],
          allergens: ["Глютен"],
        },
        {
          name: "Авторский коктейль",
          price: 3500,
          image: "/images/alcohol.svg",
          description: "Фирменный алкогольный коктейль с цитрусовыми нотами (300 мл).",
          is21Plus: true,
          recipe: [
            ["Джин", 0.05],
            ["Лимон", 0.3],
            ["Сахарный сироп", 0.02],
            ["Тоник", 0.2],
          ],
        },
      ],
    },
  ];

  const dishByName = new Map<string, { dishId: bigint }>();
  let sortOrder = 0;
  for (const categoryDef of categoryDefs) {
    const category = await prisma.category.create({
      data: { name: categoryDef.name, imageUrl: categoryDef.image, sortOrder: sortOrder++ },
    });
    for (const dishDef of categoryDef.dishes) {
      const dish = await prisma.dish.create({
        data: {
          categoryId: category.categoryId,
          name: dishDef.name,
          price: new Prisma.Decimal(dishDef.price),
          imageUrl: dishDef.image,
          description: dishDef.description,
          is21Plus: dishDef.is21Plus ?? false,
        },
      });
      dishByName.set(dishDef.name, dish);
      for (const [ingredientName, quantity] of dishDef.recipe) {
        await prisma.recipe.create({
          data: { dishId: dish.dishId, ingredientId: ing(ingredientName), quantity: new Prisma.Decimal(quantity) },
        });
      }
      for (const allergenName of dishDef.allergens ?? []) {
        await prisma.dishAllergen.create({ data: { dishId: dish.dishId, allergenId: alg(allergenName) } });
      }
    }
  }

  console.log("Creating dish options...");
  const extraParmesan = await prisma.dishOption.create({
    data: { name: "Доп. сыр пармезан", price: new Prisma.Decimal(400) },
  });
  await prisma.dishOptionIngredient.create({
    data: { optionId: extraParmesan.optionId, ingredientId: ing("Сыр пармезан"), quantity: new Prisma.Decimal(0.05) },
  });

  const extraBeef = await prisma.dishOption.create({ data: { name: "Двойная порция мяса", price: new Prisma.Decimal(1500) } });
  await prisma.dishOptionIngredient.create({
    data: { optionId: extraBeef.optionId, ingredientId: ing("Говядина"), quantity: new Prisma.Decimal(0.15) },
  });

  const extraBacon = await prisma.dishOption.create({ data: { name: "Доп. бекон", price: new Prisma.Decimal(500) } });
  await prisma.dishOptionIngredient.create({
    data: { optionId: extraBacon.optionId, ingredientId: ing("Бекон"), quantity: new Prisma.Decimal(0.05) },
  });

  const carbonara = dishByName.get("Паста Карбонара");
  const steak = dishByName.get("Стейк с овощами");
  const fries = dishByName.get("Картофель фри");
  if (carbonara) {
    await prisma.dishAvailableOption.create({ data: { dishId: carbonara.dishId, optionId: extraParmesan.optionId } });
    await prisma.dishAvailableOption.create({ data: { dishId: carbonara.dishId, optionId: extraBacon.optionId } });
  }
  if (steak) {
    await prisma.dishAvailableOption.create({ data: { dishId: steak.dishId, optionId: extraBeef.optionId } });
  }
  if (fries) {
    await prisma.dishAvailableOption.create({ data: { dishId: fries.dishId, optionId: extraBacon.optionId } });
  }

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
