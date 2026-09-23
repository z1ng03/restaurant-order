// Admin panel: full CRUD over tables, orders (incl. cancel), the menu
// catalog (categories/dishes/ingredients/inventory/options/allergens), and
// staff accounts. Every request here goes through /api/admin/*, gated to
// the ADMIN role server-side (see backend/src/modules/admin).

let TOKEN = null;
const REF = { categories: null, ingredients: null, options: null, allergens: null };

document.addEventListener("DOMContentLoaded", () => {
  initStaffGate({
    allowedRoles: ["ADMIN"],
    roleLabel: "администратор",
    onReady: (session) => {
      TOKEN = session.token;
      initTabs();
      loadDashboard();
    },
  });

  document.getElementById("admin-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".admin-tab");
    if (btn) switchTab(btn.dataset.tab);
  });

  document.getElementById("form-modal-close").addEventListener("click", closeFormModal);
  document.getElementById("form-modal").addEventListener("click", (e) => {
    if (e.target.id === "form-modal") closeFormModal();
  });
});

function initTabs() {
  // Each tab lazy-loads the first time it's opened.
  const loaders = {
    tables: loadTables,
    orders: () => loadOrders(),
    menu: loadMenuTab,
    inventory: loadIngredients,
    options: loadOptionsTab,
    staff: loadUsers,
  };
  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.dataset.loaded = "";
    if (btn.dataset.tab === "dashboard") btn.dataset.loaded = "1";
  });
  window.__adminLoaders = loaders;
}

function switchTab(tab) {
  document.querySelectorAll(".admin-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  document.querySelectorAll(".admin-panel").forEach((panel) => (panel.hidden = panel.dataset.panel !== tab));

  const btn = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
  if (btn && !btn.dataset.loaded) {
    btn.dataset.loaded = "1";
    window.__adminLoaders[tab]?.();
  }
}

/* ------------------------------- API helpers ------------------------------- */

function adminGet(path) {
  return api.get(path, { token: TOKEN });
}
function adminPost(path, body) {
  return api.post(path, body, { token: TOKEN });
}
function adminPatch(path, body) {
  return api.patch(path, body, { token: TOKEN });
}
function adminDelete(path) {
  return api.delete(path, { token: TOKEN });
}

async function ensureReferenceData(force = false) {
  if (!force && REF.categories && REF.ingredients && REF.options && REF.allergens) return REF;
  const [{ categories }, { ingredients }, { options }, { allergens }] = await Promise.all([
    adminGet("/admin/categories"),
    adminGet("/admin/ingredients"),
    adminGet("/admin/options"),
    adminGet("/admin/allergens"),
  ]);
  REF.categories = categories;
  REF.ingredients = ingredients;
  REF.options = options;
  REF.allergens = allergens;
  return REF;
}

function formatPrice(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value))} ₸`;
}

function formatQty(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(value));
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function handleApiError(err) {
  if (err.status === 401) {
    clearStaffSession();
    location.reload();
    return;
  }
  showToast(err.message);
}

/* ------------------------------ Form modal ------------------------------- */
/* A shared modal used by every "create/edit X" flow below. Callers set the
   title + inner HTML, wire a submit handler, and this just handles
   open/close plumbing so each entity's code stays focused on its fields. */

function openFormModal(title) {
  document.getElementById("form-modal-title").textContent = title;
  const form = document.getElementById("form-modal-form");
  form.innerHTML = "";
  document.getElementById("form-modal").hidden = false;
  return form;
}

function closeFormModal() {
  document.getElementById("form-modal").hidden = true;
}

function formActionsHtml(submitLabel) {
  return `
    <div class="admin-form-actions">
      <button type="button" class="secondary-btn" data-cancel>Отмена</button>
      <button type="submit" class="order-btn">${submitLabel}</button>
    </div>
    <p class="admin-form-error" data-form-error hidden></p>
  `;
}

function wireFormActions(form, onSubmit) {
  form.querySelector("[data-cancel]").addEventListener("click", closeFormModal);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector("[data-form-error]");
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await onSubmit(new FormData(form));
      closeFormModal();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/* ----------------------------- Field builders ----------------------------- */

function fText(name, label, value = "", opts = {}) {
  return `<label>${label}<input type="text" name="${name}" value="${escapeAttr(value)}" ${opts.required ? "required" : ""}></label>`;
}
function fNumber(name, label, value = "", opts = {}) {
  const step = opts.step ?? "any";
  return `<label>${label}<input type="number" name="${name}" value="${escapeAttr(value)}" step="${step}" ${opts.min !== undefined ? `min="${opts.min}"` : ""} ${opts.required ? "required" : ""}></label>`;
}
function fPassword(name, label, opts = {}) {
  return `<label>${label}<input type="password" name="${name}" ${opts.required ? "required" : ""} minlength="6"></label>`;
}
function fTextarea(name, label, value = "") {
  return `<label>${label}<textarea name="${name}">${escapeHtml(value)}</textarea></label>`;
}
function fSelect(name, label, options, selectedValue) {
  const opts = options
    .map((o) => `<option value="${escapeAttr(o.value)}" ${String(o.value) === String(selectedValue) ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
  return `<label>${label}<select name="${name}">${opts}</select></label>`;
}
function fCheckbox(name, label, checked) {
  return `<label class="admin-form-checkbox"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}> ${label}</label>`;
}
function fCheckboxGrid(name, label, items, selectedIds) {
  const selected = new Set((selectedIds ?? []).map(String));
  const boxes = items
    .map(
      (item) =>
        `<label><input type="checkbox" name="${name}" value="${item.id}" ${selected.has(String(item.id)) ? "checked" : ""}> ${escapeHtml(item.label)}</label>`,
    )
    .join("");
  return `<div><span class="admin-form-checkbox" style="margin-bottom:8px;display:block;">${label}</span><div class="admin-checkbox-grid">${boxes || '<span class="admin-muted-cell">Список пуст</span>'}</div></div>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function escapeAttr(str) {
  return escapeHtml(str);
}

function getCheckedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
}

/* ================================ Dashboard ================================ */

async function loadDashboard() {
  const cardsEl = document.getElementById("dashboard-cards");
  const lowStockEl = document.getElementById("dashboard-low-stock");
  try {
    const d = await adminGet("/admin/dashboard");
    cardsEl.innerHTML = [
      card("Столики свободны", d.tables.free, `занято: ${d.tables.occupied}`),
      card("Активные сессии", d.activeSessions, ""),
      card("На кухне", d.ordersByStatus.SENT_TO_KITCHEN ?? 0, "заказов"),
      card("Готовы к выдаче", d.ordersByStatus.READY_FOR_DELIVERY ?? 0, "заказов"),
      card("В пути", d.ordersByStatus.OUT_FOR_DELIVERY ?? 0, "заказов"),
      card("Выручка сегодня", formatPrice(d.todaysRevenue), `${d.todaysPaidOrderCount} оплаченных заказов`),
    ].join("");

    lowStockEl.innerHTML = d.lowestStockIngredients.length
      ? d.lowestStockIngredients
          .map((i) => `<div class="admin-low-stock-row"><span>${escapeHtml(i.name)}</span><strong>${formatQty(i.free)} ${escapeHtml(i.unit)}</strong></div>`)
          .join("")
      : '<p class="admin-muted-cell">Нет данных.</p>';
  } catch (err) {
    await handleApiError(err);
  }
}

function card(title, value, sub) {
  return `<div class="admin-card"><h3>${title}</h3><div class="admin-card-value">${value}</div><span class="admin-card-label">${sub}</span></div>`;
}

/* ================================= Tables =================================== */

async function loadTables() {
  const tbody = document.querySelector("#tables-table tbody");
  try {
    const { tables } = await adminGet("/admin/tables");
    tbody.innerHTML = tables.length
      ? tables
          .map(
            (t) => `
        <tr>
          <td>№${t.tableNumber}</td>
          <td>${t.monitorNumber}</td>
          <td><span class="admin-pill ${t.status === "FREE" ? "admin-pill-on" : "admin-pill-off"}">${t.status}</span></td>
          <td class="admin-muted-cell">${t.activeSession ? `сессия #${t.activeSession.sessionId}` : "—"}</td>
          <td class="admin-row-actions">
            <button class="admin-link-btn" data-action="edit" data-id="${t.tableId}">Изменить</button>
            ${t.status === "OCCUPIED" ? `<button class="admin-link-btn" data-action="free" data-id="${t.tableId}">Освободить</button>` : `<button class="admin-link-btn" data-action="occupy" data-id="${t.tableId}">Занять</button>`}
          </td>
        </tr>`,
          )
          .join("")
      : `<tr class="admin-empty-row"><td colspan="5">Столиков пока нет.</td></tr>`;

    tbody.querySelectorAll('[data-action="free"]').forEach((btn) =>
      btn.addEventListener("click", () => setTableStatus(btn.dataset.id, "FREE")),
    );
    tbody.querySelectorAll('[data-action="occupy"]').forEach((btn) =>
      btn.addEventListener("click", () => setTableStatus(btn.dataset.id, "OCCUPIED")),
    );
    tbody.querySelectorAll('[data-action="edit"]').forEach((btn) =>
      btn.addEventListener("click", () => openEditTableForm(tables.find((t) => String(t.tableId) === btn.dataset.id))),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

async function setTableStatus(tableId, status) {
  try {
    await adminPatch(`/admin/tables/${tableId}/status`, { status });
    showToast(status === "FREE" ? "Столик освобождён" : "Столик занят");
    loadTables();
  } catch (err) {
    await handleApiError(err);
  }
}

document.getElementById("table-add-btn")?.addEventListener("click", () => openTableForm());

function openTableForm() {
  const form = openFormModal("Новый столик");
  form.innerHTML =
    fNumber("tableNumber", "Номер столика", "", { required: true, min: 1, step: 1 }) +
    fNumber("monitorNumber", "Номер монитора", "", { required: true, min: 1, step: 1 }) +
    formActionsHtml("Создать");
  wireFormActions(form, async (fd) => {
    await adminPost("/admin/tables", {
      tableNumber: Number(fd.get("tableNumber")),
      monitorNumber: Number(fd.get("monitorNumber")),
    });
    showToast("Столик создан");
    loadTables();
  });
}

function openEditTableForm(table) {
  const form = openFormModal(`Столик №${table.tableNumber}`);
  form.innerHTML =
    fNumber("tableNumber", "Номер столика", table.tableNumber, { required: true, min: 1, step: 1 }) +
    fNumber("monitorNumber", "Номер монитора", table.monitorNumber, { required: true, min: 1, step: 1 }) +
    formActionsHtml("Сохранить");
  wireFormActions(form, async (fd) => {
    await adminPatch(`/admin/tables/${table.tableId}`, {
      tableNumber: Number(fd.get("tableNumber")),
      monitorNumber: Number(fd.get("monitorNumber")),
    });
    showToast("Столик обновлён");
    loadTables();
  });
}

/* ================================= Orders ==================================== */

document.getElementById("orders-status-filter")?.addEventListener("change", (e) => loadOrders(e.target.value));

async function loadOrders(status = "") {
  const tbody = document.querySelector("#orders-table tbody");
  try {
    const query = status ? `?status=${encodeURIComponent(status)}&limit=50` : "?limit=50";
    const { orders } = await adminGet(`/admin/orders${query}`);
    tbody.innerHTML = orders.length
      ? orders.map((o) => orderRowHtml(o)).join("")
      : `<tr class="admin-empty-row"><td colspan="8">Заказов не найдено.</td></tr>`;

    tbody.querySelectorAll('[data-action="cancel"]').forEach((btn) =>
      btn.addEventListener("click", () => cancelOrder(btn.dataset.id, status)),
    );
    tbody.querySelectorAll('[data-action="view"]').forEach((btn) =>
      btn.addEventListener("click", () => viewOrder(btn.dataset.id)),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

function orderRowHtml(o) {
  const dishNames = o.items.map((i) => `${i.dish.name} ×${i.quantity}`).join(", ");
  const cancellable = o.orderStatus !== "DELIVERED" && o.orderStatus !== "CANCELLED";
  return `
    <tr>
      <td>№${o.orderId}</td>
      <td>№${o.table.tableNumber}</td>
      <td class="admin-muted-cell" title="${escapeAttr(dishNames)}">${escapeHtml(dishNames.length > 40 ? dishNames.slice(0, 40) + "…" : dishNames)}</td>
      <td><span class="admin-pill ${o.orderStatus === "CANCELLED" ? "admin-pill-off" : "admin-pill-on"}">${o.orderStatus}</span></td>
      <td class="admin-muted-cell">${o.paymentStatus}</td>
      <td>${formatPrice(o.totalPrice)}</td>
      <td class="admin-muted-cell">${new Date(o.createdAt).toLocaleString("ru-RU")}</td>
      <td class="admin-row-actions">
        <button class="admin-link-btn" data-action="view" data-id="${o.orderId}">Детали</button>
        ${cancellable ? `<button class="admin-link-btn admin-danger" data-action="cancel" data-id="${o.orderId}">Отменить</button>` : ""}
      </td>
    </tr>`;
}

async function cancelOrder(orderId, currentFilter) {
  if (!confirm(`Отменить заказ №${orderId}? Зарезервированные, но ещё не списанные ингредиенты будут возвращены на склад.`)) return;
  try {
    await adminPost(`/admin/orders/${orderId}/cancel`, {});
    showToast(`Заказ №${orderId} отменён`);
    loadOrders(currentFilter);
  } catch (err) {
    await handleApiError(err);
  }
}

async function viewOrder(orderId) {
  try {
    const { order: o } = await adminGet(`/admin/orders/${orderId}`);
    const form = openFormModal(`Заказ №${o.orderId} — Столик №${o.table.tableNumber}`);
    const itemsHtml = o.items
      .map((i) => {
        const opts = i.options.map((x) => x.option.name).join(", ");
        return `<div class="admin-low-stock-row"><span>${escapeHtml(i.dish.name)} ×${i.quantity}${opts ? ` (${escapeHtml(opts)})` : ""} — <span class="admin-muted-cell">${i.status}</span></span><strong>${formatPrice(i.price)}</strong></div>`;
      })
      .join("");
    const payment = o.payments[0];
    form.innerHTML = `
      <div class="admin-order-detail">
        <p><strong>Статус заказа:</strong> ${o.orderStatus} &nbsp; <strong>Оплата:</strong> ${o.paymentStatus}${payment ? ` (${payment.method})` : ""}</p>
        <p><strong>Официант:</strong> ${o.waiter ? escapeHtml(o.waiter.name) : "—"}</p>
        <p><strong>Создан:</strong> ${new Date(o.createdAt).toLocaleString("ru-RU")}${o.deliveredAt ? ` &nbsp; <strong>Выдан:</strong> ${new Date(o.deliveredAt).toLocaleString("ru-RU")}` : ""}</p>
      </div>
      <div>${itemsHtml}</div>
      <div class="admin-low-stock-row"><strong>Итого</strong><strong>${formatPrice(o.totalPrice)}</strong></div>
      <div class="admin-form-actions"><button type="button" class="secondary-btn" data-cancel>Закрыть</button></div>
    `;
    form.querySelector("[data-cancel]").addEventListener("click", closeFormModal);
    form.addEventListener("submit", (e) => e.preventDefault());
  } catch (err) {
    await handleApiError(err);
  }
}

/* ================================== Menu ===================================== */

async function loadMenuTab() {
  await ensureReferenceData(true);
  renderCategoriesTable();
  populateCategoryFilter();
  loadDishes();
}

function renderCategoriesTable() {
  const tbody = document.querySelector("#categories-table tbody");
  tbody.innerHTML = REF.categories.length
    ? REF.categories
        .map(
          (c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.sortOrder}</td>
        <td><span class="admin-pill ${c.isActive ? "admin-pill-on" : "admin-pill-off"}">${c.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions"><button class="admin-link-btn" data-action="edit-category" data-id="${c.categoryId}">Изменить</button></td>
      </tr>`,
        )
        .join("")
    : `<tr class="admin-empty-row"><td colspan="4">Категорий пока нет.</td></tr>`;

  tbody.querySelectorAll('[data-action="edit-category"]').forEach((btn) =>
    btn.addEventListener("click", () => openCategoryForm(REF.categories.find((c) => String(c.categoryId) === btn.dataset.id))),
  );
}

function populateCategoryFilter() {
  const select = document.getElementById("dishes-category-filter");
  const current = select.value;
  select.innerHTML =
    '<option value="">Все категории</option>' +
    REF.categories.map((c) => `<option value="${c.categoryId}">${escapeHtml(c.name)}</option>`).join("");
  select.value = current;
}
document.getElementById("dishes-category-filter")?.addEventListener("change", () => loadDishes());

document.getElementById("category-add-btn")?.addEventListener("click", () => openCategoryForm());

function openCategoryForm(category) {
  const form = openFormModal(category ? `Категория: ${category.name}` : "Новая категория");
  form.innerHTML =
    fText("name", "Название", category?.name ?? "", { required: true }) +
    fTextarea("description", "Описание", category?.description ?? "") +
    fText("imageUrl", "URL изображения", category?.imageUrl ?? "") +
    fNumber("sortOrder", "Порядок сортировки", category?.sortOrder ?? 0, { step: 1 }) +
    (category ? fCheckbox("isActive", "Активна (показывать в меню)", category.isActive) : "") +
    formActionsHtml(category ? "Сохранить" : "Создать");

  wireFormActions(form, async (fd) => {
    const body = {
      name: fd.get("name"),
      description: fd.get("description") || undefined,
      imageUrl: fd.get("imageUrl") || undefined,
      sortOrder: fd.get("sortOrder") !== null ? Number(fd.get("sortOrder")) : undefined,
    };
    if (category) {
      body.isActive = fd.get("isActive") === "on";
      await adminPatch(`/admin/categories/${category.categoryId}`, body);
      showToast("Категория обновлена");
    } else {
      await adminPost("/admin/categories", body);
      showToast("Категория создана");
    }
    await ensureReferenceData(true);
    renderCategoriesTable();
    populateCategoryFilter();
  });
}

async function loadDishes() {
  const tbody = document.querySelector("#dishes-table tbody");
  const categoryId = document.getElementById("dishes-category-filter").value;
  try {
    const query = categoryId ? `?categoryId=${categoryId}` : "";
    const { dishes } = await adminGet(`/admin/dishes${query}`);
    tbody.innerHTML = dishes.length
      ? dishes
          .map(
            (d) => `
      <tr>
        <td>${escapeHtml(d.name)}</td>
        <td class="admin-muted-cell">${escapeHtml(d.category.name)}</td>
        <td>${formatPrice(d.price)}</td>
        <td>${d.is21Plus ? "21+" : "—"}</td>
        <td><span class="admin-pill ${d.isActive ? "admin-pill-on" : "admin-pill-off"}">${d.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions"><button class="admin-link-btn" data-action="edit-dish" data-id="${d.dishId}">Изменить</button></td>
      </tr>`,
          )
          .join("")
      : `<tr class="admin-empty-row"><td colspan="6">Блюд не найдено.</td></tr>`;

    tbody.querySelectorAll('[data-action="edit-dish"]').forEach((btn) =>
      btn.addEventListener("click", () => openDishFormById(btn.dataset.id)),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

document.getElementById("dish-add-btn")?.addEventListener("click", () => openDishForm(null));

async function openDishFormById(dishId) {
  try {
    const { dish } = await adminGet(`/admin/dishes/${dishId}`);
    openDishForm(dish);
  } catch (err) {
    await handleApiError(err);
  }
}

/** Recipe rows are built as repeatable ingredient+quantity lines; allergens/options as checkbox grids. */
function openDishForm(dish) {
  const form = openFormModal(dish ? `Блюдо: ${dish.name}` : "Новое блюдо");

  const categoryOptions = REF.categories.map((c) => ({ value: c.categoryId, label: c.name }));
  const recipeRows = dish?.recipes?.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })) ?? [];
  const allergenItems = REF.allergens.map((a) => ({ id: a.allergenId, label: a.name }));
  const optionItems = REF.options.map((o) => ({ id: o.optionId, label: `${o.name} (+${formatPrice(o.price)})` }));

  form.innerHTML = `
    ${fText("name", "Название", dish?.name ?? "", { required: true })}
    <div class="admin-form-row">
      ${fSelect("categoryId", "Категория", categoryOptions, dish?.category?.categoryId)}
      ${fNumber("price", "Цена, ₸", dish?.price ?? "", { required: true, min: 0 })}
    </div>
    ${fTextarea("description", "Описание", dish?.description ?? "")}
    ${fText("imageUrl", "URL изображения", dish?.imageUrl ?? "")}
    <div class="admin-form-row">
      ${fCheckbox("is21Plus", "Блюдо 21+", dish?.is21Plus)}
      ${dish ? fCheckbox("isActive", "Активно (в меню)", dish.isActive) : ""}
    </div>
    <div>
      <span class="admin-form-checkbox" style="margin-bottom:8px;display:block;">Состав (рецепт)</span>
      <div class="admin-repeatable" id="dish-recipe-rows"></div>
      <button type="button" class="admin-add-row-btn" id="dish-recipe-add">+ ингредиент</button>
    </div>
    ${fCheckboxGrid("allergenIds", "Аллергены", allergenItems, dish?.allergens?.map((a) => a.allergen.allergenId))}
    ${fCheckboxGrid("availableOptionIds", "Доступные опции", optionItems, dish?.availableOptions?.map((o) => o.option.optionId))}
    ${formActionsHtml(dish ? "Сохранить" : "Создать")}
  `;

  const rowsContainer = form.querySelector("#dish-recipe-rows");
  const ingredientOptions = REF.ingredients.map((i) => ({ value: i.ingredientId, label: `${i.name} (${i.unit})` }));

  function addRecipeRow(ingredientId, quantity) {
    const row = document.createElement("div");
    row.className = "admin-repeatable-row";
    row.innerHTML = `
      <select name="recipe-ingredient">${ingredientOptions.map((o) => `<option value="${o.value}" ${String(o.value) === String(ingredientId) ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>
      <input type="number" name="recipe-quantity" value="${quantity ?? ""}" step="any" min="0" placeholder="кол-во">
      <button type="button" class="admin-repeatable-remove" title="Удалить">×</button>
    `;
    row.querySelector(".admin-repeatable-remove").addEventListener("click", () => row.remove());
    rowsContainer.appendChild(row);
  }
  (recipeRows.length ? recipeRows : [{}]).forEach((r) => addRecipeRow(r.ingredientId, r.quantity));
  form.querySelector("#dish-recipe-add").addEventListener("click", () => addRecipeRow());

  wireFormActions(form, async (fd) => {
    const recipe = [...rowsContainer.querySelectorAll(".admin-repeatable-row")]
      .map((row) => ({
        ingredientId: row.querySelector('[name="recipe-ingredient"]').value,
        quantity: Number(row.querySelector('[name="recipe-quantity"]').value),
      }))
      .filter((r) => r.ingredientId && r.quantity > 0);

    const body = {
      name: fd.get("name"),
      categoryId: fd.get("categoryId"),
      price: Number(fd.get("price")),
      description: fd.get("description") || undefined,
      imageUrl: fd.get("imageUrl") || undefined,
      is21Plus: fd.get("is21Plus") === "on",
      recipe,
      allergenIds: getCheckedValues(form, "allergenIds"),
      availableOptionIds: getCheckedValues(form, "availableOptionIds"),
    };

    if (dish) {
      body.isActive = fd.get("isActive") === "on";
      await adminPatch(`/admin/dishes/${dish.dishId}`, body);
      showToast("Блюдо обновлено");
    } else {
      await adminPost("/admin/dishes", body);
      showToast("Блюдо создано");
    }
    loadDishes();
  });
}

/* ================================ Inventory ==================================== */

async function loadIngredients() {
  const tbody = document.querySelector("#ingredients-table tbody");
  try {
    const { ingredients } = await adminGet("/admin/ingredients");
    tbody.innerHTML = ingredients.length
      ? ingredients
          .map((i) => {
            const free = Number(i.stockQuantity) - Number(i.reservedQuantity);
            return `
      <tr>
        <td>${escapeHtml(i.name)}</td>
        <td class="admin-muted-cell">${escapeHtml(i.unit)}</td>
        <td><input class="admin-stock-input" type="number" step="any" min="0" value="${i.stockQuantity}" data-id="${i.ingredientId}"></td>
        <td class="admin-muted-cell">${formatQty(i.reservedQuantity)}</td>
        <td>${formatQty(free)}</td>
        <td><span class="admin-pill ${i.isActive ? "admin-pill-on" : "admin-pill-off"}">${i.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-link-btn" data-action="save-stock" data-id="${i.ingredientId}">Сохранить</button>
          <button class="admin-link-btn" data-action="edit-ingredient" data-id="${i.ingredientId}">Изменить</button>
        </td>
      </tr>`;
          })
          .join("")
      : `<tr class="admin-empty-row"><td colspan="7">Ингредиентов пока нет.</td></tr>`;

    tbody.querySelectorAll('[data-action="save-stock"]').forEach((btn) =>
      btn.addEventListener("click", () => saveStock(btn.dataset.id, tbody)),
    );
    tbody.querySelectorAll('[data-action="edit-ingredient"]').forEach((btn) =>
      btn.addEventListener("click", () => openIngredientForm(ingredients.find((i) => String(i.ingredientId) === btn.dataset.id))),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

async function saveStock(ingredientId, tbody) {
  const input = tbody.querySelector(`.admin-stock-input[data-id="${ingredientId}"]`);
  const value = Number(input.value);
  if (!(value >= 0)) {
    showToast("Остаток не может быть отрицательным");
    return;
  }
  try {
    await adminPatch(`/admin/ingredients/${ingredientId}/stock`, { stockQuantity: value });
    showToast("Остаток обновлён");
    loadIngredients();
  } catch (err) {
    await handleApiError(err);
  }
}

document.getElementById("ingredient-add-btn")?.addEventListener("click", () => openIngredientForm());

function openIngredientForm(ingredient) {
  const form = openFormModal(ingredient ? `Ингредиент: ${ingredient.name}` : "Новый ингредиент");
  const unitOptions = ["g", "kg", "ml", "l", "pcs"].map((u) => ({ value: u, label: u }));
  form.innerHTML =
    fText("name", "Название", ingredient?.name ?? "", { required: true }) +
    fSelect("unit", "Единица измерения", unitOptions, ingredient?.unit ?? "g") +
    (ingredient ? fCheckbox("isActive", "Активен", ingredient.isActive) : fNumber("initialStock", "Начальный остаток", 0, { min: 0 })) +
    formActionsHtml(ingredient ? "Сохранить" : "Создать");

  wireFormActions(form, async (fd) => {
    if (ingredient) {
      await adminPatch(`/admin/ingredients/${ingredient.ingredientId}`, {
        name: fd.get("name"),
        unit: fd.get("unit"),
        isActive: fd.get("isActive") === "on",
      });
      showToast("Ингредиент обновлён");
    } else {
      await adminPost("/admin/ingredients", {
        name: fd.get("name"),
        unit: fd.get("unit"),
        initialStock: Number(fd.get("initialStock") || 0),
      });
      showToast("Ингредиент создан");
    }
    await ensureReferenceData(true);
    loadIngredients();
  });
}

/* ============================= Options & Allergens ============================== */

async function loadOptionsTab() {
  await ensureReferenceData(true);
  renderOptionsTable();
  renderAllergensTable();
}

function renderOptionsTable() {
  const tbody = document.querySelector("#options-table tbody");
  tbody.innerHTML = REF.options.length
    ? REF.options
        .map((o) => {
          const composition = o.ingredients.map((i) => `${i.ingredient.name} (${i.quantity}${i.ingredient.unit})`).join(", ");
          return `
      <tr>
        <td>${escapeHtml(o.name)}</td>
        <td>${formatPrice(o.price)}</td>
        <td class="admin-muted-cell">${escapeHtml(composition || "—")}</td>
        <td><span class="admin-pill ${o.isActive ? "admin-pill-on" : "admin-pill-off"}">${o.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions"><button class="admin-link-btn" data-action="edit-option" data-id="${o.optionId}">Изменить</button></td>
      </tr>`;
        })
        .join("")
    : `<tr class="admin-empty-row"><td colspan="5">Опций пока нет.</td></tr>`;

  tbody.querySelectorAll('[data-action="edit-option"]').forEach((btn) =>
    btn.addEventListener("click", () => openOptionForm(REF.options.find((o) => String(o.optionId) === btn.dataset.id))),
  );
}

document.getElementById("option-add-btn")?.addEventListener("click", () => openOptionForm());

function openOptionForm(option) {
  const form = openFormModal(option ? `Опция: ${option.name}` : "Новая опция");
  const ingredientOptions = REF.ingredients.map((i) => ({ value: i.ingredientId, label: `${i.name} (${i.unit})` }));
  const existingIngredients = option?.ingredients?.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity })) ?? [];

  form.innerHTML = `
    ${fText("name", "Название", option?.name ?? "", { required: true })}
    ${fNumber("price", "Цена, ₸", option?.price ?? "", { required: true, min: 0 })}
    ${fTextarea("description", "Описание", option?.description ?? "")}
    ${option ? fCheckbox("isActive", "Активна", option.isActive) : ""}
    <div>
      <span class="admin-form-checkbox" style="margin-bottom:8px;display:block;">Расход ингредиентов на опцию</span>
      <div class="admin-repeatable" id="option-ingredient-rows"></div>
      <button type="button" class="admin-add-row-btn" id="option-ingredient-add">+ ингредиент</button>
    </div>
    ${formActionsHtml(option ? "Сохранить" : "Создать")}
  `;

  const rowsContainer = form.querySelector("#option-ingredient-rows");
  function addRow(ingredientId, quantity) {
    const row = document.createElement("div");
    row.className = "admin-repeatable-row";
    row.innerHTML = `
      <select name="opt-ingredient">${ingredientOptions.map((o) => `<option value="${o.value}" ${String(o.value) === String(ingredientId) ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>
      <input type="number" name="opt-quantity" value="${quantity ?? ""}" step="any" min="0" placeholder="кол-во">
      <button type="button" class="admin-repeatable-remove" title="Удалить">×</button>
    `;
    row.querySelector(".admin-repeatable-remove").addEventListener("click", () => row.remove());
    rowsContainer.appendChild(row);
  }
  (existingIngredients.length ? existingIngredients : [{}]).forEach((r) => addRow(r.ingredientId, r.quantity));
  form.querySelector("#option-ingredient-add").addEventListener("click", () => addRow());

  wireFormActions(form, async (fd) => {
    const ingredients = [...rowsContainer.querySelectorAll(".admin-repeatable-row")]
      .map((row) => ({
        ingredientId: row.querySelector('[name="opt-ingredient"]').value,
        quantity: Number(row.querySelector('[name="opt-quantity"]').value),
      }))
      .filter((r) => r.ingredientId && r.quantity > 0);

    const body = {
      name: fd.get("name"),
      price: Number(fd.get("price")),
      description: fd.get("description") || undefined,
      ingredients,
    };
    if (option) {
      body.isActive = fd.get("isActive") === "on";
      await adminPatch(`/admin/options/${option.optionId}`, body);
      showToast("Опция обновлена");
    } else {
      await adminPost("/admin/options", body);
      showToast("Опция создана");
    }
    await ensureReferenceData(true);
    renderOptionsTable();
  });
}

function renderAllergensTable() {
  const tbody = document.querySelector("#allergens-table tbody");
  tbody.innerHTML = REF.allergens.length
    ? REF.allergens
        .map(
          (a) => `
      <tr>
        <td>${escapeHtml(a.name)}</td>
        <td class="admin-muted-cell">${escapeHtml(a.description || "—")}</td>
        <td class="admin-row-actions"><button class="admin-link-btn" data-action="edit-allergen" data-id="${a.allergenId}">Изменить</button></td>
      </tr>`,
        )
        .join("")
    : `<tr class="admin-empty-row"><td colspan="3">Аллергенов пока нет.</td></tr>`;

  tbody.querySelectorAll('[data-action="edit-allergen"]').forEach((btn) =>
    btn.addEventListener("click", () => openAllergenForm(REF.allergens.find((a) => String(a.allergenId) === btn.dataset.id))),
  );
}

document.getElementById("allergen-add-btn")?.addEventListener("click", () => openAllergenForm());

function openAllergenForm(allergen) {
  const form = openFormModal(allergen ? `Аллерген: ${allergen.name}` : "Новый аллерген");
  form.innerHTML =
    fText("name", "Название", allergen?.name ?? "", { required: true }) +
    fTextarea("description", "Описание", allergen?.description ?? "") +
    formActionsHtml(allergen ? "Сохранить" : "Создать");

  wireFormActions(form, async (fd) => {
    const body = { name: fd.get("name"), description: fd.get("description") || undefined };
    if (allergen) {
      await adminPatch(`/admin/allergens/${allergen.allergenId}`, body);
      showToast("Аллерген обновлён");
    } else {
      await adminPost("/admin/allergens", body);
      showToast("Аллерген создан");
    }
    await ensureReferenceData(true);
    renderAllergensTable();
  });
}

/* ================================== Staff ====================================== */

async function loadUsers() {
  const tbody = document.querySelector("#users-table tbody");
  try {
    const { users } = await adminGet("/admin/users");
    tbody.innerHTML = users.length
      ? users
          .map(
            (u) => `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td class="admin-muted-cell">${escapeHtml(u.login)}</td>
        <td>${u.role}</td>
        <td><span class="admin-pill ${u.isActive ? "admin-pill-on" : "admin-pill-off"}">${u.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions"><button class="admin-link-btn" data-action="edit-user" data-id="${u.userId}">Изменить</button></td>
      </tr>`,
          )
          .join("")
      : `<tr class="admin-empty-row"><td colspan="5">Сотрудников пока нет.</td></tr>`;

    tbody.querySelectorAll('[data-action="edit-user"]').forEach((btn) =>
      btn.addEventListener("click", () => openUserForm(users.find((u) => String(u.userId) === btn.dataset.id))),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

document.getElementById("user-add-btn")?.addEventListener("click", () => openUserForm());

function openUserForm(user) {
  const form = openFormModal(user ? `Сотрудник: ${user.name}` : "Новый сотрудник");
  const roleOptions = [
    { value: "WAITER", label: "Официант" },
    { value: "CHEF", label: "Повар" },
    { value: "ADMIN", label: "Администратор" },
  ];

  form.innerHTML = `
    ${fText("name", "Имя", user?.name ?? "", { required: true })}
    ${user ? `<label>Логин<input type="text" value="${escapeAttr(user.login)}" disabled></label>` : fText("login", "Логин", "", { required: true })}
    ${fSelect("role", "Роль", roleOptions, user?.role ?? "WAITER")}
    ${fPassword("password", user ? "Новый пароль (необязательно)" : "Пароль", { required: !user })}
    ${user ? fCheckbox("isActive", "Активен (может входить в систему)", user.isActive) : ""}
    ${formActionsHtml(user ? "Сохранить" : "Создать")}
  `;

  wireFormActions(form, async (fd) => {
    if (user) {
      const body = { name: fd.get("name"), role: fd.get("role"), isActive: fd.get("isActive") === "on" };
      const password = fd.get("password");
      if (password) body.password = password;
      await adminPatch(`/admin/users/${user.userId}`, body);
      showToast("Сотрудник обновлён");
    } else {
      await adminPost("/admin/users", {
        name: fd.get("name"),
        login: fd.get("login"),
        password: fd.get("password"),
        role: fd.get("role"),
      });
      showToast("Сотрудник создан");
    }
    loadUsers();
  });
}
