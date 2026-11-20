// Drives both index.html (menu) and cart.html (cart/checkout) - same feature-detection pattern the original
// script.js used, so one file keeps serving both pages. Everything here talks to the backend in ../backend;
// see api.js for the fetch wrapper, session.js for the table/session bootstrap (ТЗ §1), ui.js for toast/modal
// helpers, tracker.js for the order status widget and receipt.js for the receipt window.
//
// Every string that came from the server (dish names, ingredient names, comments …) is passed through
// escapeHtml() before it is placed in innerHTML.

async function updateCartBadge() {
  const badge = document.getElementById("cart-count");
  if (!badge) return;
  try {
    const { cart } = await api.get(`/cart/${getSessionId()}`, { client: true });
    badge.textContent = cart.itemCount;
  } catch {
    // Non-fatal - the badge just won't update this time.
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
  if (document.getElementById("order-tracker")) {
    OrderTracker.init();
  }
});

/* ============================== Menu page ============================== */
/* ТЗ §2 (menu), §3 (карточка блюда) + v2 FR-02 (состав), FR-03 (аллергены). */

function initMenuPage() {
  const state = { categories: [], activeCategoryId: null };
  const dishModal = createDishModal();

  loadMenu();

  async function loadMenu() {
    const productsEl = document.getElementById("products");
    try {
      const { categories } = await api.get("/menu");
      state.categories = categories;
      renderCategoryButtons(state, selectCategory);
      const firstWithDishes = categories.find((c) => c.dishes.length > 0) ?? categories[0];
      if (firstWithDishes) selectCategory(state, firstWithDishes.categoryId);
    } catch (err) {
      productsEl.innerHTML = `<p class="menu-load-error">Не удалось загрузить меню: ${escapeHtml(err.message)}</p>`;
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
        <img src="${escapeHtml(dish.imageUrl ?? "")}" alt="${escapeHtml(dish.name)}">
        <span class="details-hint">Подробнее</span>
        ${dish.is21Plus ? '<span class="age-badge card-age-badge">21+</span>' : ""}
        ${dish.available ? "" : `<span class="unavailable-badge" title="${escapeHtml(dish.unavailableMessage ?? "")}">Нет в наличии</span>`}
      `;
      imgWrap.addEventListener("click", () => dishModal.open(dish.dishId));

      const content = document.createElement("div");
      content.className = "card-content";
      content.innerHTML = `
        <h3>${escapeHtml(dish.name)}</h3>
        <div class="card-bottom">
          <span class="price">${formatMoney(dish.price)}</span>
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
      await api.post(`/cart/${getSessionId()}/items`, { dishId: dish.dishId, quantity: 1 }, { client: true });
      showToast(`«${dish.name}» добавлено в корзину`);
      updateCartBadge();
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
    btn.innerHTML = hasAgeRestricted ? `${escapeHtml(category.name)} <span>21+</span>` : escapeHtml(category.name);
    btn.addEventListener("click", () => onSelect(state, category.categoryId));
    container.appendChild(btn);
  }
}

/**
 * The dish window: shows the composition for ONE serving with − / + per customizable ingredient (step and limits
 * come from the server), recomputes the allergen groups for what is really selected, checks with the server whether
 * THIS exact composition can be made right now, and adds it to the cart.
 */
function createDishModal() {
  const $ = (id) => document.getElementById(id);
  const m = { dish: null, selected: new Map(), checked: new Set(), seq: 0, configOk: true, lastFocus: null };

  $("dish-modal-close").addEventListener("click", close);
  $("dish-modal").addEventListener("click", (e) => { if (e.target.id === "dish-modal") close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("dish-modal").hidden) close(); });
  $("dish-modal-add").addEventListener("click", addToCart);
  $("composition-reset").addEventListener("click", () => {
    for (const ing of m.dish.ingredients) m.selected.set(String(ing.ingredientId), Number(ing.baseQuantity));
    refresh(true);
  });

  const checkConfig = debounce(runConfigCheck, 250);

  /** Every value the guest may pick for an ingredient: 0, step, 2·step … max - and the base amount itself. */
  function allowedValues(ing) {
    const base = Number(ing.baseQuantity), step = Number(ing.stepQuantity), max = Number(ing.maxQuantity);
    const values = new Set([round3(base)]);
    for (let i = 0; i <= 600; i++) {
      const v = round3(i * step);
      if (v > max + 1e-9) break;
      values.add(v);
    }
    return [...values].sort((a, b) => a - b);
  }

  const selectedOf = (ing) => m.selected.get(String(ing.ingredientId)) ?? Number(ing.baseQuantity);
  const isChanged = (ing) => Math.abs(selectedOf(ing) - Number(ing.baseQuantity)) > 1e-9;
  const changedLines = () => m.dish.ingredients.filter(isChanged);

  function payload() {
    return {
      quantity: 1,
      ingredients: changedLines().map((ing) => ({ ingredientId: String(ing.ingredientId), quantity: selectedOf(ing).toFixed(3) })),
      options: [...m.checked].map((optionId) => ({ optionId: String(optionId), quantity: 1 })),
    };
  }

  function renderIngredients() {
    const list = $("dish-ingredients");
    if (m.dish.ingredients.length === 0) {
      list.innerHTML = `<li class="ingredient-row"><span>Состав уточняйте у официанта.</span></li>`;
      return;
    }
    list.innerHTML = m.dish.ingredients.map((ing) => {
      const id = escapeHtml(ing.ingredientId);
      const value = selectedOf(ing);
      const changed = isChanged(ing);
      const label = escapeHtml(ing.name);
      const base = Number(ing.baseQuantity);
      const ingredientCount = m.dish.ingredients.filter((line) => Number(line.baseQuantity) > 0).length;
      const ingredientExtra = base > 0 && ingredientCount > 0 && value > base
        ? Math.round((Number(m.dish.price) / ingredientCount * (value / base - 1) + Number.EPSILON) * 100) / 100
        : 0;
      if (!ing.customizable) {
        return `<li class="ingredient-row"><span class="ingredient-name">${label}</span><span class="ingredient-fixed">${escapeHtml(formatQty(value, ing.unit))}</span></li>`;
      }
      const values = allowedValues(ing);
      const idx = values.findIndex((v) => Math.abs(v - value) < 1e-9);
      return `<li class="ingredient-row ${changed ? "changed" : ""} ${value === 0 ? "removed" : ""}">
        <span><span class="ingredient-name">${label}</span>${changed ? `<span class="ingredient-base">по рецепту: ${escapeHtml(formatQty(ing.baseQuantity, ing.unit))}</span>` : ""}</span>
        <span class="ingredient-controls">
          <button type="button" data-ing="${id}" data-dir="-1" aria-label="Уменьшить: ${label}" ${idx <= 0 ? "disabled" : ""}>−</button>
          <span class="ingredient-qty" aria-live="polite">${value === 0 ? "убрать" : escapeHtml(formatQty(value, ing.unit))}</span>
          ${ingredientExtra > 0 ? `<span class="ingredient-extra-price">+${formatMoney(ingredientExtra)}</span>` : ""}
          <button type="button" data-ing="${id}" data-dir="1" aria-label="Увеличить: ${label}" ${idx < 0 || idx >= values.length - 1 ? "disabled" : ""}>+</button>
        </span>
      </li>`;
    }).join("");
    list.querySelectorAll("button[data-ing]").forEach((btn) => btn.addEventListener("click", () => step(btn.dataset.ing, Number(btn.dataset.dir))));
  }

  function step(ingredientId, dir) {
    const ing = m.dish.ingredients.find((i) => String(i.ingredientId) === ingredientId);
    if (!ing) return;
    const values = allowedValues(ing);
    const idx = values.findIndex((v) => Math.abs(v - selectedOf(ing)) < 1e-9);
    const next = values[idx + dir];
    if (next === undefined) return;
    m.selected.set(ingredientId, next);
    refresh(false);
  }

  /** Mirror of computeAllergenGroups() on the server: only ingredients that are really present. */
  function renderAllergens() {
    const present = [];
    for (const ing of m.dish.ingredients) if (selectedOf(ing) > 0) present.push(ing);
    for (const opt of m.dish.options) if (m.checked.has(String(opt.optionId))) present.push(...opt.ingredients);

    const groups = new Map();
    for (const ing of present) {
      for (const a of ing.allergens ?? []) {
        const g = groups.get(a.categoryId) ?? { name: a.categoryName, contains: new Set(), may: new Set() };
        (a.kind === "MAY_CONTAIN" ? g.may : g.contains).add(ing.name);
        groups.set(a.categoryId, g);
      }
    }
    const order = new Map((m.dish.allergenGroups ?? []).map((g, i) => [String(g.categoryId), i]));
    const sorted = [...groups.entries()].sort((a, b) => (order.get(String(a[0])) ?? 999) - (order.get(String(b[0])) ?? 999) || a[1].name.localeCompare(b[1].name, "ru"));

    $("dish-allergen-groups").innerHTML = sorted.map(([, g]) => {
      const parts = [];
      if (g.contains.size) parts.push(`содержит: ${escapeHtml([...g.contains].join(", "))}`);
      if (g.may.size) parts.push(`<span class="may-contain">возможны следы / перекрёстный контакт: ${escapeHtml([...g.may].join(", "))}</span>`);
      return `<li><strong>${escapeHtml(g.name)}</strong> - ${parts.join("; ")}</li>`;
    }).join("");

    const manual = (m.dish.allergens ?? []).map((a) => a.name);
    const manualEl = $("dish-allergen-manual");
    manualEl.hidden = manual.length === 0;
    manualEl.textContent = manual.length ? `Общее предупреждение ресторана (не зависит от выбранного состава): ${manual.join(", ")}` : "";
    $("dish-allergy-section").hidden = sorted.length === 0 && manual.length === 0;
  }

  function renderPrice() {
    const priced = m.dish.ingredients.filter((ing) => Number(ing.baseQuantity) > 0);
    const share = priced.length ? Number(m.dish.price) / priced.length : 0;
    const surcharge = priced.reduce((sum, ing) =>
      sum + share * Math.max(0, selectedOf(ing) / Number(ing.baseQuantity) - 1), 0);
    let total = Number(m.dish.price) + Math.round((surcharge + Number.EPSILON) * 100) / 100;
    for (const opt of m.dish.options) if (m.checked.has(String(opt.optionId))) total += Number(opt.price);
    $("dish-modal-price").textContent = formatMoney(total);
  }

  function renderOptions() {
    const section = $("dish-options-section");
    const list = $("dish-options-list");
    if (!m.dish.options.length) {
      list.innerHTML = "";
      section.hidden = true;
      return;
    }
    list.innerHTML = m.dish.options.map((o) => `
      <label class="dish-option-row" ${o.available ? "" : 'style="opacity:.55"'}>
        <input type="checkbox" data-option-id="${escapeHtml(o.optionId)}" ${m.checked.has(String(o.optionId)) ? "checked" : ""} ${o.available ? "" : "disabled"}>
        <span>${escapeHtml(o.name)}${o.available ? "" : " (недоступно)"}</span>
        <span class="dish-option-price">+${formatMoney(o.price)}</span>
      </label>`).join("");
    section.hidden = false;
    list.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
      const id = String(input.dataset.optionId);
      if (input.checked) m.checked.add(id); else m.checked.delete(id);
      refresh(false);
    }));
  }

  function setAvailability(ok, message) {
    m.configOk = ok;
    $("dish-modal-add").disabled = !ok;
    const note = $("dish-config-note");
    note.hidden = ok || !message;
    note.textContent = ok ? "" : message;
  }

  async function runConfigCheck() {
    const mine = ++m.seq;
    try {
      const res = await api.post(`/menu/dishes/${m.dish.dishId}/check-configuration`, payload());
      if (mine !== m.seq) return; // a newer choice is already being checked
      if (res.totalUnitPrice !== undefined) $("dish-modal-price").textContent = formatMoney(res.totalUnitPrice);
      if (res.configurationAvailable) setAvailability(true);
      else setAvailability(false, res.issues.map((i) => i.message).join(" ") || "Эту комбинацию сейчас приготовить нельзя.");
    } catch (err) {
      if (mine !== m.seq) return;
      setAvailability(false, err.message);
    }
  }

  function refresh(immediate) {
    ++m.seq; // reject any in-flight validation for the previous composition immediately
    renderIngredients();
    renderAllergens();
    renderPrice();
    $("composition-reset").hidden = changedLines().length === 0;
    if (immediate) runConfigCheck(); else checkConfig();
  }

  async function open(dishId) {
    try {
      const { dish } = await api.get(`/menu/dishes/${dishId}`);
      m.dish = dish;
      m.selected = new Map(dish.ingredients.map((i) => [String(i.ingredientId), Number(i.baseQuantity)]));
      m.checked = new Set();
      m.lastFocus = document.activeElement;

      $("dish-modal-title").textContent = dish.name;
      $("dish-modal-image").src = dish.imageUrl ?? "";
      $("dish-modal-image").alt = dish.name;
      $("dish-description").textContent = dish.description ?? "";
      renderOptions();
      const note = $("dish-unavailable-note");
      note.hidden = dish.available;
      note.textContent = dish.available ? "" : (dish.unavailableMessage ?? "Сейчас недостаточно ингредиентов для этого блюда.");
      setAvailability(dish.available, null);
      refresh(true);
      $("dish-modal").hidden = false;
      document.body.classList.add("modal-open");
      $("dish-modal-close").focus();
    } catch (err) {
      showToast(`Не удалось загрузить блюдо: ${err.message}`);
    }
  }

  function close() {
    $("dish-modal").hidden = true;
    document.body.classList.remove("modal-open");
    m.seq++;
    if (m.lastFocus && m.lastFocus.focus) m.lastFocus.focus();
  }

  async function addToCart() {
    if (!m.dish || !m.configOk) return;
    const button = $("dish-modal-add");
    button.disabled = true;
    try {
      await api.post(`/cart/${getSessionId()}/items`, { dishId: m.dish.dishId, ...payload() }, { client: true });
      showToast(`«${m.dish.name}» добавлено в корзину`);
      updateCartBadge();
      close();
    } catch (err) {
      showToast(err.message);
      setAvailability(false, err.message);
      button.disabled = false;
      checkConfig();
    }
  }

  return { open, close };
}

/* ============================== Cart page ============================== */
/* ТЗ §4 (корзина), §5 (проверка), §6 (возраст), §7 (оплата) + v2 (комментарий, кэшбэк, чек). */

function initCartPage() {
  const state = { cart: null, useCashback: false, pendingPaymentMethod: null, serial: null, attemptKey: null, commentDirty: false };

  loadCart();

  document.addEventListener("client-logged-out", () => {
    state.useCashback = false;
    loadCart();
    showToast("Вход в аккаунт завершён - кэшбэк недоступен");
  });

  document.getElementById("clear-cart-btn").addEventListener("click", () => toggleModal("clear-modal", true));
  document.getElementById("clear-cancel-btn").addEventListener("click", () => toggleModal("clear-modal", false));
  document.getElementById("clear-confirm-btn").addEventListener("click", async () => {
    try {
      await api.delete(`/cart/${getSessionId()}`, { client: true });
      toggleModal("clear-modal", false);
      state.commentDirty = false;
      document.getElementById("order-comment").value = "";
      await loadCart();
      updateCartBadge();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("order-btn").addEventListener("click", () => beginCheckout(state));

  // ---- comment (one for the whole order) ----
  const commentEl = document.getElementById("order-comment");
  const counterEl = document.getElementById("comment-counter");
  const saveComment = debounce(async () => {
    if (!state.commentDirty) return;
    try {
      const { cart } = await api.patch(`/cart/${getSessionId()}/comment`, { comment: commentEl.value }, { client: true });
      state.commentDirty = false;
      state.cart = cart;
    } catch (err) {
      showToast(err.message);
    }
  }, 600);
  commentEl.addEventListener("input", () => {
    state.commentDirty = true;
    counterEl.textContent = `${commentEl.value.length} / 500`;
    saveComment();
  });
  commentEl.addEventListener("blur", () => saveComment.flush());

  document.getElementById("price-confirm-btn").addEventListener("click", async () => {
    try {
      const { cart } = await api.post(`/cart/${getSessionId()}/price-confirmation`, undefined, { client: true });
      state.cart = cart;
      renderCart(cart);
    } catch (err) {
      showToast(err.message);
    }
  });

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
      const { cart } = await api.get(`/cart/${getSessionId()}?useCashback=${state.useCashback}`, { client: true });
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

    renderExtras(cart);

    if (cart.items.length === 0) {
      itemsEl.innerHTML = "";
      emptyEl.hidden = false;
      orderBtn.disabled = true;
      return;
    }
    emptyEl.hidden = true;
    orderBtn.disabled = cart.requiresPriceConfirmation;

    itemsEl.innerHTML = "";
    for (const item of cart.items) {
      const row = document.createElement("div");
      row.className = "cart-item";
      const composition = item.ingredients
        .filter((i) => i.changed)
        .map((i) =>
          i.removed
            ? `<li class="removed">${escapeHtml(i.name)} - убрать</li>`
            : `<li>${escapeHtml(i.name)}: ${escapeHtml(formatQty(i.selectedQuantity, i.unit))} на порцию (всего ${escapeHtml(formatQty(i.totalQuantity, i.unit))}; по рецепту ${escapeHtml(formatQty(i.baseQuantity, i.unit))})</li>`,
        )
        .join("");
      const optionsText = item.options.length ? item.options.map((o) => `${o.name}${o.quantity > 1 ? ` ×${o.quantity}` : ""}`).join(", ") : "";
      row.innerHTML = `
        <div class="cart-product">
          <img src="${escapeHtml(item.dishImageUrl ?? "")}" alt="${escapeHtml(item.dishName)}">
          <div>
            <div class="cart-product-labels">
              ${item.is21Plus ? '<span class="age-badge">21+</span>' : ""}
              <span class="added-label">В корзине</span>
            </div>
            <h3>${escapeHtml(item.dishName)}</h3>
            ${optionsText ? `<p class="cart-item-description">Дополнительно: ${escapeHtml(optionsText)}</p>` : ""}
            ${composition ? `<ul class="cart-item-composition">${composition}</ul>` : ""}
          </div>
        </div>
        <span class="unit-price">${formatMoney(item.unitPrice)}</span>
        <span class="quantity-control">
          <button type="button" data-action="dec" aria-label="Уменьшить количество">−</button>
          <span>${item.quantity}</span>
          <button type="button" data-action="inc" aria-label="Увеличить количество">+</button>
        </span>
        <span class="item-total">${formatMoney(item.lineTotal)}</span>
      `;
      row.querySelector('[data-action="dec"]').addEventListener("click", () => changeQuantity(item, -1));
      row.querySelector('[data-action="inc"]').addEventListener("click", () => changeQuantity(item, 1));
      itemsEl.appendChild(row);
    }
  }

  /** Comment, cashback box, price banner and the totals block. */
  function renderExtras(cart) {
    const preview = cart.loyaltyPreview;

    // comment: never overwrite what the guest is typing right now
    if (document.activeElement !== commentEl && !state.commentDirty) {
      commentEl.value = cart.comment ?? "";
      counterEl.textContent = `${commentEl.value.length} / 500`;
    }

    // price banner (reorder with changed prices)
    const banner = document.getElementById("price-banner");
    banner.hidden = !cart.requiresPriceConfirmation;
    document.getElementById("price-banner-list").innerHTML = (cart.priceChanges ?? [])
      .map((c) => `<li>${escapeHtml(c.dishName)}: было ${formatMoney(c.previousUnitPrice)}, стало ${formatMoney(c.currentUnitPrice)}</li>`)
      .join("");

    // cashback
    const body = document.getElementById("cashback-body");
    const title = document.getElementById("cashback-title");
    title.removeAttribute("for");
    if (!preview || !preview.authenticated) {
      state.useCashback = false;
      body.innerHTML = `<small>Войдите в личный кабинет, чтобы копить кэшбэк ${Math.round((preview?.cashbackRate ?? 0.05) * 100)}% и оплачивать им до ${Math.round((preview?.redemptionCap ?? 0.5) * 100)}% заказа.</small>
        <small><a href="account.html?next=cart.html">Войти или зарегистрироваться</a></small>`;
    } else if (preview.maxRedeem > 0) {
      title.setAttribute("for", "cashback-checkbox");
      body.innerHTML = `<label for="cashback-checkbox"><input type="checkbox" id="cashback-checkbox" ${state.useCashback ? "checked" : ""}> Списать кэшбэк: −${formatMoney(preview.maxRedeem)}</label>
        <small>Доступно ${formatMoney(preview.balance)}. Можно списать до ${formatMoney(preview.maxRedeem)} (не более ${Math.round(preview.redemptionCap * 100)}% заказа).</small>
        <small>После оплаты будет начислено ${formatMoney(preview.earnPreview)} (${Math.round(preview.cashbackRate * 100)}% от оплаченной суммы).</small>`;
      document.getElementById("cashback-checkbox").addEventListener("change", (e) => {
        state.useCashback = e.target.checked;
        loadCart();
      });
    } else {
      state.useCashback = false;
      body.innerHTML = `<small>Бонусов для списания пока нет.</small><small>После оплаты будет начислено ${formatMoney(preview.earnPreview)} (${Math.round(preview.cashbackRate * 100)}%). При оплате наличными - когда официант примет деньги.</small>`;
    }

    // totals
    document.getElementById("summary-count").textContent = cart.itemCount;
    document.getElementById("summary-subtotal").textContent = formatMoney(cart.subtotal);
    const discount = preview?.discount ?? 0;
    document.getElementById("summary-discount-line").hidden = !(state.useCashback && discount > 0);
    document.getElementById("summary-discount").textContent = `−${formatMoney(discount)}`;
    document.getElementById("summary-total").textContent = formatMoney(state.useCashback && preview ? preview.payableTotal : cart.subtotal);
  }

  async function changeQuantity(item, delta) {
    const newQuantity = item.quantity + delta;
    try {
      const { cart } = await api.patch(`/cart/items/${item.cartItemId}`, { quantity: newQuantity }, { client: true });
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
    saveComment.flush(); // the comment must be on the cart before it is validated / ordered
    await new Promise((r) => setTimeout(r, 0));
    let validation;
    try {
      validation = await api.get(`/checkout/${getSessionId()}/validate?useCashback=${s.useCashback}`, { client: true });
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
      document.getElementById("age-account-hint").hidden = !ClientAuth.isLoggedIn();
      toggleModal("age-modal", true);
      return;
    }

    s.expectedPayable = validation.payableTotal;
    toggleModal("payment-modal", true);
    document.getElementById("payment-total").textContent = formatMoney(validation.payableTotal);
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
    state.rfidFinishing = false;
    document.getElementById("rfid-status").textContent = "Приложите учебную RFID-карту.";
    document.getElementById("rfid-waiting").hidden = true;
    document.getElementById("rfid-connect-btn").hidden = false;
    document.getElementById("rfid-connect-btn").disabled = false;
  }

  /**
   * Real hardware path: opens Web Serial to the RC522 Arduino sketch
   * (arduino/rc522_payment.ino) and waits for its response - no fixed
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
      if (s.serial !== serial || s.rfidFinishing) return;
      if (line === "WAITING_FOR_CARD") {
        document.getElementById("rfid-waiting").hidden = false;
        connectBtn.hidden = true;
        statusEl.textContent = "Приложите карту к считывателю…";
      } else if (line.startsWith("CARD_UID:")) {
        statusEl.textContent = `Карта считана (${line.slice("CARD_UID:".length)}), проверяем…`;
      } else if (line === "PAYMENT_APPROVED") {
        finishRfidPayment(s, true);
      } else if (line === "PAYMENT_DECLINED") {
        finishRfidPayment(s, false);
      } else if (line.startsWith("ERROR:") || line === "PAYMENT_TIMEOUT") {
        const message = line === "ERROR:CARDS_NOT_CONFIGURED" ? "Сначала назначьте две карты на странице настройки RFID." : line === "PAYMENT_TIMEOUT" ? "Время ожидания карты истекло. Попробуйте снова." : "Ошибка считывателя: " + line;
        s.serial = null;
        void serial.disconnect();
        resetRfidModal();
        statusEl.textContent = message;
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
      if (s.serial !== serial) return;
      s.serial = null;
      // Most commonly: the person closed the port-picker dialog.
      statusEl.textContent = `Не удалось подключиться: ${err.message}`;
      connectBtn.disabled = false;
    }
  }

  async function cancelRfidPayment(s) {
    const serial = s.serial;
    s.serial = null;
    toggleModal("rfid-modal", false);
    if (serial) {
      try { await serial.send("CANCEL_PAYMENT"); } catch {}
      await serial.disconnect();
    }
  }

  async function finishRfidPayment(s, approved) {
    if (s.rfidFinishing || document.getElementById("rfid-modal").hidden) return;
    s.rfidFinishing = true;
    const serial = s.serial;
    s.serial = null;
    toggleModal("rfid-modal", false);
    if (serial) {
      // Let hardware finish its feedback before the port closes/reset occurs.
      await new Promise(resolve => setTimeout(resolve, 1800));
      await serial.disconnect();
    }
    if (approved) {
      await confirmOrder(s, "KASPI_QR");
    } else {
      showResult({ ok: false, title: "Оплата отклонена", message: "Учебная карта отклонена. Заказ не оплачен, корзина сохранена." });
    }
  }

  /**
   * One user ATTEMPT = one Idempotency-Key. If the network drops after the request left, pressing the button again
   * reuses the key, so the server returns the SAME order instead of creating (and charging, and spending bonuses
   * for) a second one. The key is discarded once the attempt has a definite answer.
   */
  async function confirmOrder(s, method) {
    toggleModal("payment-modal", false);
    s.attemptKey = s.attemptKey ?? newIdempotencyKey();
    try {
      const { order, earnedBonus } = await api.post(
        `/checkout/${getSessionId()}/confirm`,
        { paymentMethod: method, useCashback: s.useCashback, ...(s.expectedPayable ? { expectedPayableTotal: s.expectedPayable } : {}) },
        { client: true, idempotencyKey: s.attemptKey },
      );
      s.attemptKey = null;
      s.useCashback = false;
      state.commentDirty = false;
      sessionStorage.setItem("restaurant.lastOrderId", order.orderId);
      await loadCart();
      updateCartBadge();
      const paid = order.paymentStatus === "PAID";
      const bonusNote = order.discountBonus > 0 ? ` Бонусами оплачено ${formatMoney(order.discountBonus)}.` : "";
      const earnNote = earnedBonus > 0 ? ` Начислено кэшбэка: ${formatMoney(earnedBonus)}.` : "";
      const paidNote = paid ? "Оплата Kaspi QR прошла успешно." : "Оплатите наличными официанту при получении заказа - после этого появится чек.";
      showResult({
        ok: true,
        title: "Заказ оформлен",
        message: `Заказ №${order.orderId} на сумму ${formatMoney(order.payableTotal)} передан на кухню. ${paidNote}${bonusNote}${earnNote}`,
        receiptOrderId: order.orderId,
      });
    } catch (err) {
      if (err.code === "NETWORK_ERROR") {
        // keep the attempt key: pressing "Заказать" again is a safe retry of the SAME order
        showResult({ ok: false, title: "Нет связи с сервером", message: "Ответ не получен. Нажмите «Заказать» ещё раз - повторная отправка не создаст дубликат заказа." });
        return;
      }
      s.attemptKey = null;
      if (err.code === "CHECKOUT_VALIDATION_FAILED") {
        renderIssues(err.details?.issues ?? []);
        await loadCart();
      } else if (err.code === "CASHBACK_CONFLICT") {
        await loadCart();
        showToast(`Сумма к оплате изменилась: ${formatMoney(err.details?.payableTotal)}. Проверьте итог и оформите заказ ещё раз.`);
      } else if (err.code === "CASHBACK_INSUFFICIENT" || err.code === "CLIENT_UNAUTHORIZED") {
        s.useCashback = false;
        await loadCart();
        showToast(err.message);
      } else {
        showResult({ ok: false, title: "Не удалось оформить заказ", message: err.message });
      }
    }
  }

  function showResult({ ok, title, message, receiptOrderId = null }) {
    document.getElementById("result-card").classList.toggle("result-fail", !ok);
    document.getElementById("result-mark").textContent = ok ? "✓" : "✕";
    document.getElementById("result-title").textContent = title;
    document.getElementById("result-message").textContent = message;
    const receiptBtn = document.getElementById("result-receipt-btn");
    receiptBtn.hidden = !receiptOrderId;
    receiptBtn.onclick = () => ReceiptViewer.open({ orderId: receiptOrderId });
    toggleModal("result-modal", true);
  }
}
