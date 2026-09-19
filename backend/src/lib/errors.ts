/**
 * Base class for errors that should be turned into a specific HTTP response
 * rather than a generic 500. Route handlers throw these; the error
 * middleware in `middleware/error.middleware.ts` catches and formats them.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, "NOT_FOUND", `${what} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(403, "FORBIDDEN", message);
  }
}

/**
 * Thrown by checkout validation when the cart fails one or more of the
 * pre-order checks from the ТЗ (empty cart, unavailable dish, price drift,
 * stale table/session, missing age verification). `issues` is a machine
 * readable list the frontend can render without parsing the message text.
 */
export class CheckoutValidationError extends AppError {
  constructor(issues: CheckoutIssue[]) {
    super(409, "CHECKOUT_VALIDATION_FAILED", "The cart is not ready to be ordered", { issues });
  }
}

export interface CheckoutIssue {
  type:
    | "EMPTY_CART"
    | "DISH_UNAVAILABLE"
    | "DISH_INACTIVE"
    | "INSUFFICIENT_INGREDIENTS"
    | "SESSION_NOT_ACTIVE"
    | "AGE_VERIFICATION_REQUIRED";
  cartItemId?: string;
  dishName?: string;
  message: string;
}
