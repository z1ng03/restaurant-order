-- Additive migration: no existing orders, receipts, links or users are removed.
ALTER TABLE "client_telegram_links" ADD COLUMN "auto_receipts" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE "telegram_bot_login_requests" (
 "token_hash" VARCHAR(64) PRIMARY KEY, "chat_id" VARCHAR(40) NOT NULL,
 "expires_at" TIMESTAMP(3) NOT NULL, "used_at" TIMESTAMP(3)
);
CREATE INDEX "telegram_bot_login_requests_chat_id_expires_at_idx" ON "telegram_bot_login_requests"("chat_id", "expires_at");
CREATE TABLE "telegram_receipt_claims" (
 "token_hash" VARCHAR(64) PRIMARY KEY, "order_id" BIGINT NOT NULL REFERENCES "orders"("order_id") ON DELETE CASCADE,
 "expires_at" TIMESTAMP(3) NOT NULL, "used_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "telegram_receipt_claims_order_id_expires_at_idx" ON "telegram_receipt_claims"("order_id", "expires_at");
CREATE TABLE "telegram_processed_updates" (
 "update_id" BIGINT PRIMARY KEY, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "telegram_auto_deliveries" (
 "receipt_id" BIGINT PRIMARY KEY REFERENCES "receipts"("receipt_id") ON DELETE CASCADE,
 "client_user_id" BIGINT NOT NULL REFERENCES "client_users"("client_user_id") ON DELETE CASCADE,
 "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "locked_at" TIMESTAMP(3), "last_error" VARCHAR(300), "sent_at" TIMESTAMP(3)
);
CREATE INDEX "telegram_auto_deliveries_status_next_attempt_at_idx" ON "telegram_auto_deliveries"("status", "next_attempt_at");
CREATE INDEX "telegram_auto_deliveries_client_user_id_status_idx" ON "telegram_auto_deliveries"("client_user_id", "status");
