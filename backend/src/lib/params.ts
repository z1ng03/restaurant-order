import { ValidationError } from "./errors";

/** Parses a route param like `:dishId` into a BigInt, or throws 400. */
export function parseIdParam(value: string | undefined, paramName: string): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw new ValidationError(`${paramName} must be a positive integer id`);
  }
  return BigInt(value);
}
