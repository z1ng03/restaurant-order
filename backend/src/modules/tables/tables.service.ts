import { prisma } from "../../db/prisma";
import { NotFoundError } from "../../lib/errors";

export function listTables() {
  return prisma.restaurantTable.findMany({ orderBy: { tableNumber: "asc" } });
}

export async function getTableByMonitorNumber(monitorNumber: number) {
  const table = await prisma.restaurantTable.findUnique({ where: { monitorNumber } });
  if (!table) {
    throw new NotFoundError(`Table for monitor #${monitorNumber}`);
  }
  return table;
}
