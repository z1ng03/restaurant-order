import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/db/prisma";
import { resetLoginLockout } from "../../src/modules/clientAuth/clientAuth.service";
import { assertTestDatabase, hasTestDatabase, resetDatabase } from "../helpers/db";
import { seedCatalog, type Catalog } from "../helpers/fixtures";
import { addToCart, api, auth, checkout, openKiosk, registerClient } from "../helpers/http";

describe.skipIf(!hasTestDatabase)("client accounts (FR-05) and the kiosk session secret (§5.2)", () => {
  let cat: Catalog;
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    cat = await seedCatalog();
    resetLoginLockout();
  });

  describe("accounts", () => {
    it("registers, normalises the e-mail, never returns or stores the password in clear, logs in and out", async () => {
      const res = await api().post("/api/client-auth/register").send({ name: "Анна", email: "  Anna@Example.COM ", password: "password-123" });
      expect(res.status).toBe(201);
      expect(res.body.client).toMatchObject({ name: "Анна", email: "anna@example.com" });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      const row = await prisma.clientUser.findFirstOrThrow();
      expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(row.passwordHash).not.toContain("password-123");

      const me = await api().get("/api/client-account/me").set(auth(res.body.token));
      expect(me.status).toBe(200);
      expect(me.body.client).toMatchObject({ email: "anna@example.com", bonusBalance: 0, identity: { status: "UNVERIFIED" } });
      expect(JSON.stringify(me.body)).not.toContain("passwordHash");

      const login = await api().post("/api/client-auth/login").send({ email: "ANNA@example.com", password: "password-123" });
      expect(login.status).toBe(200);
      expect((await api().post("/api/client-auth/logout").set(auth(login.body.token))).status).toBe(204);
      expect((await api().get("/api/client-account/me").set(auth(login.body.token))).status).toBe(401); // really revoked
      expect((await api().get("/api/client-account/me").set(auth(res.body.token))).status).toBe(200); // other session untouched
    });

    it("validates input and does not reveal whether an account exists", async () => {
      expect((await api().post("/api/client-auth/register").send({ name: "A", email: "bad", password: "password-123" })).status).toBe(400);
      expect((await api().post("/api/client-auth/register").send({ name: "A", email: "a@example.com", password: "short" })).status).toBe(400);
      expect((await api().post("/api/client-auth/register").send({ name: "A", email: "a@example.com", password: "x".repeat(80) })).status).toBe(400);
      await registerClient("dup@example.com");
      const dup = await api().post("/api/client-auth/register").send({ name: "B", email: "dup@example.com", password: "password-123" });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("REGISTRATION_FAILED");
      const wrongPw = await api().post("/api/client-auth/login").send({ email: "dup@example.com", password: "nope-nope-nope" });
      const unknown = await api().post("/api/client-auth/login").send({ email: "ghost@example.com", password: "nope-nope-nope" });
      expect([wrongPw.status, unknown.status]).toEqual([401, 401]);
      expect(wrongPw.body.error).toEqual(unknown.body.error); // identical answer
    });

    it("locks a (e-mail, IP) pair after repeated failures", async () => {
      await registerClient("lock@example.com");
      (env as { rateLimitDisabled: boolean }).rateLimitDisabled = false;
      try {
        for (let i = 0; i < env.loginMaxFailures; i++) {
          expect((await api().post("/api/client-auth/login").send({ email: "lock@example.com", password: "wrong-password" })).status).toBe(401);
        }
        const locked = await api().post("/api/client-auth/login").send({ email: "lock@example.com", password: "password-123" });
        expect(locked.status).toBe(429);
        expect(locked.body.error.code).toBe("LOGIN_LOCKED");
      } finally {
        (env as { rateLimitDisabled: boolean }).rateLimitDisabled = true;
        resetLoginLockout();
      }
    });

    it("changing the password revokes every session and the old password stops working", async () => {
      const c = await registerClient("pw@example.com", "old-password-1");
      const second = (await api().post("/api/client-auth/login").send({ email: "pw@example.com", password: "old-password-1" })).body.token;
      expect((await api().patch("/api/client-account/password").set(auth(c.token)).send({ oldPassword: "WRONG-old-pw", newPassword: "new-password-1" })).body.error.code).toBe("WRONG_PASSWORD");
      expect((await api().patch("/api/client-account/password").set(auth(c.token)).send({ oldPassword: "old-password-1", newPassword: "short" })).status).toBe(400);
      expect((await api().patch("/api/client-account/password").set(auth(c.token)).send({ oldPassword: "old-password-1", newPassword: "old-password-1" })).status).toBe(400);
      expect((await api().patch("/api/client-account/password").set(auth(c.token)).send({ oldPassword: "old-password-1", newPassword: "new-password-1" })).status).toBe(204);
      expect((await api().get("/api/client-account/me").set(auth(c.token))).status).toBe(401);
      expect((await api().get("/api/client-account/me").set(auth(second))).status).toBe(401);
      expect((await api().post("/api/client-auth/login").send({ email: "pw@example.com", password: "old-password-1" })).status).toBe(401);
      expect((await api().post("/api/client-auth/login").send({ email: "pw@example.com", password: "new-password-1" })).status).toBe(200);
    });

    it("deleting the account anonymises it, keeps the operational trail and ends every token", async () => {
      const guest = await openKiosk(1);
      const c = await registerClient("del@example.com", "password-123", guest);
      await addToCart(guest, { dishId: cat.dish.lemonade!.toString(), quantity: 1 });
      const order = await checkout(guest, { paymentMethod: "CASH" }, auth(c.token));
      expect(order.status).toBe(201);
      const body = { password: "password-123", confirm: true };
      // an order is still in progress
      expect((await api().delete("/api/client-account/me").set(auth(c.token)).send(body)).body.error.code).toBe("ACCOUNT_HAS_ACTIVE_ORDERS");
      await api().post(`/api/admin/orders/${order.body.order.orderId}/cancel`).set(auth(cat.staff.admin.token)).send({});
      const fresh = (await api().post("/api/client-auth/login").send({ email: "del@example.com", password: "password-123" })).body.token;
      expect((await api().delete("/api/client-account/me").set(auth(fresh)).send({ password: "WRONG-password", confirm: true })).body.error.code).toBe("WRONG_PASSWORD");
      expect((await api().delete("/api/client-account/me").set(auth(fresh)).send({ password: "password-123" })).status).toBe(400); // explicit confirmation required
      expect((await api().delete("/api/client-account/me").set(auth(fresh)).send(body)).status).toBe(204);

      expect((await api().get("/api/client-account/me").set(auth(fresh))).status).toBe(401);
      expect((await api().post("/api/client-auth/login").send({ email: "del@example.com", password: "password-123" })).status).toBe(401);
      const row = await prisma.clientUser.findUniqueOrThrow({ where: { clientUserId: BigInt(c.clientUserId) } });
      expect(row).toMatchObject({ email: null, passwordHash: null, isActive: false, name: "Удалённый пользователь" });
      expect(await prisma.order.count()).toBe(1); // the order itself stays
      expect((await registerClient("del@example.com")).clientUserId).not.toBe(c.clientUserId); // the address is free again
    });

    it("the two token worlds never mix: a staff token is not a client token and vice versa", async () => {
      const c = await registerClient("mix@example.com");
      expect((await api().get("/api/client-account/me").set(auth(cat.staff.admin.token))).status).toBe(401);
      expect((await api().get("/api/kitchen/orders").set(auth(c.token))).status).toBe(401);
      expect((await api().get("/api/admin/dashboard").set(auth(c.token))).status).toBe(401);
      expect((await api().get("/api/client-account/me")).status).toBe(401);
      expect((await api().get("/api/client-account/me").set({ Authorization: "Bearer garbage" })).status).toBe(401);
    });

    it("a login on a kiosk is bound to that table session: it needs the kiosk secret and dies with the table", async () => {
      const k = await openKiosk(1);
      const noSecret = await api().post("/api/client-auth/register").send({ name: "X", email: "x@example.com", password: "password-123", kioskSessionId: k.sessionId });
      expect(noSecret.status).toBe(403);
      const other = await openKiosk(2);
      const wrongSecret = await api().post("/api/client-auth/register").set(other.h).send({ name: "X", email: "x@example.com", password: "password-123", kioskSessionId: k.sessionId });
      expect(wrongSecret.status).toBe(403);
      const c = await registerClient("bound@example.com", "password-123", k);
      expect((await api().get("/api/client-account/me").set(auth(c.token))).status).toBe(200);
      // an admin releasing the table ends the guest's login immediately
      await api().patch(`/api/admin/tables/${k.tableId}/status`).set(auth(cat.staff.admin.token)).send({ status: "FREE" });
      const gone = await api().get("/api/client-account/me").set(auth(c.token));
      expect(gone.status).toBe(401);
      expect(gone.body.error.code).toBe("CLIENT_SESSION_ENDED");
      // a login made away from any kiosk is not bound
      const phone = (await api().post("/api/client-auth/login").send({ email: "bound@example.com", password: "password-123" })).body.token;
      expect((await api().get("/api/client-account/me").set(auth(phone))).status).toBe(200);
    });
  });

  describe("the kiosk session secret", () => {
    it("no secret / wrong secret / another table's secret -> 403, on every guest endpoint", async () => {
      const a = await openKiosk(1);
      const b = await openKiosk(2);
      const lemon = { dishId: cat.dish.lemonade!.toString(), quantity: 1 };
      const added = await addToCart(a, lemon);
      const itemId = added.body.cart.items[0].cartItemId;
      const calls = (h: Record<string, string>) => [
        api().get(`/api/sessions/${a.sessionId}`).set(h),
        api().get(`/api/sessions/${a.sessionId}/orders`).set(h),
        api().get(`/api/cart/${a.sessionId}`).set(h),
        api().post(`/api/cart/${a.sessionId}/items`).set(h).send(lemon),
        api().patch(`/api/cart/items/${itemId}`).set(h).send({ quantity: 2 }),
        api().delete(`/api/cart/items/${itemId}`).set(h),
        api().patch(`/api/cart/${a.sessionId}/comment`).set(h).send({ comment: "x" }),
        api().delete(`/api/cart/${a.sessionId}`).set(h),
        api().get(`/api/checkout/${a.sessionId}/validate`).set(h),
        api().post(`/api/checkout/${a.sessionId}/confirm`).set(h).send({ paymentMethod: "CASH" }),
        api().get(`/api/order-tracking/session/${a.sessionId}`).set(h),
        api().post("/api/age-verification").set(h).send({ sessionId: a.sessionId, waiterLogin: "waiter", waiterPassword: cat.staff.waiter.password, verified: true }),
      ];
      for (const [label, headers] of [["none", {}], ["wrong", { "X-Kiosk-Session-Token": "nope" }], ["other table", b.h]] as const) {
        const results = await Promise.all(calls(headers));
        results.forEach((r, i) => expect([label, i, r.status, r.body.error?.code]).toEqual([label, i, 403, "INVALID_SESSION_ACCESS"]));
      }
      // the right secret works, and nothing above has changed the cart
      expect((await api().get(`/api/cart/${a.sessionId}`).set(a.h)).body.cart.items).toHaveLength(1);
    });

    it("re-opening keeps the same secret when the browser still holds it, rotates it otherwise (killing the stale copy)", async () => {
      const first = await openKiosk(1);
      const again = await api().post("/api/sessions/open").set(first.h).send({ monitorNumber: 1 });
      expect(again.status).toBe(200);
      expect(again.body.reused).toBe(true);
      expect(again.body.kioskSessionToken).toBeUndefined(); // no new secret: the one it holds stays valid
      expect((await api().get(`/api/cart/${first.sessionId}`).set(first.h)).status).toBe(200);
      const lost = await api().post("/api/sessions/open").send({ monitorNumber: 1 });
      expect(lost.status).toBe(200);
      expect(lost.body.session.sessionId).toBe(first.sessionId); // same table session ...
      expect(typeof lost.body.kioskSessionToken).toBe("string"); // ... new secret
      expect((await api().get(`/api/cart/${first.sessionId}`).set(first.h)).status).toBe(403); // the stale copy is dead
      expect((await api().get(`/api/cart/${first.sessionId}`).set({ "X-Kiosk-Session-Token": lost.body.kioskSessionToken })).status).toBe(200);
      // the secret hash never leaves the server
      expect(JSON.stringify(lost.body)).not.toMatch(/kioskTokenHash|kiosk_token_hash/);
      expect(JSON.stringify((await api().get("/api/admin/tables").set(auth(cat.staff.admin.token))).body)).not.toMatch(/kioskTokenHash/);
    });

    it("in production a terminal must present its registered device secret", async () => {
      const prevSecrets = env.kioskDeviceSecrets;
      const prevProd = env.isProduction;
      try {
        env.kioskDeviceSecrets = { "1": "device-secret-for-monitor-1" };
        expect((await api().post("/api/sessions/open").send({ monitorNumber: 1 })).body.error.code).toBe("DEVICE_NOT_AUTHORIZED");
        expect((await api().post("/api/sessions/open").set({ "X-Device-Secret": "wrong" }).send({ monitorNumber: 1 })).status).toBe(403);
        expect((await api().post("/api/sessions/open").set({ "X-Device-Secret": "device-secret-for-monitor-1" }).send({ monitorNumber: 1 })).status).toBe(201);
        (env as { isProduction: boolean }).isProduction = true;
        expect((await api().post("/api/sessions/open").send({ monitorNumber: 2 })).body.error.code).toBe("DEVICE_NOT_REGISTERED"); // no secret configured for monitor 2
      } finally {
        env.kioskDeviceSecrets = prevSecrets;
        (env as { isProduction: boolean }).isProduction = prevProd;
      }
    });
  });
});
