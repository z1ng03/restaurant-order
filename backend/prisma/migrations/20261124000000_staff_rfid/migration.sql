ALTER TABLE "users" ADD COLUMN "rfid_uid" VARCHAR(29);
CREATE UNIQUE INDEX "users_rfid_uid_key" ON "users"("rfid_uid");
