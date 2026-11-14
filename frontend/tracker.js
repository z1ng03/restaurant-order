// FR-09 - the "Мой заказ" widget (left of the cart button) and its status window.
// It polls the tracker endpoint every 5 s while the tab is visible. It shows ONLY facts the server recorded
// (stage + time + dish count); it carries no account, payment or receipt content.

const OrderTracker = (() => {
  const POLL_MS = 5000;
  const state = { orders: [], selectedId: null, timer: null, polling: false, modalOpen: false };
  let lastFocus = null;

  const widget = () => document.getElementById("order-tracker");
  const dishesWord = (n) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return "блюдо";
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "блюда";
    return "блюд";
  };

  /** The order to show on the widget: the newest one that is still in progress, otherwise the newest of all. */
  function current() {
    const open = state.orders.find((o) => o.orderStatus !== "DELIVERED" && o.orderStatus !== "CANCELLED");
    return open ?? state.orders[0] ?? null;
  }

  function renderWidget() {
    const el = widget();
    if (!el) return;
    const order = current();
    if (!order) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("is-done", order.orderStatus === "DELIVERED");
    el.classList.toggle("is-cancelled", order.orderStatus === "CANCELLED");
    el.classList.toggle("is-active", order.orderStatus !== "DELIVERED" && order.orderStatus !== "CANCELLED");
    el.querySelector(".tracker-title").textContent = "Мой заказ";
    el.querySelector(".tracker-sub").textContent = `${order.statusLabel} · ${order.itemCount} ${dishesWord(order.itemCount)}`;
    el.setAttribute("aria-label", `Мой заказ: ${order.statusLabel}, ${order.itemCount} ${dishesWord(order.itemCount)}. Открыть статус заказа`);
  }

  function stepMark(step) {
    return step.state === "completed" ? "✓" : step.state === "active" ? "●" : "";
  }

  function renderModal() {
    const modal = document.getElementById("tracker-modal");
    if (!modal || modal.hidden) return;
    const order = state.orders.find((o) => String(o.orderId) === String(state.selectedId)) ?? current();
    if (!order) return;
    state.selectedId = order.orderId;

    const tabs = document.getElementById("tracker-orders");
    tabs.innerHTML = state.orders.length > 1
      ? state.orders.map((o) => `<button type="button" class="tracker-order-tab ${String(o.orderId) === String(order.orderId) ? "active" : ""}" data-id="${escapeHtml(o.orderId)}">№${escapeHtml(o.orderId)}</button>`).join("")
      : "";
    tabs.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { state.selectedId = b.dataset.id; renderModal(); }));

    document.getElementById("tracker-title").textContent = `Заказ №${order.orderId}`;
    document.getElementById("tracker-subtitle").textContent = `${order.itemCount} ${dishesWord(order.itemCount)} · ${order.statusLabel}`;
    document.getElementById("tracker-steps").innerHTML = order.steps.map((s) => `
      <li class="tracker-step step-${escapeHtml(s.state)}" ${s.state === "active" ? 'aria-current="step"' : ""}>
        <span class="step-mark" aria-hidden="true">${stepMark(s)}</span>
        <span class="step-label">${escapeHtml(s.label)}${s.detail ? `<small>${escapeHtml(s.detail)}</small>` : ""}</span>
        <span class="step-time">${s.occurredAt ? escapeHtml(formatTime(s.occurredAt)) : ""}</span>
      </li>`).join("");

    const cancelled = document.getElementById("tracker-cancelled");
    if (order.cancelled) {
      cancelled.hidden = false;
      cancelled.innerHTML = `<strong>Заказ отменён</strong>${order.cancelled.occurredAt ? ` в ${escapeHtml(formatTime(order.cancelled.occurredAt))}` : ""}${order.cancelled.reason ? `<br>${escapeHtml(order.cancelled.reason)}` : ""}`;
    } else {
      cancelled.hidden = true;
    }
    const receiptBtn = document.getElementById("tracker-receipt-btn");
    receiptBtn.hidden = !(order.receiptAvailable || order.paymentStatus === "WAITING_FOR_CASH");
    receiptBtn.onclick = () => ReceiptViewer.open({ orderId: order.orderId });
  }

  function openModal() {
    const modal = document.getElementById("tracker-modal");
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    state.modalOpen = true;
    renderModal();
    document.getElementById("tracker-close-btn").focus();
  }
  function closeModal() {
    const modal = document.getElementById("tracker-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    state.modalOpen = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function poll() {
    if (state.polling || document.hidden) return;
    const sessionId = getSessionId();
    if (!sessionId) return;
    state.polling = true;
    try {
      const { orders } = await api.get(`/order-tracking/session/${sessionId}`);
      state.orders = orders;
      renderWidget();
      renderModal();
    } catch (err) {
      // a dead session / secret is handled by session.js (fresh session + reload); other errors: keep the last picture
      if (err.code === "SESSION_ENDED" || err.code === "INVALID_SESSION_ACCESS") { state.orders = []; renderWidget(); }
    } finally {
      state.polling = false;
    }
  }

  function init() {
    const el = widget();
    if (!el) return;
    el.addEventListener("click", openModal);
    document.getElementById("tracker-close-btn").addEventListener("click", closeModal);
    document.getElementById("tracker-modal").addEventListener("click", (e) => { if (e.target.id === "tracker-modal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.modalOpen) closeModal(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    poll();
    state.timer = setInterval(poll, POLL_MS);
  }

  return { init, refresh: poll };
})();
