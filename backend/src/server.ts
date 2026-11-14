import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./db/prisma";
import { purgeExpiredIdempotencyKeys } from "./lib/idempotency";
import { cleanupBotRecords } from "./modules/integrations/telegram.bot";
import { processAutoReceipts } from "./modules/integrations/telegram.outbox";

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`restaurant-order backend listening on http://localhost:${env.port}`);
});

/**
 * Hourly housekeeping: idempotency keys older than 48 h can never be replayed by a sane client, and dead client
 * sessions / used or expired Telegram link tokens are only clutter. None of this touches business history.
 */
async function housekeeping() {
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
    await purgeExpiredIdempotencyKeys(prisma, 48);
    await prisma.clientAuthSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    await cleanupBotRecords();
    await prisma.clientTelegramLinkToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("housekeeping failed:", err);
  }
}
// Lease-based PostgreSQL outbox worker. Telegram downtime never affects payment commits.
let sending = false;
async function deliverPending() {
  if (sending) return;
  sending = true;
  try { await processAutoReceipts(); }
  catch (err) { console.error("telegram outbox failed:", err instanceof Error ? err.message : "unknown"); }
  finally { sending = false; }
}
const deliveryTimer = setInterval(() => void deliverPending(), 30_000);
deliveryTimer.unref();
void deliverPending();
const timer = setInterval(() => void housekeeping(), 3600 * 1000);
timer.unref();
void housekeeping();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(deliveryTimer);
    server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
  });
}
