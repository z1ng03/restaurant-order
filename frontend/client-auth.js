// The guest's optional account (FR-05). Completely separate from the staff login (staff-auth.js): different
// storage key, different token, different API routes.
//
// The token lives in sessionStorage (per tab, gone when the tab closes) and is cleared when
//   - the guest logs out,
//   - the server stops accepting it (401: expired / revoked / the table session ended),
//   - the monitor starts a different table session (session.js).
// It is bound server-side to the table session it was issued on, so on a shared kiosk it can never outlive the visit.

const ClientAuth = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(CLIENT_KEY) || "null");
    } catch {
      return null;
    }
  },
  getToken() {
    return this.get()?.token ?? null;
  },
  getClient() {
    return this.get()?.client ?? null;
  },
  isLoggedIn() {
    return Boolean(this.getToken());
  },
  save(result) {
    sessionStorage.setItem(
      CLIENT_KEY,
      JSON.stringify({ token: result.token, client: result.client, kioskSessionId: getSessionId() }),
    );
  },
  clear() {
    sessionStorage.removeItem(CLIENT_KEY);
  },
  async register({ name, email, password }) {
    const result = await api.post("/client-auth/register", { name, email, password, ...(getSessionId() ? { kioskSessionId: getSessionId() } : {}) });
    this.save(result);
    return result;
  },
  async login({ email, password }) {
    const result = await api.post("/client-auth/login", { email, password, ...(getSessionId() ? { kioskSessionId: getSessionId() } : {}) });
    this.save(result);
    return result;
  },
  async logout() {
    try {
      await api.post("/client-auth/logout", undefined, { client: true });
    } catch {
      // already invalid on the server - nothing more to revoke
    }
    this.clear();
  },
  /** Pages that need an account: sends the guest to the login screen and back. */
  requireLogin() {
    if (this.isLoggedIn()) return true;
    location.href = `account.html?next=${encodeURIComponent(location.pathname.split("/").pop() || "index.html")}`;
    return false;
  },
  /** Account API with the client token and automatic clean-up on 401. */
  call: {
    get: (path) => api.get(path, { client: true }),
    post: (path, body, opts) => api.post(path, body, { client: true, ...opts }),
    patch: (path, body) => api.patch(path, body, { client: true }),
    delete: (path, body) => apiRequest(path, { method: "DELETE", body, client: true }),
  },
};

window.onClientLoggedOut = function () {
  ClientAuth.clear();
  document.dispatchEvent(new CustomEvent("client-logged-out"));
};

/** Kiosk pages bind the login to the table session; a phone / laptop without ?monitor simply has no session. */
async function ensureSessionOptional() {
  const hasMonitor = new URLSearchParams(location.search).get("monitor") || sessionStorage.getItem("restaurant.monitorNumber");
  if (!hasMonitor) return null;
  try {
    return await ensureSession();
  } catch {
    return null;
  }
}
