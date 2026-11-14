import { describe, expect, it } from "vitest";
import { dec } from "../../src/lib/decimal";
import { AppError } from "../../src/lib/errors";
import {
  allowedQuantities,
  buildOrderItemIngredientRows,
  calculateOrderItemNeeds,
  compositionSurcharge,
  computeAllergenGroups,
  defaultAdjustmentStep,
  isAllowedQuantity,
  lineTotal,
  maxQuantity,
  mergeNeeds,
  resolveRecipeSelection,
  unitPriceWithOptions,
  type RecipeLine,
} from "../../src/modules/menu/recipeCalculation.service";

const line = (over: Partial<RecipeLine> & { ingredientId: bigint }): RecipeLine => ({
  name: "ingredient",
  unit: "kg",
  isActive: true,
  base: dec("0.040"),
  step: dec("0.020"),
  customizable: true,
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as AppError).code;
  }
  return "NO_ERROR";
};

describe("personalisation steps", () => {
  it("allowed values are 0, step, 2·step … 3·base - and the base itself", () => {
    expect(allowedQuantities(dec("0.050"), dec("0.025")).map((d) => d.toFixed(3))).toEqual([
      "0.000", "0.025", "0.050", "0.075", "0.100", "0.125", "0.150",
    ]);
    expect(maxQuantity(dec("0.040")).toFixed(3)).toBe("0.120");
    // base is an anchor even when it is not a multiple of the step (legacy data)
    expect(isAllowedQuantity(dec("0.050"), dec("0.050"), dec("0.030"))).toBe(true);
    expect(isAllowedQuantity(dec("0.060"), dec("0.050"), dec("0.030"))).toBe(true);
    expect(isAllowedQuantity(dec("0.055"), dec("0.050"), dec("0.030"))).toBe(false);
  });

  it("rejects out-of-range, wrong-step and negative values", () => {
    expect(isAllowedQuantity(dec("0.140"), dec("0.040"), dec("0.020"))).toBe(false);
    expect(isAllowedQuantity(dec("0.030"), dec("0.040"), dec("0.020"))).toBe(false);
    expect(isAllowedQuantity(dec("-0.020"), dec("0.040"), dec("0.020"))).toBe(false);
    expect(isAllowedQuantity(dec("0"), dec("0.040"), dec("0.020"))).toBe(true); // "remove" is valid
  });

  it("default step: half of the base when representable, whole pieces for integer pcs, fractional pcs keep their base", () => {
    expect(defaultAdjustmentStep(dec("0.040"), "kg").toFixed(3)).toBe("0.020");
    expect(defaultAdjustmentStep(dec("0.005"), "kg").toFixed(3)).toBe("0.005"); // half = 0.0025 is not representable
    expect(defaultAdjustmentStep(dec("1"), "pcs").toFixed()).toBe("1");
    expect(defaultAdjustmentStep(dec("2"), "pcs").toFixed()).toBe("1");
    expect(defaultAdjustmentStep(dec("0.5"), "pcs").toFixed()).toBe("0.5");
    expect(defaultAdjustmentStep(dec("0.3"), "kg").toFixed(3)).toBe("0.150");
    // the base is always one of the offered points
    for (const [b, u] of [["0.040", "kg"], ["0.005", "kg"], ["1", "pcs"], ["0.5", "pcs"], ["0.02", "l"]] as const) {
      const base = dec(b);
      expect(isAllowedQuantity(base, base, defaultAdjustmentStep(base, u))).toBe(true);
    }
  });
});

describe("resolveRecipeSelection", () => {
  const lines = [
    line({ ingredientId: 1n, name: "parmesan" }),
    line({ ingredientId: 2n, name: "egg", unit: "pcs", base: dec(1), step: dec(1), customizable: false }),
  ];

  it("untouched lines keep their base amount", () => {
    const r = resolveRecipeSelection(lines, undefined);
    expect(r.map((x) => x.selected.toFixed(3))).toEqual(["0.040", "1.000"]);
  });

  it("applies a valid choice and converts units before comparing (60 g == 0.060 kg)", () => {
    const r = resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec(60), unit: "g" }]);
    expect(r[0]!.selected.toFixed(3)).toBe("0.060");
  });

  it("stable error codes", () => {
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 9n, quantity: dec(1) }]))).toBe("INGREDIENT_NOT_IN_DISH");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec("0.030") }]))).toBe("INVALID_INGREDIENT_STEP");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec("0.140") }]))).toBe("INGREDIENT_OUT_OF_RANGE");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec("-1") }]))).toBe("INGREDIENT_OUT_OF_RANGE");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 2n, quantity: dec(2) }]))).toBe("INGREDIENT_NOT_CUSTOMIZABLE");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec(40), unit: "ml" }]))).toBe("UNIT_MISMATCH");
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 1n, quantity: dec("0.02") }, { ingredientId: 1n, quantity: dec("0.04") }]))).toBe("VALIDATION_ERROR");
    // a non-customizable ingredient at its base amount is accepted (the client may echo every line)
    expect(codeOf(() => resolveRecipeSelection(lines, [{ ingredientId: 2n, quantity: dec(1) }]))).toBe("NO_ERROR");
  });
});

describe("calculateOrderItemNeeds", () => {
  it("TZ example: 2 servings × 75 g + a 50 g option per serving = 250 g", () => {
    const needs = calculateOrderItemNeeds({
      quantity: 2,
      ingredients: [{ ingredientId: 1n, selectedPerServing: dec("0.075") }],
      options: [{ optionId: 10n, quantity: 1, ingredients: [{ ingredientId: 1n, quantity: dec("0.050") }] }],
    });
    expect(needs.get("1")!.toFixed(3)).toBe("0.250");
  });

  it("option quantity multiplies too; removed ingredients reserve nothing; floats never leak in", () => {
    const needs = calculateOrderItemNeeds({
      quantity: 3,
      ingredients: [{ ingredientId: 1n, selectedPerServing: dec(0) }, { ingredientId: 2n, selectedPerServing: dec("0.07") }],
      options: [{ optionId: 10n, quantity: 2, ingredients: [{ ingredientId: 3n, quantity: dec("0.1") }] }],
    });
    expect(needs.has("1")).toBe(false);
    expect(needs.get("2")!.toFixed()).toBe("0.21"); // 0.07 × 3 exactly (a float would give 0.21000000000000002)
    expect(needs.get("3")!.toFixed()).toBe("0.6");
  });

  it("merges the needs of several cart lines", () => {
    const a = new Map([["1", dec("0.1")]]);
    const b = new Map([["1", dec("0.2")], ["2", dec("1")]]);
    const m = mergeNeeds([a, b]);
    expect(m.get("1")!.toFixed()).toBe("0.3");
    expect(m.get("2")!.toFixed()).toBe("1");
  });
});

describe("order-item snapshot rows", () => {
  it("keeps recipe and option contributions apart, keeps removed lines at 0, aggregates option rows per ingredient", () => {
    const rows = buildOrderItemIngredientRows({
      quantity: 2,
      recipe: [
        { ingredientId: 1n, name: "bacon", unit: "kg", base: dec("0.080"), selected: dec("0.080") },
        { ingredientId: 2n, name: "onion", unit: "kg", base: dec("0.020"), selected: dec(0) },
      ],
      options: [
        { quantity: 1, ingredients: [{ ingredientId: 1n, name: "bacon", unit: "kg", quantity: dec("0.050") }] },
        { quantity: 2, ingredients: [{ ingredientId: 1n, name: "bacon", unit: "kg", quantity: dec("0.010") }] },
      ],
    });
    const by = (src: string, id: bigint) => rows.find((r) => r.source === src && r.ingredientId === id)!;
    expect(by("RECIPE", 1n).requiredTotal.toFixed(3)).toBe("0.160");
    expect(by("RECIPE", 2n).selectedPerServing.toFixed(3)).toBe("0.000"); // visible to the kitchen as "removed"
    expect(rows.filter((r) => r.source === "OPTION")).toHaveLength(1);
    expect(by("OPTION", 1n).selectedPerServing.toFixed(3)).toBe("0.070"); // 0.05 + 2×0.01 per serving
    expect(by("OPTION", 1n).requiredTotal.toFixed(3)).toBe("0.140");
  });
});

describe("prices (options are charged per serving)", () => {
  it("line total = servings × (price + Σ option price × option qty)", () => {
    const opts = [{ price: dec(500), quantity: 1 }, { price: dec(100), quantity: 2 }];
    expect(unitPriceWithOptions(dec(3200), opts).toFixed(2)).toBe("3900.00");
    expect(lineTotal(dec(3200), 2, opts).toFixed(2)).toBe("7800.00");
  });
});

describe("allergen groups", () => {
  const tags = new Map([
    ["1", [{ allergenId: 100n, kind: "CONTAINS" as const }]],
    ["2", [{ allergenId: 100n, kind: "MAY_CONTAIN" as const }, { allergenId: 200n, kind: "CONTAINS" as const }]],
  ]);
  const allergens = new Map([["100", { name: "Молоко", sortOrder: 1 }], ["200", { name: "Яйца", sortOrder: 2 }]]);

  it("groups only what is really present and keeps contains / may-contain distinguishable", () => {
    const groups = computeAllergenGroups({
      present: [{ ingredientId: 1n, name: "Пармезан" }, { ingredientId: 2n, name: "Соус" }],
      tags,
      allergens,
    });
    expect(groups.map((g) => g.categoryName)).toEqual(["Молоко", "Яйца"]);
    expect(groups[0]!.ingredients).toEqual([
      { ingredientId: "1", name: "Пармезан", kind: "CONTAINS" },
      { ingredientId: "2", name: "Соус", kind: "MAY_CONTAIN" },
    ]);
    // removing the parmesan (selected = 0) leaves only the sauce's traces - the group does not vanish incorrectly
    const without = computeAllergenGroups({ present: [{ ingredientId: 2n, name: "Соус" }], tags, allergens });
    expect(without[0]!.ingredients).toEqual([{ ingredientId: "2", name: "Соус", kind: "MAY_CONTAIN" }]);
    expect(computeAllergenGroups({ present: [], tags, allergens })).toEqual([]);
  });
});


describe("extra ingredient pricing", () => {
  it("charges only extra amounts using the same recipe price allocation as checkout", () => {
    const lines = [
      line({ ingredientId: 10n, base: dec("0.040"), step: dec("0.020") }),
      line({ ingredientId: 11n, base: dec("1"), step: dec("1"), unit: "pcs" }),
    ];
    const increase = resolveRecipeSelection(lines, [{ ingredientId: 10n, quantity: dec("0.060") }]);
    expect(compositionSurcharge(dec("1000"), increase).toFixed(2)).toBe("250.00");
    const decrease = resolveRecipeSelection(lines, [{ ingredientId: 10n, quantity: dec("0.020") }]);
    expect(compositionSurcharge(dec("1000"), decrease).toFixed(2)).toBe("0.00");
    expect(compositionSurcharge(dec("1000"), resolveRecipeSelection(lines, undefined)).toFixed(2)).toBe("0.00");
  });
});
