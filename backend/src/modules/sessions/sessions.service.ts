import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { randomToken, safeEqual, sha256Hex } from "../../lib/crypto";
import { AppError, NotFoundError } from "../../lib/errors";
import type { Tx } from "../../lib/prismaTx";
import { getOrderTrackingMap } from "../orderTracking/orderTracking.service";

/** Session fields that are safe to send to a browser (the secret hash never leaves the server). */
function publicSession<T extends { kioskTokenHash?: unknown; kioskTokenIssuedAt?: unknown }>(session: T) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { kioskTokenHash, kioskTokenIssuedAt, ...rest } = session;
  return rest;
}

export const sessionPublicSelect = {
  sessionId: true,
  tableId: true,
  status: true,
  createdAt: true,
  completedAt: true,
} as const;

export interface OpenSessionOptions {
  /** X-Device-Secret - the pre-registered secret of this physical kiosk */
  deviceSecret?: string | undefined;
  /** X-Kiosk-Session-Token the browser already holds (survives page navigation) */
  presentedToken?: string | undefined;
}

/**
 * ТЗ §1: "Монитор №7 -> Столик №7. Это проверка на то что столик свободен /
 * занят." Opening a session is idempotent per table: if the table is
 * already OCCUPIED with a live session (e.g. the kiosk tab was refreshed),
 * that same session is returned rather than creating a second one.
 *
 * TZ v2 §5.2: the response carries `kioskSessionToken` - an opaque secret shown ONCE (only its
 * SHA-256 is stored). Every cart/checkout/tracker/receipt call must present it. If a browser
 * re-opens the session while already holding the valid token it keeps it (no rotation);
 * otherwise (new tab, lost storage) the secret is ROTATED, which cuts off any stale copy.
 *
 * In production the device must also present the pre-registered `X-Device-Secret`; without it
 * anybody who can reach the API could take over a table session.
 */
export async function openSessionForMonitor(monitorNumber: number, opts: OpenSessionOptions = {}) {
  const expectedDeviceSecret = env.kioskDeviceSecrets[String(monitorNumber)];
  if (env.isProduction && !expectedDeviceSecret) {
    throw new AppError(403, "DEVICE_NOT_REGISTERED", "Для этого терминала не задан секрет устройства.");
  }
  if (expectedDeviceSecret && !(opts.deviceSecret && safeEqual(opts.deviceSecret, expectedDeviceSecret))) {
    throw new AppError(403, "DEVICE_NOT_AUTHORIZED", "Терминал не авторизован для открытия сессии.");
  }

  return prisma.$transaction(async (tx) => {
    const table = await tx.restaurantTable.findUnique({ where: { monitorNumber } });
    if (!table) {
      throw new NotFoundError(`Table for monitor #${monitorNumber}`);
    }
    // Serialise concurrent opens for the same table (double page load, two tabs).
    await tx.$queryRaw(Prisma.sql`SELECT "table_id" FROM "tables" WHERE "table_id" = ${table.tableId} FOR UPDATE`);
    const lockedTable = await tx.restaurantTable.findUniqueOrThrow({ where: { tableId: table.tableId } });

    if (lockedTable.status === "OCCUPIED") {
      const existing = await tx.restaurantSession.findFirst({
        where: { tableId: lockedTable.tableId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        const holdsValidToken =
          !!opts.presentedToken &&
          !!existing.kioskTokenHash &&
          safeEqual(sha256Hex(opts.presentedToken), existing.kioskTokenHash);
        if (holdsValidToken) {
          return { session: publicSession(existing), table: lockedTable, reused: true as const };
        }
        const kioskSessionToken = randomToken();
        const rotated = await tx.restaurantSession.update({
          where: { sessionId: existing.sessionId },
          data: { kioskTokenHash: sha256Hex(kioskSessionToken), kioskTokenIssuedAt: new Date() },
        });
        return { session: publicSession(rotated), table: lockedTable, reused: true as const, kioskSessionToken };
      }
      // Table marked OCCUPIED but no ACTIVE session - inconsistent state
      // (e.g. a previous crash). Self-heal by starting a fresh session
      // rather than leaving the monitor stuck.
    }

    const kioskSessionToken = randomToken();
    const session = await tx.restaurantSession.create({
      data: {
        tableId: lockedTable.tableId,
        status: "ACTIVE",
        kioskTokenHash: sha256Hex(kioskSessionToken),
        kioskTokenIssuedAt: new Date(),
      },
    });
    const updatedTable = await tx.restaurantTable.update({
      where: { tableId: lockedTable.tableId },
      data: { status: "OCCUPIED" },
    });
    return { session: publicSession(session), table: updatedTable, reused: false as const, kioskSessionToken };
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
  return publicSession(session);
}

/**
 * Guards used by cart/checkout: the session must still be the one actively
 * owning its table (ТЗ §5 "столик всё ещё закреплён за этой сессией").
 */
export async function assertSessionActive(sessionId: bigint, db: Tx = prisma) {
  const session = await db.restaurantSession.findUnique({ where: { sessionId }, include: { table: true } });
  if (!session) {
    throw new NotFoundError("Session");
  }
  if (session.status !== "ACTIVE") {
    throw new AppError(409, "SESSION_ENDED", "Сессия стола завершена. Начните новый заказ с экрана выбора стола.");
  }
  if (session.table.status !== "OCCUPIED") {
    throw new AppError(400, "TABLE_NOT_OCCUPIED", "Стол этой сессии не отмечен как занятый");
  }
  return publicSession(session);
}

/** Order history for a session - lets the client monitor show "order #152 is being prepared" after checkout. */
export async function getSessionOrders(sessionId: bigint) {
  await getSession(sessionId); // 404s if the session doesn't exist
  const orders = await prisma.order.findMany({
    where: { sessionId },
    include: {
      items: { include: { dish: true, options: { include: { option: true } } } },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
  const tracking = await getOrderTrackingMap(orders.map((o) => o.orderId));
  // The owner's account id is not the kiosk's business.
  return orders.map(({ clientUserId, ...order }) => ({
    ...order,
    hasClientAccount: clientUserId !== null,
    tracking: tracking.get(order.orderId.toString()) ?? null,
  }));
}

/**
 * Shared by waiter delivery (ТЗ §14) and admin order cancellation: once an
 * order stops being "active" (delivered, or now cancelled - see
 * types/status.ts), check whether it was the session's last one. If so the
 * visit is over - complete the session and free the table, "иначе система
 * будет считать столик занятым бесконечно". `excludeOrderId` is the order
 * that just changed state, so it's not counted against itself.
 *
 * TZ v2: ending the session also revokes every client login made on this kiosk session, so the
 * next guest at the monitor can never act as (or see the data of) the previous one.
 */
export async function closeSessionIfNoActiveOrders(tx: Tx, sessionId: bigint, tableId: bigint, excludeOrderId: bigint) {
  const otherActiveOrders = await tx.order.count({
    where: { sessionId, orderId: { not: excludeOrderId }, orderStatus: { notIn: ["DELIVERED", "CANCELLED"] } },
  });
  if (otherActiveOrders === 0) {
    const now = new Date();
    await tx.restaurantSession.update({ where: { sessionId }, data: { status: "COMPLETED", completedAt: now } });
    await tx.restaurantTable.update({ where: { tableId }, data: { status: "FREE" } });
    await tx.clientAuthSession.updateMany({
      where: { kioskSessionId: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
