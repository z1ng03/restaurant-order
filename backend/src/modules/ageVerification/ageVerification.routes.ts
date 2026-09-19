import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import * as ageVerificationService from "./ageVerification.service";

export const ageVerificationRouter = Router();

const verifySchema = z.object({
  sessionId: z.string().regex(/^\d+$/),
  waiterLogin: z.string().min(1),
  waiterPassword: z.string().min(1),
  verified: z.boolean(),
});

ageVerificationRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);
    const result = await ageVerificationService.recordAgeVerification({
      sessionId: BigInt(body.sessionId),
      waiterLogin: body.waiterLogin,
      waiterPassword: body.waiterPassword,
      verified: body.verified,
    });
    res.status(201).json(result);
  }),
);
