// ТЗ §§9-11: kitchen sees every order still in the kitchen (order_status =
// SENT_TO_KITCHEN), can inspect each dish's ingredients, and advances each
// item WAITING -> PREPARING -> READY -> HANDED_TO_WAITER. No websocket in
// this build - a short poll interval keeps the board current instead.

const NEXT_STATUS = { WAITING: "PREPARING", PREPARING: "READY", READY: "HANDED_TO_WAITER" };
const STATUS_LABEL = {
  WAITING: "Ожидает",
  PREPARING: "Готовится",
  READY: "Готово",
  HANDED_TO_WAITER: "Передано официанту",
};
const ACTION_LABEL = { WAITING: "Начать готовить", PREPARING: "Готово", READY: "Передать официанту" };

let pollTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  initStaffGate({
    allowedRoles: ["CHEF", "ADMIN"],
    roleLabel: "шеф-повар",
    onReady: (session) => {
      loadOrders(session.token);
      clearInterval(pollTimer);
      pollTimer = setInterval(() => loadOrders(session.token), 5000);
    },
  });
});

function timeSince(isoString) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 60000));
  if (minutes < 1) return "только что";
  return `${minutes} мин назад`;
}

async function loadOrders(token) {
  const container = document.getElementById("kitchen-orders");
  const emptyEl = document.getElementById("kitchen-empty");
  try {
    const { orders } = await api.get("/kitchen/orders", { token });
    if (orders.length === 0) {
      container.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    container.innerHTML = "";
    for (const order of orders) {
      container.appendChild(renderOrderCard(order, token));
    }
  } catch (err) {
    if (err.status === 401) {
      clearStaffSession();
      location.reload();
      return;
    }
    showToast(err.message);
  }
}

function renderOrderCard(order, token) {
  const card = document.createElement("article");
  card.className = "staff-order-card";

  const header = document.createElement("div");
  header.className = "staff-order-header";
  header.innerHTML = `
    <div>
      <strong>Заказ №${escapeHtml(order.orderId)}</strong>
      <span class="staff-order-meta">Столик №${escapeHtml(order.table.tableNumber)} · ${escapeHtml(timeSince(order.createdAt))}</span>
    </div>
  `;
  card.appendChild(header);

  // ONE comment for the whole order (FR-10). Shown only when there is one; the text is escaped, line breaks kept.
  if (order.comment) {
    const comment = document.createElement("p");
    comment.className = "staff-order-comment";
    comment.innerHTML = `<strong>Комментарий гостя:</strong> ${escapeHtml(order.comment)}`;
    card.appendChild(comment);
  }

  const itemsEl = document.createElement("div");
  itemsEl.className = "staff-order-items";
  for (const item of order.items) {
    itemsEl.appendChild(renderOrderItem(item, token));
  }
  card.appendChild(itemsEl);

  return card;
}

/**
 * What the chef cooks is the composition AS ORDERED (order_item_ingredients snapshot), never the current recipe:
 *   ✕ removed            «Лук - убрать»
 *   ± changed            «Сыр: 75 г на порцию (по рецепту 50 г) × 2 = 150 г»
 *   + added by an option «Бекон (опция): 50 г × 2 = 100 г»
 * Orders placed before snapshots existed say so and fall back to the current recipe, clearly labelled as such.
 */
function renderComposition(item) {
  if (!item.snapshotAvailable) {
    const recipe = item.dish.recipes.map((r) => `${escapeHtml(r.ingredient.name)} - ${escapeHtml(r.quantity)} ${escapeHtml(r.ingredient.unit)}`).join(", ");
    return `<p class="staff-item-sub staff-legacy">Состав на момент заказа не сохранён. Справочно, текущий рецепт блюда: ${recipe || "-"}</p>`;
  }
  const lines = item.ingredientsActual;
  const changes = lines.filter((l) => l.change !== "UNCHANGED").map((l) => {
    if (l.change === "REMOVED") return `<li class="change-removed">✕ ${escapeHtml(l.name)} - убрать</li>`;
    if (l.change === "ADDED") return `<li class="change-added">+ ${escapeHtml(l.name)} (опция): ${escapeHtml(l.display.perServing)} × ${l.servings} = ${escapeHtml(l.display.total)}</li>`;
    return `<li class="change-changed">± ${escapeHtml(l.name)}: ${escapeHtml(l.display.perServing)} на порцию (по рецепту ${escapeHtml(l.display.base)}) × ${l.servings} = ${escapeHtml(l.display.total)}</li>`;
  });
  const all = lines
    .filter((l) => l.source === "RECIPE" ? l.change !== "REMOVED" : true)
    .map((l) => `${escapeHtml(l.name)}${l.source === "OPTION" ? " (опция)" : ""} - ${escapeHtml(l.display.total)}`)
    .join(", ");
  return `
    ${changes.length ? `<ul class="staff-changes">${changes.join("")}</ul>` : ""}
    <details class="staff-ingredients">
      <summary>Все ингредиенты на ${item.quantity} порц.</summary>
      <p>${all || "-"}</p>
    </details>`;
}

function renderOrderItem(item, token) {
  const row = document.createElement("div");
  row.className = `staff-item staff-item-${String(item.status).toLowerCase().replace(/[^a-z_]/g, "")}`;

  const optionLines = item.options.map((o) => escapeHtml(o.option.name) + (o.quantity > 1 ? ` ×${o.quantity}` : "")).join(", ");

  row.innerHTML = `
    <div class="staff-item-main">
      <strong>${escapeHtml(item.dish.name)} × ${item.quantity}</strong>
      <span class="staff-status-badge">${escapeHtml(STATUS_LABEL[item.status] ?? item.status)}</span>
    </div>
    ${optionLines ? `<p class="staff-item-sub">Доп: ${optionLines}</p>` : ""}
    ${item.notes ? `<p class="staff-item-sub">Пометка к блюду: ${escapeHtml(item.notes)}</p>` : ""}
    ${renderComposition(item)}
  `;

  const nextStatus = NEXT_STATUS[item.status];
  if (nextStatus) {
    const btn = document.createElement("button");
    btn.className = "order-btn staff-action-btn";
    btn.type = "button";
    btn.textContent = ACTION_LABEL[item.status];
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.patch(`/kitchen/order-items/${item.orderItemId}/status`, { status: nextStatus }, { token: getStaffSession().token });
        const session = getStaffSession();
        await loadOrders(session.token);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        loadOrders(getStaffSession().token); // e.g. the order was cancelled meanwhile
      }
    });
    row.appendChild(btn);
  }

  return row;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}
