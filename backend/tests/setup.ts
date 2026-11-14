/**
 * Runs before every test file, i.e. BEFORE src/config/env.ts is imported.
 *
 * Safety: the integration tests TRUNCATE every table, so they only ever use TEST_DATABASE_URL (never the
 * DATABASE_URL from .env) and refuse to run unless the database name contains "test".
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-jwt-secret-test-jwt-secret-0123456789";
process.env.RATE_LIMIT_DISABLED = "true";
process.env.DEMO_IDENTITY_VERIFICATION = "true";
process.env.CASHBACK_RATE = "0.05";
process.env.CASHBACK_REDEMPTION_CAP = "0.5";
delete process.env.KIOSK_DEVICE_SECRETS;
delete process.env.SMTP_HOST;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_USERNAME;
delete process.env.TELEGRAM_WEBHOOK_SECRET;

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // unit tests never touch the database, but env.ts insists the variable exists
  process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_only_test";
}
