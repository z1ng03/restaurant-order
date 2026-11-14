import { Prisma } from "@prisma/client";
import { AppError, ValidationError } from "./errors";
import type { Tx } from "./prismaTx";
import type { PrismaClient } from "@prisma/client";

export const IDEMPOTENCY_SCOPE_CHECKOUT = "checkout.confirm";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

/** Validates the `Idempotency-Key` header (8–100 chars; a UUID is recommended). */
export function parseIdempotencyKey(header: string | string[] | undefined, required: boolean): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === "") {
    if (required) {
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Передайте заголовок Idempotency-Key (UUID)");
    }
    return null;
  }
  if (!KEY_RE.test(value)) {
    throw new ValidationError("Idempotency-Key должен быть строкой 8–100 символов (латиница, цифры, . _ : -)");
  }
  return value;
}

export type IdempotencyStart = { replay: false } | { replay: true; responseRef: string };

/**
 * Must be the FIRST statement of the transaction that performs the operation.
 *
 * The unique index (key, scope, owner_id) does the serialisation: a concurrent
 * duplicate blocks on the INSERT until the first transaction commits (-> replay)
 * or rolls back (-> it becomes the executor). Because the row is written in the
 * same transaction as the order, "key stored" and "order created" can never
 * disagree, and a request that failed on a business rule leaves no key behind
 * (so it can legitimately be retried after the cart is fixed).
 */
export async function beginIdempotentRequest(
  tx: Tx,
  args: { key: string; scope: string; ownerId: string; requestHash: string },
): Promise<IdempotencyStart> {
  const inserted = await tx.$queryRaw<{ id: bigint }[]>(
    Prisma.sql`INSERT INTO "idempotency_requests" ("key","scope","owner_id","request_hash")
               VALUES (${args.key}, ${args.scope}, ${args.ownerId}, ${args.requestHash})
               ON CONFLICT ("key","scope","owner_id") DO NOTHING
               RETURNING "id"`,
  );
  if (inserted.length > 0) return { replay: false };

  const existing = await tx.idempotencyRequest.findUnique({
    where: { key_scope_ownerId: { key: args.key, scope: args.scope, ownerId: args.ownerId } },
  });
  if (!existing) {
    // Extremely unlikely (the row vanished between the two statements): let the caller retry.
    throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "Запрос уже обрабатывается, повторите через секунду");
  }
  if (existing.requestHash !== args.requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Этот Idempotency-Key уже использован для другого запроса. Сформируйте новый ключ.",
    );
  }
  if (!existing.responseRef) {
    throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "Запрос уже обрабатывается, повторите через секунду");
  }
  return { replay: true, responseRef: existing.responseRef };
}

export async function completeIdempotentRequest(
  tx: Tx,
  args: { key: string; scope: string; ownerId: string },
  responseRef: string,
): Promise<void> {
  await tx.idempotencyRequest.update({
    where: { key_scope_ownerId: { key: args.key, scope: args.scope, ownerId: args.ownerId } },
    data: { responseRef },
  });
}

/** Housekeeping: keys older than the TTL can never be replayed by a sane client. */
export async function purgeExpiredIdempotencyKeys(db: PrismaClient, olderThanHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
  const res = await db.idempotencyRequest.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
