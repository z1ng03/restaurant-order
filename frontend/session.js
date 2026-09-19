// ТЗ §1: each physical monitor is permanently wired to one table via
// ?monitor=N in its kiosk URL. This resolves that into an open
// restaurant_session and stashes the ids in sessionStorage so index.html
// and cart.html (separate page loads, no SPA router) share the same
// session without re-prompting on every navigation.

const SESSION_KEYS = { monitor: "restaurant.monitorNumber", sessionId: "restaurant.sessionId", tableNumber: "restaurant.tableNumber" };

async function ensureSession() {
  const params = new URLSearchParams(location.search);
  const monitorFromUrl = params.get("monitor");
  const monitorNumber = monitorFromUrl || sessionStorage.getItem(SESSION_KEYS.monitor);

  if (!monitorNumber) {
    // No monitor configured for this tab — send to the local dev picker
    // rather than a physical kiosk redirect. A real deployment would give
    // every monitor its own bookmarked ?monitor=N URL and never hit this.
    location.href = `monitor-select.html?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }

  sessionStorage.setItem(SESSION_KEYS.monitor, monitorNumber);

  try {
    const { session, table } = await api.post("/sessions/open", { monitorNumber: Number(monitorNumber) });
    sessionStorage.setItem(SESSION_KEYS.sessionId, session.sessionId);
    sessionStorage.setItem(SESSION_KEYS.tableNumber, table.tableNumber);
    return { session, table };
  } catch (err) {
    if (err.status === 404) {
      // Monitor number doesn't map to any table — let the person re-pick.
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
