// ТЗ §1: each physical monitor is permanently wired to one table via
// ?monitor=N in its kiosk URL. This resolves that into an open
// restaurant_session and stashes the ids in sessionStorage so index.html,
// cart.html and the account pages (separate page loads, no SPA router)
// share the same session without re-prompting on every navigation.
//
// TZ v2: opening a session also returns `kioskSessionToken` - an opaque secret shown ONCE. It is kept in
// sessionStorage and api.js sends it with every request; the numeric id alone gives no access. A production
// terminal also carries its registered device secret: open the kiosk URL once as
//   index.html?monitor=3&device=<secret>
// and it is remembered (localStorage) for that browser.

const SESSION_KEYS = {
  monitor: "restaurant.monitorNumber",
  sessionId: "restaurant.sessionId",
  tableNumber: "restaurant.tableNumber",
  kioskToken: KIOSK_TOKEN_KEY,
};

function clearKioskSessionState() {
  sessionStorage.removeItem(SESSION_KEYS.sessionId);
  sessionStorage.removeItem(SESSION_KEYS.tableNumber);
  sessionStorage.removeItem(SESSION_KEYS.kioskToken);
}

async function ensureSession() {
  const params = new URLSearchParams(location.search);
  const monitorFromUrl = params.get("monitor");
  const deviceFromUrl = params.get("device");
  if (deviceFromUrl) localStorage.setItem("restaurant.deviceSecret", deviceFromUrl);
  const monitorNumber = monitorFromUrl || sessionStorage.getItem(SESSION_KEYS.monitor);

  if (!monitorNumber) {
    // No monitor configured for this tab - send to the local dev picker (development only; a real kiosk has
    // its own bookmarked ?monitor=N URL and never reaches this).
    location.href = `monitor-select.html?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  const previousMonitor = sessionStorage.getItem(SESSION_KEYS.monitor);
  // A dev picker can switch monitors within one tab. Never use the old
  // table's session/receipt credentials for a different physical monitor.
  if (previousMonitor && previousMonitor !== String(monitorNumber)) {
    clearKioskSessionState();
    sessionStorage.removeItem("restaurant.lastOrderId");
    if (typeof ClientAuth !== "undefined") ClientAuth.clear();
  }
  sessionStorage.setItem(SESSION_KEYS.monitor, monitorNumber);

  const previousSessionId = sessionStorage.getItem(SESSION_KEYS.sessionId);
  try {
    // After delivery the previous session is COMPLETED. Reopening it automatically
    // made a brand-new ACTIVE session and marked the table OCCUPIED again merely
    // because a guest navigated to another page. Reuse its read-only grace period.
    if (previousSessionId && getKioskToken()) {
      try {
        const { session } = await api.get(`/sessions/${previousSessionId}`);
        if (session.status !== "ACTIVE") {
          showCompletedVisit();
          return null;
        }
        return { session, table: { tableNumber: getTableNumber() } };
      } catch (error) {
        if (error.code === "SESSION_ENDED") { showCompletedVisit(); return null; }
        if (error.code === "INVALID_SESSION_ACCESS" || error.status === 404) {
          showCompletedVisit();
          return null;
        }
        throw error;
      }
    }
    const { session, table, kioskSessionToken } = await api.post("/sessions/open", { monitorNumber: Number(monitorNumber) });
    if (kioskSessionToken) sessionStorage.setItem(SESSION_KEYS.kioskToken, kioskSessionToken);
    sessionStorage.setItem(SESSION_KEYS.sessionId, session.sessionId);
    sessionStorage.setItem(SESSION_KEYS.tableNumber, table.tableNumber);
    // A different table session = a different guest: whoever was logged in on this shared monitor is signed out.
    if (previousSessionId && previousSessionId !== String(session.sessionId) && typeof ClientAuth !== "undefined") ClientAuth.clear();
    return { session, table };
  } catch (err) {
    if (err.status === 404) {
      // Monitor number doesn't map to any table - let the person re-pick.
      sessionStorage.removeItem(SESSION_KEYS.monitor);
      location.href = "monitor-select.html";
      return null;
    }
    throw err;
  }
}

function getSessionId() {
  return sessionStorage.getItem(SESSION_KEYS.sessionId);
}

function getTableNumber() {
  return sessionStorage.getItem(SESSION_KEYS.tableNumber);
}

// Never reserve the same table for a NEW visit merely because the old read token
// expired or the receipt was opened. A new visit must be explicitly started.
function showCompletedVisit() {
  if (document.getElementById("completed-visit")) return;
  if (typeof ClientAuth !== "undefined") ClientAuth.clear();
  const cover = document.createElement("div");
  cover.id = "completed-visit";
  cover.className = "checkout-modal";
  cover.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="Посещение завершено">
    <h2>Посещение завершено</h2>
    <p>Столик освобождён. Для нового гостя начните новую сессию.</p>
    <button class="order-btn modal-button" type="button" id="visit-start-again">Начать новый заказ</button>
    ${sessionStorage.getItem("restaurant.lastOrderId") ? '<button class="secondary-btn full-width-btn" type="button" id="visit-last-receipt" style="margin-top:12px">Посмотреть последний чек</button>' : ""}
  </div>`;
  document.body.appendChild(cover);
  cover.querySelector("#visit-start-again").addEventListener("click", () => {
    const monitorNumber = sessionStorage.getItem(SESSION_KEYS.monitor);
    clearKioskSessionState();
    sessionStorage.removeItem("restaurant.lastOrderId");
    location.href = `index.html?monitor=${encodeURIComponent(monitorNumber || "")}`;
  });
  cover.querySelector("#visit-last-receipt")?.addEventListener("click", () => {
    if (typeof ReceiptViewer !== "undefined") {
      ReceiptViewer.open({ orderId: sessionStorage.getItem("restaurant.lastOrderId") });
    }
  });
}

window.onKioskSessionLost = function (error) {
  if (error?.code === "SESSION_ENDED") {
    showCompletedVisit();
    return;
  }
  // Invalid/stolen token cannot access the previous session. Do not silently
  // create a new occupied table until a guest explicitly starts another visit.
  showCompletedVisit();
};
