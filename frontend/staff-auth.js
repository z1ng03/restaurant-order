// Shared by kitchen.html and waiter.html — both are staff-only screens
// gated behind a login (see lib/auth.ts + middleware/auth.middleware.ts on
// the backend for the actual enforcement; this is just the UI side).

const STAFF_KEY = "restaurant.staff"; // { token, user: { userId, name, login, role } }

function getStaffSession() {
  try {
    const raw = sessionStorage.getItem(STAFF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStaffSession(session) {
  sessionStorage.setItem(STAFF_KEY, JSON.stringify(session));
}

function clearStaffSession() {
  sessionStorage.removeItem(STAFF_KEY);
}

/**
 * Shows a login form until a staff member with an allowed role signs in,
 * then reveals the actual monitor UI. Returns nothing — call `onReady`
 * once, when a valid session becomes available.
 */
function initStaffGate({ allowedRoles, roleLabel, onReady }) {
  const loginScreen = document.getElementById("staff-login-screen");
  const appScreen = document.getElementById("staff-app-screen");
  const form = document.getElementById("staff-login-form");
  const errorEl = document.getElementById("staff-login-error");
  const staffNameEl = document.getElementById("staff-name");
  const logoutBtn = document.getElementById("staff-logout-btn");

  function showApp(session) {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    if (staffNameEl) staffNameEl.textContent = `${session.user.name} (${roleLabel})`;
    onReady(session);
  }

  function showLogin(message) {
    loginScreen.hidden = false;
    appScreen.hidden = true;
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  }

  const existing = getStaffSession();
  if (existing && allowedRoles.includes(existing.user.role)) {
    showApp(existing);
  } else {
    if (existing) clearStaffSession(); // logged in, but as the wrong role for this monitor
    showLogin();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const login = document.getElementById("staff-login-input").value.trim();
    const password = document.getElementById("staff-password-input").value;
    try {
      const result = await api.post("/auth/login", { login, password });
      if (!allowedRoles.includes(result.user.role)) {
        showLogin(`Этот экран только для роли: ${roleLabel}.`);
        return;
      }
      setStaffSession(result);
      form.reset();
      showApp(result);
    } catch (err) {
      showLogin(err.message);
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearStaffSession();
      location.reload();
    });
  }
}
