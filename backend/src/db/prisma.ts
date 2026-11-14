import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

/**
 * Single place that knows how a PrismaClient is built. Seeds and scripts call
 * this too, so there is exactly one construction path (and one place to change
 * if a driver adapter is ever introduced).
 */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
  });
}

// A single shared PrismaClient instance. Re-creating it per-request (or per
// hot-reload in dev) exhausts Postgres connections, so we stash it on
// `globalThis` in development to survive `tsx watch` reloads.
declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

export const prisma = global.__prisma__ ?? createPrismaClient();

if (env.nodeEnv === "development") {
  global.__prisma__ = prisma;
}
