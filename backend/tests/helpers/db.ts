import { prisma } from "../../src/db/prisma";

export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

/** Integration suites call this in beforeAll: refuse to continue unless the database is clearly a test one. */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  let dbName = "";
  try {
    dbName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    /* fall through */
  }
  if (!hasTestDatabase || !/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests: TEST_DATABASE_URL must be set and its database name must contain "test" (got "${dbName}").`,
    );
  }
}

export async function resetDatabase(): Promise<void> {
  assertTestDatabase();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE receipt_number_seq RESTART WITH 1`);
}
