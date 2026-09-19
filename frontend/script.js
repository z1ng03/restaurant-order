// Drives both index.html (menu) and cart.html (cart/checkout) — same
// feature-detection pattern the original script.js used, so one file keeps
// serving both pages. Everything here talks to the backend in ../backend;
// see api.js for the fetch wrapper and session.js for the table/session
// bootstrap (ТЗ §1).

function formatPrice(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value))} ₸`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function updateCartBadge() {
  const badge = document.getElementById("cart-count");
  if (!badge) return;
  try {
    const { cart } = await api.get(`/cart/${getSessionId()}`);
    badge.textContent = cart.itemCount;
  } catch {
    // Non-fatal — the badge just won't update this time.
  }
}

function updateTableIndicator() {
  const el = document.getElementById("table-indicator");
  if (el) el.textContent = `Столик №${getTableNumber() ?? "?"}`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const session = await ensureSession();
  if (!session) return; // redirected to monitor-select.html

  updateTableIndicator();
  updateCartBadge();

  if (document.getElementById("products")) {
    initMenuPage();
  }
  if (document.getElementById("cart-items")) {
    initCartPage();
  }
});

/* ============================== Menu page ============================== */
/* ТЗ §2 (menu) и §3 (карточка блюда). */

function initMenuPage() {
  const state = { categories: [], activeCategoryId: null, activeDish: null };

  loadMenu();

  document.getElementById("dish-modal-close").addEventListener("click", closeDishModal);
  document.getElementById("dish-modal").addEventListener("click", (e) => {
    if (e.target.id === "dish-modal") closeDishModal();
  });
  document.getElementById("dish-modal-add").addEventListener("click", () => addActiveDishToCart(state));

  async function loadMenu() {
    const productsEl = document.getElementById("products");
    try {
      const { categories } = await api.get("/menu");
      state.categories = categories;
      renderCategoryButtons(state, selectCategory);
      const firstWithDishes = categories.find((c) => c.dishes.length > 0) ?? categories[0];
      if (firstWithDishes) selectCategory(state, firstWithDishes.categoryId);
    } catch (err) {
      productsEl.innerHTML = `<p class="menu-load-error">Не удалось загрузить меню: ${err.message}</p>`;
    }
  }

  function selectCategory(s, categoryId) {
    s.activeCategoryId = categoryId;
    const category = s.categories.find((c) => String(c.categoryId) === String(categoryId));
    document.querySelectorAll(".category-btn").forEach((btn) => {
      btn.classList.toggle("active", String(btn.dataset.categoryId) === String(categoryId));
    });
    document.getElementById("category-title").textContent = category?.name ?? "Меню";
    renderProducts(category?.dishes ?? []);
  }

  function renderProducts(dishes) {
    const productsEl = document.getElementById("products");
    const countEl = document.getElementById("products-count");
    countEl.textContent = dishes.length ? `${dishes.length} блюд` : "";

    if (dishes.length === 0) {
      productsEl.innerHTML = `<p class="menu-load-error">В этой категории пока нет блюд.</p>`;
      return;
    }

    productsEl.innerHTML = "";
    for (const dish of dishes) {
      const card = document.createElement("article");
      card.className = "card" + (dish.available ? "" : " unavailable");

      const imgWrap = document.createElement("button");
      imgWrap.type = "button";
      imgWrap.className = "card-image-wrap";
      imgWrap.setAttribute("aria-label", `Подробнее о блюде ${dish.name}`);
      imgWrap.innerHTML = `
        <img src="${dish.imageUrl ?? ""}" alt="${dish.name}">
        <span class="details-hint">Подробнее</span>
        ${dish.is21Plus ? '<span class="age-badge card-age-badge">21+</span>' : ""}
        ${dish.available ? "" : '<span class="unavailable-badge">Нет в наличии</span>'}
      `;
      imgWrap.addEventListener("click", () => openDishModal(state, dish.dishId));

      const content = document.createElement("div");
      content.className = "card-content";
      content.innerHTML = `
        <h3>${dish.name}</h3>
        <div class="card-bottom">
          <span class="price">${formatPrice(dish.price)}</span>
          <button type="button" class="add-cart" ${dish.available ? "" : "disabled"}>+ В корзину</button>
        </div>
      `;
      content.querySelector(".add-cart").addEventListener("click", () => quickAddToCart(dish));

      card.append(imgWrap, content);
      productsEl.appendChild(card);
    }
  }

  async function quickAddToCart(dish) {
    try {
      await api.post(`/cart/${getSessionId()}/items`, { dishId: dish.dishId, quantity: 1 });
      showToast(`«${dish.name}» добавлено в корзину`);
      updateCartBadge();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function openDishModal(s, dishId) {
    const modal = document.getElementById("dish-modal");
    try {
      const { dish } = await api.get(`/menu/dishes/${dishId}`);
      s.activeDish = dish;

      document.getElementById("dish-modal-title").textContent = dish.name;
      document.getElementById("dish-modal-image").src = dish.imageUrl ?? "";
      document.getElementById("dish-modal-image").alt = dish.name;
      document.getElementById("dish-description").textContent = dish.description ?? "";
      document.getElementById("dish-ingredients").textContent = dish.ingredients.length
        ? dish.ingredients.map((i) => i.name).join(", ")
        : "Состав уточняйте у официанта.";
      document.getElementById("dish-modal-price").textContent = formatPrice(dish.price);

      const allergySection = document.getElementById("dish-allergy-section");
      if (dish.allergens.length) {
        document.getElementById("dish-allergens").textContent = dish.allergens.map((a) => a.name).join(", ");
        allergySection.hidden = false;
      } else {
        allergySection.hidden = true;
      }

      const optionsSection = document.getElementById("dish-options-section");
      const optionsList = document.getElementById("dish-options-list");
      if (dish.options.length) {
        optionsList.innerHTML = dish.options
          .map(
            (o) => `
            <label class="dish-option-row">
              <input type="checkbox" data-option-id="${o.optionId}" data-option-price="${o.price}">
              <span>${o.name}</span>
              <span class="dish-option-price">+${formatPrice(o.price)}</span>
            </label>`,
          )
          .join("");
        optionsSection.hidden = false;
      } else {
        optionsList.innerHTML = "";
        optionsSection.hidden = true;
      }

      const addBtn = document.getElementById("dish-modal-add");
      const unavailableNote = document.getElementById("dish-unavailable-note");
      addBtn.disabled = !dish.available;
      unavailableNote.hidden = dish.available;

      modal.hidden = false;
    } catch (err) {
      showToast(`Не удалось загрузить блюдо: ${err.message}`);
    }
  }

  function closeDishModal() {
    document.getElementById("dish-modal").hidden = true;
  }

  async function addActiveDishToCart(s) {
    if (!s.activeDish) return;
    const chosenOptions = [...document.querySelectorAll("#dish-options-list input:checked")].map((input) => ({
      optionId: input.dataset.optionId,
      quantity: 1,
    }));
    try {
      await api.post(`/cart/${getSessionId()}/items`, {
        dishId: s.activeDish.dishId,
        quantity: 1,
        options: chosenOptions,
      });
      showToast(`«${s.activeDish.name}» добавлено в корзину`);
      updateCartBadge();
      closeDishModal();
    } catch (err) {
      showToast(err.message);
    }
  }
}

function renderCategoryButtons(state, onSelect) {
  const container = document.getElementById("category-buttons");
  container.innerHTML = "";
  for (const category of state.categories) {
    const hasAgeRestricted = category.dishes.some((d) => d.is21Plus);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-btn" + (hasAgeRestricted ? " age-restricted-category" : "");
    btn.dataset.categoryId = category.categoryId;
    btn.innerHTML = hasAgeRestricted ? `${category.name} <span>21+</span>` : category.name;
    btn.addEventListener("click", () => onSelect(state, category.categoryId));
    container.appendChild(btn);
  }
}

/* ============================== Cart page ============================== */
/* ТЗ §4 (корзина), §5 (проверка), §6 (возраст), §7 (оплата). */

function initCartPage() {
  const state = { cart: null, pendingPaymentMethod: null, serial: null };

  loadCart();

  document.getElementById("clear-cart-btn").addEventListener("click", () => toggleModal("clear-modal", true));
  document.getElementById("clear-cancel-btn").addEventListener("click", () => toggleModal("clear-modal", false));
  document.getElementById("clear-confirm-btn").addEventListener("click", async () => {
    try {
      await api.delete(`/cart/${getSessionId()}`);
      toggleModal("clear-modal", false);
      await loadCart();
      updateCartBadge();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("order-btn").addEventListener("click", () => beginCheckout(state));

  const ageForm = document.getElementById("age-form");
  ageForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitAgeVerification(state, true);
  });
  document.getElementById("age-decline-btn").addEventListener("click", async () => {
    toggleModal("age-modal", false);
    showResult({
      ok: false,
      title: "Заказ не оформлен",
      message: "Продажа блюд с пометкой 21+ несовершеннолетним запрещена.",
    });
  });

  document.getElementById("payment-close-btn").addEventListener("click", () => toggleModal("payment-modal", false));
  document.getElementById("cash-payment-btn").addEventListener("click", () => confirmOrder(state, "CASH"));
  document.getElementById("card-payment-btn").addEventListener("click", () => {
    toggleModal("payment-modal", false);
    toggleModal("rfid-modal", true);
    resetRfidModal();
  });

  document.getElementById("rfid-cancel-btn").addEventListener("click", () => cancelRfidPayment(state));
  document.getElementById("rfid-connect-btn").addEventListener("click", () => connectRfidReader(state));
  document.getElementById("demo-approved-btn").addEventListener("click", () => finishRfidPayment(state, true));
  document.getElementById("demo-declined-btn").addEventListener("click", () => finishRfidPayment(state, false));

  document.getElementById("result-primary-btn").addEventListener("click", () => (location.href = "index.html"));
  document.getElementById("result-close-btn").addEventListener("click", () => toggleModal("result-modal", false));

  async function loadCart() {
    try {
      const { cart } = await api.get(`/cart/${getSessionId()}`);
      state.cart = cart;
      renderCart(cart);
    } catch (err) {
      showToast(`Не удалось загрузить корзину: ${err.message}`);
    }
  }

  function renderCart(cart) {
    const itemsEl = document.getElementById("cart-items");
    const emptyEl = document.getElementById("empty-cart");
    const orderBtn = document.getElementById("order-btn");

    document.getElementById("summary-count").textContent = cart.itemCount;
    document.getElementById("summary-total").textContent = formatPrice(cart.total);

    if (cart.items.length === 0) {
      itemsEl.innerHTML = "";
      emptyEl.hidden = false;
      orderBtn.disabled = true;
      return;
    }
    emptyEl.hidden = true;
    orderBtn.disabled = false;

    itemsEl.innerHTML = "";
    for (const item of cart.items) {
      const row = document.createElement("div");
      row.className = "cart-item";
      const optionsText = item.options.length ? item.options.map((o) => o.name).join(", ") : "";
      row.innerHTML = `
        <div class="cart-product">
          <img src="${item.dishImageUrl ?? ""}" alt="${item.dishName}">
          <div>
            <div class="cart-product-labels">
              ${item.is21Plus ? '<span class="age-badge">21+</span>' : ""}
              <span class="added-label">В корзине</span>
            </div>
            <h3>${item.dishName}</h3>
            ${optionsText ? `<p class="cart-item-description">Дополнительно: ${optionsText}</p>` : ""}
            ${item.notes ? `<p class="cart-item-description">Комментарий: ${item.notes}</p>` : ""}
          </div>
        </div>
        <span class="unit-price">${formatPrice(item.unitPrice)}</span>
        <span class="quantity-control">
          <button type="button" data-action="dec">−</button>
          <span>${item.quantity}</span>
          <button type="button" data-action="inc">+</button>
        </span>
        <span class="item-total">${formatPrice(item.lineTotal)}</span>
      `;
      row.querySelector('[data-action="dec"]').addEventListener("click", () => changeQuantity(item, -1));
      row.querySelector('[data-action="inc"]').addEventListener("click", () => changeQuantity(item, 1));
      itemsEl.appendChild(row);
    }
  }

  async function changeQuantity(item, delta) {
    const newQuantity = item.quantity + delta;
    try {
      const { cart } = await api.patch(`/cart/items/${item.cartItemId}`, { quantity: newQuantity });
      state.cart = cart;
      renderCart(cart);
      updateCartBadge();
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderIssues(issues) {
    const el = document.getElementById("checkout-issues");
    if (!issues || issues.length === 0) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = issues.map((i) => i.message).join(" ");
  }

  async function beginCheckout(s) {
    renderIssues(null);
    let validation;
    try {
      validation = await api.get(`/checkout/${getSessionId()}/validate`);
    } catch (err) {
      showToast(err.message);
      return;
    }

    const blockingIssues = validation.issues.filter((i) => i.type !== "AGE_VERIFICATION_REQUIRED");
    if (blockingIssues.length > 0) {
      renderIssues(blockingIssues);
      await loadCart(); // reflects e.g. a dish that just went inactive
      return;
    }

    if (validation.requiresAgeVerification && validation.issues.some((i) => i.type === "AGE_VERIFICATION_REQUIRED")) {
      document.getElementById("age-form-error").hidden = true;
      document.getElementById("age-form").reset();
      toggleModal("age-modal", true);
      return;
    }

    toggleModal("payment-modal", true);
    document.getElementById("payment-total").textContent = formatPrice(state.cart.total);
  }

  async function submitAgeVerification(s, verified) {
    const errorEl = document.getElementById("age-form-error");
    errorEl.hidden = true;
    const login = document.getElementById("waiter-login").value.trim();
    const password = document.getElementById("waiter-password").value;
    try {
      await api.post("/age-verification", { sessionId: getSessionId(), waiterLogin: login, waiterPassword: password, verified });
      toggleModal("age-modal", false);
      await beginCheckout(s); // re-validate now that age is confirmed
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  function resetRfidModal() {
    document.getElementById("rfid-status").textContent = "Приложите банковскую/дебетовую карту.";
    document.getElementById("rfid-waiting").hidden = true;
    document.getElementById("rfid-connect-btn").hidden = false;
    document.getElementById("rfid-connect-btn").disabled = false;
  }

  /**
   * Real hardware path: opens Web Serial to the RC522 Arduino sketch
   * (arduino/rc522_payment.ino) and waits for its response — no fixed
   * timer, this genuinely waits for a card tap. Falls back to a clear
   * message (not a fake result) when Web Serial isn't available; the
   * "Демонстрация без Arduino" buttons work either way, exactly like the
   * original build.
   */
  async function connectRfidReader(s) {
    const statusEl = document.getElementById("rfid-status");
    const connectBtn = document.getElementById("rfid-connect-btn");

    if (!SerialPayment.isSupported()) {
      statusEl.textContent = "Web Serial недоступен в этом браузере. Откройте сайт в Chrome или Edge, либо используйте демонстрацию ниже.";
      return;
    }

    connectBtn.disabled = true;
    statusEl.textContent = "Выберите COM-порт Arduino…";

    const serial = new SerialPayment();
    s.serial = serial;
    serial.onMessage = (line) => {
      if (line === "READER_READY" || line === "WAITING_FOR_CARD") {
        document.getElementById("rfid-waiting").hidden = false;
        connectBtn.hidden = true;
        statusEl.textContent = "Приложите карту к считывателю…";
      } else if (line.startsWith("CARD_UID:")) {
        statusEl.textContent = `Карта считана (${line.slice("CARD_UID:".length)}), проверяем…`;
      } else if (line === "PAYMENT_APPROVED") {
        finishRfidPayment(s, true);
      } else if (line === "PAYMENT_DECLINED") {
        finishRfidPayment(s, false);
      } else if (line === "PAYMENT_CANCELLED") {
        resetRfidModal();
      }
    };
    serial.onDisconnect = () => {
      if (!document.getElementById("rfid-modal").hidden) {
        statusEl.textContent = "Связь со считывателем потеряна.";
        resetRfidModal();
      }
    };

    try {
      await serial.connect();
      await serial.send("START_PAYMENT");
    } catch (err) {
      // Most commonly: the person closed the port-picker dialog.
      statusEl.textContent = `Не удалось подключиться: ${err.message}`;
      connectBtn.disabled = false;
    }
  }

  async function cancelRfidPayment(s) {
    if (s.serial?.port) {
      try {
        await s.serial.send("CANCEL_PAYMENT");
      } catch {
        /* port may already be gone */
      }
      await s.serial.disconnect();
      s.serial = null;
    }
    toggleModal("rfid-modal", false);
  }

  async function finishRfidPayment(s, approved) {
    if (s.serial) {
      await s.serial.disconnect();
      s.serial = null;
    }
    toggleModal("rfid-modal", false);
    if (approved) {
      await confirmOrder(s, "KASPI_QR");
    } else {
      showResult({ ok: false, title: "Оплата отклонена", message: "Банк отклонил операцию. Попробуйте другой способ оплаты." });
    }
  }

  async function confirmOrder(s, method) {
    toggleModal("payment-modal", false);
    try {
      const { order } = await api.post(`/checkout/${getSessionId()}/confirm`, { paymentMethod: method });
      await loadCart();
      updateCartBadge();
      const paidNote = method === "CASH" ? "Оплатите наличными официанту при получении заказа." : "Оплата Kaspi QR прошла успешно.";
      showResult({
        ok: true,
        title: "Заказ оформлен",
        message: `Заказ №${order.orderId} на сумму ${formatPrice(order.totalPrice)} передан на кухню. ${paidNote}`,
      });
    } catch (err) {
      if (err.code === "CHECKOUT_VALIDATION_FAILED") {
        renderIssues(err.details?.issues ?? []);
        await loadCart();
      } else {
        showResult({ ok: false, title: "Не удалось оформить заказ", message: err.message });
      }
    }
  }

  function showResult({ ok, title, message }) {
    document.getElementById("result-card").classList.toggle("result-fail", !ok);
    document.getElementById("result-mark").textContent = ok ? "✓" : "✕";
    document.getElementById("result-title").textContent = title;
    document.getElementById("result-message").textContent = message;
    toggleModal("result-modal", true);
  }
}

function toggleModal(id, show) {
  const el = document.getElementById(id);
  if (el) el.hidden = !show;
}
