const MENU = [
    {
        id: 1, category: "hot", name: "Стейк с овощами", price: 4500, image: "images/hot.svg",
        description: "Сочный говяжий стейк средней прожарки с ароматными овощами гриль.",
        ingredients: "Говядина, сладкий перец, цукини, томаты, растительное масло, соль, чёрный перец, зелень.",
        nutrition: { calories: "620", protein: "48 г", fat: "39 г", carbs: "19 г" },
        allergens: "Возможна индивидуальная реакция на специи. Блюдо может содержать следы горчицы и сельдерея."
    },
    {
        id: 2, category: "hot", name: "Паста Карбонара", price: 3200, image: "images/hot.svg",
        description: "Классическая паста в нежном сливочном соусе с беконом и сыром.",
        ingredients: "Спагетти, бекон, сливки, яичный желток, сыр пармезан, чеснок, чёрный перец.",
        nutrition: { calories: "710", protein: "29 г", fat: "38 г", carbs: "65 г" },
        allergens: "Содержит глютен, молоко и яйца. Может содержать следы сои."
    },
    {
        id: 3, category: "hot", name: "Курица гриль", price: 3500, image: "images/hot.svg",
        description: "Куриное филе на гриле с золотистой корочкой и лёгким травяным ароматом.",
        ingredients: "Куриное филе, растительное масло, чеснок, паприка, прованские травы, соль, перец.",
        nutrition: { calories: "470", protein: "55 г", fat: "22 г", carbs: "12 г" },
        allergens: "Возможна индивидуальная реакция на чеснок и специи. Может содержать следы горчицы."
    },
    {
        id: 4, category: "cold", name: "Салат Цезарь", price: 2800, image: "images/cold.svg",
        description: "Свежий салат с куриным филе, хрустящими листьями и фирменной заправкой.",
        ingredients: "Куриное филе, салат романо, томаты, сухарики, пармезан, соус «Цезарь».",
        nutrition: { calories: "430", protein: "31 г", fat: "27 г", carbs: "20 г" },
        allergens: "Содержит глютен, молоко, яйца, рыбу и горчицу."
    },
    {
        id: 5, category: "cold", name: "Греческий салат", price: 2500, image: "images/cold.svg",
        description: "Лёгкий салат из свежих овощей, маслин и рассольного сыра.",
        ingredients: "Томаты, огурцы, сладкий перец, красный лук, маслины, сыр фета, оливковое масло.",
        nutrition: { calories: "340", protein: "10 г", fat: "27 г", carbs: "15 г" },
        allergens: "Содержит молоко. Возможна индивидуальная реакция на маслины и лук."
    },
    {
        id: 6, category: "cold", name: "Капрезе", price: 2700, image: "images/cold.svg",
        description: "Итальянская закуска из спелых томатов, моцареллы и свежего базилика.",
        ingredients: "Томаты, сыр моцарелла, базилик, оливковое масло, бальзамический соус, соль.",
        nutrition: { calories: "360", protein: "18 г", fat: "27 г", carbs: "11 г" },
        allergens: "Содержит молоко и сульфиты в бальзамическом соусе."
    },
    {
        id: 7, category: "snacks", name: "Картофель фри", price: 1500, image: "images/snacks.svg",
        description: "Золотистый хрустящий картофель, приготовленный во фритюре.",
        ingredients: "Картофель, растительное масло, соль.",
        nutrition: { calories: "390", protein: "5 г", fat: "19 г", carbs: "50 г" },
        allergens: "Само блюдо не содержит основных аллергенов, но может готовиться в масле вместе с продуктами, содержащими глютен."
    },
    {
        id: 8, category: "snacks", name: "Куриные наггетсы", price: 1900, image: "images/snacks.svg",
        description: "Кусочки нежного куриного филе в хрустящей золотистой панировке.",
        ingredients: "Куриное филе, пшеничная панировка, яйцо, растительное масло, соль, специи.",
        nutrition: { calories: "510", protein: "32 г", fat: "27 г", carbs: "34 г" },
        allergens: "Содержит глютен и яйца. Может содержать молоко и сою."
    },
    {
        id: 9, category: "snacks", name: "Сырные палочки", price: 2100, image: "images/snacks.svg",
        description: "Тягучий сыр в хрустящей панировке, обжаренный до золотистой корочки.",
        ingredients: "Сыр моцарелла, пшеничная панировка, яйцо, растительное масло, специи.",
        nutrition: { calories: "560", protein: "25 г", fat: "35 г", carbs: "36 г" },
        allergens: "Содержит молоко, глютен и яйца. Может содержать сою."
    },
    {
        id: 10, category: "drinks", name: "Coca-Cola", price: 800, image: "images/drinks.svg",
        description: "Охлаждённый газированный безалкогольный напиток.",
        ingredients: "Вода, сахар, углекислый газ, краситель, регулятор кислотности, натуральные ароматизаторы, кофеин.",
        nutrition: { calories: "210", protein: "0 г", fat: "0 г", carbs: "53 г" },
        allergens: "Основные пищевые аллергены не заявлены. Содержит кофеин; возможна индивидуальная непереносимость компонентов."
    },
    {
        id: 11, category: "drinks", name: "Домашний лимонад", price: 1200, image: "images/drinks.svg",
        description: "Освежающий лимонад с цитрусом, мятой и лёгкой сладостью.",
        ingredients: "Вода, лимон, лайм, сахарный сироп, мята, лёд.",
        nutrition: { calories: "170", protein: "1 г", fat: "0 г", carbs: "42 г" },
        allergens: "Возможна аллергическая реакция на цитрусовые и мяту."
    },
    {
        id: 12, category: "drinks", name: "Апельсиновый сок", price: 1000, image: "images/drinks.svg",
        description: "Натуральный апельсиновый сок с ярким цитрусовым вкусом.",
        ingredients: "Апельсиновый сок без добавления сахара.",
        nutrition: { calories: "135", protein: "2 г", fat: "0 г", carbs: "31 г" },
        allergens: "Возможна аллергическая реакция на цитрусовые."
    },
    {
        id: 13, category: "hookah", name: "Кальян Classic", price: 7000, image: "images/hookah.svg",
        description: "Классический кальян с выбором вкуса и средней крепостью.",
        ingredients: "Кальянная смесь, ароматизаторы, глицерин, уголь.",
        nutrition: { calories: "—", protein: "—", fat: "—", carbs: "—" },
        allergens: "Возможна индивидуальная реакция на ароматизаторы. Смесь может содержать никотин. Только для совершеннолетних."
    },
    {
        id: 14, category: "hookah", name: "Кальян Premium", price: 9000, image: "images/hookah.svg",
        description: "Премиальная кальянная смесь с насыщенным вкусом и индивидуальной настройкой крепости.",
        ingredients: "Премиальная кальянная смесь, ароматизаторы, глицерин, уголь.",
        nutrition: { calories: "—", protein: "—", fat: "—", carbs: "—" },
        allergens: "Возможна индивидуальная реакция на ароматизаторы. Смесь может содержать никотин. Только для совершеннолетних."
    },
    {
        id: 15, category: "hookah", name: "Кальян Fruit", price: 11000, image: "images/hookah.svg",
        description: "Ароматный кальян, приготовленный на свежем фрукте.",
        ingredients: "Кальянная смесь, свежий фрукт, ароматизаторы, глицерин, уголь.",
        nutrition: { calories: "—", protein: "—", fat: "—", carbs: "—" },
        allergens: "Возможна реакция на выбранный фрукт или ароматизаторы. Смесь может содержать никотин. Только для совершеннолетних."
    }
];

const CATEGORY_TITLES = {
    hot: "Горячие блюда",
    cold: "Холодные блюда",
    snacks: "Закуски",
    drinks: "Напитки",
    hookah: "Кальяны"
};

const CART_KEY = "restaurantCart";

function getCart() {
    try {
        return JSON.parse(localStorage.getItem(CART_KEY)) || {};
    } catch {
        return {};
    }
}

function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge();
}

function formatPrice(value) {
    return `${new Intl.NumberFormat("ru-RU").format(value)} ₸`;
}

function cartCount(cart = getCart()) {
    return Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
}

function updateCartBadge() {
    const badge = document.getElementById("cart-count");
    if (badge) badge.textContent = cartCount();
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function addToCart(id) {
    const item = MENU.find(product => product.id === id);
    const cart = getCart();
    cart[id] = (cart[id] || 0) + 1;
    saveCart(cart);
    showToast(`Добавлено: ${item.name} — ${formatPrice(item.price)}`);
}

function renderProducts(category = "hot") {
    const container = document.getElementById("products");
    if (!container) return;

    const filtered = MENU.filter(item => item.category === category);
    container.innerHTML = filtered.map(item => `
        <article class="card">
            <button class="card-image-wrap" type="button" data-details-id="${item.id}" aria-label="Посмотреть описание блюда ${item.name}">
                <img src="${item.image}" alt="${item.name}">
                <span class="details-hint">Подробнее</span>
            </button>
            <div class="card-content">
                <h3>${item.name}</h3>
                <div class="card-bottom">
                    <span class="price">${formatPrice(item.price)}</span>
                    <button class="add-cart" type="button" data-add-id="${item.id}" aria-label="Добавить ${item.name} в корзину">
                        <span>Добавить</span>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 3h2l2.4 10.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 7H6M10 20a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm9 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
                        </svg>
                    </button>
                </div>
            </div>
        </article>
    `).join("");

    document.getElementById("category-title").textContent = CATEGORY_TITLES[category];
    document.getElementById("products-count").textContent = `${filtered.length} позиции`;

    container.querySelectorAll("[data-add-id]").forEach(button => {
        button.addEventListener("click", () => addToCart(Number(button.dataset.addId)));
    });

    container.querySelectorAll("[data-details-id]").forEach(button => {
        button.addEventListener("click", () => openDishModal(Number(button.dataset.detailsId)));
    });
}

function openDishModal(id) {
    const item = MENU.find(product => product.id === id);
    const modal = document.getElementById("dish-modal");
    if (!item || !modal) return;

    const modalImage = document.getElementById("dish-modal-image");
    modalImage.src = item.image;
    modalImage.alt = item.name;
    document.getElementById("dish-modal-title").textContent = item.name;
    document.getElementById("dish-description").textContent = item.description;
    document.getElementById("dish-ingredients").textContent = item.ingredients;
    document.getElementById("dish-calories").textContent = item.nutrition.calories;
    document.getElementById("dish-protein").textContent = item.nutrition.protein;
    document.getElementById("dish-fat").textContent = item.nutrition.fat;
    document.getElementById("dish-carbs").textContent = item.nutrition.carbs;
    document.getElementById("dish-allergens").textContent = item.allergens;
    document.getElementById("dish-modal-price").textContent = formatPrice(item.price);
    document.getElementById("dish-modal-add").dataset.addId = item.id;

    modal.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("dish-modal-close").focus();
}

function closeDishModal() {
    const modal = document.getElementById("dish-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
}

function initMenuPage() {
    const buttons = document.querySelectorAll(".category-btn");
    if (!buttons.length) return;

    buttons.forEach(button => {
        button.addEventListener("click", () => {
            buttons.forEach(btn => btn.classList.remove("active"));
            button.classList.add("active");
            renderProducts(button.dataset.category);
        });
    });

    renderProducts("hot");
    updateCartBadge();

    const modal = document.getElementById("dish-modal");
    const closeButton = document.getElementById("dish-modal-close");
    const modalAddButton = document.getElementById("dish-modal-add");

    closeButton.addEventListener("click", closeDishModal);
    modal.addEventListener("click", event => {
        if (event.target === modal) closeDishModal();
    });
    modalAddButton.addEventListener("click", () => {
        addToCart(Number(modalAddButton.dataset.addId));
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !modal.hidden) closeDishModal();
    });
}

function changeQuantity(id, difference) {
    const cart = getCart();
    const nextQuantity = (cart[id] || 0) + difference;

    if (nextQuantity <= 0) {
        delete cart[id];
    } else {
        cart[id] = nextQuantity;
    }

    saveCart(cart);
    renderCart();
}

function renderCart() {
    const container = document.getElementById("cart-items");
    if (!container) return;

    const cart = getCart();
    const entries = Object.entries(cart)
        .map(([id, quantity]) => ({ item: MENU.find(product => product.id === Number(id)), quantity }))
        .filter(entry => entry.item && entry.quantity > 0);

    container.innerHTML = entries.map(({ item, quantity }) => `
        <article class="cart-item">
            <div class="cart-product">
                <img src="${item.image}" alt="${item.name}">
                <div>
                    <span class="added-label">Добавлено</span>
                    <h3>${item.name}</h3>
                </div>
            </div>
            <div class="unit-price" data-label="Цена за единицу">${formatPrice(item.price)}</div>
            <div class="quantity-control" data-label="Количество">
                <button type="button" data-change-id="${item.id}" data-difference="-1" aria-label="Уменьшить количество ${item.name}">−</button>
                <strong>${quantity}</strong>
                <button type="button" data-change-id="${item.id}" data-difference="1" aria-label="Увеличить количество ${item.name}">+</button>
            </div>
            <strong class="item-total" data-label="Общая цена">${formatPrice(item.price * quantity)}</strong>
        </article>
    `).join("");

    const count = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    const total = entries.reduce((sum, entry) => sum + entry.item.price * entry.quantity, 0);
    document.getElementById("summary-count").textContent = count;
    document.getElementById("summary-total").textContent = formatPrice(total);
    document.getElementById("empty-cart").hidden = entries.length !== 0;

    const orderButton = document.getElementById("order-btn");
    orderButton.disabled = entries.length === 0;

    container.querySelectorAll("[data-change-id]").forEach(button => {
        button.addEventListener("click", () => {
            changeQuantity(Number(button.dataset.changeId), Number(button.dataset.difference));
        });
    });
}

function initCartPage() {
    const orderButton = document.getElementById("order-btn");
    if (!orderButton) return;

    renderCart();
    orderButton.addEventListener("click", () => {
        if (cartCount() === 0) return;
        localStorage.removeItem(CART_KEY);
        document.getElementById("order-modal").hidden = false;
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initMenuPage();
    initCartPage();
});
