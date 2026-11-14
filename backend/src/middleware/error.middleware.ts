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

/** Postgres SQLSTATE of a failed raw query / constraint, however Prisma surfaced it. */
function sqlState(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  if (typeof meta?.code === "string") return meta.code;
  const original = meta?.driverAdapterError?.cause?.originalCode;
  return typeof original === "string" ? original : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Некорректный запрос", details: err.flatten() },
    });
    return;
  }

  // express.json() failures
  const bodyErr = err as { type?: string; status?: number } | null;
  if (bodyErr && typeof bodyErr === "object" && bodyErr.type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Слишком большой запрос" } });
    return;
  }
  if (bodyErr && typeof bodyErr === "object" && bodyErr.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Тело запроса не является корректным JSON" } });
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
    if (err.code === "P2003") {
      res.status(409).json({
        error: {
          code: "REFERENCE_CONSTRAINT",
          message: "Запись связана с другими данными и не может быть изменена или удалена",
        },
      });
      return;
    }
    if (err.code === "P2034") {
      res.status(409).json({
        error: { code: "TRY_AGAIN", message: "Конфликт одновременных операций, повторите запрос" },
      });
      return;
    }
    // Raw queries surface SQLSTATE through P2010 (or P2004 for model queries).
    const state = sqlState(err);
    if (state === "40001" || state === "40P01") {
      res.status(409).json({
        error: { code: "TRY_AGAIN", message: "Конфликт одновременных операций, повторите запрос" },
      });
      return;
    }
    if (state === "23514" || state === "23505" || state === "23503" || err.code === "P2004") {
      res.status(409).json({
        error: { code: "DB_CONSTRAINT_VIOLATION", message: "Операция нарушает ограничение целостности данных" },
      });
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.error("Unhandled error:", err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}
