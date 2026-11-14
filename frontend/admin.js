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
    audit: loadAudit,
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


/** 0.04 kg -> "40 г" (the API stores base units; people read friendly ones). admin's formatQty() above takes ONE argument. */
function qtyWithUnit(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const num = (x) => String(Math.round(x * 1000) / 1000).replace(".", ",");
  switch (unit) {
    case "kg": return Math.abs(n) < 1 ? `${num(n * 1000)} г` : `${num(n)} кг`;
    case "l": return Math.abs(n) < 1 ? `${num(n * 1000)} мл` : `${num(n)} л`;
    case "g": return `${num(n)} г`;
    case "ml": return `${num(n)} мл`;
    case "pcs": return `${num(n)} шт.`;
    default: return `${num(n)} ${unit ?? ""}`.trim();
  }
}

const ADJUSTMENT_REASONS = { INITIAL: "Начальный остаток", RECEIPT: "Приёмка", CORRECTION: "Корректировка", WRITE_OFF: "Списание" };
const EVENT_LABELS = {
  ORDER_CREATED: "Заказ создан", PAYMENT_CONFIRMED: "Оплата подтверждена", COOKING_STARTED: "Начали готовить",
  READY_FOR_DELIVERY: "Готов к выдаче", OUT_FOR_DELIVERY: "Официант несёт", DELIVERED: "Выдан", CANCELLED: "Отменён",
};
const LEDGER_LABELS = { EARN: "Начисление", SPEND: "Списание", REVERSE_EARN: "Отмена начисления", REFUND_SPEND: "Возврат списания" };
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "-");

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
          <td class="admin-muted-cell">${t.activeSession ? `сессия #${t.activeSession.sessionId}` : "-"}</td>
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

    const byId = new Map(orders.map((o) => [String(o.orderId), o]));
    tbody.querySelectorAll('[data-action="cancel"]').forEach((btn) =>
      btn.addEventListener("click", () => cancelOrder(byId.get(btn.dataset.id), status)),
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
  const refund = o.payments?.[0]?.refundStatus === "REFUND_REQUIRED";
  return `
    <tr>
      <td>№${escapeHtml(o.orderId)}</td>
      <td>№${escapeHtml(o.table.tableNumber)}</td>
      <td class="admin-muted-cell" title="${escapeAttr(dishNames)}">${escapeHtml(dishNames.length > 40 ? dishNames.slice(0, 40) + "…" : dishNames)}${o.comment ? ' <span title="Есть комментарий гостя">💬</span>' : ""}</td>
      <td><span class="admin-pill ${o.orderStatus === "CANCELLED" ? "admin-pill-off" : "admin-pill-on"}">${escapeHtml(o.orderStatus)}</span></td>
      <td class="admin-muted-cell">${escapeHtml(o.paymentStatus)}${refund ? ' <span class="admin-pill admin-pill-off">нужен возврат</span>' : ""}</td>
      <td>${formatPrice(o.payableTotal ?? o.totalPrice)}${Number(o.discountBonus) > 0 ? `<br><small class="admin-muted-cell">бонусами −${escapeHtml(o.discountBonus)} ₸</small>` : ""}</td>
      <td class="admin-muted-cell">${escapeHtml(fmtDate(o.createdAt))}</td>
      <td class="admin-row-actions">
        <button class="admin-link-btn" data-action="view" data-id="${escapeAttr(o.orderId)}">Детали</button>
        ${cancellable ? `<button class="admin-link-btn admin-danger" data-action="cancel" data-id="${escapeAttr(o.orderId)}">Отменить</button>` : ""}
      </td>
    </tr>`;
}

/**
 * Cancellation needs a decision when the order was ALREADY PAID: bonuses can be returned automatically, but the
 * money itself must go back through the real payment channel - this system never pretends to refund a payment.
 */
function cancelOrder(order, currentFilter) {
  if (!order) return;
  const paid = order.paymentStatus === "PAID";
  const form = openFormModal(`Отмена заказа №${order.orderId}`);
  form.innerHTML = `
    <p class="admin-muted-cell">Зарезервированные, но ещё не списанные ингредиенты вернутся на склад (уже приготовленное остаётся списанным).
    ${paid ? "Заказ оплачен - выберите, что делать с оплатой." : "Заказ не оплачен: бонусы, заблокированные под него, вернутся гостю автоматически."}</p>
    ${fText("reason", "Причина отмены (увидит гость в статусе заказа)", "")}
    ${paid ? fSelect("refundDecision", "Оплата", [
      { value: "NO_REFUND", label: "Деньги остаются (без возврата)" },
      { value: "REFUND", label: "Возврат: вернуть потраченные бонусы, снять начисленные, пометить «нужен возврат средств»" },
    ], "NO_REFUND") : ""}
    ${formActionsHtml("Отменить заказ")}`;
  wireFormActions(form, async (fd) => {
    const body = { reason: fd.get("reason") || undefined, ...(paid ? { refundDecision: fd.get("refundDecision") } : {}) };
    const { cancellation } = await adminPost(`/admin/orders/${order.orderId}/cancel`, body);
    const extra = cancellation?.paymentRefundRequired ? " Деньги нужно вернуть через платёжный канал вручную." : "";
    showToast(`Заказ №${order.orderId} отменён.${extra}`);
    loadOrders(currentFilter);
  });
}

async function viewOrder(orderId) {
  try {
    const { order: o } = await adminGet(`/admin/orders/${orderId}`);
    const form = openFormModal(`Заказ №${o.orderId} - Столик №${o.table.tableNumber}`);
    const itemsHtml = o.items
      .map((i) => {
        const opts = i.options.map((x) => `${x.option.name}${x.quantity > 1 ? ` ×${x.quantity}` : ""}`).join(", ");
        const lines = (i.ingredients ?? []).filter((x) => x.source === "OPTION" || !x.selectedPerServing || Number(x.selectedPerServing) !== Number(x.basePerServing));
        const composition = i.ingredients?.length
          ? lines.map((x) => {
              if (x.source === "OPTION") return `<li>+ ${escapeHtml(x.ingredientNameSnapshot)} (опция): ${escapeHtml(qtyWithUnit(x.requiredTotal, x.unitSnapshot))}</li>`;
              if (Number(x.selectedPerServing) === 0) return `<li>✕ ${escapeHtml(x.ingredientNameSnapshot)} - убрать</li>`;
              return `<li>± ${escapeHtml(x.ingredientNameSnapshot)}: ${escapeHtml(qtyWithUnit(x.selectedPerServing, x.unitSnapshot))} на порцию (по рецепту ${escapeHtml(qtyWithUnit(x.basePerServing, x.unitSnapshot))})</li>`;
            }).join("")
          : "";
        return `<div style="margin-bottom:8px"><div class="admin-low-stock-row"><span>${escapeHtml(i.dish.name)} ×${i.quantity}${opts ? ` (${escapeHtml(opts)})` : ""} - <span class="admin-muted-cell">${escapeHtml(i.status)}</span></span><strong>${formatPrice(i.price)}</strong></div>
          ${composition ? `<ul class="admin-muted-cell" style="margin:4px 0 0 18px">${composition}</ul>` : i.ingredients?.length ? "" : '<div class="admin-muted-cell" style="margin-left:18px">Состав на момент заказа не сохранён (заказ создан до версии 2)</div>'}</div>`;
      })
      .join("");
    const payment = o.payments[0];
    const events = (o.statusEvents ?? []).map((e) => `<li>${escapeHtml(fmtDate(e.occurredAt))} - ${escapeHtml(EVENT_LABELS[e.eventType] ?? e.eventType)} <span class="admin-muted-cell">(${escapeHtml(e.actorType)})</span></li>`).join("");
    const ledger = (o.loyaltyEntries ?? []).map((l) => `<li>${escapeHtml(LEDGER_LABELS[l.type] ?? l.type)}: ${l.amount > 0 ? "+" : ""}${escapeHtml(l.amount)} ₸ <span class="admin-muted-cell">${escapeHtml(l.note ?? "")}</span></li>`).join("");
    const reservations = (o.inventoryReservations ?? []).map((r) => `<li>${escapeHtml(r.ingredient.name)}: ${escapeHtml(qtyWithUnit(r.quantity, r.ingredient.unit))} - ${escapeHtml(r.status)}</li>`).join("");
    form.innerHTML = `
      <div class="admin-order-detail">
        <p><strong>Статус заказа:</strong> ${escapeHtml(o.orderStatus)} &nbsp; <strong>Оплата:</strong> ${escapeHtml(o.paymentStatus)}${payment ? ` (${escapeHtml(payment.method)}${payment.isDemo ? ", демо" : ""})` : ""}${payment?.refundStatus === "REFUND_REQUIRED" ? ' <span class="admin-pill admin-pill-off">нужен возврат средств</span>' : ""}</p>
        <p><strong>Официант:</strong> ${o.waiter ? escapeHtml(o.waiter.name) : "-"} &nbsp; <strong>Клиент:</strong> ${o.clientUser ? escapeHtml(o.clientUser.name) : "гость без аккаунта"}</p>
        <p><strong>Создан:</strong> ${escapeHtml(fmtDate(o.createdAt))}${o.deliveredAt ? ` &nbsp; <strong>Выдан:</strong> ${escapeHtml(fmtDate(o.deliveredAt))}` : ""}${o.cancelledAt ? ` &nbsp; <strong>Отменён:</strong> ${escapeHtml(fmtDate(o.cancelledAt))}${o.cancelReason ? ` - ${escapeHtml(o.cancelReason)}` : ""}` : ""}</p>
        ${o.comment ? `<p><strong>Комментарий гостя:</strong> <span style="white-space:pre-wrap">${escapeHtml(o.comment)}</span></p>` : ""}
        ${o.receipt ? `<p><strong>Чек:</strong> ${escapeHtml(o.receipt.receiptNumber)} (${escapeHtml(o.receipt.kind)}, фискализация: ${escapeHtml(o.receipt.fiscalStatus)})</p>` : ""}
      </div>
      <div>${itemsHtml}</div>
      <div class="admin-low-stock-row"><span>Сумма заказа</span><strong>${formatPrice(o.subtotal)}</strong></div>
      ${Number(o.discountBonus) > 0 ? `<div class="admin-low-stock-row"><span>Бонусами</span><strong>−${formatPrice(o.discountBonus)}</strong></div>` : ""}
      <div class="admin-low-stock-row"><strong>К оплате деньгами</strong><strong>${formatPrice(o.payableTotal)}</strong></div>
      ${events ? `<h4 style="margin:14px 0 4px">События</h4><ul class="admin-muted-cell" style="margin:0 0 0 18px">${events}</ul>` : ""}
      ${ledger ? `<h4 style="margin:14px 0 4px">Бонусы по заказу</h4><ul class="admin-muted-cell" style="margin:0 0 0 18px">${ledger}</ul>` : ""}
      ${reservations ? `<details style="margin-top:12px"><summary>Резервы ингредиентов</summary><ul class="admin-muted-cell" style="margin:6px 0 0 18px">${reservations}</ul></details>` : ""}
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
        <td>${d.is21Plus ? "21+" : "-"}</td>
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
  const recipeRows = dish?.recipes?.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity, adjustmentStep: r.adjustmentStep, isCustomizable: r.isCustomizable })) ?? [];
  const allergenItems = REF.allergens.map((a) => ({ id: a.allergenId, label: a.name }));
  const optionItems = REF.options.map((o) => ({ id: o.optionId, label: `${o.name} (+${formatPrice(o.price)})` }));

  form.innerHTML = `
    ${fText("name", "Название", dish?.name ?? "", { required: true })}
    <div class="admin-form-row">
      ${fSelect("categoryId", "Категория", categoryOptions, dish?.category?.categoryId)}
      ${fNumber("price", "Цена, ₸", dish?.price ?? "", { required: true, min: 0 })}
    </div>
    ${fTextarea("description", "Описание (обязательно для активного блюда: 1–3 предложения - состав, вкус, способ приготовления)", dish?.description ?? "")}
    ${fText("imageUrl", "URL изображения", dish?.imageUrl ?? "")}
    <div class="admin-form-row">
      ${fCheckbox("is21Plus", "Блюдо 21+", dish?.is21Plus)}
      ${dish ? fCheckbox("isActive", "Активно (в меню)", dish.isActive) : ""}
    </div>
    ${fCheckbox("inventoryTracked", "Вести учёт остатков (если снять - блюдо доступно без проверки склада; пустой рецепт при включённом учёте = блюдо недоступно)", dish ? dish.inventoryTracked : true)}
    <div>
      <span class="admin-form-checkbox" style="margin-bottom:4px;display:block;">Состав на 1 порцию (рецепт)</span>
      <span class="admin-muted-cell" style="display:block;margin-bottom:8px;">Количество - в базовой единице ингредиента. «Шаг» - на сколько гость меняет количество кнопками − / + (пусто = половина базы; для целых штук - 1). Гость может выбрать от 0 до 3× базы.</span>
      <div class="admin-repeatable" id="dish-recipe-rows"></div>
      <button type="button" class="admin-add-row-btn" id="dish-recipe-add">+ ингредиент</button>
    </div>
    ${fCheckboxGrid("allergenIds", "Аллергены", allergenItems, dish?.allergens?.map((a) => a.allergen.allergenId))}
    ${fCheckboxGrid("availableOptionIds", "Доступные опции", optionItems, dish?.availableOptions?.map((o) => o.option.optionId))}
    ${formActionsHtml(dish ? "Сохранить" : "Создать")}
  `;

  const rowsContainer = form.querySelector("#dish-recipe-rows");
  const ingredientOptions = REF.ingredients.map((i) => ({ value: i.ingredientId, label: `${i.name} (${i.unit})` }));

  function addRecipeRow(ingredientId, quantity, adjustmentStep, isCustomizable) {
    const row = document.createElement("div");
    row.className = "admin-repeatable-row";
    row.style.flexWrap = "wrap";
    row.innerHTML = `
      <select name="recipe-ingredient">${ingredientOptions.map((o) => `<option value="${escapeAttr(o.value)}" ${String(o.value) === String(ingredientId) ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>
      <input type="number" name="recipe-quantity" value="${escapeAttr(quantity ?? "")}" step="0.001" min="0" placeholder="кол-во" title="Количество на порцию">
      <input type="number" name="recipe-step" value="${escapeAttr(adjustmentStep ?? "")}" step="0.001" min="0" placeholder="шаг (авто)" title="Шаг изменения количества гостем">
      <label class="admin-form-checkbox" style="white-space:nowrap"><input type="checkbox" name="recipe-customizable" ${isCustomizable === false ? "" : "checked"}> гость может менять</label>
      <button type="button" class="admin-repeatable-remove" title="Удалить">×</button>
    `;
    row.querySelector(".admin-repeatable-remove").addEventListener("click", () => row.remove());
    rowsContainer.appendChild(row);
  }
  (recipeRows.length ? recipeRows : [{}]).forEach((r) => addRecipeRow(r.ingredientId, r.quantity, r.adjustmentStep, r.isCustomizable));
  form.querySelector("#dish-recipe-add").addEventListener("click", () => addRecipeRow());

  wireFormActions(form, async (fd) => {
    const recipe = [...rowsContainer.querySelectorAll(".admin-repeatable-row")]
      .map((row) => {
        const step = row.querySelector('[name="recipe-step"]').value.trim();
        return {
          ingredientId: row.querySelector('[name="recipe-ingredient"]').value,
          quantity: row.querySelector('[name="recipe-quantity"]').value.trim().replace(",", "."),
          ...(step ? { adjustmentStep: step.replace(",", ".") } : {}),
          isCustomizable: row.querySelector('[name="recipe-customizable"]').checked,
        };
      })
      .filter((r) => r.ingredientId && Number(r.quantity) > 0);

    const ids = recipe.map((r) => r.ingredientId);
    if (new Set(ids).size !== ids.length) throw new Error("Один и тот же ингредиент указан в рецепте дважды");
    const wantsActive = dish ? fd.get("isActive") === "on" : true;
    if (wantsActive && !String(fd.get("description") ?? "").trim()) throw new Error("У активного блюда должно быть описание");

    const body = {
      name: fd.get("name"),
      categoryId: fd.get("categoryId"),
      price: Number(fd.get("price")),
      description: fd.get("description") || undefined,
      imageUrl: fd.get("imageUrl") || undefined,
      is21Plus: fd.get("is21Plus") === "on",
      inventoryTracked: fd.get("inventoryTracked") === "on",
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
        <td><input class="admin-stock-input" type="number" step="0.001" min="${escapeAttr(i.reservedQuantity)}" value="${escapeAttr(i.stockQuantity)}" data-id="${escapeAttr(i.ingredientId)}" title="Нельзя опустить ниже резерва: ${escapeAttr(i.reservedQuantity)}"></td>
        <td class="admin-muted-cell">${formatQty(i.reservedQuantity)}</td>
        <td>${formatQty(free)}</td>
        <td><span class="admin-pill ${i.isActive ? "admin-pill-on" : "admin-pill-off"}">${i.isActive ? "да" : "нет"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-link-btn" data-action="save-stock" data-id="${escapeAttr(i.ingredientId)}" title="Задать посчитанный остаток">Сохранить</button>
          <button class="admin-link-btn" data-action="receive" data-id="${escapeAttr(i.ingredientId)}">Приёмка</button>
          <button class="admin-link-btn" data-action="write-off" data-id="${escapeAttr(i.ingredientId)}">Списать</button>
          <button class="admin-link-btn" data-action="journal" data-id="${escapeAttr(i.ingredientId)}">Журнал</button>
          <button class="admin-link-btn" data-action="edit-ingredient" data-id="${escapeAttr(i.ingredientId)}">Изменить</button>
        </td>
      </tr>`;
          })
          .join("")
      : `<tr class="admin-empty-row"><td colspan="7">Ингредиентов пока нет.</td></tr>`;

    const find = (id) => ingredients.find((i) => String(i.ingredientId) === id);
    tbody.querySelectorAll('[data-action="save-stock"]').forEach((btn) =>
      btn.addEventListener("click", () => saveStock(btn.dataset.id, tbody)),
    );
    tbody.querySelectorAll('[data-action="receive"]').forEach((btn) => btn.addEventListener("click", () => openStockMovementForm("receive", find(btn.dataset.id))));
    tbody.querySelectorAll('[data-action="write-off"]').forEach((btn) => btn.addEventListener("click", () => openStockMovementForm("write-off", find(btn.dataset.id))));
    tbody.querySelectorAll('[data-action="journal"]').forEach((btn) => btn.addEventListener("click", () => showStockJournal(find(btn.dataset.id))));
    tbody.querySelectorAll('[data-action="edit-ingredient"]').forEach((btn) =>
      btn.addEventListener("click", () => openIngredientForm(find(btn.dataset.id))),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

/** A counted stock level. The server refuses anything below what is already reserved (STOCK_BELOW_RESERVED). */
function saveStock(ingredientId, tbody) {
  const input = tbody.querySelector(`.admin-stock-input[data-id="${ingredientId}"]`);
  const value = input.value.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    showToast("Остаток - число не меньше нуля, до 3 знаков после запятой");
    return;
  }
  const form = openFormModal("Корректировка остатка");
  form.innerHTML = `
    <p>Новый остаток: <strong>${escapeHtml(value)}</strong>. Изменение попадёт в журнал склада.</p>
    ${fText("comment", "Причина / комментарий (например: пересчёт, ревизия)", "")}
    ${formActionsHtml("Применить")}`;
  wireFormActions(form, async (fd) => {
    await adminPatch(`/admin/ingredients/${ingredientId}/stock`, { stockQuantity: value, reason: "CORRECTION", comment: fd.get("comment") || undefined });
    showToast("Остаток обновлён");
    loadIngredients();
  });
}

function openStockMovementForm(kind, ingredient) {
  if (!ingredient) return;
  const receive = kind === "receive";
  const form = openFormModal(`${receive ? "Приёмка" : "Списание"}: ${ingredient.name}`);
  form.innerHTML = `
    <p class="admin-muted-cell">Сейчас на складе ${escapeHtml(qtyWithUnit(ingredient.stockQuantity, ingredient.unit))}, зарезервировано ${escapeHtml(qtyWithUnit(ingredient.reservedQuantity, ingredient.unit))}.${receive ? "" : " Списать можно не больше свободного остатка."}</p>
    ${fNumber("quantity", `Количество, ${escapeHtml(ingredient.unit)}`, "", { required: true, min: 0, step: "0.001" })}
    ${fText("comment", receive ? "Комментарий (поставщик, накладная)" : "Причина (порча, бой)", "")}
    ${formActionsHtml(receive ? "Принять" : "Списать")}`;
  wireFormActions(form, async (fd) => {
    const quantity = String(fd.get("quantity")).replace(",", ".");
    if (!/^\d+(\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0) throw new Error("Введите положительное число (до 3 знаков после запятой)");
    await adminPost(`/admin/ingredients/${ingredient.ingredientId}/stock/${receive ? "receive" : "write-off"}`, { quantity, comment: fd.get("comment") || undefined });
    showToast(receive ? "Поставка принята" : "Списание выполнено");
    loadIngredients();
  });
}

async function showStockJournal(ingredient) {
  if (!ingredient) return;
  try {
    const { adjustments } = await adminGet(`/admin/inventory-adjustments?ingredientId=${ingredient.ingredientId}&limit=50`);
    const form = openFormModal(`Журнал склада: ${ingredient.name}`);
    const rows = adjustments.map((a) => `
      <tr><td>${escapeHtml(fmtDate(a.createdAt))}</td><td>${escapeHtml(ADJUSTMENT_REASONS[a.reason] ?? a.reason)}</td>
      <td>${Number(a.delta) > 0 ? "+" : ""}${escapeHtml(qtyWithUnit(a.delta, a.unit))}</td>
      <td>${escapeHtml(qtyWithUnit(a.stockBefore, a.unit))} → ${escapeHtml(qtyWithUnit(a.stockAfter, a.unit))}</td>
      <td class="admin-muted-cell">${escapeHtml(a.actorName ?? "система")}${a.comment ? ` - ${escapeHtml(a.comment)}` : ""}</td></tr>`).join("");
    form.innerHTML = `
      <p class="admin-muted-cell">Расход на готовку и резервы заказов здесь не показываются - это ручные операции склада.</p>
      <div style="overflow:auto"><table class="admin-table"><thead><tr><th>Когда</th><th>Операция</th><th>Изменение</th><th>Было → стало</th><th>Кто / комментарий</th></tr></thead>
      <tbody>${rows || '<tr class="admin-empty-row"><td colspan="5">Операций пока нет.</td></tr>'}</tbody></table></div>
      <div class="admin-form-actions"><button type="button" class="secondary-btn" data-cancel>Закрыть</button></div>`;
    form.querySelector("[data-cancel]").addEventListener("click", closeFormModal);
    form.addEventListener("submit", (e) => e.preventDefault());
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
  loadIngredientAllergens();
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
        <td class="admin-muted-cell">${escapeHtml(composition || "-")}</td>
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
    ${fCheckbox("inventoryTracked", "Вести учёт остатков (снимите для опции без ингредиентов, например «салфетки»)", option ? option.inventoryTracked : true)}
    <div>
      <span class="admin-form-checkbox" style="margin-bottom:8px;display:block;">Расход ингредиентов на 1 порцию блюда</span>
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
      inventoryTracked: fd.get("inventoryTracked") === "on",
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
        <td class="admin-muted-cell">${escapeHtml(a.description || "-")}</td>
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
    fTextarea("description", "Представители категории (показывается как справка)", allergen?.description ?? "") +
    fNumber("sortOrder", "Порядок в списке", allergen?.sortOrder ?? 0, { step: "1" }) +
    formActionsHtml(allergen ? "Сохранить" : "Создать");

  wireFormActions(form, async (fd) => {
    const body = { name: fd.get("name"), description: fd.get("description") || undefined, sortOrder: Number(fd.get("sortOrder") || 0) };
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

/* ======================== Ingredient allergen tags ============================ */
/* FR-03: allergens belong to INGREDIENTS (20 categories); a dish's list is derived from what is really in it. */

const KIND_LABEL = { CONTAINS: "содержит", MAY_CONTAIN: "возможны следы" };

async function loadIngredientAllergens() {
  const tbody = document.querySelector("#ingredient-allergens-table tbody");
  if (!tbody) return;
  try {
    const { ingredients } = await adminGet("/admin/ingredient-allergens");
    tbody.innerHTML = ingredients.length
      ? ingredients.map((i) => `
        <tr>
          <td>${escapeHtml(i.name)} <span class="admin-muted-cell">(${escapeHtml(i.unit)})</span></td>
          <td class="admin-muted-cell">${i.allergens.length ? i.allergens.map((a) => `${escapeHtml(a.name)} - ${escapeHtml(KIND_LABEL[a.kind] ?? a.kind)}`).join("; ") : "-"}</td>
          <td class="admin-row-actions"><button class="admin-link-btn" data-id="${escapeAttr(i.ingredientId)}">Изменить</button></td>
        </tr>`).join("")
      : `<tr class="admin-empty-row"><td colspan="3">Ингредиентов пока нет.</td></tr>`;
    tbody.querySelectorAll("button[data-id]").forEach((btn) =>
      btn.addEventListener("click", () => openIngredientAllergensForm(ingredients.find((i) => String(i.ingredientId) === btn.dataset.id))),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

function openIngredientAllergensForm(ingredient) {
  if (!ingredient) return;
  const form = openFormModal(`Аллергены: ${ingredient.name}`);
  const current = new Map(ingredient.allergens.map((a) => [String(a.allergenId), a.kind]));
  form.innerHTML = `
    <p class="admin-muted-cell">Отметьте категории, к которым относится ингредиент. «Возможны следы» - перекрёстный контакт, он показывается гостю отдельно от «содержит».</p>
    <div class="admin-checkbox-grid" style="grid-template-columns:1fr">
      ${REF.allergens.map((a) => `
        <label style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" name="tag" value="${escapeAttr(a.allergenId)}" ${current.has(String(a.allergenId)) ? "checked" : ""}>
          <span style="flex:1">${escapeHtml(a.name)}</span>
          <select name="kind-${escapeAttr(a.allergenId)}"><option value="CONTAINS" ${current.get(String(a.allergenId)) !== "MAY_CONTAIN" ? "selected" : ""}>содержит</option><option value="MAY_CONTAIN" ${current.get(String(a.allergenId)) === "MAY_CONTAIN" ? "selected" : ""}>возможны следы</option></select>
        </label>`).join("")}
    </div>
    ${formActionsHtml("Сохранить")}`;
  wireFormActions(form, async (fd) => {
    const allergens = getCheckedValues(form, "tag").map((id) => ({ allergenId: id, kind: fd.get(`kind-${id}`) }));
    await adminPatch(`/admin/ingredient-allergens/${ingredient.ingredientId}`, { allergens });
    showToast("Аллергены ингредиента сохранены");
    loadIngredientAllergens();
  });
}

/* =========================== Receipts, loyalty, audits ============================= */

async function loadAudit() {
  const receiptsEl = document.getElementById("audit-receipts");
  const loyaltyEl = document.getElementById("audit-loyalty");
  const inventoryEl = document.getElementById("audit-inventory");
  try {
    const [{ receipts }, loyalty, inventory] = await Promise.all([
      adminGet("/admin/receipts?limit=30"),
      adminGet("/admin/loyalty-audit"),
      adminGet("/admin/inventory-audit"),
    ]);

    receiptsEl.innerHTML = receipts.length
      ? `<table class="admin-table"><thead><tr><th>№ чека</th><th>Заказ</th><th>Вид</th><th>Фискализация</th><th>Сумма</th><th>Бонусы</th><th>Отправки</th></tr></thead><tbody>${receipts.map((r) => `
          <tr><td>${escapeHtml(r.receiptNumber)}${r.legacySnapshot ? ' <span class="admin-muted-cell">(восстановлен)</span>' : ""}</td><td>№${escapeHtml(r.orderId)}</td><td>${escapeHtml(r.kind)}</td>
          <td class="admin-muted-cell">${escapeHtml(r.fiscalStatus)}</td><td>${formatPrice(r.paidTotal)}</td><td>${escapeHtml(r.bonusDiscount)} ₸</td>
          <td class="admin-muted-cell">${r.dispatches.length ? r.dispatches.map((d) => `${escapeHtml(d.channel)} ${escapeHtml(d.destinationMasked)}: ${escapeHtml(d.status)}${d.status === "FAILED" && d.lastError ? ` (${escapeHtml(d.lastError)})` : ""}`).join("<br>") : "-"}</td></tr>`).join("")}</tbody></table>`
      : '<p class="admin-muted-cell">Чеков пока нет.</p>';

    const loyaltyProblems = [
      ...loyalty.cacheMismatch.map((x) => `Клиент №${x.clientUserId}: кэш баланса ${x.cache}, по журналу ${x.ledger}`),
      ...loyalty.spendNotRefundedOnCancelledOrders.map((x) => `Заказ №${x.orderId} отменён без оплаты, но ${x.spent} бонусов не возвращены`),
      ...loyalty.earnWithoutPaidPayment.map((x) => `Заказ №${x.orderId}: бонусы начислены, а оплаты нет`),
      ...loyalty.partialEarnReversals.map((x) => `Заказ №${x.orderId}: возврат оплаты, начислено ${x.earned}, снято ${x.reversed} (остальное гость уже потратил)`),
    ];
    loyaltyEl.innerHTML = loyalty.ok && loyaltyProblems.length === 0
      ? '<p class="admin-pill admin-pill-on" style="display:inline-block">Расхождений нет</p>'
      : `<ul>${loyaltyProblems.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;

    inventoryEl.innerHTML = inventory.ok
      ? '<p class="admin-pill admin-pill-on" style="display:inline-block">Остатки сходятся с резервами</p>'
      : `<ul>${inventory.mismatches.map((m) => `<li>${escapeHtml(m.name)}: на складе ${escapeHtml(m.stock)}, резерв ${escapeHtml(m.reserved)}, по строкам резерва ${escapeHtml(m.reservedFromReservations)} - ${escapeHtml(m.problems.join("; "))}</li>`).join("")}${inventory.staleReservations.map((r) => `<li>Резерв №${escapeHtml(r.reservationId)} заказа №${escapeHtml(r.orderId)} (${escapeHtml(r.orderStatus)}) всё ещё активен</li>`).join("")}</ul><p class="admin-muted-cell">Исправление выполняется командой <code>npm run audit:inventory -- --repair</code> (сначала план, затем <code>--apply</code>).</p>`;
  } catch (err) {
    await handleApiError(err);
  }
}
document.getElementById("audit-refresh-btn")?.addEventListener("click", loadAudit);

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
