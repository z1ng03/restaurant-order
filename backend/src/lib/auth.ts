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
  return jwt.verify(token, env.jwtSecret) as StaffTokenPayload;
}
