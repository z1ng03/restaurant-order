import { prisma } from "../../db/prisma";
import { ConflictError, ValidationError } from "../../lib/errors";
import { verifyPassword } from "../../lib/auth";
import { assertSessionActive } from "../sessions/sessions.service";
import { env } from "../../config/env";
import { normalizeRfidUid } from "./rfid";

function assertDemoRfid() {
  if (env.isProduction) throw new ValidationError("UID-брелки доступны только в учебном режиме");
}

export async function enrollWaiterBadge(params: { waiterLogin: string; waiterPassword: string; uid: string }) {
  assertDemoRfid();
  const uid = normalizeRfidUid(params.uid);
  const waiter = await prisma.user.findUnique({ where: { login: params.waiterLogin } });
  if (!waiter?.isActive || !["WAITER", "ADMIN"].includes(waiter.role) ||
      !await verifyPassword(params.waiterPassword, waiter.passwordHash)) {
    throw new ValidationError("Неверный логин или пароль официанта");
  }
  try {
    await prisma.user.update({ where: { userId: waiter.userId }, data: { rfidUid: uid } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ConflictError("Этот брелок уже принадлежит другому сотруднику");
    throw error;
  }
  return { waiterName: waiter.name, uid };
}

export async function recordRfidAgeVerification(params: { sessionId: bigint; uid: string }) {
  assertDemoRfid();
  await assertSessionActive(params.sessionId);
  const waiter = await prisma.user.findUnique({ where: { rfidUid: normalizeRfidUid(params.uid) } });
  if (!waiter?.isActive || !["WAITER", "ADMIN"].includes(waiter.role)) {
    throw new ValidationError("Брелок не привязан к действующему официанту");
  }
  const record = await prisma.ageVerification.create({ data: {
    sessionId: params.sessionId, verified: true, verifiedBy: waiter.userId, verifiedAt: new Date(),
  } });
  return { verificationId: record.verificationId, verified: true, waiterName: waiter.name };
}

/**
 * ТЗ §5: "К клиенту подходит официант и проверяет возраст ... Проверка
 * относится к конкретному клиенту/сессии и должна иметь историю" - the
 * check is scoped to the *session*, not to one order, so one confirmed
 * check covers every 21+ order placed for the rest of that visit.
 *
 * Password confirmation remains available beside the demo RFID staff badge flow.
 */
export async function recordAgeVerification(params: {
  sessionId: bigint;
  waiterLogin: string;
  waiterPassword: string;
  verified: boolean;
}) {
  await assertSessionActive(params.sessionId);

  const waiter = await prisma.user.findUnique({ where: { login: params.waiterLogin } });
  if (!waiter || !waiter.isActive) {
    throw new ValidationError("Staff login not recognized");
  }
  if (waiter.role !== "WAITER" && waiter.role !== "ADMIN") {
    throw new ValidationError("Only a waiter or admin can confirm age verification");
  }
  const passwordOk = await verifyPassword(params.waiterPassword, waiter.passwordHash);
  if (!passwordOk) {
    throw new ValidationError("Incorrect staff password");
  }

  const record = await prisma.ageVerification.create({
    data: {
      sessionId: params.sessionId,
      verified: params.verified,
      verifiedBy: waiter.userId,
      verifiedAt: new Date(),
    },
  });

  return { verificationId: record.verificationId, verified: record.verified, waiterName: waiter.name };
}

/** Has this session ever had a successful age check? (session-scoped, see above) */
export async function sessionHasVerifiedAge(sessionId: bigint): Promise<boolean> {
  const record = await prisma.ageVerification.findFirst({
    where: { sessionId, verified: true },
  });
  return record !== null;
}

/**
 * Best-effort audit link: attach the session's most recent successful
 * verification to a freshly created order, if it isn't already linked to
 * an earlier one. Never blocks order creation if this can't find a row -
 * the gate check (`sessionHasVerifiedAge`) already ran before checkout.
 */
export async function linkAgeVerificationToOrder(sessionId: bigint, orderId: bigint) {
  const unlinked = await prisma.ageVerification.findFirst({
    where: { sessionId, verified: true, orderId: null },
    orderBy: { verifiedAt: "desc" },
  });
  if (unlinked) {
    await prisma.ageVerification.update({ where: { verificationId: unlinked.verificationId }, data: { orderId } });
  }
}

export function assertAgeVerified(hasVerification: boolean) {
  if (!hasVerification) {
    throw new ConflictError("Age verification is required before this order can be placed", {
      requiresAgeVerification: true,
    });
  }
}
