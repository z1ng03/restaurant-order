import { prisma } from "../src/db/prisma";

/** The demo seed writes a rating directly: there is no HTTP request (and no kiosk) behind it. */
export async function rateOrderForSeed(clientUserId: bigint, orderId: bigint, rating: number) {
  await prisma.orderRating.create({ data: { orderId, clientUserId, rating } });
}
