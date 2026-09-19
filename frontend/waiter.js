// ТЗ §§12-14: waiter sees orders ready to carry or already out for
// delivery, picks them up, collects cash when that's the payment method,
// and marks delivery (which the backend then cascades to session/table).

let pollTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  initStaffGate({
    allowedRoles: ["WAITER", "ADMIN"],
    roleLabel: "официант",
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
  const container = document.getElementById("waiter-orders");
  const emptyEl = document.getElementById("waiter-empty");
  try {
    const { orders } = await api.get("/waiter/orders", { token });
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
  const payment = order.payments[0];
  const isPaid = order.paymentStatus === "PAID";

  const itemLines = order.items
    .map((item) => {
      const opts = item.options.map((o) => o.option.name).join(", ");
      return `${item.dish.name} × ${item.quantity}${opts ? ` (${opts})` : ""}`;
    })
    .join("; ");

  card.innerHTML = `
    <div class="staff-order-header">
      <div>
        <strong>Заказ №${order.orderId}</strong>
        <span class="staff-order-meta">Столик №${order.table.tableNumber} · ${timeSince(order.createdAt)}</span>
      </div>
      <span class="staff-status-badge ${isPaid ? "staff-badge-paid" : "staff-badge-waiting"}">
        ${isPaid ? "Оплачено" : payment?.method === "CASH" ? "Ожидает наличные" : "Ожидает оплату"}
      </span>
    </div>
    <p class="staff-item-sub">${itemLines}</p>
    <p class="staff-order-status">Статус заказа: <strong>${orderStatusLabel(order.orderStatus)}</strong></p>
    <div class="staff-order-actions"></div>
  `;

  const actions = card.querySelector(".staff-order-actions");

  if (order.orderStatus === "READY_FOR_DELIVERY") {
    actions.appendChild(makeActionButton("Нести заказ", async () => {
      await api.patch(`/waiter/orders/${order.orderId}/pickup`, {}, { token });
      await loadOrders(token);
    }));
  }

  if (order.orderStatus === "OUT_FOR_DELIVERY") {
    if (!isPaid && payment?.method === "CASH") {
      actions.appendChild(makeActionButton("Наличные получены", async () => {
        await api.patch(`/waiter/orders/${order.orderId}/cash-received`, {}, { token });
        await loadOrders(token);
      }));
    }

    const deliverBtn = makeActionButton("Заказ выдан", async () => {
      await api.patch(`/waiter/orders/${order.orderId}/delivered`, {}, { token });
      await loadOrders(token);
    });
    if (!isPaid) {
      deliverBtn.disabled = true;
      deliverBtn.title = "Сначала получите оплату";
    }
    actions.appendChild(deliverBtn);
  }

  return card;
}

function orderStatusLabel(status) {
  return { READY_FOR_DELIVERY: "Готов к выдаче", OUT_FOR_DELIVERY: "Несу заказ" }[status] ?? status;
}

function makeActionButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "order-btn staff-action-btn";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });
  return btn;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}
