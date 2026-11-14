/**
 * Post-migration backfill report (TZ §3 "отдельный backfill").
 *
 * The SQL migration already did everything that is exactly derivable (recipe steps, order totals, status
 * events for known facts, open-cart snapshots). This script handles what needs application code:
 *
 *   npm run backfill                    report only
 *   npm run backfill -- --receipts      create receipts for orders that were PAID before receipts existed
 *
 * It NEVER invents history: composition snapshots and cooking/cancel timestamps of old orders are not
 * reconstructed (the UI shows "Состав на момент заказа не сохранён" for them). Legacy receipts are
 * flagged `legacySnapshot` - they are rebuilt from stored order data, not frozen at payment time.
 */
import { prisma } from "../db/prisma";
import { ensureReceipt } from "../modules/receipts/receipts.service";

async function main() {
  const makeReceipts = process.argv.includes("--receipts");
  /* eslint-disable no-console */
  const ordersWithoutSnapshot = await prisma.order.count({ where: { items: { some: { ingredients: { none: {} } } } } });
  const paidWithoutReceipt = await prisma.order.findMany({
    where: { paymentStatus: "PAID", receipt: null },
    select: { orderId: true },
    orderBy: { orderId: "asc" },
  });
  const ordersWithoutCreatedEvent = await prisma.order.count({ where: { statusEvents: { none: { eventType: "ORDER_CREATED" } } } });

  console.log(`Orders with items that have no composition snapshot (pre-v2): ${ordersWithoutSnapshot}  (left as is, never invented)`);
  console.log(`Orders without an ORDER_CREATED event: ${ordersWithoutCreatedEvent}  (the migration backfills these; expected 0)`);
  console.log(`PAID orders without a receipt: ${paidWithoutReceipt.length}`);

  if (makeReceipts && paidWithoutReceipt.length > 0) {
    let created = 0;
    for (const { orderId } of paidWithoutReceipt) {
      await prisma.$transaction((tx) => ensureReceipt(tx, orderId, { legacySnapshot: true }));
      created += 1;
    }
    console.log(`Created ${created} legacy receipt(s).`);
  } else if (paidWithoutReceipt.length > 0) {
    console.log("Run with --receipts to create them (they are also created lazily on first view).");
  }
  /* eslint-enable no-console */
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
