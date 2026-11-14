import { describe, expect, it } from "vitest";
import { parseDecimalInput, floorToInt, money, qtyStr, dec } from "../../src/lib/decimal";
import { convertQuantity, formatQuantityRu } from "../../src/lib/units";
import { parseIdempotencyKey } from "../../src/lib/idempotency";
import { stableHash } from "../../src/lib/crypto";
import { FailureLockout } from "../../src/lib/rateLimit";
import { env } from "../../src/config/env";
import { computeEarn, computeMaxRedeem } from "../../src/modules/loyalty/loyalty.service";
import { buildTrackingOrder } from "../../src/modules/orderTracking/orderTracking.service";
import { evaluateIdentity } from "../../src/modules/identity/identity.service";
import { maskEmail, renderReceiptHtml } from "../../src/modules/receipts/delivery.service";
import { formatReceiptNumber } from "../../src/modules/receipts/receipts.service";

describe("decimal input", () => {
  it("accepts numbers and numeric strings, strips float noise, rejects what is too fine or not a number", () => {
    expect(parseDecimalInput(0.07 * 3, "q").toFixed()).toBe("0.21"); // 0.21000000000000002 in floating point
    expect(parseDecimalInput("0.060", "q").toFixed(3)).toBe("0.060");
    expect(() => parseDecimalInput(0.0001, "q")).toThrow();
    expect(() => parseDecimalInput("abc", "q")).toThrow();
    expect(() => parseDecimalInput(NaN, "q")).toThrow();
    expect(() => parseDecimalInput(null, "q")).toThrow();
  });
  it("formats money with two decimals and quantities without trailing zeros", () => {
    expect(money("3200")).toBe("3200.00");
    expect(qtyStr("0.0500")).toBe("0.05");
    expect(floorToInt("475.9")).toBe(475);
  });
});

describe("units", () => {
  it("converts only within one dimension", () => {
    expect(convertQuantity(dec(25), "g", "kg").toFixed()).toBe("0.025");
    expect(convertQuantity(dec(250), "ml", "l").toFixed()).toBe("0.25");
    expect(() => convertQuantity(dec(1), "g", "ml")).toThrow();
    expect(() => convertQuantity(dec(1), "kg", "pcs")).toThrow();
  });
  it("formats for people: 0.04 kg -> 40 г, 1.2 kg -> 1,2 кг, 0.1 l -> 100 мл, 1 pcs -> 1 шт.", () => {
    expect(formatQuantityRu("0.04", "kg")).toBe("40 г");
    expect(formatQuantityRu("1.2", "kg")).toBe("1,2 кг");
    expect(formatQuantityRu("0.1", "l")).toBe("100 мл");
    expect(formatQuantityRu("1", "pcs")).toBe("1 шт.");
    expect(formatQuantityRu("0.5", "pcs")).toBe("0,5 шт.");
  });
});

describe("loyalty arithmetic (TZ FR-06)", () => {
  it("earn = floor(5% of the MONEY paid); redeem is capped at 50% of the order and at the balance", () => {
    expect(computeEarn(dec("5900"))).toBe(295);
    expect(computeEarn(dec("19.99"))).toBe(0);
    expect(computeEarn(dec("0"))).toBe(0);
    expect(computeMaxRedeem(500, dec("6400"))).toBe(500);
    expect(computeMaxRedeem(5000, dec("3200"))).toBe(1600);
    expect(computeMaxRedeem(5000, dec("3201"))).toBe(1600); // floor(1600.5)
    expect(computeMaxRedeem(0, dec("3200"))).toBe(0);
  });
});

describe("idempotency key + hashing", () => {
  it("validates the header format", () => {
    expect(parseIdempotencyKey("11111111-aaaa-4bbb-8ccc-000000000001", true)).toBe("11111111-aaaa-4bbb-8ccc-000000000001");
    expect(parseIdempotencyKey(undefined, false)).toBeNull();
    expect(() => parseIdempotencyKey(undefined, true)).toThrow();
    expect(() => parseIdempotencyKey("short", false)).toThrow();
    expect(() => parseIdempotencyKey("bad key with spaces!!", false)).toThrow();
  });
  it("hashes bodies independently of key order", () => {
    expect(stableHash({ a: 1, b: [1, 2], c: undefined })).toBe(stableHash({ b: [1, 2], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe("login lockout", () => {
  it("locks after N failures and a success clears the counter", () => {
    const prev = env.rateLimitDisabled;
    (env as { rateLimitDisabled: boolean }).rateLimitDisabled = false;
    try {
      const l = new FailureLockout(3, 60_000);
      expect(l.isLocked("k")).toBe(0);
      l.recordFailure("k");
      l.recordFailure("k");
      l.recordSuccess("k");
      l.recordFailure("k");
      l.recordFailure("k");
      expect(l.isLocked("k")).toBe(0);
      l.recordFailure("k");
      expect(l.isLocked("k")).toBeGreaterThan(0);
      expect(l.isLocked("other")).toBe(0);
    } finally {
      (env as { rateLimitDisabled: boolean }).rateLimitDisabled = prev;
    }
  });
});

describe("tracker (FR-09)", () => {
  const base = { orderId: 1n, paymentStatus: "PAID", createdAt: new Date("2026-10-12T10:00:00Z"), deliveredAt: null, cancelledAt: null, cancelReason: null, items: [{ quantity: 2 }, { quantity: 1 }], receipt: null };
  const ev = (type: string, at: string) => ({ eventType: type, occurredAt: new Date(at) });
  const states = (o: ReturnType<typeof buildTrackingOrder>) => o.steps.map((s) => s.state);

  it("a fresh order: accepted, nothing else is marked - no false 'Готовится'", () => {
    const o = buildTrackingOrder({ ...base, orderStatus: "SENT_TO_KITCHEN", statusEvents: [ev("ORDER_CREATED", "2026-10-12T10:00:00Z")] });
    expect(states(o)).toEqual(["completed", "pending", "pending", "pending"]);
    expect(o.statusLabel).toBe("Заказ принят");
    expect(o.itemCount).toBe(3);
    expect(o.steps[0]!.occurredAt).toBe("2026-10-12T10:00:00.000Z");
    expect(o.steps[1]!.occurredAt).toBeNull();
  });
  it("cooking started -> active with the real time", () => {
    const o = buildTrackingOrder({ ...base, orderStatus: "SENT_TO_KITCHEN", statusEvents: [ev("ORDER_CREATED", "2026-10-12T10:00:00Z"), ev("COOKING_STARTED", "2026-10-12T10:05:00Z")] });
    expect(states(o)).toEqual(["completed", "active", "pending", "pending"]);
    expect(o.statusLabel).toBe("Готовится");
    expect(o.steps[1]!.occurredAt).toBe("2026-10-12T10:05:00.000Z");
  });
  it("with the waiter (and a detail while it is being carried)", () => {
    const events = [ev("ORDER_CREATED", "2026-10-12T10:00:00Z"), ev("COOKING_STARTED", "2026-10-12T10:05:00Z"), ev("READY_FOR_DELIVERY", "2026-10-12T10:20:00Z")];
    expect(states(buildTrackingOrder({ ...base, orderStatus: "READY_FOR_DELIVERY", statusEvents: events }))).toEqual(["completed", "completed", "active", "pending"]);
    const out = buildTrackingOrder({ ...base, orderStatus: "OUT_FOR_DELIVERY", statusEvents: events });
    expect(out.steps[2]!.detail).toBe("Официант несёт заказ");
    expect(out.statusLabel).toBe("У официанта");
  });
  it("delivered: everything completed", () => {
    const o = buildTrackingOrder({ ...base, orderStatus: "DELIVERED", deliveredAt: new Date("2026-10-12T10:30:00Z"), statusEvents: [ev("ORDER_CREATED", "2026-10-12T10:00:00Z"), ev("DELIVERED", "2026-10-12T10:30:00Z")] });
    expect(states(o)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(o.statusLabel).toBe("Подан");
    // legacy order: the stages in between are known to have happened, but their time is NOT invented
    expect(o.steps[1]!.occurredAt).toBeNull();
    expect(o.steps[2]!.occurredAt).toBeNull();
  });
  it("cancelled: an explicit terminal state, future stages are not marked as passed", () => {
    const o = buildTrackingOrder({ ...base, orderStatus: "CANCELLED", cancelReason: "нет продукта", statusEvents: [ev("ORDER_CREATED", "2026-10-12T10:00:00Z"), ev("CANCELLED", "2026-10-12T10:02:00Z")] });
    expect(o.statusLabel).toBe("Отменён");
    expect(o.cancelled).toEqual({ occurredAt: "2026-10-12T10:02:00.000Z", reason: "нет продукта" });
    expect(states(o)).toEqual(["completed", "pending", "pending", "pending"]);
  });
});

describe("identity status (FR-05)", () => {
  it("DEMO never waives 21+ unless demo mode is on; PROVIDER always can; expiry flips to EXPIRED", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    const future = new Date("2027-10-12T00:00:00Z");
    const past = new Date("2026-01-01T00:00:00Z");
    expect(evaluateIdentity(null, now)).toMatchObject({ status: "UNVERIFIED", ageVerified: false });
    expect(evaluateIdentity({ status: "VERIFIED", mode: "PROVIDER", verifiedAt: past, expiresAt: future }, now).ageVerified).toBe(true);
    expect(evaluateIdentity({ status: "VERIFIED", mode: "DEMO", verifiedAt: past, expiresAt: future }, now).ageVerified).toBe(env.demoIdentityVerification);
    expect(evaluateIdentity({ status: "VERIFIED", mode: "PROVIDER", verifiedAt: past, expiresAt: past }, now)).toMatchObject({ status: "EXPIRED", ageVerified: false });
    expect(evaluateIdentity({ status: "PENDING", mode: "DEMO", verifiedAt: null, expiresAt: null }, now).ageVerified).toBe(false);
  });
});

describe("receipt helpers", () => {
  it("numbers are DEMO-000001 style and masks hide the address", () => {
    expect(formatReceiptNumber(158n, "DEMO")).toBe("DEMO-000158");
    expect(maskEmail("anna.petrova@gmail.com")).toBe("a***@g***.com");
    expect(maskEmail("a@b.kz")).toBe("*@*.kz");
  });
  it("the e-mail body escapes everything that came from the data", () => {
    const html = renderReceiptHtml({
      receiptNumber: "DEMO-000001", orderId: "1", paidAtLocal: "now", timeZone: "Asia/Almaty",
      merchant: { name: "<script>x</script>", address: "a", taxId: "t", kkmSerial: "s", kkmRegNumber: "r" },
      items: [{ lineNo: 1, name: "<img src=x onerror=alert(1)>", details: ['"><b>'], quantity: 1, unit: "порц.", unitPrice: "1.00", lineTotal: "1.00", nktCode: null, nktLabel: "n" }],
      subtotal: "1.00", bonusDiscount: "0.00", paidTotal: "1.00", paymentMethodLabel: "Наличные", vat: { applicable: false, ratePercent: null, amount: null, label: "v" },
      ofdLabel: "Отсутствует", fiscalSignLabel: "Не присвоен", message: "m",
    } as never);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
