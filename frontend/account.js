// Account home: sign in / register, or (when signed in) the two shortcuts - order history and profile.

/** Only our own pages are valid redirect targets after login (no open redirect). */
function safeNext() {
  const next = new URLSearchParams(location.search).get("next");
  return ["index.html", "cart.html", "orders.html", "profile.html"].includes(next ?? "") ? next : null;
}

document.addEventListener("DOMContentLoaded", async () => {
  await ensureSessionOptional();
  const $ = (id) => document.getElementById(id);

  const showTab = (which) => {
    const login = which === "login";
    $("tab-login").setAttribute("aria-selected", String(login));
    $("tab-register").setAttribute("aria-selected", String(!login));
    $("login-form").hidden = !login;
    $("register-form").hidden = login;
  };
  $("tab-login").addEventListener("click", () => showTab("login"));
  $("tab-register").addEventListener("click", () => showTab("register"));

  const fail = (id, message) => {
    const el = $(id);
    el.textContent = message;
    el.hidden = false;
  };
  const afterAuth = () => {
    const next = safeNext();
    if (next) location.href = next;
    else renderHome();
  };

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").hidden = true;
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) return fail("login-error", "Введите email и пароль");
    $("login-submit").disabled = true;
    try {
      await ClientAuth.login({ email, password });
      afterAuth();
    } catch (err) {
      fail("login-error", err.message);
    } finally {
      $("login-submit").disabled = false;
    }
  });

  $("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("register-error").hidden = true;
    const name = $("register-name").value.trim();
    const email = $("register-email").value.trim();
    const password = $("register-password").value;
    if (!name || !email) return fail("register-error", "Заполните имя и email");
    if (password.length < 8) return fail("register-error", "Пароль должен содержать не менее 8 символов");
    if (password !== $("register-password2").value) return fail("register-error", "Пароли не совпадают");
    $("register-submit").disabled = true;
    try {
      await ClientAuth.register({ name, email, password });
      afterAuth();
    } catch (err) {
      fail("register-error", err.message);
    } finally {
      $("register-submit").disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await ClientAuth.logout();
    renderHome();
  });
  document.addEventListener("client-logged-out", renderHome);

  async function renderHome() {
    const loggedIn = ClientAuth.isLoggedIn();
    $("auth-section").hidden = loggedIn;
    $("home-section").hidden = !loggedIn;
    if (!loggedIn) return;
    $("home-greeting").textContent = `Здравствуйте, ${ClientAuth.getClient()?.name ?? ""}!`;
    try {
      const { client } = await ClientAuth.call.get("/client-account/me");
      $("home-greeting").textContent = `Здравствуйте, ${client.name}!`;
      $("home-balance").textContent = formatMoney(client.bonusBalance);
    } catch {
      // a 401 already cleared the login and re-rendered this page
    }
  }
  renderHome();
});
