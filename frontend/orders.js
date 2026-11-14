// Order history of the signed-in account: list (cursor pagination), details, rating, reorder, receipt.
// Every piece of server text is escaped before it is placed in innerHTML.

const ORDER_STATUS = {
  CREATED: ["Создан", "warn"],
  SENT_TO_KITCHEN: ["В работе", "warn"],
  READY_FOR_DELIVERY: ["Готов к выдаче", "warn"],
  OUT_FOR_DELIVERY: ["Несут к столу", "warn"],
  DELIVERED: ["Выдан", "ok"],
  CANCELLED: ["Отменён", "bad"],
};
const badge = (status, label) => {
  const [text, kind] = ORDER_STATUS[status] ?? [status, ""];
  return `<span class="status-badge ${kind}">${escapeHtml(label ?? text)}</span>`;
};

document.addEventListener("DOMContentLoaded", async () => {
  if (!ClientAuth.requireLogin()) return;
  await ensureSessionOptional();
  document.addEventListener("client-logged-out", () => ClientAuth.requireLogin());

  const $ = (id) => document.getElementById(id);
  const state = { cursor: null, loaded: 0 };

  $("orders-more").addEventListener("click", () => loadPage());
  $("detail-close").addEventListener("click", () => ($("detail-modal").hidden = true));
  $("reorder-close").addEventListener("click", () => ($("reorder-modal").hidden = true));
  $("reorder-dismiss").addEventListener("click", () => ($("reorder-modal").hidden = true));
  for (const id of ["detail-modal", "reorder-modal"]) {
    $(id).addEventListener("click", (e) => { if (e.target.id === id) $(id).hidden = true; });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("detail-modal").hidden = true; $("reorder-modal").hidden = true; }
  });

  await loadPage();

  async function loadPage() {
    $("orders-more").disabled = true;
    try {
      const data = await ClientAuth.call.get(`/client-account/orders?limit=10${state.cursor ? `&cursor=${state.cursor}` : ""}`);
      state.cursor = data.nextCursor;
      state.loaded += data.orders.length;
      for (const order of data.orders) $("orders-list").appendChild(renderCard(order));
      $("orders-more").hidden = !data.nextCursor;
      $("orders-status").textContent = state.loaded === 0 ? "Заказов пока нет. Самое время что-нибудь заказать!" : "";
    } catch (err) {
      $("orders-status").textContent = `Не удалось загрузить историю: ${err.message}`;
    } finally {
      $("orders-more").disabled = false;
    }
  }

  function renderCard(order) {
    const el = document.createElement("article");
    el.className = "order-card";
    const items = order.itemsPreview.map((i) => `${escapeHtml(i.name)} ×${i.quantity}`).join(", ");
    const more = order.itemCount > order.itemsPreview.reduce((s, i) => s + i.quantity, 0) ? " …" : "";
    el.innerHTML = `
      <div class="order-card-head">
        <h3>Заказ №${escapeHtml(order.orderId)} - ${escapeHtml(formatMoney(order.payableTotal))}</h3>
        ${badge(order.orderStatus)}
      </div>
      <div class="muted">${escapeHtml(formatDateTime(order.createdAt))}${order.discountBonus > 0 ? ` · бонусами: ${escapeHtml(formatMoney(order.discountBonus))}` : ""}</div>
      <div>${items}${more}</div>
      <div class="order-card-actions">
        <button type="button" data-act="detail">Подробнее</button>
        <button type="button" data-act="reorder">Заказать ещё раз</button>
        <button type="button" data-act="receipt" ${order.receiptAvailable ? "" : "disabled title=\"Чек появится после оплаты\""}>Чек</button>
        <span data-slot="rating"></span>
      </div>`;
    el.querySelector('[data-act="detail"]').addEventListener("click", () => openDetail(order.orderId));
    el.querySelector('[data-act="reorder"]').addEventListener("click", (e) => reorder(order.orderId, e.currentTarget));
    el.querySelector('[data-act="receipt"]').addEventListener("click", () => ReceiptViewer.open({ orderId: order.orderId, account: true }));
    renderRating(el.querySelector('[data-slot="rating"]'), order.orderId, order.rating, order.canRate);
    return el;
  }

  function renderRating(slot, orderId, rating, canRate) {
    if (rating) {
      slot.innerHTML = `<span class="muted" aria-label="Ваша оценка: ${rating} из 5">Ваша оценка: ${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>`;
      return;
    }
    if (!canRate) { slot.innerHTML = ""; return; }
    slot.innerHTML = `<span class="stars" role="group" aria-label="Оценить заказ">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} из 5">★</button>`).join("")}</span>`;
    const buttons = [...slot.querySelectorAll("button")];
    buttons.forEach((b) => {
      b.addEventListener("mouseenter", () => buttons.forEach((x) => x.classList.toggle("on", Number(x.dataset.n) <= Number(b.dataset.n))));
      b.addEventListener("click", async () => {
        try {
          await ClientAuth.call.post(`/client-account/orders/${orderId}/rating`, { rating: Number(b.dataset.n) });
          renderRating(slot, orderId, Number(b.dataset.n), false);
          showToast("Спасибо за оценку!");
        } catch (err) {
          showToast(err.message);
        }
      });
    });
    slot.addEventListener("mouseleave", () => buttons.forEach((x) => x.classList.remove("on")));
  }

  async function openDetail(orderId) {
    $("detail-title").textContent = `Заказ №${orderId}`;
    $("detail-body").innerHTML = `<p class="muted">Загрузка…</p>`;
    $("detail-modal").hidden = false;
    try {
      const { order } = await ClientAuth.call.get(`/client-account/orders/${orderId}`);
      const rows = order.items.map((i) => `
        <tr>
          <td>${escapeHtml(i.name)}
            ${i.options.map((o) => `<small>+ ${escapeHtml(o.name)}${o.quantity > 1 ? ` ×${o.quantity}` : ""} (${escapeHtml(formatMoney(o.price))})</small>`).join("")}
            ${i.composition.map((c) => `<small>${escapeHtml(c.name)}: ${escapeHtml(c.text)}</small>`).join("")}
            ${i.snapshotAvailable ? "" : "<small>Состав на момент заказа не сохранён</small>"}
          </td>
          <td class="num">${escapeHtml(formatMoney(i.unitPrice))}</td>
          <td class="num">${i.quantity}</td>
          <td class="num">${escapeHtml(formatMoney(i.lineTotal))}</td>
        </tr>`).join("");
      const p = order.payment;
      $("detail-body").innerHTML = `
        <dl class="detail-grid">
          <dt>Номер заказа</dt><dd>${escapeHtml(order.orderId)}</dd>
          <dt>Статус</dt><dd>${badge(order.orderStatus, order.statusLabel)}</dd>
          <dt>Оформлен</dt><dd>${escapeHtml(formatDateTime(order.createdAt))}</dd>
          <dt>Выдан</dt><dd>${order.deliveredAt ? escapeHtml(formatDateTime(order.deliveredAt)) : order.cancelled ? "-" : "Ожидается"}</dd>
          ${order.cancelled ? `<dt>Отмена</dt><dd>${order.cancelled.occurredAt ? escapeHtml(formatDateTime(order.cancelled.occurredAt)) : ""}${order.cancelled.reason ? ` - ${escapeHtml(order.cancelled.reason)}` : ""}</dd>` : ""}
          ${order.tableNumber ? `<dt>Стол</dt><dd>${escapeHtml(order.tableNumber)}</dd>` : ""}
          ${order.comment ? `<dt>Комментарий</dt><dd>${escapeHtml(order.comment)}</dd>` : ""}
          <dt>Заведение</dt><dd>${escapeHtml(order.restaurant.name)}<br><span class="muted">${escapeHtml(order.restaurant.address)}</span></dd>
        </dl>
        <table class="detail-items">
          <thead><tr><th>Блюдо</th><th class="num">Цена</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <dl class="detail-grid">
          <dt>Сумма заказа</dt><dd>${escapeHtml(formatMoney(order.subtotal))}</dd>
          ${order.discountBonus > 0 ? `<dt>Оплачено бонусами</dt><dd>−${escapeHtml(formatMoney(order.discountBonus))}</dd>` : ""}
          <dt><strong>К оплате деньгами</strong></dt><dd><strong>${escapeHtml(formatMoney(order.payableTotal))}</strong></dd>
          <dt>Оплата</dt><dd>${p
            ? `${escapeHtml(p.methodLabel)} - ${p.status === "PAID" ? `оплачено${p.paidAt ? ` ${escapeHtml(formatDateTime(p.paidAt))}` : ""}` : "ожидает оплаты"}${p.isDemo ? " <span class=\"muted\">(демо-симуляция, реального списания нет)</span>" : ""}${p.refundStatus === "REFUND_REQUIRED" ? " <span class=\"status-badge bad\">требуется возврат</span>" : ""}`
            : "-"}</dd>
          <dt>Чек</dt><dd>${order.receipt.available
            ? `<button type="button" class="secondary-action" id="detail-receipt" style="min-height:36px;padding:4px 14px">${order.receipt.receiptNumber ? `№ ${escapeHtml(order.receipt.receiptNumber)}` : "Показать чек"}</button>`
            : escapeHtml(order.receipt.reason ?? "Недоступен")}</dd>
        </dl>
        <div class="inline-actions"><button type="button" class="secondary-action" id="detail-reorder">Заказать ещё раз</button></div>`;
      const r = $("detail-receipt");
      if (r) r.addEventListener("click", () => ReceiptViewer.open({ orderId: order.orderId, account: true }));
      $("detail-reorder").addEventListener("click", (e) => { $("detail-modal").hidden = true; reorder(order.orderId, e.currentTarget); });
    } catch (err) {
      $("detail-body").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function reorder(orderId, button) {
    const sessionId = getSessionId();
    if (!sessionId) {
      showToast("Чтобы повторить заказ, откройте кабинет на терминале стола.");
      return;
    }
    button.disabled = true;
    try {
      const res = await ClientAuth.call.post(`/client-account/orders/${orderId}/reorder`, { sessionId });
      const lines = [];
      if (res.addedItems.length) lines.push(`<h3>Добавлено в корзину</h3><ul>${res.addedItems.map((i) => `<li>${escapeHtml(i.dishName)} ×${i.quantity}</li>`).join("")}</ul>`);
      if (res.unavailableItems.length) lines.push(`<h3>Не удалось добавить</h3><ul>${res.unavailableItems.map((i) => `<li><strong>${escapeHtml(i.dishName)}</strong> ×${i.quantity} - ${escapeHtml(i.message)}</li>`).join("")}</ul>`);
      if (res.priceChanged.length) lines.push(`<h3>Цены изменились</h3><ul>${res.priceChanged.map((c) => `<li>${escapeHtml(c.dishName)}: было ${escapeHtml(formatMoney(c.previousUnitPrice))}, стало ${escapeHtml(formatMoney(c.currentUnitPrice))}</li>`).join("")}</ul><p class="form-hint">Новую сумму нужно подтвердить в корзине перед оплатой.</p>`);
      if (res.warnings.length) lines.push(`<h3>Обратите внимание</h3><ul>${res.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`);
      $("reorder-body").innerHTML = lines.join("") || "<p>Ничего не добавлено.</p>";
      $("reorder-to-cart").hidden = res.addedItems.length === 0;
      $("reorder-modal").hidden = false;
    } catch (err) {
      showToast(err.message);
    } finally {
      button.disabled = false;
    }
  }
});
