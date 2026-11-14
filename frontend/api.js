// Shared by every page (client menu/cart/account, kitchen monitor, waiter monitor, admin).
// Points at the backend from src/server.ts. Override by setting
// window.RESTAURANT_API_BASE before this script loads if the API runs
// somewhere other than localhost:4000 (e.g. deployed).
const API_BASE = window.RESTAURANT_API_BASE || "http://localhost:4000/api";

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// small shared helpers (every page loads this file first)
// ---------------------------------------------------------------------------

/** Everything that came from the server / a user goes through this before it is put into innerHTML. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 3200 -> "3 200 ₸" (the API sends money as strings, "3200.00" / "3200"). */
function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const hasFraction = Math.abs(n - Math.round(n)) > 0.004;
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} ₸`;
}

/** Quantity in the ingredient's BASE unit -> a friendly string: 0.04 kg -> "40 г", 1.2 kg -> "1,2 кг", 0.1 l -> "100 мл", 1 pcs -> "1 шт." (mirrors lib/units.ts) */
function formatQty(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const num = (x) => String(Math.round(x * 1000) / 1000).replace(".", ",");
  switch (unit) {
    case "kg": return Math.abs(n) < 1 ? `${num(n * 1000)} г` : `${num(n)} кг`;
    case "l": return Math.abs(n) < 1 ? `${num(n * 1000)} мл` : `${num(n)} л`;
    case "g": return `${num(n)} г`;
    case "ml": return `${num(n)} мл`;
    case "pcs": return `${num(n)} шт.`;
    default: return `${num(n)} ${unit ?? ""}`.trim();
  }
}

/** Every user-visible time is shown in the restaurant's zone (Almaty). */
function formatDateTime(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}
function formatTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** A fresh key per user ATTEMPT (kept while retrying the same attempt) - see confirmCheckout(). */
function newIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

// ---------------------------------------------------------------------------
// storage keys shared with session.js / client-auth.js
// ---------------------------------------------------------------------------
const KIOSK_TOKEN_KEY = "restaurant.kioskToken";
const CLIENT_KEY = "restaurant.client"; // { token, client, kioskSessionId }

function getKioskToken() {
  return sessionStorage.getItem(KIOSK_TOKEN_KEY);
}
function getClientToken() {
  try {
    return JSON.parse(sessionStorage.getItem(CLIENT_KEY) || "null")?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Options:
 *   token           staff bearer token (kitchen / waiter / admin)
 *   client: true    attach the guest account's bearer token if one is stored (cart, checkout, account pages)
 *   idempotencyKey  sent as the Idempotency-Key header
 *
 * The kiosk session secret is attached to EVERY request (the server ignores it where it is not needed): a numeric
 * session id alone does not give access to a cart, order, tracker or receipt.
 */
async function apiRequest(path, { method = "GET", body, token, client = false, idempotencyKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  const kioskToken = getKioskToken();
  if (kioskToken) headers["X-Kiosk-Session-Token"] = kioskToken;
  const bearer = token || (client ? getClientToken() : null);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (path === "/sessions/open") {
    const device = localStorage.getItem("restaurant.deviceSecret");
    if (device) headers["X-Device-Secret"] = device;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (networkErr) {
    throw new ApiError("Не удаётся связаться с сервером. Проверьте подключение.", 0, "NETWORK_ERROR");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // No JSON body (e.g. 204) - fine.
  }

  if (!response.ok) {
    const message = data?.error?.message || `Ошибка запроса (${response.status})`;
    const err = new ApiError(message, response.status, data?.error?.code, data?.error?.details);
    // The table session ended / the terminal's secret is stale: session.js starts a fresh session.
    if (err.code === "INVALID_SESSION_ACCESS" || err.code === "SESSION_ENDED") {
      if (typeof window.onKioskSessionLost === "function") window.onKioskSessionLost(err);
    }
    // A guest login that the server no longer accepts must disappear from the screen immediately.
    if (client && err.status === 401 && typeof window.onClientLoggedOut === "function") {
      window.onClientLoggedOut(err);
    }
    throw err;
  }
  return data;
}

const api = {
  get: (path, opts) => apiRequest(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => apiRequest(path, { ...opts, method: "POST", body }),
  patch: (path, body, opts) => apiRequest(path, { ...opts, method: "PATCH", body }),
  delete: (path, opts) => apiRequest(path, { ...opts, method: "DELETE" }),
};
