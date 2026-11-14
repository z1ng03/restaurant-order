/**
 * Stock-books audit / repair (TZ §FR-12).
 *
 *   npm run audit:inventory                      report only (exit code 1 when something is wrong)
 *   npm run audit:inventory -- --repair          print the repair PLAN, change nothing
 *   npm run audit:inventory -- --repair --apply  execute the plan
 *
 * The only automatic repair is "reserved_quantity := SUM of RESERVED rows" when that fits within stock;
 * everything else is listed for a human. Stock is never changed silently.
 */
import { prisma } from "../db/prisma";
import { auditInventory, repairInventory } from "../modules/admin/admin.audit.service";

async function main() {
  const args = new Set(process.argv.slice(2));
  const repair = args.has("--repair");
  const apply = args.has("--apply");

  const report = await auditInventory();
  /* eslint-disable no-console */
  if (report.ok) {
    console.log("Inventory OK: reserved == sum(RESERVED rows) and 0 <= reserved <= stock for every ingredient.");
  } else {
    console.log(`Found ${report.mismatches.length} ingredient mismatch(es), ${report.staleReservations.length} stale reservation(s):`);
    for (const m of report.mismatches) {
      console.log(
        `  #${m.ingredientId} ${m.name} [${m.unit}] stock=${m.stock} reserved=${m.reserved} reservations=${m.reservedFromReservations} diff=${m.difference} - ${m.problems.join("; ")}`,
      );
    }
    for (const s of report.staleReservations) {
      console.log(`  stale: reservation #${s.reservationId} (order #${s.orderId} is ${s.orderStatus}) ingredient #${s.ingredientId} qty ${s.quantity}`);
    }
  }

  if (repair) {
    const plan = await repairInventory(apply);
    console.log(apply ? "\nRepair APPLIED:" : "\nRepair PLAN (dry run - nothing was changed; add --apply to execute):");
    for (const step of plan.steps) console.log(`  #${step.ingredientId} ${step.name}: reserved ${step.from} -> ${step.to} ${step.unit}`);
    if (plan.steps.length === 0) console.log("  (no safe automatic repair available)");
    for (const note of plan.manual) console.log(`  MANUAL: ${note}`);
  }
  /* eslint-enable no-console */
  process.exitCode = report.ok || repair ? 0 : 1;
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
