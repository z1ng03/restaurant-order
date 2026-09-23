import { prisma } from "../../db/prisma";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { hashPassword } from "../../lib/auth";
import type { StaffRoleValue } from "../../types/status";

const userListSelect = {
  userId: true,
  name: true,
  login: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

/** Never returns passwordHash — this is the one place staff accounts are listed for management. */
export function listUsers() {
  return prisma.user.findMany({ orderBy: { name: "asc" }, select: userListSelect });
}

export async function createUser(input: { name: string; login: string; password: string; role: StaffRoleValue }) {
  const existing = await prisma.user.findUnique({ where: { login: input.login } });
  if (existing) {
    throw new ValidationError("That login is already taken");
  }
  const passwordHash = await hashPassword(input.password);
  return prisma.user.create({
    data: { name: input.name, login: input.login, passwordHash, role: input.role },
    select: userListSelect,
  });
}

export interface UpdateUserInput {
  name?: string;
  role?: StaffRoleValue;
  isActive?: boolean;
  password?: string; // set to issue a new password
}

/**
 * No hard delete: users.user_id is referenced by orders.waiter_id,
 * payments.paid_by and age_verifications.verified_by (ON DELETE RESTRICT
 * on the first, SET NULL / required on the others) — deleting a staff
 * member with any history would either fail or erase who did what.
 * `isActive = false` is how a departed employee is handled; their login
 * stops working (auth.service.ts checks isActive) but past orders/payments
 * they touched still show their name.
 */
export async function updateUser(userId: bigint, input: UpdateUserInput) {
  const user = await prisma.user.findUnique({ where: { userId } });
  if (!user) throw new NotFoundError("Staff member");

  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  return prisma.user.update({
    where: { userId },
    data: { name: input.name, role: input.role, isActive: input.isActive, passwordHash },
    select: userListSelect,
  });
}
