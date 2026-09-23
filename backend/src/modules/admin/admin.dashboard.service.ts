import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";

export async function getDashboard() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [tablesFree, tablesOccupied, ordersByStatus, todaysPayments, lowestStock, activeSessions] = await Promise.all([
    prisma.restaurantTable.count({ where: { status: "FREE" } }),
    prisma.restaurantTable.count({ where: { status: "OCCUPIED" } }),
    prisma.order.groupBy({ by: ["orderStatus"], _count: { orderStatus: true } }),
    prisma.payment.findMany({ where: { status: "PAID", paidAt: { gte: startOfToday } }, select: { amount: true } }),
    prisma.inventory.findMany({
      orderBy: { stockQuantity: "asc" },
      take: 5,
      include: { ingredient: true },
    }),
    prisma.restaurantSession.count({ where: { status: "ACTIVE" } }),
  ]);

  const todaysRevenue = todaysPayments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

  return {
    tables: { free: tablesFree, occupied: tablesOccupied },
    activeSessions,
    ordersByStatus: Object.fromEntries(ordersByStatus.map((o) => [o.orderStatus, o._count.orderStatus])),
    todaysRevenue,
    todaysPaidOrderCount: todaysPayments.length,
    lowestStockIngredients: lowestStock.map((inv) => ({
      ingredientId: inv.ingredientId,
      name: inv.ingredient.name,
      unit: inv.ingredient.unit,
      free: inv.stockQuantity.minus(inv.reservedQuantity),
    })),
  };
}
