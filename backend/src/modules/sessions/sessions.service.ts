import { prisma } from "../../db/prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";

/**
 * ТЗ §1: "Монитор №7 -> Столик №7. Это проверка на то что столик свободен /
 * занят." Opening a session is idempotent per table: if the table is
 * already OCCUPIED with a live session (e.g. the kiosk tab was refreshed),
 * that same session is returned rather than creating a second one.
 */
export async function openSessionForMonitor(monitorNumber: number) {
  return prisma.$transaction(async (tx) => {
    const table = await tx.restaurantTable.findUnique({ where: { monitorNumber } });
    if (!table) {
      throw new NotFoundError(`Table for monitor #${monitorNumber}`);
    }

    if (table.status === "OCCUPIED") {
      const existing = await tx.restaurantSession.findFirst({
        where: { tableId: table.tableId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        return { session: existing, table, reused: true as const };
      }
      // Table marked OCCUPIED but no ACTIVE session — inconsistent state
      // (e.g. a previous crash). Self-heal by starting a fresh session
      // rather than leaving the monitor stuck.
    }

    const session = await tx.restaurantSession.create({
      data: { tableId: table.tableId, status: "ACTIVE" },
    });
    const updatedTable = await tx.restaurantTable.update({
      where: { tableId: table.tableId },
      data: { status: "OCCUPIED" },
    });
    return { session, table: updatedTable, reused: false as const };
  });
}

export async function getSession(sessionId: bigint) {
  const session = await prisma.restaurantSession.findUnique({
    where: { sessionId },
    include: { table: true },
  });
  if (!session) {
    throw new NotFoundError("Session");
  }
  return session;
}

/**
 * Guards used by cart/checkout: the session must still be the one actively
 * owning its table (ТЗ §5 "столик всё ещё закреплён за этой сессией").
 */
export async function assertSessionActive(sessionId: bigint) {
  const session = await getSession(sessionId);
  if (session.status !== "ACTIVE") {
    throw new ConflictError("This session is no longer active — please start a new order from the table screen");
  }
  if (session.table.status !== "OCCUPIED") {
    throw new ValidationError("The table for this session is not marked occupied");
  }
  return session;
}

/** Order history for a session — lets the client monitor show "order #152 is being prepared" after checkout. */
export async function getSessionOrders(sessionId: bigint) {
  await getSession(sessionId); // 404s if the session doesn't exist
  return prisma.order.findMany({
    where: { sessionId },
    include: {
      items: { include: { dish: true, options: { include: { option: true } } } },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
}
