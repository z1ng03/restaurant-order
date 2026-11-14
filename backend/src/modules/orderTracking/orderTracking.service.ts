import { prisma } from "../../db/prisma";
import type { Tx } from "../../lib/prismaTx";

/**
 * FR-09 - client-side order status tracker.
 *
 * Four UI stages, each derived from REAL recorded facts (order_status_events + the order row):
 *   ACCEPTED     <- order created (SENT_TO_KITCHEN)                  completed with a tick
 *   PREPARING    <- the FIRST order item entered PREPARING            active, then completed
 *   WITH_WAITER  <- all items handed over -> READY_FOR_DELIVERY       active (OUT_FOR_DELIVERY adds a detail)
 *   DELIVERED    <- the waiter delivered the order                    completed
 *
 * Rules that matter:
 *  - nothing is marked "Готовится" until an item really started cooking;
 *  - a stage that must have happened (the order is further along) but has no event - data from
 *    before this feature - is "completed" with `occurredAt: null`: we never invent a time;
 *  - CANCELLED is an explicit terminal state with its reason; future stages are NOT marked passed.
 */

export const TRACKING_STEP_KEYS = ["ACCEPTED", "PREPARING", "WITH_WAITER", "DELIVERED"] as const;
export type TrackingStepKey = (typeof TRACKING_STEP_KEYS)[number];
export type TrackingStepState = "completed" | "active" | "pending";

const STEP_LABELS: Record<TrackingStepKey, string> = {
  ACCEPTED: "Заказ принят",
  PREPARING: "Готовится",
  WITH_WAITER: "У официанта",
  DELIVERED: "Подан",
};

export interface TrackingStep {
  key: TrackingStepKey;
  label: string;
  state: TrackingStepState;
  occurredAt: string | null;
  detail?: string;
}

export interface TrackingOrder {
  orderId: bigint;
  itemCount: number;
  statusLabel: string;
  orderStatus: string;
  paymentStatus: string;
  createdAt: string;
  deliveredAt: string | null;
  receiptAvailable: boolean;
  cancelled: { occurredAt: string | null; reason: string | null } | null;
  steps: TrackingStep[];
}

interface TrackedOrderRow {
  orderId: bigint;
  orderStatus: string;
  paymentStatus: string;
  createdAt: Date;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  items: { quantity: number }[];
  statusEvents: { eventType: string; occurredAt: Date }[];
  receipt: { receiptId: bigint } | null;
}

/** Pure: derives the four steps from the order row + its events. Exported for unit tests. */
export function buildTrackingOrder(order: TrackedOrderRow): TrackingOrder {
  const events = new Map(order.statusEvents.map((e) => [e.eventType, e.occurredAt]));
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  const status = order.orderStatus;
  const cancelled = status === "CANCELLED";

  // How far did the order get (index into TRACKING_STEP_KEYS)?
  let reached = 0;
  if (events.has("COOKING_STARTED")) reached = 1;
  if (events.has("READY_FOR_DELIVERY") || status === "READY_FOR_DELIVERY" || status === "OUT_FOR_DELIVERY") reached = 2;
  if (status === "DELIVERED" || events.has("DELIVERED")) reached = 3;
  if (cancelled && !events.has("READY_FOR_DELIVERY")) reached = Math.min(reached, events.has("COOKING_STARTED") ? 1 : 0);

  const times: Record<TrackingStepKey, string | null> = {
    ACCEPTED: iso(events.get("ORDER_CREATED") ?? order.createdAt),
    PREPARING: iso(events.get("COOKING_STARTED")),
    WITH_WAITER: iso(events.get("READY_FOR_DELIVERY")),
    DELIVERED: iso(events.get("DELIVERED") ?? order.deliveredAt),
  };

  const steps: TrackingStep[] = TRACKING_STEP_KEYS.map((key, index) => {
    let state: TrackingStepState;
    if (index > reached) state = "pending";
    else if (index < reached) state = "completed";
    else if (cancelled) state = "completed"; // reached before the cancellation, then stopped
    else state = key === "ACCEPTED" || key === "DELIVERED" ? "completed" : "active";

    const step: TrackingStep = { key, label: STEP_LABELS[key], state, occurredAt: times[key] };
    if (key === "WITH_WAITER" && status === "OUT_FOR_DELIVERY") step.detail = "Официант несёт заказ";
    return step;
  });

  const currentKey = TRACKING_STEP_KEYS[reached] ?? "ACCEPTED";
  return {
    orderId: order.orderId,
    itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
    statusLabel: cancelled ? "Отменён" : STEP_LABELS[currentKey],
    orderStatus: status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt.toISOString(),
    deliveredAt: iso(order.deliveredAt),
    // Paid legacy orders may create their receipt lazily on first view.
    receiptAvailable: order.receipt !== null || order.paymentStatus === "PAID",
    cancelled: cancelled
      ? { occurredAt: iso(events.get("CANCELLED") ?? order.cancelledAt), reason: order.cancelReason }
      : null,
    steps,
  };
}

const trackingSelect = {
  orderId: true,
  orderStatus: true,
  paymentStatus: true,
  createdAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancelReason: true,
  items: { select: { quantity: true } },
  statusEvents: { select: { eventType: true, occurredAt: true } },
  receipt: { select: { receiptId: true } },
} as const;

/** All orders of one table session, newest first. Contains no account, receipt content or payment details. */
export async function getSessionTracking(sessionId: bigint, db: Tx = prisma): Promise<TrackingOrder[]> {
  const orders = await db.order.findMany({
    where: { sessionId },
    select: trackingSelect,
    orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
    take: 20,
  });
  return orders.map(buildTrackingOrder);
}

export async function getOrderTrackingMap(orderIds: bigint[], db: Tx = prisma): Promise<Map<string, TrackingOrder>> {
  if (orderIds.length === 0) return new Map();
  const orders = await db.order.findMany({ where: { orderId: { in: orderIds } }, select: trackingSelect });
  return new Map(orders.map((o) => [o.orderId.toString(), buildTrackingOrder(o)]));
}

/**
 * Records one business event for an order. Part of the SAME transaction as the state change it
 * describes (TZ §FR-09 "События"); (order_id, event_type) is unique, so a retry or a second
 * item entering PREPARING never writes a duplicate. Returns true when a row was inserted.
 */
export async function recordOrderEvent(
  tx: Tx,
  args: {
    orderId: bigint;
    eventType: string;
    status: string;
    actorType: "SYSTEM" | "GUEST" | "CLIENT" | "STAFF";
    actorId?: bigint | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  const result = await tx.orderStatusEvent.createMany({
    data: [
      {
        orderId: args.orderId,
        eventType: args.eventType,
        status: args.status,
        actorType: args.actorType,
        actorId: args.actorId ?? null,
        occurredAt: args.occurredAt ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return result.count > 0;
}
