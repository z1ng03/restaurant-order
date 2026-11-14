import type { Prisma } from "@prisma/client";

/**
 * Extension point for a real cash-register / OFD integration (Казахстан: ОФД / ККМ).
 *
 * Today only DemoFiscalProvider exists, and it NEVER pretends to be fiscal: every receipt it
 * produces is kind = DEMO, fiscal_status = NOT_CONFIGURED, with no fiscal sign and no OFD. A real
 * provider is wired in by implementing this interface and returning it from getFiscalProvider().
 *
 * Contract for a real provider: issue() must be idempotent per order - calling it twice for the
 * same payment must return the SAME fiscal reference/sign (never mint a second number). Because
 * network calls do not belong inside the payment transaction, a real implementation should
 * return fiscalStatus "PENDING" immediately and complete the receipt asynchronously (the
 * receipts trigger lets fiscal_status / fiscal_reference / verification_url change later while
 * the snapshot itself stays immutable).
 */
export interface FiscalIssueInput {
  orderId: bigint;
  receiptNumber: string;
  paidTotal: string;
  paidAt: Date;
  payload: Prisma.InputJsonObject;
}

export interface FiscalIssueResult {
  kind: "DEMO" | "FISCAL";
  fiscalStatus: "NOT_CONFIGURED" | "PENDING" | "SUCCEEDED" | "FAILED";
  fiscalReference: string | null;
  /** фискальный признак - only ever set by a real provider */
  fiscalSign: string | null;
  ofdName: string | null;
  verificationUrl: string | null;
}

export interface FiscalReceiptProvider {
  readonly name: string;
  issue(input: FiscalIssueInput): Promise<FiscalIssueResult>;
}

export class DemoFiscalProvider implements FiscalReceiptProvider {
  readonly name = "demo";

  async issue(): Promise<FiscalIssueResult> {
    return {
      kind: "DEMO",
      fiscalStatus: "NOT_CONFIGURED",
      fiscalReference: null,
      fiscalSign: null,
      ofdName: null,
      verificationUrl: null,
    };
  }
}

let provider: FiscalReceiptProvider = new DemoFiscalProvider();

export function getFiscalProvider(): FiscalReceiptProvider {
  return provider;
}

/** Test seam / composition root hook for a real provider. */
export function setFiscalProvider(next: FiscalReceiptProvider): void {
  provider = next;
}
