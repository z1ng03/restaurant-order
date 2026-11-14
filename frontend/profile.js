// Profile: data, cashback ledger, identity verification (FR-05), Telegram link (FR-07), password, account deletion.
// Server text is only ever written with textContent / escapeHtml.

const IDENTITY_LABELS = {
  UNVERIFIED: ["Не подтверждена", ""],
  PENDING: ["На проверке", "warn"],
  VERIFIED: ["Подтверждена", "ok"],
  REJECTED: ["Отклонена", "bad"],
  EXPIRED: ["Срок подтверждения истёк", "bad"],
};

document.addEventListener("DOMContentLoaded", async () => {
  // Preserve a bot-initiated login token through the existing account login screen.
  const botLoginToken = location.hash.startsWith("#telegram_login=") ? location.hash.slice("#telegram_login=".length) : "";
  if (/^l_[A-Za-z0-9_-]{20,64}$/.test(botLoginToken)) sessionStorage.setItem("restaurant.pendingTelegramLogin", botLoginToken);
  if (!ClientAuth.requireLogin()) return;
  await ensureSessionOptional();
  document.addEventListener("client-logged-out", () => ClientAuth.requireLogin());

  const $ = (id) => document.getElementById(id);
  const showError = (id, message) => { const el = $(id); el.textContent = message; el.hidden = !message; };
  const state = { ledgerCursor: null, tgTimer: null };
  let autoButton = null;

  await Promise.all([loadProfile(), loadLedger()]);
  if (location.hash === "#identity") $("identity").scrollIntoView();
  const pendingLogin = sessionStorage.getItem("restaurant.pendingTelegramLogin");
  if (pendingLogin && /^l_[A-Za-z0-9_-]{20,64}$/.test(pendingLogin)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Подтвердить вход в Telegram";
    $("tg-status").insertAdjacentElement("afterend", button);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await ClientAuth.call.post("/client-account/telegram/confirm-bot-login", { token: pendingLogin });
        sessionStorage.removeItem("restaurant.pendingTelegramLogin");
        history.replaceState(null, "", location.pathname + location.search);
        button.remove();
        await loadProfile();
        showToast("Вход в Telegram подтверждён");
      } catch (err) { showToast(err.message); button.disabled = false; }
    });
  }

  /* ---------------------------------- profile --------------------------------- */
  async function loadProfile() {
    try {
      const { client } = await ClientAuth.call.get("/client-account/me");
      $("p-name").textContent = client.name;
      $("p-email").textContent = client.email ?? "-";
      $("p-since").textContent = formatDateTime(client.createdAt);
      $("p-balance").textContent = formatMoney(client.bonusBalance);
      $("p-rules").textContent = `Начисление: ${Math.round(client.loyalty.cashbackRate * 100)}% от оплаченной деньгами суммы (после оплаты заказа). Списание: до ${Math.round(client.loyalty.redemptionCap * 100)}% стоимости заказа, 1 бонус = 1 ₸.`;
      renderIdentity(client.identity);
      renderTelegram(client.telegram);
    } catch (err) {
      showToast(err.message);
    }
  }

  /* ------------------------------ cashback ledger ------------------------------ */
  async function loadLedger() {
    try {
      const data = await ClientAuth.call.get(`/client-account/loyalty?limit=20${state.ledgerCursor ? `&cursor=${state.ledgerCursor}` : ""}`);
      state.ledgerCursor = data.nextCursor;
      $("ledger").insertAdjacentHTML("beforeend", data.entries.map((e) => `
        <li>
          <span><strong>${escapeHtml(e.typeLabel)}</strong> · заказ №${escapeHtml(e.orderId)}</span>
          <span class="amount ${e.amount > 0 ? "plus" : "minus"}">${e.amount > 0 ? "+" : "−"}${escapeHtml(formatMoney(Math.abs(e.amount)))}</span>
          <small>${escapeHtml(formatDateTime(e.createdAt))}${e.note ? ` - ${escapeHtml(e.note)}` : ""}</small>
        </li>`).join(""));
      $("ledger-empty").hidden = $("ledger").children.length > 0;
      $("ledger-more").hidden = !data.nextCursor;
    } catch (err) {
      showToast(err.message);
    }
  }
  $("ledger-more").addEventListener("click", loadLedger);

  /* ---------------------------------- identity --------------------------------- */
  function renderIdentity(identity) {
    const [label, kind] = IDENTITY_LABELS[identity.status] ?? [identity.status, ""];
    const badge = $("id-badge");
    badge.textContent = label;
    badge.className = `status-badge ${kind}`;
    let text = "";
    if (identity.status === "VERIFIED") {
      text = `Возраст подтверждён${identity.expiresAt ? ` до ${formatDateTime(identity.expiresAt)}` : ""}. ${identity.mode === "DEMO" ? "Это демонстрационное подтверждение. " : ""}Блюда 21+ можно заказывать без официанта.`;
    } else if (!identity.demoModeAvailable) {
      text = "Проверка личности через сервис пока не подключена. Подтвердить возраст можно у официанта при оформлении заказа.";
    } else if (identity.status === "PENDING") {
      text = "Документ отправлен. В демонстрационном режиме подтвердите проверку кнопкой ниже.";
    } else {
      text = "Приложите фото документа - после проверки блюда 21+ можно будет заказывать без официанта.";
    }
    $("id-text").textContent = text;
    const canSubmit = identity.demoModeAvailable && ["UNVERIFIED", "REJECTED", "EXPIRED"].includes(identity.status);
    $("id-form").hidden = !canSubmit;
    $("id-demo").hidden = !(identity.demoModeAvailable && identity.status === "PENDING");
  }

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });

  $("id-submit").addEventListener("click", async () => {
    showError("id-error", "");
    const file = $("id-file").files[0];
    if (!file) return showError("id-error", "Выберите файл с фото или сканом документа");
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) return showError("id-error", "Допустимы только JPEG, PNG или PDF");
    if (file.size > 3 * 1024 * 1024) return showError("id-error", "Файл больше 3 МБ");
    $("id-submit").disabled = true;
    try {
      const fileBase64 = await readAsBase64(file);
      const { identity } = await ClientAuth.call.post("/client-account/identity-verification", { fileBase64 });
      $("id-file").value = "";
      renderIdentity(identity);
    } catch (err) {
      showError("id-error", err.message);
    } finally {
      $("id-submit").disabled = false;
    }
  });

  $("id-confirm").addEventListener("click", async () => {
    showError("id-error", "");
    try {
      const { identity } = await ClientAuth.call.post("/client-account/identity-verification/demo-confirm");
      renderIdentity(identity);
    } catch (err) {
      showError("id-error", err.message);
    }
  });

  /* ---------------------------------- Telegram ---------------------------------- */
  function renderTelegram(tg) {
    $("tg-status").textContent = tg.linked
      ? `Привязан (чат ${tg.chatIdMasked}${tg.linkedAt ? `, с ${formatDateTime(tg.linkedAt)}` : ""}). Чеки можно отправлять из истории заказов.`
      : tg.linkAvailable ? "Не привязан." : "Telegram-бот не настроен на сервере.";
    $("tg-link").hidden = tg.linked || !tg.linkAvailable;
    $("tg-unlink").hidden = !tg.linked;
    if (autoButton) {
      autoButton.hidden = !tg.linked;
      autoButton.dataset.enabled = String(Boolean(tg.autoReceipts));
      autoButton.textContent = tg.autoReceipts ? "Отключить автоматические чеки" : "Включить автоматические чеки";
    }
    if (tg.linked) {
      $("tg-open").hidden = true;
      $("tg-hint").hidden = true;
      clearInterval(state.tgTimer);
    }
  }

  $("tg-link").addEventListener("click", async () => {
    showError("tg-error", "");
    $("tg-link").disabled = true;
    try {
      const { deepLink } = await ClientAuth.call.post("/client-account/telegram/link");
      $("tg-open").href = deepLink;
      $("tg-open").hidden = false;
      $("tg-hint").hidden = false;
      // wait (up to 3 minutes) until the webhook has confirmed the chat
      let tries = 0;
      clearInterval(state.tgTimer);
      state.tgTimer = setInterval(async () => {
        if (++tries > 60) return clearInterval(state.tgTimer);
        try {
          const { client } = await ClientAuth.call.get("/client-account/me");
          if (client.telegram.linked) { renderTelegram(client.telegram); showToast("Telegram привязан"); }
        } catch { /* ignore */ }
      }, 3000);
    } catch (err) {
      showError("tg-error", err.message);
    } finally {
      $("tg-link").disabled = false;
    }
  });

  // Optional opt-in: absent until Telegram is linked; inherits the site's existing button styling.
  autoButton = document.createElement("button");
  autoButton.type = "button";
  autoButton.hidden = true;
  $("tg-status").insertAdjacentElement("afterend", autoButton);
  autoButton.addEventListener("click", async () => {
    try {
      const current = autoButton.dataset.enabled === "true";
      await ClientAuth.call.patch("/client-account/telegram/auto-receipts", { enabled: !current });
      await loadProfile();
    } catch (err) { showToast(err.message); }
  });

  await loadProfile(); // refresh consent control after it is inserted
  $("tg-unlink").addEventListener("click", async () => {
    try {
      await ClientAuth.call.delete("/client-account/telegram");
      await loadProfile();
    } catch (err) {
      showError("tg-error", err.message);
    }
  });

  /* ------------------------------------ password ---------------------------------- */
  $("pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("pw-error", "");
    const oldPassword = $("pw-old").value;
    const newPassword = $("pw-new").value;
    if (newPassword.length < 8) return showError("pw-error", "Новый пароль должен содержать не менее 8 символов");
    if (newPassword !== $("pw-new2").value) return showError("pw-error", "Новые пароли не совпадают");
    $("pw-submit").disabled = true;
    try {
      await ClientAuth.call.patch("/client-account/password", { oldPassword, newPassword });
      // the server revoked every session, this one included
      ClientAuth.clear();
      alert("Пароль изменён. Войдите с новым паролем.");
      location.href = "account.html";
    } catch (err) {
      showError("pw-error", err.message);
      $("pw-submit").disabled = false;
    }
  });

  /* ------------------------------------ deletion ----------------------------------- */
  $("del-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("del-error", "");
    if (!$("del-password").value) return showError("del-error", "Введите пароль");
    if (!$("del-confirm").checked) return showError("del-error", "Подтвердите, что понимаете последствия");
    if (!window.confirm("Удалить аккаунт безвозвратно?")) return;
    $("del-submit").disabled = true;
    try {
      await ClientAuth.call.delete("/client-account/me", { password: $("del-password").value, confirm: true });
      ClientAuth.clear();
      location.href = "index.html";
    } catch (err) {
      showError("del-error", err.message);
      $("del-submit").disabled = false;
    }
  });
});
