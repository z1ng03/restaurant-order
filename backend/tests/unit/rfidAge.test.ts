import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), password: vi.fn(), active: vi.fn() }));
vi.mock("../../src/db/prisma", () => ({ prisma: { user: { findUnique: mocks.findUnique, update: mocks.update }, ageVerification: { create: mocks.create } } }));
vi.mock("../../src/lib/auth", () => ({ verifyPassword: mocks.password }));
vi.mock("../../src/modules/sessions/sessions.service", () => ({ assertSessionActive: mocks.active }));
vi.mock("../../src/config/env", () => ({ env: { isProduction: false } }));
import { normalizeRfidUid } from "../../src/modules/ageVerification/rfid";
import { enrollWaiterBadge, recordRfidAgeVerification } from "../../src/modules/ageVerification/ageVerification.service";
const uid="AA:BB:CC:DD";
const waiter={userId:7n, name:"Официант", role:"WAITER", isActive:true, passwordHash:"hash"};
beforeEach(() => { vi.resetAllMocks(); mocks.findUnique.mockResolvedValue(waiter); mocks.password.mockResolvedValue(true); mocks.create.mockResolvedValue({verificationId:3n}); });
describe("RFID confirmation", () => {
  it("normalizes valid UID sizes and rejects malformed identifiers", () => {
    expect(normalizeRfidUid(" aa:bb:cc:dd ")).toBe(uid);
    for(const value of ["NONE", "AA:BB", "AA:BB:CC:DD:EE", "GG:BB:CC:DD", "AABBCCDD"]) expect(()=>normalizeRfidUid(value)).toThrow();
  });
  it("records the actual waiter and checks the session", async()=>{
    await recordRfidAgeVerification({sessionId:2n,uid});
    expect(mocks.active).toHaveBeenCalledWith(2n);
    expect(mocks.findUnique).toHaveBeenCalledWith({where:{rfidUid:uid}});
    expect(mocks.create).toHaveBeenCalledWith({data:expect.objectContaining({sessionId:2n,verifiedBy:7n,verified:true})});
  });
  it.each([null,{...waiter,isActive:false},{...waiter,role:"CHEF"}])("rejects unknown, inactive and non-waiter badges",async(user)=>{
    mocks.findUnique.mockResolvedValue(user);
    await expect(recordRfidAgeVerification({sessionId:2n,uid})).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects a closed session",async()=>{
    mocks.active.mockRejectedValue(new Error("Session ended"));
    await expect(recordRfidAgeVerification({sessionId:2n,uid})).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires staff password to enroll and replaces only their badge",async()=>{
    await enrollWaiterBadge({waiterLogin:"staff",waiterPassword:"secret",uid});
    expect(mocks.update).toHaveBeenCalledWith({where:{userId:7n},data:{rfidUid:uid}});
    mocks.update.mockClear(); mocks.password.mockResolvedValue(false);
    await expect(enrollWaiterBadge({waiterLogin:"staff",waiterPassword:"wrong",uid})).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not take another employee's badge",async()=>{
    mocks.update.mockRejectedValue({code:"P2002"});
    await expect(enrollWaiterBadge({waiterLogin:"staff",waiterPassword:"secret",uid})).rejects.toThrow("другому сотруднику");
  });
});
