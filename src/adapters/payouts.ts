import { constants, publicEncrypt } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { CashfreeSettings, Config } from "../config.js";
import { AppError } from "../platform/errors.js";

export interface Transfer {
  /** Ours, also Cashfree's `transfer_id`: up to 40 letters, digits and _. Sending it again never pays twice. */
  transferId: string;
  /** Paise, what reaches the vendor. */
  amount: number;
  /** Letters and spaces, as the bank has it. */
  name: string;
  to: { kind: "bank"; accountNumber: string; ifsc: string } | { kind: "upi"; vpa: string };
}

export interface TransferState {
  status: "pending" | "paid" | "failed";
  /** The bank's reference once paid. */
  utr: string | null;
  /** Cashfree's reason code when it failed, such as INVALID_BENE_VPA. */
  failure: string | null;
}

/** Money out to vendors. Amounts are paise everywhere except on the wire to Cashfree. */
export interface PayoutGateway {
  readonly available: boolean;
  /** Starts the transfer, or reports on it if Cashfree already has it. */
  send(transfer: Transfer): Promise<TransferState>;
  /** Null when Cashfree has no transfer with this id. */
  status(transferId: string): Promise<TransferState | null>;
}

const TIMEOUT_MS = 15_000;
type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const rupees = (paise: number) => Math.round(paise) / 100;
const FAILED = new Set(["FAILED", "REJECTED", "REVERSED", "MANUALLY_REJECTED"]);

function stateOf(body: Json): TransferState {
  const status = String(body.status ?? "");
  if (status === "SUCCESS") return { status: "paid", utr: str(body.transfer_utr), failure: null };
  if (FAILED.has(status)) return { status: "failed", utr: null, failure: str(body.status_code) ?? status };
  return { status: "pending", utr: null, failure: null };
}

/** Cashfree Payouts, API version 2024-01-01, with the bank account or UPI ID sent on each transfer. */
class CashfreePayouts implements PayoutGateway {
  readonly available = true;
  private readonly base: string;

  constructor(
    private readonly settings: CashfreeSettings,
    private readonly log: FastifyBaseLogger,
  ) {
    this.base = settings.env === "production" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout";
  }

  /** Signed requests prove the caller without an allow-listed IP. The signature is valid for 5 minutes. */
  private headers() {
    const { clientId, clientSecret, apiVersion, publicKey } = this.settings;
    const signature = publicKey
      ? publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`)).toString("base64")
      : null;
    return {
      "x-client-id": clientId,
      "x-client-secret": clientSecret,
      "x-api-version": apiVersion,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(signature ? { "x-cf-signature": signature } : {}),
    };
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      this.log.error({ err: (err as Error).message, path }, "Cashfree payouts request failed");
      throw new AppError("PAYOUTS_UNAVAILABLE");
    }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  }

  /** 401 and 403 mean our keys, signature or IP are wrong; those and 5xx leave the payout to be tried again. */
  private refused(status: number, body: Json, path: string): never {
    const level = status === 401 || status === 403 ? "error" : "warn";
    this.log[level]({ status, code: str(body.code), reply: str(body.message), path }, "Cashfree refused the payouts request");
    throw new AppError("PAYOUTS_UNAVAILABLE");
  }

  async status(transferId: string) {
    const path = `/transfers?transfer_id=${encodeURIComponent(transferId)}`;
    const { status, body } = await this.call(path);
    if (status === 404) return null;
    if (status >= 400) this.refused(status, body, "/transfers");
    return stateOf(body);
  }

  async send(transfer: Transfer) {
    const known = await this.status(transfer.transferId);
    if (known) return known;
    const { status, body } = await this.call("/transfers", {
      method: "POST",
      body: JSON.stringify({
        transfer_id: transfer.transferId,
        transfer_amount: rupees(transfer.amount),
        transfer_currency: "INR",
        transfer_mode: transfer.to.kind === "upi" ? "upi" : "banktransfer",
        beneficiary_details: {
          beneficiary_name: transfer.name,
          beneficiary_instrument_details:
            transfer.to.kind === "upi" ? { vpa: transfer.to.vpa } : { bank_account_number: transfer.to.accountNumber, bank_ifsc: transfer.to.ifsc },
        },
        transfer_remarks: "Ruxstar payout",
      }),
    });
    if (status < 300) return stateOf(body);
    // Sent twice at once: the first one is the transfer.
    if (status === 409) return (await this.status(transfer.transferId)) ?? { status: "pending" as const, utr: null, failure: null };
    // Cashfree turned the details down (a bad account number, IFSC or UPI ID): nothing was sent.
    if (status === 400 || status === 422) {
      this.log.warn({ status, code: str(body.code), reply: str(body.message) }, "Cashfree turned a payout down");
      return { status: "failed" as const, utr: null, failure: str(body.code) ?? "INVALID_REQUEST" };
    }
    this.refused(status, body, "/transfers");
  }
}

/** For tests and laptops without keys: transfers are paid at once unless `next` says otherwise. */
export class FakePayouts implements PayoutGateway {
  readonly available = true;
  readonly transfers = new Map<string, Transfer & TransferState>();
  /** How the next new transfer answers. `down` throws as if Cashfree were unreachable. */
  next: "paid" | "pending" | "failed" | "down" = "paid";

  async send(transfer: Transfer) {
    const known = this.transfers.get(transfer.transferId);
    if (known) return { status: known.status, utr: known.utr, failure: known.failure };
    const outcome = this.next;
    this.next = "paid";
    if (outcome === "down") throw new AppError("PAYOUTS_UNAVAILABLE");
    const state: TransferState =
      outcome === "paid"
        ? { status: "paid", utr: `FAKEUTR${this.transfers.size + 1}`, failure: null }
        : { status: outcome, utr: null, failure: outcome === "failed" ? "BENE_BANK_DECLINED" : null };
    this.transfers.set(transfer.transferId, { ...transfer, ...state });
    return state;
  }

  async status(transferId: string) {
    const known = this.transfers.get(transferId);
    return known ? { status: known.status, utr: known.utr, failure: known.failure } : null;
  }

  /** What the bank later says about a pending transfer. */
  settle(transferId: string, status: "paid" | "failed") {
    const known = this.transfers.get(transferId);
    if (!known) return;
    Object.assign(known, status === "paid" ? { status, utr: `FAKEUTR${transferId}`, failure: null } : { status, utr: null, failure: "BENE_BANK_DECLINED" });
  }
}

class UnavailablePayouts implements PayoutGateway {
  readonly available = false;
  async send(): Promise<never> {
    throw new AppError("PAYOUTS_UNAVAILABLE");
  }
  async status(): Promise<never> {
    throw new AppError("PAYOUTS_UNAVAILABLE");
  }
}

export function createPayoutGateway(config: Config, log: FastifyBaseLogger): PayoutGateway {
  if (config.payouts.provider === "fake") return new FakePayouts();
  if (config.payouts.cashfree) return new CashfreePayouts(config.payouts.cashfree, log);
  log.warn("CASHFREE_PAYOUT_CLIENT_ID is not set. Vendors cannot withdraw.");
  return new UnavailablePayouts();
}
