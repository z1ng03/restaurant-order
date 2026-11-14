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
