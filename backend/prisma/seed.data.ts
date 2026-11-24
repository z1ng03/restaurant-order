import { MENU_PHOTOS } from "./seed.photos";
/**
 * Reference data for seed.reference.ts. Pure data, no database access.
 *
 * NOTE on the allergen classification: the 20 categories and their "representatives" below follow the common
 * food-allergen classifications (EU list + frequent extras). They are a classification for the menu UI, NOT a
 * legal statement that every listed product is a regulated allergen. If the restaurant's own list differs,
 * edit ALLERGEN_CATEGORIES here (or in the admin panel) - everything else is driven by it.
 */

export type AllergenKey =
  | "milk" | "eggs" | "fish" | "crustaceans" | "molluscs" | "peanuts" | "nuts" | "gluten" | "soy" | "sesame"
  | "mustard" | "celery" | "lupin" | "sulphites" | "corn" | "legumes" | "fruits" | "vegetables" | "spices" | "other";

export interface AllergenCategoryDef {
  key: AllergenKey;
  name: string;
  representatives: string;
  /** names this category was (or may be) called before - used to rename in place instead of duplicating */
  synonyms: string[];
}

export const ALLERGEN_CATEGORIES: AllergenCategoryDef[] = [
  { key: "milk", name: "Молоко и молочные продукты", representatives: "молоко, сливки, сыры (пармезан, моцарелла, фета), творог, сливочное масло, кефир, йогурт, мороженое", synonyms: ["Молоко", "Молочные продукты", "Молоко и молочные продукты"] },
  { key: "eggs", name: "Яйца", representatives: "куриные и перепелиные яйца, яичный порошок, меланж, майонез и соусы на яйце", synonyms: ["Яйца", "Яйцо"] },
  { key: "fish", name: "Рыба", representatives: "все виды рыбы, анчоусы (например, в соусе Цезарь), рыбный соус, рыбий жир", synonyms: ["Рыба"] },
  { key: "crustaceans", name: "Ракообразные", representatives: "креветки, крабы, раки, омары, лангусты", synonyms: ["Ракообразные"] },
  { key: "molluscs", name: "Моллюски", representatives: "мидии, устрицы, кальмары, осьминоги, гребешки, улитки", synonyms: ["Моллюски"] },
  { key: "peanuts", name: "Арахис", representatives: "арахис, арахисовая паста и масло", synonyms: ["Арахис"] },
  { key: "nuts", name: "Орехи", representatives: "миндаль, фундук, грецкий орех, кешью, фисташки, пекан, макадамия", synonyms: ["Орехи", "Орех"] },
  { key: "gluten", name: "Пшеница и другие злаки с глютеном", representatives: "пшеница, рожь, ячмень, овёс, спельта; мука, макароны, хлеб, панировочные сухари, пиво", synonyms: ["Глютен", "Пшеница", "Злаки", "Злаки с глютеном"] },
  { key: "soy", name: "Соя", representatives: "соевые бобы, соевый соус, тофу, соевое молоко, соевый лецитин", synonyms: ["Соя"] },
  { key: "sesame", name: "Кунжут", representatives: "кунжутное семя, кунжутное масло, тахини", synonyms: ["Кунжут"] },
  { key: "mustard", name: "Горчица", representatives: "горчичные семена и порошок, готовая горчица, соусы и маринады на её основе", synonyms: ["Горчица"] },
  { key: "celery", name: "Сельдерей", representatives: "корень, стебель, листья и семена сельдерея, сельдерейная соль", synonyms: ["Сельдерей"] },
  { key: "lupin", name: "Люпин", representatives: "люпиновая мука и семена, выпечка с люпином", synonyms: ["Люпин"] },
  { key: "sulphites", name: "Сульфиты", representatives: "диоксид серы и сульфиты: вино, сухофрукты, бальзамический уксус, некоторые маринады", synonyms: ["Сульфиты"] },
  { key: "corn", name: "Кукуруза", representatives: "кукуруза, кукурузный крахмал, мука и сироп", synonyms: ["Кукуруза"] },
  { key: "legumes", name: "Бобовые (кроме сои и арахиса)", representatives: "горох, фасоль, чечевица, нут, бобы", synonyms: ["Бобовые"] },
  { key: "fruits", name: "Фрукты", representatives: "цитрусовые (лимон, лайм, апельсин), яблоки, киви, бананы, косточковые", synonyms: ["Фрукты"] },
  { key: "vegetables", name: "Овощи", representatives: "томаты, сладкий перец, цукини, огурцы, картофель, лук, листовые салаты", synonyms: ["Овощи"] },
  { key: "spices", name: "Специи и пряности", representatives: "паприка, чеснок, перец, кориандр, корица, прованские травы, базилик, мята", synonyms: ["Специи", "Пряности", "Специи и пряности"] },
  { key: "other", name: "Другие продукты", representatives: "продукты вне перечисленных категорий (например, грибы, мёд, красители, алкоголь)", synonyms: ["Другое", "Прочее"] },
];

export interface IngredientDef {
  name: string;
  unit: "kg" | "l" | "pcs";
  /** starting stock for a NEW dev/demo database; production starts every ingredient at 0 */
  stock: number;
  tags?: [AllergenKey, "CONTAINS" | "MAY_CONTAIN"][];
}

export const INGREDIENTS: IngredientDef[] = [
  { name: "Говядина", unit: "kg", stock: 15 },
  { name: "Куриное филе", unit: "kg", stock: 20 },
  { name: "Сладкий перец", unit: "kg", stock: 8, tags: [["vegetables", "CONTAINS"]] },
  { name: "Цукини", unit: "kg", stock: 6, tags: [["vegetables", "CONTAINS"]] },
  { name: "Томаты", unit: "kg", stock: 10, tags: [["vegetables", "CONTAINS"]] },
  { name: "Растительное масло", unit: "l", stock: 10 },
  { name: "Спагетти", unit: "kg", stock: 12, tags: [["gluten", "CONTAINS"]] },
  { name: "Бекон", unit: "kg", stock: 6, tags: [["soy", "MAY_CONTAIN"]] },
  { name: "Сливки", unit: "l", stock: 8, tags: [["milk", "CONTAINS"]] },
  { name: "Яйцо", unit: "pcs", stock: 120, tags: [["eggs", "CONTAINS"]] },
  { name: "Сыр пармезан", unit: "kg", stock: 5, tags: [["milk", "CONTAINS"]] },
  { name: "Чеснок", unit: "kg", stock: 3, tags: [["spices", "CONTAINS"]] },
  { name: "Паприка", unit: "kg", stock: 2, tags: [["spices", "CONTAINS"]] },
  { name: "Прованские травы", unit: "kg", stock: 1.5, tags: [["spices", "CONTAINS"]] },
  { name: "Салат романо", unit: "kg", stock: 6, tags: [["vegetables", "CONTAINS"]] },
  { name: "Сухарики", unit: "kg", stock: 3, tags: [["gluten", "CONTAINS"]] },
  { name: "Соус Цезарь", unit: "l", stock: 4, tags: [["eggs", "CONTAINS"], ["fish", "CONTAINS"], ["mustard", "CONTAINS"], ["milk", "CONTAINS"], ["gluten", "MAY_CONTAIN"]] },
  { name: "Огурцы", unit: "kg", stock: 8, tags: [["vegetables", "CONTAINS"]] },
  { name: "Красный лук", unit: "kg", stock: 4, tags: [["vegetables", "CONTAINS"]] },
  { name: "Маслины", unit: "kg", stock: 3 },
  { name: "Сыр фета", unit: "kg", stock: 5, tags: [["milk", "CONTAINS"]] },
  { name: "Оливковое масло", unit: "l", stock: 6 },
  { name: "Сыр моцарелла", unit: "kg", stock: 8, tags: [["milk", "CONTAINS"]] },
  { name: "Базилик", unit: "kg", stock: 1.5, tags: [["spices", "CONTAINS"]] },
  { name: "Бальзамический соус", unit: "l", stock: 2, tags: [["sulphites", "CONTAINS"]] },
  { name: "Картофель", unit: "kg", stock: 25, tags: [["vegetables", "CONTAINS"]] },
  { name: "Пшеничная панировка", unit: "kg", stock: 6, tags: [["gluten", "CONTAINS"], ["soy", "MAY_CONTAIN"]] },
  { name: "Газированная вода Cola", unit: "l", stock: 20 },
  { name: "Лимон", unit: "pcs", stock: 60, tags: [["fruits", "CONTAINS"]] },
  { name: "Лайм", unit: "pcs", stock: 60, tags: [["fruits", "CONTAINS"]] },
  { name: "Мята", unit: "kg", stock: 1, tags: [["spices", "CONTAINS"]] },
  { name: "Сахарный сироп", unit: "l", stock: 5 },
  { name: "Апельсиновый сок", unit: "l", stock: 10, tags: [["fruits", "CONTAINS"]] },
  { name: "Кальянная смесь Classic", unit: "kg", stock: 3 },
  { name: "Кальянная смесь Premium", unit: "kg", stock: 2 },
  { name: "Свежий фрукт для кальяна", unit: "kg", stock: 4, tags: [["fruits", "CONTAINS"]] },
  { name: "Уголь", unit: "kg", stock: 10 },
  { name: "Красное вино", unit: "l", stock: 9, tags: [["sulphites", "CONTAINS"]] },
  { name: "Светлое пиво", unit: "l", stock: 15, tags: [["gluten", "CONTAINS"], ["sulphites", "MAY_CONTAIN"]] },
  { name: "Джин", unit: "l", stock: 4 },
  { name: "Тоник", unit: "l", stock: 6 },
];

/** Recipe lines that must NOT be personalised by the guest (alcohol, tobacco, fixed-recipe drinks). */
const FIXED = { customizable: false } as const;

export interface DishDef {
  name: string;
  price: number;
  image: string;
  description: string;
  /** descriptions this dish had in the previous seed - replaced only while untouched */
  legacyDescriptions: string[];
  is21Plus?: boolean;
  recipe: { ingredient: string; quantity: number; step?: number; customizable?: boolean }[];
  /** administrator warnings about things that are not modelled as ingredients (marinades etc.) */
  manualAllergens?: AllergenKey[];
}

export interface CategoryDef {
  name: string;
  image: string;
  dishes: DishDef[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    name: "Горячие блюда",
    image: "/images/hot.svg",
    dishes: [
      {
        name: "Стейк с овощами", price: 4500, image: "/images/hot.svg",
        description: "Говяжий стейк средней прожарки, обжаренный на гриле, с запечёнными сладким перцем, цукини и томатами. Вкус сочный, мясной, с лёгкой дымной ноткой гриля.",
        legacyDescriptions: ["Сочный говяжий стейк средней прожарки с ароматными овощами гриль."],
        recipe: [
          { ingredient: "Говядина", quantity: 0.3, step: 0.15 }, { ingredient: "Сладкий перец", quantity: 0.1 }, { ingredient: "Цукини", quantity: 0.1 },
          { ingredient: "Томаты", quantity: 0.08 }, { ingredient: "Растительное масло", quantity: 0.02, ...FIXED },
        ],
        manualAllergens: ["mustard", "celery"],
      },
      {
        name: "Паста Карбонара", price: 3200, image: "/images/hot.svg",
        description: "Спагетти в сливочном соусе с беконом, яйцом и пармезаном и ноткой чеснока. Вкус нежный, сливочный, слегка солоноватый; готовится классическим способом - паста смешивается с соусом на горячей сковороде.",
        legacyDescriptions: ["Классическая паста в нежном сливочном соусе с беконом и сыром."],
        recipe: [
          { ingredient: "Спагетти", quantity: 0.2, step: 0.1 }, { ingredient: "Бекон", quantity: 0.08, step: 0.04 }, { ingredient: "Сливки", quantity: 0.1, step: 0.05 },
          { ingredient: "Яйцо", quantity: 1, step: 1 }, { ingredient: "Сыр пармезан", quantity: 0.04, step: 0.02 }, { ingredient: "Чеснок", quantity: 0.01, step: 0.005 },
        ],
      },
      {
        name: "Курица гриль", price: 3500, image: "/images/hot.svg",
        description: "Куриное филе, замаринованное с паприкой, чесноком и прованскими травами и обжаренное на гриле до золотистой корочки. Вкус мягкий, пряный, с травяным ароматом.",
        legacyDescriptions: ["Куриное филе на гриле с золотистой корочкой и лёгким травяным ароматом."],
        recipe: [
          { ingredient: "Куриное филе", quantity: 0.3, step: 0.15 }, { ingredient: "Растительное масло", quantity: 0.02, ...FIXED }, { ingredient: "Чеснок", quantity: 0.01, step: 0.005 },
          { ingredient: "Паприка", quantity: 0.005 }, { ingredient: "Прованские травы", quantity: 0.005 },
        ],
        manualAllergens: ["mustard"],
      },
    ],
  },
  {
    name: "Холодные блюда",
    image: "/images/cold.svg",
    dishes: [
      {
        name: "Салат Цезарь", price: 2800, image: "/images/cold.svg",
        description: "Листья романо с куриным филе, томатами, сухариками и пармезаном под соусом Цезарь. Вкус свежий, с хрустом и пикантной сливочной заправкой.",
        legacyDescriptions: ["Свежий салат с куриным филе, хрустящими листьями и фирменной заправкой."],
        recipe: [
          { ingredient: "Куриное филе", quantity: 0.15, step: 0.075 }, { ingredient: "Салат романо", quantity: 0.1, step: 0.05 }, { ingredient: "Томаты", quantity: 0.05 },
          { ingredient: "Сухарики", quantity: 0.03 }, { ingredient: "Сыр пармезан", quantity: 0.02, step: 0.01 }, { ingredient: "Соус Цезарь", quantity: 0.05, step: 0.025 },
        ],
      },
      {
        name: "Греческий салат", price: 2500, image: "/images/cold.svg",
        description: "Свежие томаты, огурцы, сладкий перец, красный лук и маслины с кусочками фета, заправленные оливковым маслом. Вкус лёгкий, сочный, с солоноватым сыром.",
        legacyDescriptions: ["Лёгкий салат из свежих овощей, маслин и рассольного сыра."],
        recipe: [
          { ingredient: "Томаты", quantity: 0.12, step: 0.06 }, { ingredient: "Огурцы", quantity: 0.1, step: 0.05 }, { ingredient: "Сладкий перец", quantity: 0.05 },
          { ingredient: "Красный лук", quantity: 0.03 }, { ingredient: "Маслины", quantity: 0.03 }, { ingredient: "Сыр фета", quantity: 0.06, step: 0.03 },
          { ingredient: "Оливковое масло", quantity: 0.02, ...FIXED },
        ],
      },
      {
        name: "Капрезе", price: 2700, image: "/images/cold.svg",
        description: "Ломтики спелых томатов и моцареллы с листьями базилика, оливковым маслом и каплей бальзамического соуса. Вкус свежий, молочный, с лёгкой кислинкой.",
        legacyDescriptions: ["Итальянская закуска из спелых томатов, моцареллы и свежего базилика."],
        recipe: [
          { ingredient: "Томаты", quantity: 0.15 }, { ingredient: "Сыр моцарелла", quantity: 0.12, step: 0.06 }, { ingredient: "Базилик", quantity: 0.01, step: 0.005 },
          { ingredient: "Оливковое масло", quantity: 0.02, ...FIXED }, { ingredient: "Бальзамический соус", quantity: 0.01, step: 0.005 },
        ],
      },
    ],
  },
  {
    name: "Закуски",
    image: "/images/snacks.svg",
    dishes: [
      {
        name: "Картофель фри", price: 1500, image: "/images/snacks.svg",
        description: "Брусочки картофеля, обжаренные во фритюре до золотистой хрустящей корочки. Вкус простой, слегка солоноватый; внутри картофель мягкий.",
        legacyDescriptions: ["Золотистый хрустящий картофель, приготовленный во фритюре."],
        recipe: [{ ingredient: "Картофель", quantity: 0.25, step: 0.125 }, { ingredient: "Растительное масло", quantity: 0.03, ...FIXED }],
      },
      {
        name: "Куриные наггетсы", price: 1900, image: "/images/snacks.svg",
        description: "Кусочки куриного филе в яичной и хрустящей пшеничной панировке, обжаренные во фритюре. Вкус нежный, с хрустящей корочкой.",
        legacyDescriptions: ["Кусочки нежного куриного филе в хрустящей золотистой панировке."],
        recipe: [
          { ingredient: "Куриное филе", quantity: 0.18, step: 0.09 }, { ingredient: "Пшеничная панировка", quantity: 0.05, step: 0.025 },
          { ingredient: "Яйцо", quantity: 1, step: 1, customizable: false }, { ingredient: "Растительное масло", quantity: 0.03, ...FIXED },
        ],
      },
      {
        name: "Сырные палочки", price: 2100, image: "/images/snacks.svg",
        description: "Моцарелла в панировке из яйца и пшеничных сухарей, обжаренная во фритюре до хрустящей корочки. Вкус сливочный, внутри тягучий расплавленный сыр.",
        legacyDescriptions: ["Тягучий сыр в хрустящей панировке, обжаренный до золотистой корочки."],
        recipe: [
          { ingredient: "Сыр моцарелла", quantity: 0.15, step: 0.075 }, { ingredient: "Пшеничная панировка", quantity: 0.05, step: 0.025 },
          { ingredient: "Яйцо", quantity: 1, step: 1, customizable: false }, { ingredient: "Растительное масло", quantity: 0.03, ...FIXED },
        ],
      },
    ],
  },
  {
    name: "Напитки",
    image: "/images/drinks.svg",
    dishes: [
      {
        name: "Coca-Cola", price: 800, image: "/images/drinks.svg",
        description: "Охлаждённый газированный безалкогольный напиток, 0,33 л. Вкус сладкий, с карамельными и цитрусовыми нотами.",
        legacyDescriptions: ["Охлаждённый газированный безалкогольный напиток."],
        recipe: [{ ingredient: "Газированная вода Cola", quantity: 0.33, ...FIXED }],
      },
      {
        name: "Домашний лимонад", price: 1200, image: "/images/drinks.svg",
        description: "Освежающий напиток из лимона, лайма, мяты и сахарного сиропа. Вкус цитрусовый, кисло-сладкий, с мятной свежестью.",
        legacyDescriptions: ["Освежающий лимонад с цитрусом, мятой и лёгкой сладостью."],
        recipe: [
          { ingredient: "Лимон", quantity: 0.5, step: 0.5 }, { ingredient: "Лайм", quantity: 0.5, step: 0.5 },
          { ingredient: "Сахарный сироп", quantity: 0.05, step: 0.025 }, { ingredient: "Мята", quantity: 0.005 },
        ],
      },
      {
        name: "Апельсиновый сок", price: 1000, image: "/images/drinks.svg",
        description: "Натуральный апельсиновый сок, 0,25 л. Вкус сладкий, яркий цитрусовый, с лёгкой кислинкой.",
        legacyDescriptions: ["Натуральный апельсиновый сок с ярким цитрусовым вкусом."],
        recipe: [{ ingredient: "Апельсиновый сок", quantity: 0.25, ...FIXED }],
      },
    ],
  },
  {
    name: "Кальяны",
    image: "/images/hookah.svg",
    dishes: [
      {
        name: "Кальян Classic", price: 7000, image: "/images/hookah.svg", is21Plus: true,
        description: "Кальян на смеси Classic средней крепости, вкус смеси выбирает гость. Готовится на углях; только для гостей 21+.",
        legacyDescriptions: ["Классический кальян с выбором вкуса и средней крепостью."],
        recipe: [{ ingredient: "Кальянная смесь Classic", quantity: 0.15, ...FIXED }, { ingredient: "Уголь", quantity: 0.2, ...FIXED }],
      },
      {
        name: "Кальян Premium", price: 9000, image: "/images/hookah.svg", is21Plus: true,
        description: "Кальян на премиальной смеси с насыщенным вкусом; крепость настраивается по желанию гостя. Готовится на углях; только для гостей 21+.",
        legacyDescriptions: ["Премиальная кальянная смесь с насыщенным вкусом и индивидуальной настройкой крепости."],
        recipe: [{ ingredient: "Кальянная смесь Premium", quantity: 0.15, ...FIXED }, { ingredient: "Уголь", quantity: 0.2, ...FIXED }],
      },
      {
        name: "Кальян Fruit", price: 11000, image: "/images/hookah.svg", is21Plus: true,
        description: "Кальян на свежих фруктах с добавлением смеси Classic. Вкус мягкий, фруктовый; готовится на углях, только для гостей 21+.",
        legacyDescriptions: ["Ароматный кальян, приготовленный на свежем фрукте."],
        recipe: [
          { ingredient: "Кальянная смесь Classic", quantity: 0.1, ...FIXED }, { ingredient: "Свежий фрукт для кальяна", quantity: 0.4, ...FIXED }, { ingredient: "Уголь", quantity: 0.2, ...FIXED },
        ],
      },
    ],
  },
  {
    name: "Алкоголь",
    image: "/images/alcohol.svg",
    dishes: [
      {
        name: "Красное вино", price: 3200, image: "/images/alcohol.svg", is21Plus: true,
        description: "Бокал сухого красного вина (150 мл) с насыщенным ягодным ароматом. Содержит алкоголь, только для гостей 21+.",
        legacyDescriptions: ["Бокал сухого красного вина с насыщенным ягодным ароматом (150 мл)."],
        recipe: [{ ingredient: "Красное вино", quantity: 0.15, ...FIXED }],
      },
      {
        name: "Светлое пиво", price: 1800, image: "/images/alcohol.svg", is21Plus: true,
        description: "Охлаждённое светлое пиво (500 мл) с мягким солодовым вкусом и лёгкой горчинкой. Содержит алкоголь, только для гостей 21+.",
        legacyDescriptions: ["Охлаждённое светлое пиво с мягким солодовым вкусом (500 мл)."],
        recipe: [{ ingredient: "Светлое пиво", quantity: 0.5, ...FIXED }],
      },
      {
        name: "Авторский коктейль", price: 3500, image: "/images/alcohol.svg", is21Plus: true,
        description: "Коктейль на основе джина с лимоном, сахарным сиропом и тоником (300 мл). Вкус освежающий, цитрусовый. Содержит алкоголь, только для гостей 21+.",
        legacyDescriptions: ["Фирменный алкогольный коктейль с цитрусовыми нотами (300 мл)."],
        recipe: [
          { ingredient: "Джин", quantity: 0.05, ...FIXED }, { ingredient: "Лимон", quantity: 0.3, step: 0.3, ...FIXED },
          { ingredient: "Сахарный сироп", quantity: 0.02, ...FIXED }, { ingredient: "Тоник", quantity: 0.2, ...FIXED },
        ],
      },
    ],
  },
];

export interface OptionDef {
  name: string;
  price: number;
  ingredient: string;
  quantity: number;
  dishes: string[];
}

export const OPTIONS: OptionDef[] = [
  { name: "Доп. сыр пармезан", price: 400, ingredient: "Сыр пармезан", quantity: 0.05, dishes: ["Паста Карбонара"] },
  { name: "Двойная порция мяса", price: 1500, ingredient: "Говядина", quantity: 0.15, dishes: ["Стейк с овощами"] },
  { name: "Доп. бекон", price: 500, ingredient: "Бекон", quantity: 0.05, dishes: ["Паста Карбонара", "Картофель фри"] },
];

export const STAFF = [
  { name: "Админ", login: "admin", password: "admin123", role: "ADMIN" },
  { name: "Айгерим", login: "aigerim", password: "waiter123", role: "WAITER" },
  { name: "Марат", login: "marat", password: "chef123", role: "CHEF" },
] as const;


// MAISON catalog additions; keep recipes and allergen tags available to all clients.
INGREDIENTS.push(...[
  {
    "name": "Шампиньоны",
    "unit": "kg",
    "stock": 8
  },
  {
    "name": "Питьевая вода",
    "unit": "l",
    "stock": 100
  },
  {
    "name": "Лосось",
    "unit": "kg",
    "stock": 8,
    "tags": [
      [
        "fish",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Пшеничная мука",
    "unit": "kg",
    "stock": 15,
    "tags": [
      [
        "gluten",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Сливочное масло",
    "unit": "kg",
    "stock": 5,
    "tags": [
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Сахар",
    "unit": "kg",
    "stock": 10
  },
  {
    "name": "Булочка бриошь",
    "unit": "pcs",
    "stock": 40,
    "tags": [
      [
        "gluten",
        "CONTAINS"
      ],
      [
        "eggs",
        "CONTAINS"
      ],
      [
        "milk",
        "CONTAINS"
      ],
      [
        "sesame",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Сыр чеддер",
    "unit": "kg",
    "stock": 4,
    "tags": [
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Соус для бургера",
    "unit": "l",
    "stock": 3,
    "tags": [
      [
        "eggs",
        "CONTAINS"
      ],
      [
        "mustard",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Сливочный сыр",
    "unit": "kg",
    "stock": 6,
    "tags": [
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Печенье песочное",
    "unit": "kg",
    "stock": 5,
    "tags": [
      [
        "gluten",
        "CONTAINS"
      ],
      [
        "milk",
        "CONTAINS"
      ],
      [
        "eggs",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Тёмный шоколад",
    "unit": "kg",
    "stock": 4,
    "tags": [
      [
        "soy",
        "CONTAINS"
      ],
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Маскарпоне",
    "unit": "kg",
    "stock": 4,
    "tags": [
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Печенье савоярди",
    "unit": "kg",
    "stock": 3,
    "tags": [
      [
        "gluten",
        "CONTAINS"
      ],
      [
        "eggs",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Кофе молотый",
    "unit": "kg",
    "stock": 5
  },
  {
    "name": "Молоко",
    "unit": "l",
    "stock": 15,
    "tags": [
      [
        "milk",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Чай чёрный",
    "unit": "kg",
    "stock": 2
  },
  {
    "name": "Ягодный микс",
    "unit": "kg",
    "stock": 5,
    "tags": [
      [
        "fruits",
        "CONTAINS"
      ]
    ]
  },
  {
    "name": "Какао",
    "unit": "kg",
    "stock": 2
  }
] as IngredientDef[]);
CATEGORIES.find(c => c.name === "Горячие блюда")!.dishes.push(...[
  {
    "name": "Лосось на гриле",
    "price": 5900,
    "image": "/images/food/salmon.jpg",
    "description": "Филе лосося с румяной корочкой, овощами гриль и долькой лимона. Лёгкое сочетание для неспешного ужина.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Лосось",
        "quantity": 0.2,
        "customizable": false
      },
      {
        "ingredient": "Цукини",
        "quantity": 0.1,
        "customizable": false
      },
      {
        "ingredient": "Сладкий перец",
        "quantity": 0.08,
        "customizable": false
      },
      {
        "ingredient": "Оливковое масло",
        "quantity": 0.015,
        "customizable": false
      },
      {
        "ingredient": "Лимон",
        "quantity": 0.25,
        "customizable": false
      }
    ]
  },
  {
    "name": "Пицца Маргарита",
    "price": 3600,
    "image": "/images/food/pizza.jpg",
    "description": "Тонкое тесто, томатный соус, моцарелла и свежий базилик. Итальянская классика, которой хочется поделиться.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Пшеничная мука",
        "quantity": 0.2,
        "customizable": false
      },
      {
        "ingredient": "Питьевая вода",
        "quantity": 0.12,
        "customizable": false
      },
      {
        "ingredient": "Томаты",
        "quantity": 0.12,
        "customizable": false
      },
      {
        "ingredient": "Сыр моцарелла",
        "quantity": 0.12,
        "customizable": false
      },
      {
        "ingredient": "Базилик",
        "quantity": 0.005,
        "customizable": false
      },
      {
        "ingredient": "Оливковое масло",
        "quantity": 0.015,
        "customizable": false
      }
    ]
  },
  {
    "name": "Бургер с говядиной",
    "price": 3900,
    "image": "/images/food/burger.jpg",
    "description": "Сочная говяжья котлета, чеддер, свежие овощи и фирменный соус в мягкой булочке бриошь.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Говядина",
        "quantity": 0.18,
        "customizable": false
      },
      {
        "ingredient": "Булочка бриошь",
        "quantity": 1,
        "customizable": false
      },
      {
        "ingredient": "Сыр чеддер",
        "quantity": 0.03,
        "customizable": false
      },
      {
        "ingredient": "Томаты",
        "quantity": 0.04,
        "customizable": false
      },
      {
        "ingredient": "Салат романо",
        "quantity": 0.02,
        "customizable": false
      },
      {
        "ingredient": "Красный лук",
        "quantity": 0.015,
        "customizable": false
      },
      {
        "ingredient": "Соус для бургера",
        "quantity": 0.025,
        "customizable": false
      }
    ]
  }
]);
CATEGORIES.find(c => c.name === "Напитки")!.dishes.push(...[
  {
    "name": "Капучино",
    "price": 1400,
    "image": "/images/food/cappuccino.jpg",
    "description": "Двойной эспрессо под бархатистой молочной пеной. Мягкий кофейный вкус, 200 мл.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Кофе молотый",
        "quantity": 0.018,
        "customizable": false
      },
      {
        "ingredient": "Питьевая вода",
        "quantity": 0.04,
        "customizable": false
      },
      {
        "ingredient": "Молоко",
        "quantity": 0.16,
        "customizable": false
      }
    ]
  },
  {
    "name": "Эспрессо",
    "price": 1000,
    "image": "/images/food/espresso.jpg",
    "description": "Концентрированный кофе со стойкой крема и глубоким ароматом. Порция 40 мл.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Кофе молотый",
        "quantity": 0.018,
        "customizable": false
      },
      {
        "ingredient": "Питьевая вода",
        "quantity": 0.04,
        "customizable": false
      }
    ]
  },
  {
    "name": "Чай с мятой",
    "price": 1800,
    "image": "/images/food/mint-tea.jpg",
    "description": "Чёрный чай с листьями свежей мяты и лимоном. Чайник 600 мл — для тёплой беседы.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Чай чёрный",
        "quantity": 0.008,
        "customizable": false
      },
      {
        "ingredient": "Питьевая вода",
        "quantity": 0.6,
        "customizable": false
      },
      {
        "ingredient": "Мята",
        "quantity": 0.005,
        "customizable": false
      },
      {
        "ingredient": "Лимон",
        "quantity": 0.25,
        "customizable": false
      }
    ]
  },
  {
    "name": "Ягодный лимонад",
    "price": 1700,
    "image": "/images/food/berry-lemonade.jpg",
    "description": "Ягоды, лимон и свежая мята с лёгкой сладостью. Освежающий напиток, 350 мл.",
    "legacyDescriptions": [],
    "recipe": [
      {
        "ingredient": "Ягодный микс",
        "quantity": 0.05,
        "customizable": false
      },
      {
        "ingredient": "Питьевая вода",
        "quantity": 0.28,
        "customizable": false
      },
      {
        "ingredient": "Сахарный сироп",
        "quantity": 0.02,
        "customizable": false
      },
      {
        "ingredient": "Лимон",
        "quantity": 0.25,
        "customizable": false
      },
      {
        "ingredient": "Мята",
        "quantity": 0.003,
        "customizable": false
      }
    ]
  }
]);
CATEGORIES.splice(1, 0, {
  "name": "Супы",
  "image": "/images/food/mushroom-soup.jpg",
  "dishes": [
    {
      "name": "Грибной крем-суп",
      "price": 2400,
      "image": "/images/food/mushroom-soup.jpg",
      "description": "Нежный крем-суп из шампиньонов со сливками и хрустящими сухариками. Согревающий вкус и бархатистая текстура.",
      "legacyDescriptions": [],
      "recipe": [
        {
          "ingredient": "Шампиньоны",
          "quantity": 0.18,
          "customizable": false
        },
        {
          "ingredient": "Сливки",
          "quantity": 0.08,
          "customizable": false
        },
        {
          "ingredient": "Картофель",
          "quantity": 0.08,
          "customizable": false
        },
        {
          "ingredient": "Питьевая вода",
          "quantity": 0.15,
          "customizable": false
        },
        {
          "ingredient": "Сухарики",
          "quantity": 0.02,
          "customizable": false
        },
        {
          "ingredient": "Сливочное масло",
          "quantity": 0.015,
          "customizable": false
        }
      ]
    },
    {
      "name": "Томатный суп",
      "price": 2200,
      "image": "/images/food/tomato-soup.jpg",
      "description": "Спелые томаты, базилик и оливковое масло. Подаём с сухариками и тёртым пармезаном.",
      "legacyDescriptions": [],
      "recipe": [
        {
          "ingredient": "Томаты",
          "quantity": 0.25,
          "customizable": false
        },
        {
          "ingredient": "Питьевая вода",
          "quantity": 0.12,
          "customizable": false
        },
        {
          "ingredient": "Базилик",
          "quantity": 0.005,
          "customizable": false
        },
        {
          "ingredient": "Оливковое масло",
          "quantity": 0.015,
          "customizable": false
        },
        {
          "ingredient": "Сухарики",
          "quantity": 0.02,
          "customizable": false
        },
        {
          "ingredient": "Сыр пармезан",
          "quantity": 0.015,
          "customizable": false
        }
      ]
    }
  ]
});
CATEGORIES.splice(4, 0, {
  "name": "Десерты",
  "image": "/images/food/cheesecake.jpg",
  "dishes": [
    {
      "name": "Чизкейк",
      "price": 2400,
      "image": "/images/food/cheesecake.jpg",
      "description": "Сливочный чизкейк на рассыпчатой основе из печенья. Завершаем подачу ягодами и хорошим настроением.",
      "legacyDescriptions": [],
      "recipe": [
        {
          "ingredient": "Сливочный сыр",
          "quantity": 0.1,
          "customizable": false
        },
        {
          "ingredient": "Печенье песочное",
          "quantity": 0.035,
          "customizable": false
        },
        {
          "ingredient": "Сливочное масло",
          "quantity": 0.015,
          "customizable": false
        },
        {
          "ingredient": "Сахар",
          "quantity": 0.025,
          "customizable": false
        },
        {
          "ingredient": "Яйцо",
          "quantity": 0.25,
          "customizable": false
        },
        {
          "ingredient": "Ягодный микс",
          "quantity": 0.03,
          "customizable": false
        }
      ]
    },
    {
      "name": "Шоколадный фондан",
      "price": 2600,
      "image": "/images/food/fondant.jpg",
      "description": "Тёплый шоколадный десерт с нежной жидкой серединой. Насыщенный какао-вкус и тонкая корочка.",
      "legacyDescriptions": [],
      "recipe": [
        {
          "ingredient": "Тёмный шоколад",
          "quantity": 0.06,
          "customizable": false
        },
        {
          "ingredient": "Сливочное масло",
          "quantity": 0.03,
          "customizable": false
        },
        {
          "ingredient": "Яйцо",
          "quantity": 1,
          "customizable": false
        },
        {
          "ingredient": "Пшеничная мука",
          "quantity": 0.02,
          "customizable": false
        },
        {
          "ingredient": "Сахар",
          "quantity": 0.025,
          "customizable": false
        }
      ]
    },
    {
      "name": "Тирамису",
      "price": 2500,
      "image": "/images/food/tiramisu.jpg",
      "description": "Воздушный маскарпоне, савоярди, пропитанные эспрессо, и тонкий слой какао. Наша маленькая итальянская традиция.",
      "legacyDescriptions": [],
      "recipe": [
        {
          "ingredient": "Маскарпоне",
          "quantity": 0.08,
          "customizable": false
        },
        {
          "ingredient": "Печенье савоярди",
          "quantity": 0.04,
          "customizable": false
        },
        {
          "ingredient": "Кофе молотый",
          "quantity": 0.01,
          "customizable": false
        },
        {
          "ingredient": "Питьевая вода",
          "quantity": 0.04,
          "customizable": false
        },
        {
          "ingredient": "Сливки",
          "quantity": 0.04,
          "customizable": false
        },
        {
          "ingredient": "Сахар",
          "quantity": 0.02,
          "customizable": false
        },
        {
          "ingredient": "Какао",
          "quantity": 0.005,
          "customizable": false
        }
      ]
    }
  ]
});
for (const category of CATEGORIES) {
  for (const dish of category.dishes) { if (MENU_PHOTOS[dish.name]) dish.image = MENU_PHOTOS[dish.name]; }
  category.image = category.dishes[0]?.image ?? category.image;
}
