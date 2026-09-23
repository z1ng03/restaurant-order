import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { parseIdParam } from "../../lib/params";
import { TABLE_STATUSES, STAFF_ROLES } from "../../types/status";
import * as tablesService from "./admin.tables.service";
import * as ordersService from "./admin.orders.service";
import * as catalogService from "./admin.catalog.service";
import * as usersService from "./admin.users.service";
import * as dashboardService from "./admin.dashboard.service";

export const adminRouter = Router();

// Unlike kitchen/waiter (which also allow ADMIN as a fallback operator
// role), this whole router is ADMIN-only — it's the one place that can
// rewrite the menu, override a table, or void an order.
adminRouter.use(requireAuth, requireRole("ADMIN"));

const idString = z.string().regex(/^\d+$/, "must be a numeric id");

/* -------------------------------- Dashboard ------------------------------- */

adminRouter.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    res.json(await dashboardService.getDashboard());
  }),
);

/* --------------------------------- Tables --------------------------------- */

adminRouter.get(
  "/tables",
  asyncHandler(async (_req, res) => {
    res.json({ tables: await tablesService.listTables() });
  }),
);

const createTableSchema = z.object({
  tableNumber: z.number().int().positive(),
  monitorNumber: z.number().int().positive(),
});

adminRouter.post(
  "/tables",
  asyncHandler(async (req, res) => {
    const body = createTableSchema.parse(req.body);
    res.status(201).json({ table: await tablesService.createTable(body) });
  }),
);

const updateTableSchema = z.object({
  tableNumber: z.number().int().positive().optional(),
  monitorNumber: z.number().int().positive().optional(),
});

adminRouter.patch(
  "/tables/:tableId",
  asyncHandler(async (req, res) => {
    const tableId = parseIdParam(req.params.tableId, "tableId");
    const body = updateTableSchema.parse(req.body);
    res.json({ table: await tablesService.updateTable(tableId, body) });
  }),
);

const setTableStatusSchema = z.object({ status: z.enum(TABLE_STATUSES) });

adminRouter.patch(
  "/tables/:tableId/status",
  asyncHandler(async (req, res) => {
    const tableId = parseIdParam(req.params.tableId, "tableId");
    const { status } = setTableStatusSchema.parse(req.body);
    res.json({ table: await tablesService.setTableStatus(tableId, status) });
  }),
);

adminRouter.delete(
  "/tables/:tableId",
  asyncHandler(async (req, res) => {
    const tableId = parseIdParam(req.params.tableId, "tableId");
    await tablesService.deleteTable(tableId);
    res.status(204).end();
  }),
);

/* --------------------------------- Orders ---------------------------------- */

const listOrdersQuerySchema = z.object({
  status: z.string().optional(),
  tableId: idString.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
  cursor: idString.optional(),
});

adminRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const query = listOrdersQuerySchema.parse(req.query);
    const result = await ordersService.listOrders({
      status: ordersService.assertValidOrderStatusFilter(query.status),
      tableId: query.tableId ? BigInt(query.tableId) : undefined,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      cursor: query.cursor ? BigInt(query.cursor) : undefined,
    });
    res.json(result);
  }),
);

adminRouter.get(
  "/orders/:orderId",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    res.json({ order: await ordersService.getOrder(orderId) });
  }),
);

adminRouter.post(
  "/orders/:orderId/cancel",
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.orderId, "orderId");
    res.json({ order: await ordersService.cancelOrder(orderId) });
  }),
);

/* ------------------------------- Categories -------------------------------- */

adminRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    res.json({ categories: await catalogService.listCategories() });
  }),
);

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.post(
  "/categories",
  asyncHandler(async (req, res) => {
    const body = createCategorySchema.parse(req.body);
    res.status(201).json({ category: await catalogService.createCategory(body) });
  }),
);

const updateCategorySchema = createCategorySchema.partial().extend({ isActive: z.boolean().optional() });

adminRouter.patch(
  "/categories/:categoryId",
  asyncHandler(async (req, res) => {
    const categoryId = parseIdParam(req.params.categoryId, "categoryId");
    const body = updateCategorySchema.parse(req.body);
    res.json({ category: await catalogService.updateCategory(categoryId, body) });
  }),
);

/* ------------------------------- Ingredients -------------------------------- */

adminRouter.get(
  "/ingredients",
  asyncHandler(async (_req, res) => {
    res.json({ ingredients: await catalogService.listIngredients() });
  }),
);

const createIngredientSchema = z.object({
  name: z.string().min(1).max(150),
  unit: z.enum(["g", "kg", "ml", "l", "pcs"]),
  initialStock: z.number().min(0).default(0),
});

adminRouter.post(
  "/ingredients",
  asyncHandler(async (req, res) => {
    const body = createIngredientSchema.parse(req.body);
    res.status(201).json({ ingredient: await catalogService.createIngredient(body) });
  }),
);

const updateIngredientSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  unit: z.enum(["g", "kg", "ml", "l", "pcs"]).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch(
  "/ingredients/:ingredientId",
  asyncHandler(async (req, res) => {
    const ingredientId = parseIdParam(req.params.ingredientId, "ingredientId");
    const body = updateIngredientSchema.parse(req.body);
    res.json({ ingredient: await catalogService.updateIngredient(ingredientId, body) });
  }),
);

const setStockSchema = z.object({ stockQuantity: z.number().min(0) });

adminRouter.patch(
  "/ingredients/:ingredientId/stock",
  asyncHandler(async (req, res) => {
    const ingredientId = parseIdParam(req.params.ingredientId, "ingredientId");
    const { stockQuantity } = setStockSchema.parse(req.body);
    res.json({ inventory: await catalogService.setIngredientStock(ingredientId, stockQuantity) });
  }),
);

/* ---------------------------------- Dishes ---------------------------------- */

const recipeLineSchema = z.object({ ingredientId: idString, quantity: z.number().positive() });

const dishWriteSchema = z.object({
  categoryId: idString.optional(),
  name: z.string().min(1).max(150).optional(),
  price: z.number().nonnegative().optional(),
  imageUrl: z.string().max(2000).optional(),
  description: z.string().max(4000).optional(),
  is21Plus: z.boolean().optional(),
  isActive: z.boolean().optional(),
  recipe: z.array(recipeLineSchema).optional(),
  allergenIds: z.array(idString).optional(),
  availableOptionIds: z.array(idString).optional(),
});

function toDishServiceInput(body: z.infer<typeof dishWriteSchema>) {
  return {
    ...body,
    categoryId: body.categoryId ? BigInt(body.categoryId) : undefined,
    recipe: body.recipe?.map((r) => ({ ingredientId: BigInt(r.ingredientId), quantity: r.quantity })),
    allergenIds: body.allergenIds?.map((id) => BigInt(id)),
    availableOptionIds: body.availableOptionIds?.map((id) => BigInt(id)),
  };
}

adminRouter.get(
  "/dishes",
  asyncHandler(async (req, res) => {
    const categoryId = req.query.categoryId ? parseIdParam(String(req.query.categoryId), "categoryId") : undefined;
    res.json({ dishes: await catalogService.listDishes({ categoryId }) });
  }),
);

adminRouter.get(
  "/dishes/:dishId",
  asyncHandler(async (req, res) => {
    const dishId = parseIdParam(req.params.dishId, "dishId");
    res.json({ dish: await catalogService.getDish(dishId) });
  }),
);

adminRouter.post(
  "/dishes",
  asyncHandler(async (req, res) => {
    const body = dishWriteSchema
      .extend({ categoryId: idString, name: z.string().min(1).max(150), price: z.number().nonnegative() })
      .parse(req.body);
    const dish = await catalogService.createDish(
      toDishServiceInput(body) as Parameters<typeof catalogService.createDish>[0],
    );
    res.status(201).json({ dish });
  }),
);

adminRouter.patch(
  "/dishes/:dishId",
  asyncHandler(async (req, res) => {
    const dishId = parseIdParam(req.params.dishId, "dishId");
    const body = dishWriteSchema.parse(req.body);
    res.json({ dish: await catalogService.updateDish(dishId, toDishServiceInput(body)) });
  }),
);

/* ------------------------------- Dish options -------------------------------- */

const optionIngredientSchema = z.object({ ingredientId: idString, quantity: z.number().positive() });

const optionWriteSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  price: z.number().nonnegative().optional(),
  description: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  ingredients: z.array(optionIngredientSchema).optional(),
});

function toOptionServiceInput(body: z.infer<typeof optionWriteSchema>) {
  return {
    ...body,
    ingredients: body.ingredients?.map((i) => ({ ingredientId: BigInt(i.ingredientId), quantity: i.quantity })),
  };
}

adminRouter.get(
  "/options",
  asyncHandler(async (_req, res) => {
    res.json({ options: await catalogService.listOptions() });
  }),
);

adminRouter.post(
  "/options",
  asyncHandler(async (req, res) => {
    const body = optionWriteSchema.extend({ name: z.string().min(1).max(100), price: z.number().nonnegative() }).parse(req.body);
    const option = await catalogService.createOption(
      toOptionServiceInput(body) as Parameters<typeof catalogService.createOption>[0],
    );
    res.status(201).json({ option });
  }),
);

adminRouter.patch(
  "/options/:optionId",
  asyncHandler(async (req, res) => {
    const optionId = parseIdParam(req.params.optionId, "optionId");
    const body = optionWriteSchema.parse(req.body);
    res.json({ option: await catalogService.updateOption(optionId, toOptionServiceInput(body)) });
  }),
);

/* -------------------------------- Allergens ---------------------------------- */

adminRouter.get(
  "/allergens",
  asyncHandler(async (_req, res) => {
    res.json({ allergens: await catalogService.listAllergens() });
  }),
);

const allergenWriteSchema = z.object({ name: z.string().min(1).max(100), description: z.string().max(2000).optional() });

adminRouter.post(
  "/allergens",
  asyncHandler(async (req, res) => {
    const body = allergenWriteSchema.parse(req.body);
    res.status(201).json({ allergen: await catalogService.createAllergen(body) });
  }),
);

adminRouter.patch(
  "/allergens/:allergenId",
  asyncHandler(async (req, res) => {
    const allergenId = parseIdParam(req.params.allergenId, "allergenId");
    const body = allergenWriteSchema.partial().parse(req.body);
    res.json({ allergen: await catalogService.updateAllergen(allergenId, body) });
  }),
);

/* ---------------------------------- Staff ------------------------------------ */

adminRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    res.json({ users: await usersService.listUsers() });
  }),
);

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  login: z.string().min(3).max(100),
  password: z.string().min(6).max(200),
  role: z.enum(STAFF_ROLES),
});

adminRouter.post(
  "/users",
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    res.status(201).json({ user: await usersService.createUser(body) });
  }),
);

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(STAFF_ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).max(200).optional(),
});

adminRouter.patch(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    const userId = parseIdParam(req.params.userId, "userId");
    const body = updateUserSchema.parse(req.body);
    res.json({ user: await usersService.updateUser(userId, body) });
  }),
);
