import { Prisma } from "@prisma/client";
import { AppError, ValidationError } from "./errors";

/**
 * All quantities and money go through Decimal - never through JS floats - so
 * 0.1 + 0.2 style drift can never leak into stock, reservations or receipts.
 */
export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export const ZERO: Decimal = new Prisma.Decimal(0);

export function dec(value: Prisma.Decimal.Value): Decimal {
  return new Prisma.Decimal(value);
}

/**
 * Parses a quantity coming from JSON (number or numeric string) into a Decimal
 * with at most `maxDecimals` fractional digits. Float noise from the browser
 * (0.07 * 3 = 0.21000000000000002) is stripped; genuinely finer values are rejected.
 */
export function parseDecimalInput(value: unknown, field: string, maxDecimals = 3): Decimal {
  let d: Decimal;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field}: число должно быть конечным`);
    d = new Prisma.Decimal(value.toFixed(9));
  } else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    d = new Prisma.Decimal(value.trim());
  } else {
    throw new ValidationError(`${field}: ожидается число`);
  }
  if (d.decimalPlaces() > maxDecimals) {
    throw new ValidationError(`${field}: не более ${maxDecimals} знаков после запятой`);
  }
  return d;
}

/** "3200.00" - money is always two fixed decimals on the wire and on receipts. */
export function money(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed(2);
}

/** "0.05" - quantity without trailing zeros and without exponent notation. */
export function qtyStr(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toDecimalPlaces(3).toFixed();
}

export function sumDecimals(values: Iterable<Decimal>): Decimal {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
}

/** Whole-number floor (bonuses are whole KZT, rounded DOWN so the house never over-credits). */
export function floorToInt(value: Prisma.Decimal.Value): number {
  return new Prisma.Decimal(value).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toNumber();
}

/** Used when a unit string coming from outside is not understood. */
export function unitMismatch(message: string): AppError {
  return new AppError(400, "UNIT_MISMATCH", message);
}
