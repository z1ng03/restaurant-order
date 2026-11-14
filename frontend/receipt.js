// Receipt viewer shared by cart.html (guest, right after payment), the tracker and the order history.
// Everything that comes from the server goes through escapeHtml() (api.js) before it reaches innerHTML.
//
// The receipt is a snapshot taken when the payment was confirmed. Without a configured fiscal provider it is a DEMO,
// non-fiscal document and says so on its face; the "QR" below is an ILLUSTRATION generated from the receipt number,
// not a verification code, and is captioned as such.

const ReceiptViewer = (() => {
  let root = null;
  let lastFocus = null;

  /** Deterministic 25×25 pseudo-QR picture from the receipt number (finder squares + hash-derived modules). */
  function illustrationSvg(seedText) {
    const n = 25;
    let h = 2166136261;
    for (const ch of String(seedText)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296);
    const cells = [];
    const finder = (ox, oy) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (edge || core) cells.push(`<rect x="${ox + x}" y="${oy + y}" width="1" height="1"/>`);
      }
    };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    const inFinder = (x, y) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!inFinder(x, y) && rnd() > 0.52) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
    return `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" role="img" aria-label="Иллюстрация, не QR-код проверки" xmlns="http://www.w3.org/2000/svg"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/><g fill="#111">${cells.join("")}</g></svg>`;
  }

  function receiptText(r) {
    const lines = [r.merchant.name, r.merchant.address, `БИН/ИИН: ${r.merchant.taxId}`, `ККМ: ${r.merchant.kkmSerial} / рег. № ${r.merchant.kkmRegNumber}`, "",
      `${r.isPaymentPreview ? "Счёт к оплате" : "Чек"} № ${r.receiptNumber} (заказ №${r.orderId}${r.tableNumber ? `, стол ${r.tableNumber}` : ""})`, `${r.isPaymentPreview ? "Оформлен" : "Оплата"}: ${r.paidAtLocal} (${r.timeZone})`, ""];
    for (const it of r.items) {
      lines.push(`${it.lineNo}. ${it.name}`);
      for (const d of it.details) lines.push(`   ${d}`);
      lines.push(`   ${it.quantity} ${it.unit} × ${it.unitPrice} = ${it.lineTotal} ₸  (НКТ: ${it.nktLabel})`);
    }
    lines.push("", `Сумма: ${r.subtotal} ₸`, `Скидка бонусами: ${r.bonusDiscount} ₸`, `${r.isPaymentPreview ? "К оплате" : "Оплачено"}: ${r.paidTotal} ₸`, `Способ оплаты: ${r.paymentMethodLabel}`, r.vat.label,
      `ОФД: ${r.ofdLabel}`, `Фискальный признак: ${r.fiscalSignLabel}`);
    if (r.message) lines.push("", r.message);
    return lines.join("\n");
  }

  function receiptHtml(r) {
    const items = r.items.map((it) => `
      <div class="receipt-item">
        <div class="receipt-item-row"><span>${it.lineNo}. ${escapeHtml(it.name)}</span><span>${escapeHtml(it.lineTotal)} ₸</span></div>
        ${it.details.map((d) => `<small>${escapeHtml(d)}</small>`).join("")}
        <small>${it.quantity} ${escapeHtml(it.unit)} × ${escapeHtml(it.unitPrice)} ₸ · НКТ: ${escapeHtml(it.nktLabel)}</small>
      </div>`).join("");
    return `
      <h2>${escapeHtml(r.merchant.name)}</h2>
      <p class="receipt-meta">${escapeHtml(r.merchant.address)}<br>БИН/ИИН: ${escapeHtml(r.merchant.taxId)}<br>
        ККМ: ${escapeHtml(r.merchant.kkmSerial)} · рег. № ${escapeHtml(r.merchant.kkmRegNumber)}</p>
      ${r.message ? `<p class="receipt-demo-banner">${escapeHtml(r.message)}</p>` : ""}
      <p class="receipt-center"><strong>${r.isPaymentPreview ? "Счёт к оплате" : "Чек"} № ${escapeHtml(r.receiptNumber)}</strong></p>
      <p class="receipt-meta">Заказ №${escapeHtml(r.orderId)}${r.tableNumber ? ` · стол ${escapeHtml(r.tableNumber)}` : ""}<br>
        ${r.isPaymentPreview ? "Оформлен" : "Оплата"}: ${escapeHtml(r.paidAtLocal)} (${escapeHtml(r.timeZone)})</p>
      ${r.legacySnapshot ? `<p class="receipt-meta"><em>Чек восстановлен по сохранённым данным заказа (оформлен до появления чеков).</em></p>` : ""}
      <hr class="receipt-rule">
      ${items}
      <hr class="receipt-rule">
      <div class="receipt-totals">
        <div><span>Сумма</span><span>${escapeHtml(r.subtotal)} ₸</span></div>
        <div><span>Скидка бонусами</span><span>−${escapeHtml(r.bonusDiscount)} ₸</span></div>
        <div class="receipt-grand"><span>${r.isPaymentPreview ? "К оплате" : "Оплачено"}</span><span>${escapeHtml(r.paidTotal)} ₸</span></div>
      </div>
      <div class="receipt-facts">
        Способ оплаты: ${escapeHtml(r.paymentMethodLabel)}<br>
        ${escapeHtml(r.vat.label)}${r.vat.amount ? `: ${escapeHtml(r.vat.amount)} ₸` : ""}<br>
        ОФД: ${escapeHtml(r.ofdLabel)}<br>
        Фискальный признак: ${escapeHtml(r.fiscalSignLabel)}
      </div>
      ${r.isPaymentPreview ? "" : `<div class="receipt-qr">${illustrationSvg(r.receiptNumber)}<small>${escapeHtml(r.barcode?.note ?? "")}</small></div>`}`;
  }

  function close() {
    const printRoot = document.getElementById("receipt-print-root");
    if (printRoot) printRoot.innerHTML = "";
    if (!root) return;
    root.remove();
    root = null;
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("modal-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }

  /**
   * opts.orderId      the order whose receipt to show
   * opts.account      true when the signed-in guest owns the order (enables "send to e-mail / Telegram")
   */
  async function open({ orderId, account = false }) {
    close();
    lastFocus = document.activeElement;
    root = document.createElement("div");
    root.className = "checkout-modal";
    root.innerHTML = `<div class="modal-card receipt-card" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><p class="receipt-center">Загрузка чека…</p></div>`;
    document.body.appendChild(root);
    document.body.classList.add("modal-open");
    root.addEventListener("click", (e) => { if (e.target === root) close(); });
    document.addEventListener("keydown", onKey);
    const card = root.querySelector(".receipt-card");

    let receipt;
    try {
      // a signed-in guest reads it as the owner; otherwise the terminal's session secret (added by api.js) is enough
      receipt = (await api.get(`/orders/${orderId}/receipt`, { client: account })).receipt;
    } catch (err) {
      const waiting = err.code === "PAYMENT_NOT_SETTLED";
      card.innerHTML = `<h2>${waiting ? "Чек ещё не готов" : "Чек недоступен"}</h2>
        <p class="receipt-center" style="margin:12px 0">${escapeHtml(waiting ? "Чек появится после оплаты заказа (для наличных - когда официант примет оплату)." : err.message)}</p>
        <div class="receipt-actions"><button type="button" data-close>Закрыть</button></div>`;
      card.querySelector("[data-close]").addEventListener("click", close);
      return;
    }

    card.innerHTML = `${receiptHtml(receipt)}
      <div class="receipt-actions">
        ${receipt.isPaymentPreview ? '<button type="button" data-act="refresh">Обновить статус оплаты</button>' : ""}
        <button type="button" data-act="copy">Копировать</button>
        <button type="button" data-act="print">Печать</button>
        ${account ? `<button type="button" data-act="email">На e-mail</button><button type="button" data-act="telegram">В Telegram</button>` : (!receipt.isPaymentPreview ? `<button type="button" data-act="telegram-guest">Получить в Telegram</button>` : "")}
        <button type="button" data-close>Закрыть</button>
      </div>
      <p class="receipt-status" id="receipt-status" role="status" aria-live="polite"></p>`;
    const status = (text) => { card.querySelector("#receipt-status").textContent = text; };
    card.querySelector("[data-close]").addEventListener("click", close);
    card.querySelector("[data-close]").focus();

    if (receipt.isPaymentPreview) {
      card.querySelector('[data-act="refresh"]').addEventListener("click", () => open({ orderId, account }));
    }
    card.querySelector('[data-act="copy"]').addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(receiptText(receipt)); status("Чек скопирован"); }
      catch { status("Не удалось скопировать - выделите текст вручную"); }
    });
    card.querySelector('[data-act="print"]').addEventListener("click", () => {
      let printRoot = document.getElementById("receipt-print-root");
      if (!printRoot) { printRoot = document.createElement("div"); printRoot.id = "receipt-print-root"; document.body.appendChild(printRoot); }
      printRoot.innerHTML = `<div class="receipt-card">${receiptHtml(receipt)}</div>`;
      document.body.classList.add("printing-receipt");
      window.print();
      document.body.classList.remove("printing-receipt");
      printRoot.innerHTML = ""; // nothing of the receipt may linger in the DOM of a shared monitor
    });

    if (!account && !receipt.isPaymentPreview) {
      card.querySelector('[data-act="telegram-guest"]').addEventListener("click", async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const { deepLink } = await api.post(`/orders/${orderId}/receipt/telegram-link`);
          // Open only the server-issued link; never accept a user-supplied chat id.
          const anchor = document.createElement("a");
          anchor.href = deepLink;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = "Открыть Telegram для получения чека";
          const target = card.querySelector("#receipt-status");
          target.textContent = "";
          target.appendChild(anchor);
          anchor.click();
        } catch (err) { status(err.message); }
        finally { button.disabled = false; }
      });
    }

    if (account) {
      const send = async (channel, button) => {
        button.disabled = true;
        status("Отправляем…");
        try {
          const res = await ClientAuth.call.post(`/client-account/orders/${orderId}/receipt/${channel}`, channel === "email" ? {} : undefined);
          status(`Отправлено: ${res.destinationMasked}`);
        } catch (err) {
          if (err.code === "TELEGRAM_NOT_LINKED") status("Telegram не привязан - привяжите его в профиле.");
          else status(err.message);
        } finally {
          button.disabled = false;
        }
      };
      card.querySelector('[data-act="email"]').addEventListener("click", (e) => send("email", e.currentTarget));
      card.querySelector('[data-act="telegram"]').addEventListener("click", (e) => send("telegram", e.currentTarget));
    }
  }

  return { open, close };
})();
