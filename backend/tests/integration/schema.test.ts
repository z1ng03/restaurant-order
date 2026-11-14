import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import { assertTestDatabase, hasTestDatabase } from "../helpers/db";

const SCALARS = new Set(["String", "Int", "BigInt", "Boolean", "DateTime", "Decimal", "Json", "Float", "Bytes"]);

/** Minimal schema.prisma reader: { table -> { column -> nullable } } for scalar fields (relations have no column). */
function readSchema(): Map<string, Map<string, boolean>> {
  const text = readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const out = new Map<string, Map<string, boolean>>();
  for (const match of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, modelName = "", body = ""] = match;
    const tableMap = /@@map\("([^"]+)"\)/.exec(body);
    const table = tableMap?.[1] ?? modelName;
    const columns = new Map<string, boolean>();
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@") || line.startsWith("///")) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?(?:\s+(.*))?$/.exec(line);
      if (!m) continue;
      const [, field = "", type = "", isList, optional, attrs = ""] = m;
      if (!SCALARS.has(type) || isList) continue;
      const column = /@map\("([^"]+)"\)/.exec(attrs)?.[1] ?? field;
      columns.set(column, optional === "?");
    }
    out.set(table, columns);
  }
  return out;
}

/**
 * Guards against the classic hand-written-migration failure: schema.prisma and the real database drifting apart.
 * Every scalar field of every Prisma model must exist as a column with the same nullability.
 */
describe.skipIf(!hasTestDatabase)("schema.prisma matches the migrated database", () => {
  beforeAll(() => assertTestDatabase());
  afterAll(() => prisma.$disconnect());

  it("every model/column exists with matching nullability", async () => {
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string; is_nullable: string }[]>`
      SELECT table_name::text AS table_name, column_name::text AS column_name, is_nullable::text AS is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'`;
    const db = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable === "YES"]));

    const schema = readSchema();
    expect(schema.size).toBeGreaterThan(30);
    const problems: string[] = [];
    for (const [table, columns] of schema) {
      for (const [column, nullable] of columns) {
        const dbNullable = db.get(`${table}.${column}`);
        if (dbNullable === undefined) problems.push(`missing column ${table}.${column}`);
        else if (dbNullable !== nullable) problems.push(`nullability mismatch ${table}.${column}: db nullable=${dbNullable}, schema nullable=${nullable}`);
      }
    }
    // and the other direction: no column the schema does not know about
    for (const key of db.keys()) {
      const [table = "", column = ""] = key.split(".");
      if (table === "_prisma_migrations") continue;
      if (!schema.get(table)?.has(column)) problems.push(`column ${key} exists in the database but not in schema.prisma`);
    }
    expect(problems).toEqual([]);
  });

  it("the database has the constraints Prisma cannot express", async () => {
    const names = (await prisma.$queryRaw<{ conname: string }[]>`SELECT conname::text AS conname FROM pg_constraint`).map((r) => r.conname);
    for (const c of [
      "inventory_reserved_within_stock",
      "recipes_adjustment_step_positive",
      "orders_amounts_consistent",
      "loyalty_ledger_type_sign_check",
      "order_ratings_rating_range",
      "client_users_bonus_balance_nonnegative",
    ]) {
      expect(names).toContain(c);
    }
    const triggers = (await prisma.$queryRaw<{ tgname: string }[]>`SELECT tgname::text AS tgname FROM pg_trigger WHERE NOT tgisinternal`).map((r) => r.tgname);
    expect(triggers).toEqual(expect.arrayContaining(["order_status_events_append_only", "loyalty_ledger_append_only", "receipts_snapshot_immutable"]));
  });
});
