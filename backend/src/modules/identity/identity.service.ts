import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { AppError } from "../../lib/errors";
import type { Tx } from "../../lib/prismaTx";

/**
 * FR-05 - identity (age) verification of a client account.
 *
 *  - There is NO real identity provider in this project. What exists is a clearly labelled DEMO mode
 *    (a classroom simulation) that is OFF in production: there it is refused (DEMO_MODE_DISABLED) and a
 *    DEMO verification is never accepted as a 21+ waiver even if a row somehow exists.
 *  - The raw document is never stored: the upload is written to a private temp file only for the duration
 *    of the request (hashed, "processed"), then deleted in `finally`. Only an opaque reference is kept.
 *  - A client can never mark themself verified: the only way to VERIFIED is the explicit demo-approve action
 *    (demo mode only) or, in future, a provider callback implementing IdentityVerificationProvider.
 */

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export type EffectiveIdentityStatus = "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED" | "EXPIRED";

export interface IdentityStatusView {
  status: EffectiveIdentityStatus;
  mode: "DEMO" | "PROVIDER" | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  /** may this verification be used as a 21+ waiver right now? */
  ageVerified: boolean;
  demoModeAvailable: boolean;
}

type Row = { status: string; mode: string; verifiedAt: Date | null; expiresAt: Date | null } | null;

/** Pure: collapses the latest verification row into what the rest of the system may rely on. */
export function evaluateIdentity(row: Row, now = new Date()): IdentityStatusView {
  const demoModeAvailable = env.demoIdentityVerification;
  if (!row) {
    return { status: "UNVERIFIED", mode: null, verifiedAt: null, expiresAt: null, ageVerified: false, demoModeAvailable };
  }
  const mode = row.mode === "PROVIDER" ? "PROVIDER" : "DEMO";
  let status = row.status as EffectiveIdentityStatus;
  if (status === "VERIFIED" && row.expiresAt && row.expiresAt.getTime() <= now.getTime()) status = "EXPIRED";
  // A DEMO result is only ever honoured while demo mode is enabled (never in production).
  const modeAllowed = mode === "PROVIDER" || env.demoIdentityVerification;
  return {
    status,
    mode,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    ageVerified: status === "VERIFIED" && modeAllowed,
    demoModeAvailable,
  };
}

export async function getIdentityStatus(clientUserId: bigint, db: Tx = prisma): Promise<IdentityStatusView> {
  const latest = await db.clientIdentityVerification.findFirst({
    where: { clientUserId },
    orderBy: [{ createdAt: "desc" }, { verificationId: "desc" }],
  });
  return evaluateIdentity(latest);
}

export async function isClientAgeVerified(db: Tx, clientUserId: bigint): Promise<boolean> {
  return (await getIdentityStatus(clientUserId, db)).ageVerified;
}

// ----------------------------------------------------------------------------

function sniffDocument(buf: Buffer): "jpeg" | "png" | "pdf" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  return null;
}

export async function submitIdentityVerification(args: { clientUserId: bigint; fileBase64: string | undefined }) {
  if (!env.demoIdentityVerification) {
    // No real provider is integrated; refuse honestly instead of pretending.
    throw new AppError(
      503,
      "IDENTITY_PROVIDER_NOT_CONFIGURED",
      "Проверка личности не подключена. Подтвердите возраст у официанта.",
    );
  }

  const current = await getIdentityStatus(args.clientUserId);
  if (current.status === "PENDING") return current; // idempotent: one open request at a time
  if (current.status === "VERIFIED") return current;

  if (!args.fileBase64) {
    throw new AppError(400, "VALIDATION_ERROR", "Приложите фото или скан документа");
  }
  const cleaned = args.fileBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (cleaned.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Файл слишком большой (максимум 3 МБ)");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Файл слишком большой (максимум 3 МБ)");
  }
  const kind = sniffDocument(buf);
  if (!kind) {
    throw new AppError(400, "INVALID_FILE", "Допустимы только JPEG, PNG или PDF");
  }

  // The document exists on disk only while the request is being handled.
  const dir = await mkdtemp(path.join(tmpdir(), "ro-identity-"));
  let reference: string;
  try {
    const file = path.join(dir, `upload.${kind}`);
    await writeFile(file, buf, { mode: 0o600 });
    reference = `demo:${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`;
    // (a real provider adapter would stream the file to the provider here)
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await prisma.clientIdentityVerification.create({
    data: { clientUserId: args.clientUserId, status: "PENDING", mode: "DEMO", providerReference: reference },
  });
  return getIdentityStatus(args.clientUserId);
}

/**
 * Demo-only approval of the open request. In production this refuses with DEMO_MODE_DISABLED.
 * It is an explicit server-side action - the client cannot send `verified: true` to anything.
 */
export async function demoApproveIdentity(clientUserId: bigint) {
  if (!env.demoIdentityVerification) {
    throw new AppError(403, "DEMO_MODE_DISABLED", "Демо-подтверждение отключено");
  }
  const pending = await prisma.clientIdentityVerification.findFirst({
    where: { clientUserId, status: "PENDING" },
    orderBy: { verificationId: "desc" },
  });
  if (!pending) {
    throw new AppError(409, "IDENTITY_VERIFICATION_REQUIRED", "Сначала отправьте документ на проверку");
  }
  const now = new Date();
  await prisma.clientIdentityVerification.update({
    where: { verificationId: pending.verificationId },
    data: {
      status: "VERIFIED",
      mode: "DEMO",
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + env.identityVerificationTtlDays * 86_400_000),
    },
  });
  return getIdentityStatus(clientUserId);
}

/** Removes every verification record of an account (account deletion). */
export async function deleteIdentityRecords(tx: Tx, clientUserId: bigint): Promise<void> {
  await tx.clientIdentityVerification.deleteMany({ where: { clientUserId } });
}
