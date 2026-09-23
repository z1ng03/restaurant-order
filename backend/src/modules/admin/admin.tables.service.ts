import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { closeSessionIfNoActiveOrders } from "../sessions/sessions.service";
import type { TableStatus } from "../../types/status";

const tableWithSessionInclude = {
  sessions: {
    where: { status: "ACTIVE" as const },
    take: 1,
    orderBy: { createdAt: "desc" as const },
  },
};

export async function listTables() {
  const tables = await prisma.restaurantTable.findMany({
    orderBy: { tableNumber: "asc" },
    include: tableWithSessionInclude,
  });
  return tables.map((t) => ({
    tableId: t.tableId,
    tableNumber: t.tableNumber,
    monitorNumber: t.monitorNumber,
    status: t.status,
    createdAt: t.createdAt,
    activeSession: t.sessions[0] ?? null,
  }));
}

export async function createTable(input: { tableNumber: number; monitorNumber: number }) {
  return prisma.restaurantTable.create({
    data: { tableNumber: input.tableNumber, monitorNumber: input.monitorNumber, status: "FREE" },
  });
}

export async function updateTable(tableId: bigint, input: { tableNumber?: number; monitorNumber?: number }) {
  const table = await prisma.restaurantTable.findUnique({ where: { tableId } });
  if (!table) throw new NotFoundError("Table");
  return prisma.restaurantTable.update({
    where: { tableId },
    data: { tableNumber: input.tableNumber, monitorNumber: input.monitorNumber },
  });
}

/**
 * Manual admin override — mainly for unsticking a table that's stuck
 * OCCUPIED (crashed kiosk, staff seated someone without opening a session,
 * etc.). Forcing a table back to FREE while it has a live session cancels
 * that session too, so the two never drift out of sync; forcing it to
 * OCCUPIED with no session is allowed as a plain "block this table" flag
 * (e.g. reserved, or physically out of service) — it doesn't fabricate a
 * session for it.
 */
export async function setTableStatus(tableId: bigint, status: TableStatus) {
  const table = await prisma.restaurantTable.findUnique({
    where: { tableId },
    include: { sessions: { where: { status: "ACTIVE" }, take: 1 } },
  });
  if (!table) throw new NotFoundError("Table");

  if (status === "FREE" && table.sessions[0]) {
    const session = table.sessions[0];
    await prisma.$transaction(async (tx) => {
      await tx.restaurantSession.update({
        where: { sessionId: session.sessionId },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
      await tx.restaurantTable.update({ where: { tableId }, data: { status: "FREE" } });
    });
    return prisma.restaurantTable.findUniqueOrThrow({ where: { tableId } });
  }

  return prisma.restaurantTable.update({ where: { tableId }, data: { status } });
}

export async function deleteTable(tableId: bigint) {
  const table = await prisma.restaurantTable.findUnique({
    where: { tableId },
    include: { sessions: { where: { status: "ACTIVE" }, take: 1 } },
  });
  if (!table) throw new NotFoundError("Table");
  if (table.sessions[0]) {
    throw new ConflictError("Can't delete a table with an active session — free it first");
  }
  try {
    await prisma.restaurantTable.delete({ where: { tableId } });
  } catch {
    // FK RESTRICT from restaurant_sessions/orders referencing this table's history.
    throw new ValidationError("This table has order history and can't be deleted — it can still be edited");
  }
}
