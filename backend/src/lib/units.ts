import { Prisma } from "@prisma/client";
import { unitMismatch, type Decimal } from "./decimal";

/**
 * Ingredient.unit is the BASE unit for storage, reservation and API payloads
 * (typically kg / l / pcs). The UI shows friendly units (40 г, 100 мл, 1 шт.)
 * but numbers are never compared across units without converting first -
 * 25 g must never be compared with 0.04 kg.
 */
type Dimension = "mass" | "volume" | "count";

const UNITS: Record<string, { dim: Dimension; toBase: number }> = {
  g: { dim: "mass", toBase: 1 },
  kg: { dim: "mass", toBase: 1000 },
  ml: { dim: "volume", toBase: 1 },
  l: { dim: "volume", toBase: 1000 },
  pcs: { dim: "count", toBase: 1 },
};

export function isKnownUnit(unit: string): boolean {
  return unit in UNITS;
}

/** Converts `value` from unit `from` to unit `to`; throws 400 UNIT_MISMATCH when impossible. */
export function convertQuantity(value: Decimal, from: string, to: string): Decimal {
  if (from === to) return value;
  const f = UNITS[from];
  const t = UNITS[to];
  if (!f || !t || f.dim !== t.dim) {
    throw unitMismatch(`Единицы «${from}» и «${to}» несовместимы`);
  }
  return value.times(f.toBase).dividedBy(t.toBase);
}

function trimNumber(d: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(d).toDecimalPlaces(3).toFixed().replace(".", ",");
}

/**
 * Human-readable quantity for the guest/kitchen UI: 0.04 kg -> "40 г",
 * 1.2 kg -> "1,2 кг", 0.1 l -> "100 мл", 1 pcs -> "1 шт.". Mirrors formatQty()
 * in frontend/api.js.
 */
export function formatQuantityRu(value: Prisma.Decimal.Value, unit: string): string {
  const v = new Prisma.Decimal(value);
  switch (unit) {
    case "kg":
      return v.abs().lt(1) ? `${trimNumber(v.times(1000))} г` : `${trimNumber(v)} кг`;
    case "l":
      return v.abs().lt(1) ? `${trimNumber(v.times(1000))} мл` : `${trimNumber(v)} л`;
    case "g":
      return `${trimNumber(v)} г`;
    case "ml":
      return `${trimNumber(v)} мл`;
    case "pcs":
      return `${trimNumber(v)} шт.`;
    default:
      return `${trimNumber(v)} ${unit}`;
  }
}
