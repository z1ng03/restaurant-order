import "./lib/bigint-json"; // must be imported before any res.json() call

import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { authRouter } from "./modules/auth/auth.routes";
import { tablesRouter } from "./modules/tables/tables.routes";
import { sessionsRouter } from "./modules/sessions/sessions.routes";
import { menuRouter } from "./modules/menu/menu.routes";
import { cartRouter } from "./modules/cart/cart.routes";
import { checkoutRouter } from "./modules/checkout/checkout.routes";
import { ageVerificationRouter } from "./modules/ageVerification/ageVerification.routes";
import { kitchenRouter } from "./modules/kitchen/kitchen.routes";
import { waiterRouter } from "./modules/waiter/waiter.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { clientAuthRouter } from "./modules/clientAuth/clientAuth.routes";
import { clientAccountRouter } from "./modules/clientAccount/clientAccount.routes";
import { ordersReceiptRouter } from "./modules/receipts/receipts.routes";
import { orderTrackingRouter } from "./modules/orderTracking/orderTracking.routes";
import { telegramRouter } from "./modules/integrations/telegram.routes";

export function createApp() {
  const app = express();

  // Behind a reverse proxy set TRUST_PROXY=1 so req.ip (rate limits, login lockout) is the real client address.
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(cors({ origin: env.corsOrigin.includes("*") ? true : env.corsOrigin }));
  // The identity-document upload (base64 inside JSON) is the only route that needs a bigger body. Its parser must
  // run BEFORE the global one (body-parser skips a body that was already read), and only for POST.
  app.post("/api/client-account/identity-verification", express.json({ limit: "5mb" }));
  app.use(express.json());

  // Responses here are live operational state (stock, order status, cart). Nothing must be cached
  // by the browser or a proxy, otherwise a monitor could show an item as available long after it sold out.
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/tables", tablesRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/menu", menuRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/checkout", checkoutRouter);
  app.use("/api/age-verification", ageVerificationRouter);
  app.use("/api/kitchen", kitchenRouter);
  app.use("/api/waiter", waiterRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/client-auth", clientAuthRouter);
  app.use("/api/client-account", clientAccountRouter);
  app.use("/api/orders", ordersReceiptRouter);
  app.use("/api/order-tracking", orderTrackingRouter);
  app.use("/api/integrations/telegram", telegramRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
