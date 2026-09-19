import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error.middleware";
import * as authService from "./auth.service";

export const authRouter = Router();

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { login, password } = loginSchema.parse(req.body);
    const result = await authService.login(login, password);
    res.json(result);
  }),
);
