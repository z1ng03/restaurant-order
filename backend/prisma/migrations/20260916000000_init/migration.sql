-- CreateTable
CREATE TABLE "users" (
    "user_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "login" VARCHAR(100) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "tables" (
    "table_id" BIGSERIAL NOT NULL,
    "table_number" INTEGER NOT NULL,
    "monitor_number" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'FREE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tables_pkey" PRIMARY KEY ("table_id")
);

-- CreateTable
CREATE TABLE "restaurant_sessions" (
    "session_id" BIGSERIAL NOT NULL,
    "table_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "restaurant_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "category_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "dishes" (
    "dish_id" BIGSERIAL NOT NULL,
    "category_id" BIGINT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "image_url" TEXT,
    "is_21_plus" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dishes_pkey" PRIMARY KEY ("dish_id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "ingredient_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("ingredient_id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "recipe_id" BIGSERIAL NOT NULL,
    "dish_id" BIGINT NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    CONSTRAINT "recipes_pkey" PRIMARY KEY ("recipe_id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "inventory_id" BIGSERIAL NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "stock_quantity" DECIMAL(14,3) NOT NULL,
    "reserved_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_pkey" PRIMARY KEY ("inventory_id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "reservation_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "order_item_id" BIGINT,
    "ingredient_id" BIGINT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "carts" (
    "cart_id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "carts_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "cart_item_id" BIGSERIAL NOT NULL,
    "cart_id" BIGINT NOT NULL,
    "dish_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_at_add" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cart_item_id")
);

-- CreateTable
CREATE TABLE "cart_item_options" (
    "cart_item_option_id" BIGSERIAL NOT NULL,
    "cart_item_id" BIGINT NOT NULL,
    "option_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price_at_add" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "cart_item_options_pkey" PRIMARY KEY ("cart_item_option_id")
);

-- CreateTable
CREATE TABLE "dish_options" (
    "option_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "dish_options_pkey" PRIMARY KEY ("option_id")
);

-- CreateTable
CREATE TABLE "dish_option_ingredients" (
    "option_id" BIGINT NOT NULL,
    "ingredient_id" BIGINT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    CONSTRAINT "dish_option_ingredients_pkey" PRIMARY KEY ("option_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "dish_available_options" (
    "dish_id" BIGINT NOT NULL,
    "option_id" BIGINT NOT NULL,
    CONSTRAINT "dish_available_options_pkey" PRIMARY KEY ("dish_id","option_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "table_id" BIGINT NOT NULL,
    "waiter_id" BIGINT,
    "total_price" DECIMAL(12,2) NOT NULL,
    "order_status" VARCHAR(30) NOT NULL,
    "payment_status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "order_item_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "dish_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "order_item_options" (
    "order_item_option_id" BIGSERIAL NOT NULL,
    "order_item_id" BIGINT NOT NULL,
    "option_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "order_item_options_pkey" PRIMARY KEY ("order_item_option_id")
);

-- CreateTable
CREATE TABLE "payments" (
    "payment_id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "paid_by" BIGINT,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "age_verifications" (
    "verification_id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "order_id" BIGINT,
    "verified" BOOLEAN NOT NULL,
    "verified_by" BIGINT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "age_verifications_pkey" PRIMARY KEY ("verification_id")
);

-- CreateTable
CREATE TABLE "allergens" (
    "allergen_id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    CONSTRAINT "allergens_pkey" PRIMARY KEY ("allergen_id")
);

-- CreateTable
CREATE TABLE "dish_allergens" (
    "dish_id" BIGINT NOT NULL,
    "allergen_id" BIGINT NOT NULL,
    CONSTRAINT "dish_allergens_pkey" PRIMARY KEY ("dish_id","allergen_id")
);

-- CreateIndex / Unique constraints
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");
CREATE UNIQUE INDEX "tables_table_number_key" ON "tables"("table_number");
CREATE UNIQUE INDEX "tables_monitor_number_key" ON "tables"("monitor_number");
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");
CREATE UNIQUE INDEX "ingredients_name_key" ON "ingredients"("name");
CREATE INDEX "recipes_dish_id_idx" ON "recipes"("dish_id");
CREATE UNIQUE INDEX "inventory_ingredient_id_key" ON "inventory"("ingredient_id");
CREATE INDEX "inventory_reservations_order_id_idx" ON "inventory_reservations"("order_id");
CREATE INDEX "inventory_reservations_order_item_id_idx" ON "inventory_reservations"("order_item_id");
CREATE UNIQUE INDEX "carts_session_id_key" ON "carts"("session_id");
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items"("cart_id");
CREATE INDEX "cart_item_options_cart_item_id_idx" ON "cart_item_options"("cart_item_id");
CREATE INDEX "orders_session_id_idx" ON "orders"("session_id");
CREATE INDEX "orders_table_id_idx" ON "orders"("table_id");
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX "order_item_options_order_item_id_idx" ON "order_item_options"("order_item_id");
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");
CREATE INDEX "age_verifications_session_id_idx" ON "age_verifications"("session_id");
CREATE UNIQUE INDEX "allergens_name_key" ON "allergens"("name");

-- AddForeignKey
ALTER TABLE "restaurant_sessions" ADD CONSTRAINT "restaurant_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("table_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("category_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("dish_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("order_item_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carts" ADD CONSTRAINT "carts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "restaurant_sessions"("session_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("cart_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("dish_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_item_options" ADD CONSTRAINT "cart_item_options_cart_item_id_fkey" FOREIGN KEY ("cart_item_id") REFERENCES "cart_items"("cart_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_item_options" ADD CONSTRAINT "cart_item_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "dish_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_option_ingredients" ADD CONSTRAINT "dish_option_ingredients_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "dish_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_option_ingredients" ADD CONSTRAINT "dish_option_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("ingredient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_available_options" ADD CONSTRAINT "dish_available_options_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("dish_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_available_options" ADD CONSTRAINT "dish_available_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "dish_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "restaurant_sessions"("session_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("table_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_waiter_id_fkey" FOREIGN KEY ("waiter_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("dish_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("order_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "dish_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "restaurant_sessions"("session_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_allergens" ADD CONSTRAINT "dish_allergens_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("dish_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dish_allergens" ADD CONSTRAINT "dish_allergens_allergen_id_fkey" FOREIGN KEY ("allergen_id") REFERENCES "allergens"("allergen_id") ON DELETE RESTRICT ON UPDATE CASCADE;
