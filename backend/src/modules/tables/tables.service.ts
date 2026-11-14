import { prisma } from "../../db/prisma";
import { NotFoundError } from "../../lib/errors";

export async function listTables() {
  // The dev monitor picker must reflect actual sessions, not a stale flag
  // left behind by a crash or an already-completed visit.
  const tables = await prisma.restaurantTable.findMany({
    orderBy: { tableNumber: "asc" },
    include: { sessions: { orderBy: { createdAt: "desc" }, select: { sessionId: true, status: true }, take: 1 } },
  });
  return tables.map(({ sessions, ...table }) => ({
    ...table,
    // Completed/cancelled visits must not look occupied. For never-used
    // tables, keep the admin's explicit OCCUPIED/manual-block flag.
    status: sessions[0]?.status === "ACTIVE" ? "OCCUPIED" :
      sessions[0] ? "FREE" : table.status,
  }));
}

export async function getTableByMonitorNumber(monitorNumber: number) {
  const table = await prisma.restaurantTable.findUnique({ where: { monitorNumber } });
  if (!table) {
    throw new NotFoundError(`Table for monitor #${monitorNumber}`);
  }
  return table;
}
