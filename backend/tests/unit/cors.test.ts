import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";

/**
 * The frontend is served from another origin than the API, so the new custom headers must pass the CORS preflight
 * or every guest request would fail in a real browser (Node-side tests never see this).
 */
describe("CORS preflight for the headers the frontend sends", () => {
  it("allows Idempotency-Key, X-Kiosk-Session-Token, X-Device-Secret, Authorization and Content-Type", async () => {
    const res = await request(app)
      .options("/api/checkout/1/confirm")
      .set("Origin", "http://localhost:8000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization,idempotency-key,x-kiosk-session-token,x-device-secret");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeTruthy();
    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    for (const h of ["content-type", "authorization", "idempotency-key", "x-kiosk-session-token", "x-device-secret"]) {
      expect(allowed).toContain(h);
    }
  });

  it("answers 404 JSON for unknown routes and never caches API responses", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/nope")).body.error.code).toBe("NOT_FOUND");
  });
});
