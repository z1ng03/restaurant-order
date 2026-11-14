import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { hashPassword, signClientToken, verifyPassword } from "../../lib/auth";
import { newUuid } from "../../lib/crypto";
import { AppError, ValidationError } from "../../lib/errors";
import { FailureLockout } from "../../lib/rateLimit";

/**
 * FR-05 - an account system that is completely independent of staff `users` (separate table, separate JWT
 * secret and `typ`, separate routes): a staff token can never open a client route and vice versa.
 *
 * Production notes (the demo scope is e-mail + password):
 *   - e-mail ownership is NOT verified and there is no password-reset flow - both are required before real use;
 *   - login failures are rate-limited / locked out per (email, IP) in memory - use a shared store (Redis) with
 *     several backend instances;
 *   - the bearer token is kept in sessionStorage by the frontend and is bound server-side to the kiosk session it
 *     was issued on, so it dies when the table is released. For a non-shared device an HttpOnly cookie is preferable.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only looks at the first 72 BYTES - longer passwords would be silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов`);
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new ValidationError("Пароль слишком длинный (не более 72 байт)");
  }
}

const loginLockout = new FailureLockout(env.loginMaxFailures, env.loginLockoutMinutes * 60_000);
/** test helper */
export function resetLoginLockout(): void {
  loginLockout.reset();
}

let dummyHash: string | undefined;
/** Compared against when the e-mail is unknown, so "no such account" costs the same time as "wrong password". */
function getDummyHash(): string {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", 10);
  return dummyHash;
}

export interface PublicClient {
  clientUserId: bigint;
  name: string;
  email: string | null;
}

function toPublic(c: { clientUserId: bigint; name: string; email: string | null }): PublicClient {
  return { clientUserId: c.clientUserId, name: c.name, email: c.email };
}

/** Issues a JWT and records it server-side (that row is what logout / password change revoke). */
export async function issueClientSession(clientUserId: bigint, kioskSessionId: bigint | null) {
  const jti = newUuid();
  const { token, expiresAt } = signClientToken({ clientUserId, jti, kioskSessionId });
  await prisma.clientAuthSession.create({ data: { jti, clientUserId, kioskSessionId, expiresAt } });
  return { token, expiresAt };
}

export async function registerClient(input: {
  name: string;
  email: string;
  password: string;
  kioskSessionId: bigint | null;
}) {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new ValidationError("Имя должно содержать от 1 до 100 символов");
  assertValidPassword(input.password);
  const email = normalizeEmail(input.email);

  // Hash first, always: registration of a taken address then costs the same as a fresh one.
  const passwordHash = await hashPassword(input.password);
  try {
    const client = await prisma.clientUser.create({ data: { name, email, passwordHash } });
    const session = await issueClientSession(client.clientUserId, input.kioskSessionId);
    return { client: toPublic(client), ...session };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Does not state WHICH field clashed, nor offer a hint beyond "log in instead".
      throw new AppError(409, "REGISTRATION_FAILED", "Не удалось зарегистрироваться. Если у вас уже есть аккаунт - войдите.");
    }
    throw err;
  }
}

export async function loginClient(input: {
  email: string;
  password: string;
  ip: string;
  kioskSessionId: bigint | null;
}) {
  const email = normalizeEmail(input.email);
  const lockKey = `${email}|${input.ip}`;

  const remainingMs = loginLockout.isLocked(lockKey);
  if (remainingMs > 0) {
    throw new AppError(
      429,
      "LOGIN_LOCKED",
      `Слишком много неудачных попыток входа. Повторите через ${Math.max(1, Math.ceil(remainingMs / 60_000))} мин.`,
    );
  }

  const user = await prisma.clientUser.findUnique({ where: { email } });
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? getDummyHash());
  if (!user || !passwordOk || !user.isActive || user.deletedAt) {
    loginLockout.recordFailure(lockKey);
    // One message for every failure: unknown e-mail, wrong password, deleted/blocked account.
    throw new AppError(401, "INVALID_CREDENTIALS", "Неверный email или пароль");
  }
  loginLockout.recordSuccess(lockKey);

  const session = await issueClientSession(user.clientUserId, input.kioskSessionId);
  return { client: toPublic(user), ...session };
}

export async function logoutClient(jti: string): Promise<void> {
  await prisma.clientAuthSession.updateMany({ where: { jti, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllClientSessions(clientUserId: bigint, tx: Pick<typeof prisma, "clientAuthSession"> = prisma): Promise<void> {
  await tx.clientAuthSession.updateMany({ where: { clientUserId, revokedAt: null }, data: { revokedAt: new Date() } });
}
