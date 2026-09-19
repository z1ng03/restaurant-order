// ТЗ §§9-11: kitchen sees every order still in the kitchen (order_status =
// SENT_TO_KITCHEN), can inspect each dish's ingredients, and advances each
// item WAITING -> PREPARING -> READY -> HANDED_TO_WAITER. No websocket in
// this build — a short poll interval keeps the board current instead.

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
      <strong>Заказ №${order.orderId}</strong>
      <span class="staff-order-meta">Столик №${order.table.tableNumber} · ${timeSince(order.createdAt)}</span>
    </div>
  `;
  card.appendChild(header);

  const itemsEl = document.createElement("div");
  itemsEl.className = "staff-order-items";
  for (const item of order.items) {
    itemsEl.appendChild(renderOrderItem(item, token));
  }
  card.appendChild(itemsEl);

  return card;
}

function renderOrderItem(item, token) {
  const row = document.createElement("div");
  row.className = `staff-item staff-item-${item.status.toLowerCase()}`;

  const ingredientLines = item.dish.recipes
    .map((r) => `${r.ingredient.name} — ${r.quantity}${r.ingredient.unit}`)
    .join(", ");
  const optionLines = item.options.map((o) => o.option.name).join(", ");

  row.innerHTML = `
    <div class="staff-item-main">
      <strong>${item.dish.name} × ${item.quantity}</strong>
      <span class="staff-status-badge">${STATUS_LABEL[item.status] ?? item.status}</span>
    </div>
    ${optionLines ? `<p class="staff-item-sub">Доп: ${optionLines}</p>` : ""}
    ${item.notes ? `<p class="staff-item-sub">Комментарий: ${item.notes}</p>` : ""}
    <details class="staff-ingredients">
      <summary>Ингредиенты</summary>
      <p>${ingredientLines || "—"}</p>
    </details>
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
        await api.patch(`/kitchen/order-items/${item.orderItemId}/status`, { status: nextStatus }, { token });
        const session = getStaffSession();
        await loadOrders(session.token);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
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
