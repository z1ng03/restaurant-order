import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "./errors";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small in-memory fixed-window limiter (no extra dependency).
 *
 * LIMITATION (documented in README): state lives in this process. Behind more
 * than one backend instance use a shared store (Redis) or the reverse proxy's
 * limiter instead - this one is defence-in-depth for the single-process demo
 * deployment.
 */
export function rateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(opts.windowMs, 30_000));
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    if (env.rateLimitDisabled) return next();
    const id = opts.key ? opts.key(req) : (req.ip ?? "unknown");
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError(
        429,
        "RATE_LIMITED",
        opts.message ?? "Слишком много запросов. Подождите немного и попробуйте снова.",
      );
    }
    next();
  };
}

/** Failed-login tracker: lock a (email, ip) pair after N consecutive failures. */
export class FailureLockout {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly lockoutMs: number,
  ) {}

  isLocked(key: string): number {
    if (env.rateLimitDisabled) return 0;
    const e = this.entries.get(key);
    if (!e) return 0;
    const remaining = e.lockedUntil - Date.now();
    if (remaining > 0) return remaining;
    if (e.lockedUntil !== 0) this.entries.delete(key); // lock expired
    return 0;
  }

  recordFailure(key: string): void {
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = Date.now() + this.lockoutMs;
      e.failures = 0;
    }
    this.entries.set(key, e);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** test helper */
  reset(): void {
    this.entries.clear();
  }
}
