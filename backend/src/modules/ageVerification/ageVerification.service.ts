import { prisma } from "../../db/prisma";
import { ConflictError, ValidationError } from "../../lib/errors";
import { verifyPassword } from "../../lib/auth";
import { assertSessionActive } from "../sessions/sessions.service";

/**
 * ТЗ §5: "К клиенту подходит официант и проверяет возраст ... Проверка
 * относится к конкретному клиенту/сессии и должна иметь историю" — the
 * check is scoped to the *session*, not to one order, so one confirmed
 * check covers every 21+ order placed for the rest of that visit.
 *
 * The ТЗ doesn't specify exactly how the waiter's identity reaches the
 * system at this step (unlike payment, which explicitly uses the
 * card-tap/Arduino flow). The simplest faithful reading — a real staff
 * member's login/password, entered on the table's monitor when they walk
 * over — is what's implemented here: it satisfies "verified_by = an actual
 * authenticated waiter" without inventing hardware the ТЗ never mentions.
 * If a dedicated waiter device is added later, this is the one place to
 * change (swap the inline credential check for the same JWT auth the
 * kitchen/waiter monitors already use).
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
 * an earlier one. Never blocks order creation if this can't find a row —
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
