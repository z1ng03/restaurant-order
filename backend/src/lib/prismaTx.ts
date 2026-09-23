import type { PrismaClient } from "@prisma/client";

/** The client type Prisma passes into a `$transaction(async (tx) => ...)` callback. */
export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
