import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

const SALT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Allowed values match users.role in the schema. */
export type StaffRole = "ADMIN" | "WAITER" | "CHEF";

export interface StaffTokenPayload {
  userId: string;
  login: string;
  name: string;
  role: StaffRole;
}

export function signStaffToken(payload: StaffTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

export function verifyStaffToken(token: string): StaffTokenPayload {
  const payload = jwt.verify(token, env.jwtSecret) as StaffTokenPayload & { typ?: string };
  // Defence in depth: the secrets already differ, but a client token must never pass as staff.
  if (payload.typ === "client") throw new Error("not a staff token");
  return payload;
}

// ---------------------------------------------------------------------------
// Client (guest account) tokens - a different secret and a `typ: "client"`
// claim, so a staff JWT can never authenticate a client route and vice versa.
// ---------------------------------------------------------------------------

export interface ClientTokenPayload {
  typ: "client";
  /** client_user_id */
  sub: string;
  /** client_auth_sessions.jti - what makes logout / password change real revocation */
  jti: string;
  /** restaurant session id this login was made on (shared-kiosk binding), if any */
  ksid?: string;
}

export function signClientToken(input: {
  clientUserId: bigint;
  jti: string;
  kioskSessionId?: bigint | null;
}): { token: string; expiresAt: Date } {
  const payload: ClientTokenPayload = {
    typ: "client",
    sub: input.clientUserId.toString(),
    jti: input.jti,
    ...(input.kioskSessionId ? { ksid: input.kioskSessionId.toString() } : {}),
  };
  const token = jwt.sign(payload, env.clientJwtSecret, {
    expiresIn: env.clientJwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(decoded.exp * 1000) };
}

export function verifyClientToken(token: string): ClientTokenPayload {
  const payload = jwt.verify(token, env.clientJwtSecret) as ClientTokenPayload;
  if (payload.typ !== "client" || !payload.sub || !payload.jti) throw new Error("not a client token");
  return payload;
}
