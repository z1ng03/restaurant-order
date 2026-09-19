// Shared by every page (client menu/cart, kitchen monitor, waiter monitor).
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

async function apiRequest(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError("Не удаётся связаться с сервером. Проверьте подключение.", 0, "NETWORK_ERROR");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // No JSON body (e.g. 204) — fine.
  }

  if (!response.ok) {
    const message = data?.error?.message || `Ошибка запроса (${response.status})`;
    throw new ApiError(message, response.status, data?.error?.code, data?.error?.details);
  }
  return data;
}

const api = {
  get: (path, opts) => apiRequest(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => apiRequest(path, { ...opts, method: "POST", body }),
  patch: (path, body, opts) => apiRequest(path, { ...opts, method: "PATCH", body }),
  delete: (path, opts) => apiRequest(path, { ...opts, method: "DELETE" }),
};
