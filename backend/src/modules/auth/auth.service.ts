import { prisma } from "../../db/prisma";
import { UnauthorizedError } from "../../lib/errors";
import { signStaffToken, verifyPassword, type StaffRole } from "../../lib/auth";

export async function login(loginValue: string, password: string) {
  const user = await prisma.user.findUnique({ where: { login: loginValue } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError("Incorrect login or password");
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new UnauthorizedError("Incorrect login or password");
  }

  const token = signStaffToken({
    userId: user.userId.toString(),
    login: user.login,
    name: user.name,
    role: user.role as StaffRole,
  });

  return { token, user: { userId: user.userId, name: user.name, login: user.login, role: user.role } };
}
