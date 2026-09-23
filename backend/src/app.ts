import "./lib/bigint-json"; // must be imported before any res.json() call

import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { tablesRouter } from "./modules/tables/tables.routes";
import { sessionsRouter } from "./modules/sessions/sessions.routes";
import { menuRouter } from "./modules/menu/menu.routes";
import { cartRouter } from "./modules/cart/cart.routes";
import { checkoutRouter } from "./modules/checkout/checkout.routes";
import { ageVerificationRouter } from "./modules/ageVerification/ageVerification.routes";
import { kitchenRouter } from "./modules/kitchen/kitchen.routes";
import { waiterRouter } from "./modules/waiter/waiter.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { adminRouter } from "./modules/admin/admin.routes";

export const app = express();

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/tables", tablesRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/menu", menuRouter);
app.use("/api/cart", cartRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/age-verification", ageVerificationRouter);
app.use("/api/kitchen", kitchenRouter);
app.use("/api/waiter", waiterRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
