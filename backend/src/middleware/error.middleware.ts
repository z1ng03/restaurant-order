import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";

/** Wraps an async route handler so thrown/rejected errors reach errorHandler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.flatten() },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Record not found" } });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({
        error: { code: "UNIQUE_CONSTRAINT", message: "A record with that value already exists", details: err.meta },
      });
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.error("Unhandled error:", err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}
