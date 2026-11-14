// Tiny UI helpers shared by the kiosk pages (menu, cart, account, orders, profile).

function formatPrice(value) {
  return formatMoney(value);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function toggleModal(id, show) {
  const el = document.getElementById(id);
  if (el) el.hidden = !show;
}

function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  return wrapped;
}

/** Number of decimals JS floats can carry cleanly in this UI: quantities live on a 0.001 grid. */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
