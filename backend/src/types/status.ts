/**
 * Every status column in the schema is a plain VARCHAR — the ERD documents
 * allowed values in a comment rather than a native Postgres enum, and this
 * file keeps the same approach on the TypeScript side: union types here,
 * checked at the API boundary by the zod schemas in each module, rather
 * than a DB-level CHECK constraint.
 */

export const TABLE_STATUSES = ["FREE", "OCCUPIED"] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const SESSION_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const CART_STATUSES = ["ACTIVE", "CONVERTED"] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const ORDER_STATUSES = [
  "CREATED",
  "SENT_TO_KITCHEN",
  "READY_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ["WAITING", "PREPARING", "READY", "HANDED_TO_WAITER", "DELIVERED"] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

/** Order.payment_status — separate from order_status by design (see ТЗ §6). */
export const ORDER_PAYMENT_STATUSES = ["WAITING_FOR_PAYMENT", "WAITING_FOR_CASH", "PAID"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["KASPI_QR", "CASH"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["WAITING_FOR_CASH", "PAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const INVENTORY_RESERVATION_STATUSES = ["RESERVED", "CONSUMED", "RELEASED"] as const;
export type InventoryReservationStatus = (typeof INVENTORY_RESERVATION_STATUSES)[number];

export const STAFF_ROLES = ["ADMIN", "WAITER", "CHEF"] as const;
export type StaffRoleValue = (typeof STAFF_ROLES)[number];

/**
 * Order item lifecycle, chef- and waiter-driven:
 *   WAITING -> PREPARING -> READY -> HANDED_TO_WAITER -> DELIVERED
 * The chef moves an item through the first four; the last step is applied in
 * bulk when the waiter marks the whole order DELIVERED (ТЗ §14).
 */
const ORDER_ITEM_TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  WAITING: ["PREPARING"],
  PREPARING: ["READY"],
  READY: ["HANDED_TO_WAITER"],
  HANDED_TO_WAITER: ["DELIVERED"],
  DELIVERED: [],
};

export function canTransitionOrderItem(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return ORDER_ITEM_TRANSITIONS[from].includes(to);
}

/**
 * Order lifecycle. CREATED and SENT_TO_KITCHEN both happen inside the same
 * checkout transaction (ТЗ pipeline steps 7-10 have no user action between
 * them), so in practice an order is persisted directly at SENT_TO_KITCHEN;
 * CREATED is kept as a named state for completeness / future use (e.g. if
 * order confirmation and kitchen dispatch are ever split into two calls).
 */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["SENT_TO_KITCHEN"],
  SENT_TO_KITCHEN: ["READY_FOR_DELIVERY"],
  READY_FOR_DELIVERY: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isAgeRestrictedRequired(is21Plus: boolean): boolean {
  return is21Plus === true;
}
