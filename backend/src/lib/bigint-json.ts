/**
 * Every primary/foreign key in the schema is BIGSERIAL, which Prisma maps to
 * JS `bigint`. `JSON.stringify` throws on `bigint` by default, so every id
 * would crash `res.json(...)`. The standard fix (and the one Prisma's own
 * docs suggest) is to give `BigInt` a `toJSON`, turning ids into strings on
 * the wire. Import this module once, before any route handles a request —
 * `app.ts` does that.
 *
 * Numeric strings keep 64-bit ids exact in JSON (a plain JS `number` loses
 * precision above 2^53). The frontend should treat all `*_id` fields as
 * opaque strings, not parse them back into numbers.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

export {};
