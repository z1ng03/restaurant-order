import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import { assertKioskAccess } from "../../middleware/kiosk.middleware";
import { rateLimit } from "../../lib/rateLimit";
import * as ageVerificationService from "./ageVerification.service";

export const ageVerificationRouter = Router();

ageVerificationRouter.post("/rfid/enroll",
  rateLimit({ name: "rfid-enroll", windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ waiterLogin: z.string().min(1), waiterPassword: z.string().min(1), uid: z.string().max(29) }).parse(req.body);
    res.json(await ageVerificationService.enrollWaiterBadge(body));
  }),
);

ageVerificationRouter.post("/rfid",
  rateLimit({ name: "rfid-age", windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ sessionId: z.string().regex(/^\d+$/), uid: z.string().max(29) }).parse(req.body);
    await assertKioskAccess(req, BigInt(body.sessionId), "write");
    res.status(201).json(await ageVerificationService.recordRfidAgeVerification({ sessionId: BigInt(body.sessionId), uid: body.uid }));
  }),
);

const verifySchema = z.object({
  sessionId: z.string().regex(/^\d+$/),
  waiterLogin: z.string().min(1),
  waiterPassword: z.string().min(1),
  verified: z.boolean(),
});

ageVerificationRouter.post(
  "/",
  // A waiter's password is typed on a guest-facing terminal: throttle guessing per IP + session.
  rateLimit({
    name: "age-verification",
    windowMs: 60_000,
    max: 10,
    key: (req) => `${req.ip}|${typeof req.body?.sessionId === "string" ? req.body.sessionId : ""}`,
    message: "Слишком много попыток подтверждения возраста. Подождите минуту.",
  }),
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);
    // Only the terminal that owns this table session may start a staff check on it.
    await assertKioskAccess(req, BigInt(body.sessionId), "write");
    const result = await ageVerificationService.recordAgeVerification({
      sessionId: BigInt(body.sessionId),
      waiterLogin: body.waiterLogin,
      waiterPassword: body.waiterPassword,
      verified: body.verified,
    });
    res.status(201).json(result);
  }),
);
