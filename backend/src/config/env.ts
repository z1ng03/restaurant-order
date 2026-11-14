import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

/** KIOSK_DEVICE_SECRETS="1:secretA,2:secretB" -> { 1: "secretA", 2: "secretB" } (monitor number -> secret). */
function parseDeviceSecrets(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [monitor, ...rest] = part.split(":");
    const secret = rest.join(":").trim();
    if (monitor && secret) out[monitor.trim()] = secret;
  }
  return out;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";
const jwtSecret = required("JWT_SECRET");

// Client tokens use their OWN secret so a staff token can never be replayed as a
// client token (or vice versa). In development it is derived from JWT_SECRET.
const clientJwtSecret = str("CLIENT_JWT_SECRET") ?? (isProduction ? required("CLIENT_JWT_SECRET") : `${jwtSecret}::client`);

if (isProduction) {
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters in production");
  if (clientJwtSecret.length < 32) throw new Error("CLIENT_JWT_SECRET must be at least 32 characters in production");
  if (clientJwtSecret === jwtSecret) throw new Error("CLIENT_JWT_SECRET must differ from JWT_SECRET");
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
  corsOrigin: (process.env.CORS_ORIGIN ?? "*").split(",").map((s) => s.trim()),
  nodeEnv,
  isProduction,

  /** Public base URL of the static frontend (used in e-mails / Telegram messages). */
  frontendBaseUrl: (str("FRONTEND_BASE_URL") ?? "http://localhost:8000").replace(/\/+$/, ""),

  // ---- client accounts ------------------------------------------------------
  clientJwtSecret,
  clientJwtExpiresIn: process.env.CLIENT_JWT_EXPIRES_IN ?? "8h",
  /** Brute-force protection for login (per e-mail + IP). */
  loginMaxFailures: num("LOGIN_MAX_FAILURES", 5),
  loginLockoutMinutes: num("LOGIN_LOCKOUT_MINUTES", 15),
  /** Tests switch the in-memory limiters off. Never disable in production. */
  rateLimitDisabled: !isProduction && bool("RATE_LIMIT_DISABLED", false),

  // ---- kiosk session secret (TZ §5.2) ----------------------------------------
  /** Forced to true in production. Set KIOSK_TOKEN_ENFORCED=false ONLY for legacy local tooling. */
  kioskTokenEnforced: isProduction ? true : bool("KIOSK_TOKEN_ENFORCED", true),
  /** After a table session ends its tracker/receipt stay readable for this long (guest "Подан" view). */
  kioskTokenGraceMinutes: num("KIOSK_TOKEN_GRACE_MINUTES", 30),
  /** Pre-registered device secrets: required by POST /sessions/open in production. */
  kioskDeviceSecrets: parseDeviceSecrets(process.env.KIOSK_DEVICE_SECRETS),

  // ---- loyalty -----------------------------------------------------------------
  /** Cashback earned on the MONEY actually paid (5% by default), rounded down to whole bonuses. */
  cashbackRate: num("CASHBACK_RATE", 0.05),
  /** Max share of an order that bonuses may cover (50% by default). 1 bonus = 1 KZT. */
  cashbackRedemptionCap: num("CASHBACK_REDEMPTION_CAP", 0.5),

  // ---- identity / 21+ ----------------------------------------------------------
  /** The "demo" identity check is a classroom simulation: always off in production. */
  demoIdentityVerification: !isProduction && bool("DEMO_IDENTITY_VERIFICATION", true),
  identityVerificationTtlDays: num("IDENTITY_VERIFICATION_TTL_DAYS", 365),

  // ---- receipts (demo / non-fiscal unless a real provider is configured) ------
  // Server-side config only: no secrets or merchant identifiers ever live in frontend JS.
  merchant: {
    name: str("MERCHANT_NAME") ?? "Демо-ресторан Restaurant Order",
    address: str("MERCHANT_ADDRESS") ?? "Алматы, пр. Абылай хана, 104 - демонстрационные данные",
    taxId: str("MERCHANT_TAX_ID") ?? "Тестовый БИН, не действителен",
    kkmSerial: str("KKM_SERIAL") ?? "DEMO (не настроено)",
    kkmRegNumber: str("KKM_REG_NUMBER") ?? "DEMO (не настроено)",
    ofdName: str("OFD_NAME") ?? null,
    ofdUrl: str("OFD_URL") ?? null,
    /** e.g. "12" (%). Unset = VAT is NOT printed: we never invent an unconfirmed rate. */
    vatRatePercent: str("MERCHANT_VAT_RATE_PERCENT") ?? null,
  },

  smtp: {
    host: str("SMTP_HOST"),
    port: num("SMTP_PORT", 587),
    user: str("SMTP_USER"),
    pass: str("SMTP_PASS"),
    from: str("SMTP_FROM"),
    secure: bool("SMTP_SECURE", false),
  },

  telegram: {
    botToken: str("TELEGRAM_BOT_TOKEN"),
    botUsername: str("TELEGRAM_BOT_USERNAME"),
    webhookSecret: str("TELEGRAM_WEBHOOK_SECRET"),
  },
};
