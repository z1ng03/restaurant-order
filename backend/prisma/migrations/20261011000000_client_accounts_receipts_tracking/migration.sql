-- ============================================================================
-- Technical_TZ_Restaurant_Order_v2.md - §3 "Модель данных и миграции Prisma"
--
-- ADDITIVE migration: nothing is renamed or dropped, the initial migration
-- 20260916000000_init is untouched, no data is reset. Data that already exists
-- is backfilled (recipe steps, order amounts, status events, cart snapshots).
--
-- Contents
--   0. Pre-flight guard (stock invariants - never "fixed" silently)
--   1. Existing tables: new columns, backfills, de-duplication
--   2. New tables
--   3. Keys, indexes, foreign keys
--   4. CHECK constraints
--   5. Triggers (append-only / immutable snapshots) and the receipt sequence
--   6. Backfill of the order timeline
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Pre-flight: the new CHECKs require 0 <= reserved <= stock. The old admin
--    "set stock" call only checked >= 0, so legacy data may violate it. We do
--    NOT repair it silently (stock/reserved are money-like numbers) - we stop
--    and tell the operator how to inspect it.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "inventory"
    WHERE "stock_quantity" < 0 OR "reserved_quantity" < 0 OR "reserved_quantity" > "stock_quantity"
  ) THEN
    RAISE EXCEPTION 'Migration stopped: some inventory rows violate 0 <= reserved_quantity <= stock_quantity. Run "npm run audit:inventory" to list them, correct them deliberately (restock or release reservations), then re-run the migration.';
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 1. Existing tables
-- ----------------------------------------------------------------------------

-- 1.1 restaurant_sessions: opaque kiosk session secret (stored hashed)
ALTER TABLE "restaurant_sessions"
  ADD COLUMN "kiosk_token_hash" VARCHAR(64),
  ADD COLUMN "kiosk_token_issued_at" TIMESTAMP(3);

-- 1.2 dishes / dish_options: explicit "is stock tracked" classification
ALTER TABLE "dishes" ADD COLUMN "inventory_tracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "dish_options" ADD COLUMN "inventory_tracked" BOOLEAN NOT NULL DEFAULT true;

-- 1.3 allergens: ordering of the 20 categories
ALTER TABLE "allergens" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- 1.4 recipes: merge duplicate (dish, ingredient) rows, add step / customizable
ALTER TABLE "recipes"
  ADD COLUMN "adjustment_step" DECIMAL(12,3),
  ADD COLUMN "is_customizable" BOOLEAN NOT NULL DEFAULT true;

-- Duplicates would double the recipe amount in the old code too (it summed the
-- rows), so merging them by SUM keeps the effective recipe identical.
UPDATE "recipes" r
SET "quantity" = d."total"
FROM (
  SELECT MIN("recipe_id") AS "keep_id", SUM("quantity") AS "total"
  FROM "recipes"
  GROUP BY "dish_id", "ingredient_id"
  HAVING COUNT(*) > 1
) d
WHERE r."recipe_id" = d."keep_id";

DELETE FROM "recipes" r
USING (
  SELECT "dish_id", "ingredient_id", MIN("recipe_id") AS "keep_id"
  FROM "recipes"
  GROUP BY "dish_id", "ingredient_id"
  HAVING COUNT(*) > 1
) d
WHERE r."dish_id" = d."dish_id" AND r."ingredient_id" = d."ingredient_id" AND r."recipe_id" <> d."keep_id";

-- Default step (same rule as defaultAdjustmentStep() in recipeCalculation.service.ts):
--   pcs  : integer base -> 1;  fractional base (e.g. half a lemon) -> the base itself
--   other: half of the base when it is representable with 3 decimals, else the base
-- so `base` is always a valid point and the UI offers 0, 1/2 base, base, ... 3x base.
UPDATE "recipes" r
SET "adjustment_step" = GREATEST(0.001, CASE
    WHEN i."unit" = 'pcs' THEN
      CASE WHEN r."quantity" = trunc(r."quantity") THEN 1 ELSE r."quantity" END
    WHEN (r."quantity" / 2) * 1000 = trunc((r."quantity" / 2) * 1000) THEN r."quantity" / 2
    ELSE r."quantity"
  END)
FROM "ingredients" i
WHERE i."ingredient_id" = r."ingredient_id";

ALTER TABLE "recipes" ALTER COLUMN "adjustment_step" SET NOT NULL;

-- 1.5 carts: ONE comment for the whole order; pending price confirmation (reorder)
ALTER TABLE "carts"
  ADD COLUMN "comment" TEXT,
  ADD COLUMN "pending_price_changes" JSONB;

-- 1.6 cart_item_options: deleting a cart line must delete its options.
--     (Was ON DELETE RESTRICT - removing/clearing a line that had options, and
--     checkout's cart cleanup, failed with an FK violation.)
ALTER TABLE "cart_item_options" DROP CONSTRAINT "cart_item_options_cart_item_id_fkey";
ALTER TABLE "cart_item_options"
  ADD CONSTRAINT "cart_item_options_cart_item_id_fkey"
  FOREIGN KEY ("cart_item_id") REFERENCES "cart_items"("cart_item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1.7 orders: owner, comment, amounts, timestamps
ALTER TABLE "orders"
  ADD COLUMN "client_user_id" BIGINT,
  ADD COLUMN "subtotal" DECIMAL(12,2),
  ADD COLUMN "discount_bonus" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payable_total" DECIMAL(12,2),
  ADD COLUMN "comment" TEXT,
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancel_reason" TEXT;

-- Historical orders had no bonus discount: payable == subtotal == total_price.
UPDATE "orders"
SET "subtotal" = "total_price",
    "payable_total" = "total_price",
    "accepted_at" = "created_at"
WHERE "subtotal" IS NULL;

ALTER TABLE "orders"
  ALTER COLUMN "subtotal" SET NOT NULL,
  ALTER COLUMN "payable_total" SET NOT NULL;

-- 1.8 payments
ALTER TABLE "payments"
  ADD COLUMN "bonus_used" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provider_ref" VARCHAR(100),
  ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "refund_status" VARCHAR(30) NOT NULL DEFAULT 'NONE';

-- The only non-cash method in this project is the Arduino/RC522 simulation.
UPDATE "payments" SET "is_demo" = true WHERE "method" = 'KASPI_QR';

-- 1.9 inventory_reservations: one aggregated RESERVED row per (item, ingredient).
--     Legacy code created one row per recipe line AND per option line, so the
--     same ingredient could appear twice; merge those (the sum is unchanged, so
--     inventory.reserved_quantity stays consistent).
UPDATE "inventory_reservations" r
SET "quantity" = d."total"
FROM (
  SELECT MIN("reservation_id") AS "keep_id", SUM("quantity") AS "total"
  FROM "inventory_reservations"
  WHERE "status" = 'RESERVED' AND "order_item_id" IS NOT NULL
  GROUP BY "order_item_id", "ingredient_id"
  HAVING COUNT(*) > 1
) d
WHERE r."reservation_id" = d."keep_id";

DELETE FROM "inventory_reservations" r
USING (
  SELECT "order_item_id", "ingredient_id", MIN("reservation_id") AS "keep_id"
  FROM "inventory_reservations"
  WHERE "status" = 'RESERVED' AND "order_item_id" IS NOT NULL
  GROUP BY "order_item_id", "ingredient_id"
  HAVING COUNT(*) > 1
) d
WHERE r."status" = 'RESERVED'
  AND r."order_item_id" = d."order_item_id"
  AND r."ingredient_id" = d."ingredient_id"
  AND r."reservation_id" <> d."keep_id";


-- ----------------------------------------------------------------------------
-- 2. New tables
-- ----------------------------------------------------------------------------

CREATE TABLE "ingredient_allergens" (
    "ingredient_id" BIGINT NOT NULL,
    "allergen_id" BIGINT NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'CONTAINS',
    CONSTRAINT "ingredient_allergens_pkey" PRIMARY KEY ("ingredient_id","allergen_id")
);

CREATE TABLE "allergen_synonyms" (
    "synonym" VARCHAR(100) NOT NULL,
    "allergen_id" BIGINT NOT NULL,
    CONSTRAINT "allergen_synonyms_pkey" PRIMARY KEY ("synonym")
);

CREATE TABLE "cart_item_ingredients" (
    "cart_item_ingredient_id" BIGSERIAL NOT NULL,
    "cart_item_id" BIGINT NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "base_quantity" DECIMAL(12,3) NOT NULL,
    "selected_quantity" DECIMAL(12,3) NOT NULL,
    "unit_snapshot" VARCHAR(20) NOT NULL,
    CONSTRAINT "cart_item_ingredients_pkey" PRIMARY KEY ("cart_item_ingredient_id")
);

CREATE TABLE "order_item_ingredients" (
    "order_item_ingredient_id" BIGSERIAL NOT NULL,
    "order_item_id" BIGINT NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "ingredient_name_snapshot" VARCHAR(150) NOT NULL,
    "unit_snapshot" VARCHAR(20) NOT NULL,
    "base_per_serving" DECIMAL(12,3) NOT NULL,
    "selected_per_serving" DECIMAL(12,3) NOT NULL,
    "required_total" DECIMAL(14,3) NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    CONSTRAINT "order_item_ingredients_pkey" PRIMARY KEY ("order_item_ingredient_id")
);

CREATE TABLE "inventory_adjustments" (
    "adjustment_id" BIGSERIAL NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "delta" DECIMAL(14,3) NOT NULL,
    "stock_before" DECIMAL(14,3) NOT NULL,
    "stock_after" DECIMAL(14,3) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "comment" VARCHAR(500),
    "actor_user_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("adjustment_id")
);

CREATE TABLE "client_users" (
    "client_user_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254),
    "password_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "bonus_balance" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "client_users_pkey" PRIMARY KEY ("client_user_id")
);

CREATE TABLE "client_auth_sessions" (
    "jti" VARCHAR(36) NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "kiosk_session_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "client_auth_sessions_pkey" PRIMARY KEY ("jti")
);

CREATE TABLE "client_identity_verifications" (
    "verification_id" BIGSERIAL NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "provider_reference" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_identity_verifications_pkey" PRIMARY KEY ("verification_id")
);

CREATE TABLE "client_telegram_links" (
    "link_id" BIGSERIAL NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "telegram_chat_id" VARCHAR(40) NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "client_telegram_links_pkey" PRIMARY KEY ("link_id")
);

CREATE TABLE "client_telegram_link_tokens" (
    "token_hash" VARCHAR(64) NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    CONSTRAINT "client_telegram_link_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE TABLE "loyalty_ledger" (
    "ledger_id" BIGSERIAL NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" VARCHAR(100) NOT NULL,
    CONSTRAINT "loyalty_ledger_pkey" PRIMARY KEY ("ledger_id")
);

CREATE TABLE "order_ratings" (
    "rating_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "client_user_id" BIGINT NOT NULL,
    "rating" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_ratings_pkey" PRIMARY KEY ("rating_id")
);

CREATE TABLE "order_status_events" (
    "event_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" VARCHAR(20) NOT NULL,
    "actor_id" BIGINT,
    "event_type" VARCHAR(30) NOT NULL,
    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("event_id")
);

CREATE TABLE "receipts" (
    "receipt_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "receipt_number" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "payload_json" JSONB NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "fiscal_status" VARCHAR(20) NOT NULL,
    "fiscal_reference" VARCHAR(100),
    "verification_url" TEXT,
    CONSTRAINT "receipts_pkey" PRIMARY KEY ("receipt_id")
);

CREATE TABLE "receipt_dispatches" (
    "dispatch_id" BIGSERIAL NOT NULL,
    "receipt_id" BIGINT NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "destination_masked" VARCHAR(120) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "requested_by_client_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    CONSTRAINT "receipt_dispatches_pkey" PRIMARY KEY ("dispatch_id")
);

CREATE TABLE "idempotency_requests" (
    "id" BIGSERIAL NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "scope" VARCHAR(60) NOT NULL,
    "owner_id" VARCHAR(40) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_ref" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_requests_pkey" PRIMARY KEY ("id")
);


-- ----------------------------------------------------------------------------
-- 3. Keys, indexes, foreign keys
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX "recipes_dish_id_ingredient_id_key" ON "recipes"("dish_id","ingredient_id");
CREATE UNIQUE INDEX "payments_provider_ref_key" ON "payments"("provider_ref");

CREATE INDEX "orders_client_user_id_created_at_idx" ON "orders"("client_user_id", "created_at" DESC);
CREATE INDEX "orders_session_id_created_at_idx" ON "orders"("session_id", "created_at" DESC);

CREATE INDEX "inventory_reservations_order_item_id_status_idx" ON "inventory_reservations"("order_item_id","status");
-- At most one open (RESERVED) aggregated row per order item + ingredient.
CREATE UNIQUE INDEX "inventory_reservations_open_item_ingredient_key"
  ON "inventory_reservations"("order_item_id","ingredient_id")
  WHERE "status" = 'RESERVED' AND "order_item_id" IS NOT NULL;

CREATE INDEX "ingredient_allergens_allergen_id_idx" ON "ingredient_allergens"("allergen_id");
CREATE INDEX "allergen_synonyms_allergen_id_idx" ON "allergen_synonyms"("allergen_id");

CREATE UNIQUE INDEX "cart_item_ingredients_cart_item_id_ingredient_id_key" ON "cart_item_ingredients"("cart_item_id","ingredient_id");
CREATE UNIQUE INDEX "order_item_ingredients_order_item_id_ingredient_id_source_key" ON "order_item_ingredients"("order_item_id","ingredient_id","source");
CREATE INDEX "order_item_ingredients_order_item_id_idx" ON "order_item_ingredients"("order_item_id");

CREATE INDEX "inventory_adjustments_ingredient_id_created_at_idx" ON "inventory_adjustments"("ingredient_id", "created_at" DESC);

CREATE UNIQUE INDEX "client_users_email_key" ON "client_users"("email");
CREATE INDEX "client_auth_sessions_client_user_id_idx" ON "client_auth_sessions"("client_user_id");
CREATE INDEX "client_auth_sessions_kiosk_session_id_idx" ON "client_auth_sessions"("kiosk_session_id");
CREATE INDEX "client_identity_verifications_client_user_id_created_at_idx" ON "client_identity_verifications"("client_user_id", "created_at" DESC);
CREATE UNIQUE INDEX "client_telegram_links_client_user_id_key" ON "client_telegram_links"("client_user_id");
CREATE UNIQUE INDEX "client_telegram_links_telegram_chat_id_key" ON "client_telegram_links"("telegram_chat_id");
CREATE INDEX "client_telegram_link_tokens_client_user_id_idx" ON "client_telegram_link_tokens"("client_user_id");

CREATE UNIQUE INDEX "loyalty_ledger_idempotency_key_key" ON "loyalty_ledger"("idempotency_key");
CREATE UNIQUE INDEX "loyalty_ledger_order_id_type_key" ON "loyalty_ledger"("order_id","type");
CREATE INDEX "loyalty_ledger_client_user_id_created_at_idx" ON "loyalty_ledger"("client_user_id","created_at");

CREATE UNIQUE INDEX "order_ratings_order_id_key" ON "order_ratings"("order_id");

CREATE UNIQUE INDEX "order_status_events_order_id_event_type_key" ON "order_status_events"("order_id","event_type");
CREATE INDEX "order_status_events_order_id_occurred_at_idx" ON "order_status_events"("order_id","occurred_at");

CREATE UNIQUE INDEX "receipts_order_id_key" ON "receipts"("order_id");
CREATE UNIQUE INDEX "receipts_receipt_number_key" ON "receipts"("receipt_number");
CREATE INDEX "receipt_dispatches_receipt_id_created_at_idx" ON "receipt_dispatches"("receipt_id","created_at");

CREATE UNIQUE INDEX "idempotency_requests_key_scope_owner_id_key" ON "idempotency_requests"("key","scope","owner_id");
CREATE INDEX "idempotency_requests_created_at_idx" ON "idempotency_requests"("created_at");

-- Foreign keys
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ingredient_allergens" ADD CONSTRAINT "ingredient_allergens_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ingredient_allergens" ADD CONSTRAINT "ingredient_allergens_allergen_id_fkey" FOREIGN KEY ("allergen_id") REFERENCES "allergens"("allergen_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "allergen_synonyms" ADD CONSTRAINT "allergen_synonyms_allergen_id_fkey" FOREIGN KEY ("allergen_id") REFERENCES "allergens"("allergen_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_item_ingredients" ADD CONSTRAINT "cart_item_ingredients_cart_item_id_fkey" FOREIGN KEY ("cart_item_id") REFERENCES "cart_items"("cart_item_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cart_item_ingredients" ADD CONSTRAINT "cart_item_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item_ingredients" ADD CONSTRAINT "order_item_ingredients_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("order_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item_ingredients" ADD CONSTRAINT "order_item_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "client_auth_sessions" ADD CONSTRAINT "client_auth_sessions_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_auth_sessions" ADD CONSTRAINT "client_auth_sessions_kiosk_session_id_fkey" FOREIGN KEY ("kiosk_session_id") REFERENCES "restaurant_sessions"("session_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "client_identity_verifications" ADD CONSTRAINT "client_identity_verifications_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_telegram_links" ADD CONSTRAINT "client_telegram_links_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("client_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_dispatches" ADD CONSTRAINT "receipt_dispatches_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("receipt_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ----------------------------------------------------------------------------
-- 4. CHECK constraints (TZ §3 "SQL-ограничения")
-- ----------------------------------------------------------------------------

ALTER TABLE "inventory" ADD CONSTRAINT "inventory_stock_quantity_nonnegative" CHECK ("stock_quantity" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_quantity_nonnegative" CHECK ("reserved_quantity" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_within_stock" CHECK ("reserved_quantity" <= "stock_quantity");

ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "recipes" ADD CONSTRAINT "recipes_adjustment_step_positive" CHECK ("adjustment_step" > 0);

ALTER TABLE "cart_item_ingredients" ADD CONSTRAINT "cart_item_ingredients_selected_quantity_nonnegative" CHECK ("selected_quantity" >= 0);
ALTER TABLE "cart_item_ingredients" ADD CONSTRAINT "cart_item_ingredients_within_triple_base" CHECK ("selected_quantity" <= "base_quantity" * 3);

ALTER TABLE "order_item_ingredients" ADD CONSTRAINT "order_item_ingredients_amounts_nonnegative" CHECK ("selected_per_serving" >= 0 AND "required_total" >= 0 AND "base_per_serving" >= 0);
ALTER TABLE "order_item_ingredients" ADD CONSTRAINT "order_item_ingredients_source_check" CHECK ("source" IN ('RECIPE','OPTION'));

ALTER TABLE "ingredient_allergens" ADD CONSTRAINT "ingredient_allergens_kind_check" CHECK ("kind" IN ('CONTAINS','MAY_CONTAIN'));

ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_consistent" CHECK (
  "subtotal" >= 0 AND "discount_bonus" >= 0 AND "payable_total" >= 0
  AND "payable_total" = "subtotal" - "discount_bonus"
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts_nonnegative" CHECK ("amount" >= 0 AND "bonus_used" >= 0);

ALTER TABLE "client_users" ADD CONSTRAINT "client_users_bonus_balance_nonnegative" CHECK ("bonus_balance" >= 0);

-- Ledger: signed amounts must match the operation type; a zero row is meaningless.
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_type_sign_check" CHECK (
  ("type" = 'EARN'         AND "amount" > 0) OR
  ("type" = 'REFUND_SPEND' AND "amount" > 0) OR
  ("type" = 'SPEND'        AND "amount" < 0) OR
  ("type" = 'REVERSE_EARN' AND "amount" < 0)
);

ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_kind_check" CHECK ("kind" IN ('DEMO','FISCAL'));
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_fiscal_status_check" CHECK ("fiscal_status" IN ('NOT_CONFIGURED','PENDING','SUCCEEDED','FAILED'));

ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_stock_after_nonnegative" CHECK ("stock_after" >= 0);


-- ----------------------------------------------------------------------------
-- 5. Triggers and sequences
-- ----------------------------------------------------------------------------

-- Append-only tables: business history may only ever grow.
CREATE OR REPLACE FUNCTION "forbid_row_modification"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_status_events_append_only"
  BEFORE UPDATE OR DELETE ON "order_status_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_row_modification"();

CREATE TRIGGER "loyalty_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "loyalty_ledger"
  FOR EACH ROW EXECUTE FUNCTION "forbid_row_modification"();

-- A receipt is an immutable snapshot of the payment. Only the fiscalisation
-- result columns (fiscal_status / fiscal_reference / verification_url) may
-- change later, e.g. when a real fiscal provider answers asynchronously.
CREATE OR REPLACE FUNCTION "receipts_protect_snapshot"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."order_id" <> OLD."order_id"
     OR NEW."receipt_number" <> OLD."receipt_number"
     OR NEW."kind" <> OLD."kind"
     OR NEW."issued_at" <> OLD."issued_at"
     OR NEW."payload_json" IS DISTINCT FROM OLD."payload_json" THEN
    RAISE EXCEPTION 'the receipt snapshot is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "receipts_snapshot_immutable"
  BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION "receipts_protect_snapshot"();

-- Unique, gap-tolerant receipt numbers: DEMO-000001, DEMO-000002, ...
CREATE SEQUENCE "receipt_number_seq" AS BIGINT START WITH 1 INCREMENT BY 1;


-- ----------------------------------------------------------------------------
-- 6. Backfill (idempotent; only states that are really known are recorded -
--    the time a legacy order started cooking / was cancelled is NOT invented)
-- ----------------------------------------------------------------------------

-- Cart lines that are open right now get a snapshot equal to the current recipe.
INSERT INTO "cart_item_ingredients" ("cart_item_id","ingredient_id","base_quantity","selected_quantity","unit_snapshot")
SELECT ci."cart_item_id", r."ingredient_id", r."quantity", r."quantity", i."unit"
FROM "cart_items" ci
JOIN "recipes" r ON r."dish_id" = ci."dish_id"
JOIN "ingredients" i ON i."ingredient_id" = r."ingredient_id"
ON CONFLICT DO NOTHING;

INSERT INTO "order_status_events" ("order_id","status","occurred_at","actor_type","actor_id","event_type")
SELECT o."order_id", 'SENT_TO_KITCHEN', o."created_at", 'SYSTEM', NULL, 'ORDER_CREATED'
FROM "orders" o
ON CONFLICT ("order_id","event_type") DO NOTHING;

INSERT INTO "order_status_events" ("order_id","status","occurred_at","actor_type","actor_id","event_type")
SELECT p."order_id", 'PAID', p."paid_at", 'SYSTEM', NULL, 'PAYMENT_CONFIRMED'
FROM (
  SELECT DISTINCT ON ("order_id") "order_id", "paid_at"
  FROM "payments"
  WHERE "status" = 'PAID' AND "paid_at" IS NOT NULL
  ORDER BY "order_id", "paid_at" ASC
) p
ON CONFLICT ("order_id","event_type") DO NOTHING;

INSERT INTO "order_status_events" ("order_id","status","occurred_at","actor_type","actor_id","event_type")
SELECT o."order_id", 'DELIVERED', o."delivered_at", 'SYSTEM', NULL, 'DELIVERED'
FROM "orders" o
WHERE o."delivered_at" IS NOT NULL
ON CONFLICT ("order_id","event_type") DO NOTHING;
