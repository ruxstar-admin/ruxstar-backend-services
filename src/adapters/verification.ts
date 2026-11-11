import { constants, publicEncrypt } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { CashfreeSettings, Config } from "../config.js";
import { AppError } from "../platform/errors.js";

export type DigilockerStatus = "pending" | "authenticated" | "expired" | "denied";

export interface AadhaarDocument {
  /** As printed on the Aadhaar. */
  name: string;
  last4: string;
  /** The Aadhaar photo, for the face match. Kept only until that match is done. */
  photo: Buffer | null;
}

export interface PanResult {
  valid: boolean;
  registeredName: string | null;
  /** Cashfree's grade, for example DIRECT_MATCH or NO_MATCH. */
  nameMatch: string | null;
  message: string | null;
}

export interface GstinResult {
  valid: boolean;
  legalName: string | null;
  /** For example Active or Cancelled. */
  status: string | null;
  message: string | null;
}

/** Identity checks. Cashfree in sandbox and production; a fake for tests and local runs. */
export interface Verifier {
  startDigilocker(verificationId: string, redirectUrl: string): Promise<{ url: string; referenceId: string | null }>;
  digilockerStatus(verificationId: string): Promise<DigilockerStatus>;
  /** Null until DigiLocker has the document ready. */
  aadhaar(verificationId: string): Promise<AadhaarDocument | null>;
  pan(pan: string, name: string): Promise<PanResult>;
  liveness(verificationId: string, selfie: Buffer): Promise<{ live: boolean; score: number | null }>;
  faceMatch(verificationId: string, selfie: Buffer, aadhaarPhoto: Buffer): Promise<{ match: boolean; score: number | null }>;
  gstin(gstin: string, businessName: string): Promise<GstinResult>;
}

/** Below this, Cashfree's face match says NO. v1 used the same. */
const FACE_MATCH_THRESHOLD = "0.75";
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : null);

/** Cashfree's Secure ID (verification) API, version 2024-12-01. */
class CashfreeVerifier implements Verifier {
  private readonly base: string;

  constructor(
    private readonly settings: CashfreeSettings,
    private readonly log: FastifyBaseLogger,
  ) {
    this.base = settings.env === "production" ? "https://api.cashfree.com/verification" : "https://sandbox.cashfree.com/verification";
  }

  /** Signed requests prove the caller without an allow-listed IP. The signature is valid for a few minutes. */
  private headers(extra: Record<string, string> = {}) {
    const { clientId, clientSecret, apiVersion, publicKey } = this.settings;
    const signature = publicKey
      ? publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`)).toString("base64")
      : null;
    return {
      "x-client-id": clientId,
      "x-client-secret": clientSecret,
      "x-api-version": apiVersion,
      ...(signature ? { "x-cf-signature": signature } : {}),
      ...extra,
    };
  }

  /**
   * 400 and 422 are answers about the document (invalid PAN, unknown GSTIN) and come back to the caller.
   * Anything else means we cannot verify right now; 401 and 403 also mean our keys or signature are wrong.
   */
  private async call(path: string, init: RequestInit, { answers = false } = {}): Promise<{ status: number; body: Json }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      this.log.error({ err: (err as Error).message, path }, "Cashfree request failed");
      throw new AppError("KYC_UNAVAILABLE");
    }
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.ok || (answers && (res.status === 400 || res.status === 422))) return { status: res.status, body };
    const level = res.status === 401 || res.status === 403 ? "error" : "warn";
    this.log[level]({ status: res.status, code: str(body.code), reply: str(body.message), path }, "Cashfree refused the request");
    throw new AppError("KYC_UNAVAILABLE");
  }

  private json(path: string, payload: Json, options?: { answers?: boolean }) {
    return this.call(path, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(payload) }, options);
  }

  private form(path: string, fields: Record<string, string>, files: Record<string, Buffer>) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    for (const [name, data] of Object.entries(files)) form.append(name, new Blob([new Uint8Array(data)], { type: "image/jpeg" }), `${name}.jpg`);
    return this.call(path, { method: "POST", headers: this.headers(), body: form }, { answers: true });
  }

  async startDigilocker(verificationId: string, redirectUrl: string) {
    const { body } = await this.json("/digilocker", {
      verification_id: verificationId,
      document_requested: ["AADHAAR"],
      redirect_url: redirectUrl,
      user_flow: "signup",
    });
    const url = str(body.url);
    if (!url) throw new AppError("KYC_UNAVAILABLE");
    return { url, referenceId: body.reference_id != null ? String(body.reference_id) : null };
  }

  async digilockerStatus(verificationId: string): Promise<DigilockerStatus> {
    const { body } = await this.call(`/digilocker?verification_id=${encodeURIComponent(verificationId)}`, { headers: this.headers() });
    const consent = Array.isArray(body.document_consent) ? body.document_consent : [];
    switch (body.status) {
      case "AUTHENTICATED":
        return consent.includes("AADHAAR") ? "authenticated" : "pending";
      case "EXPIRED":
        return "expired";
      case "CONSENT_DENIED":
        return "denied";
      default:
        return "pending";
    }
  }

  async aadhaar(verificationId: string): Promise<AadhaarDocument | null> {
    const { body } = await this.call(`/digilocker/document/AADHAAR?verification_id=${encodeURIComponent(verificationId)}`, { headers: this.headers() });
    if (body.status !== "SUCCESS") return null;
    const last4 = String(body.uid ?? "").replace(/\D/g, "").slice(-4);
    const name = str(body.name);
    if (!name || last4.length !== 4) return null;
    const photo = str(body.photo_link);
    return { name, last4, photo: photo ? Buffer.from(photo.replace(/^data:image\/\w+;base64,/, ""), "base64") : null };
  }

  async pan(pan: string, name: string): Promise<PanResult> {
    const { body } = await this.json("/pan", { pan, name }, { answers: true });
    const valid = body.valid === true && body.pan_status === "VALID";
    // The sandbox knows only Cashfree's test PANs (ABCPV1234D is JOHN DOE) and never grades the name,
    // so a valid sandbox PAN counts as a match. Production always grades it.
    const sandboxMatch = this.settings.env === "sandbox" && valid ? "DIRECT_MATCH" : null;
    return {
      valid,
      registeredName: str(body.registered_name),
      nameMatch: str(body.name_match_result) ?? sandboxMatch,
      message: str(body.message),
    };
  }

  async liveness(verificationId: string, selfie: Buffer) {
    const { body } = await this.form("/face-liveness", { verification_id: verificationId }, { image: selfie });
    return { live: body.status === "SUCCESS" && body.liveness === true, score: num(body.liveness_score) };
  }

  async faceMatch(verificationId: string, selfie: Buffer, aadhaarPhoto: Buffer) {
    const { body } = await this.form(
      "/face-match",
      { verification_id: verificationId, threshold: FACE_MATCH_THRESHOLD },
      { first_image: selfie, second_image: aadhaarPhoto },
    );
    return { match: body.face_match_result === "YES", score: num(body.face_match_score) };
  }

  async gstin(gstin: string, businessName: string): Promise<GstinResult> {
    const { body } = await this.json("/gstin", { GSTIN: gstin, business_name: businessName }, { answers: true });
    return {
      valid: body.valid === true,
      legalName: str(body.legal_name_of_business),
      status: str(body.gst_in_status),
      message: str(body.message),
    };
  }
}

/**
 * Passes every check without calling anyone. DigiLocker sends the user straight back to the return
 * page. Tests flip the switches to see each failure.
 */
export class FakeVerifier implements Verifier {
  digilocker: DigilockerStatus = "authenticated";
  aadhaarName = "Asha Rao";
  panValid = true;
  nameMatch = "DIRECT_MATCH";
  live = true;
  match = true;
  gstinValid = true;
  down = false;
  calls = 0;

  private touch() {
    this.calls++;
    if (this.down) throw new AppError("KYC_UNAVAILABLE");
  }

  async startDigilocker(verificationId: string, redirectUrl: string) {
    this.touch();
    const url = new URL(redirectUrl);
    url.searchParams.set("verification_id", verificationId);
    return { url: url.toString(), referenceId: "fake-ref" };
  }

  async digilockerStatus() {
    this.touch();
    return this.digilocker;
  }

  async aadhaar() {
    this.touch();
    return this.digilocker === "authenticated" ? { name: this.aadhaarName, last4: "1234", photo: Buffer.from("aadhaar-photo") } : null;
  }

  async pan(_pan: string, name: string) {
    this.touch();
    return this.panValid
      ? { valid: true, registeredName: name.toUpperCase(), nameMatch: this.nameMatch, message: null }
      : { valid: false, registeredName: null, nameMatch: null, message: "Invalid PAN" };
  }

  async liveness() {
    this.touch();
    return { live: this.live, score: this.live ? 0.98 : 0.1 };
  }

  async faceMatch() {
    this.touch();
    return { match: this.match, score: this.match ? 0.91 : 0.3 };
  }

  async gstin(_gstin: string, businessName: string) {
    this.touch();
    return this.gstinValid
      ? { valid: true, legalName: businessName.toUpperCase(), status: "Active", message: null }
      : { valid: false, legalName: null, status: null, message: "GSTIN not found" };
  }
}

class UnavailableVerifier implements Verifier {
  private no(): never {
    throw new AppError("KYC_UNAVAILABLE");
  }
  startDigilocker = async () => this.no();
  digilockerStatus = async () => this.no();
  aadhaar = async () => this.no();
  pan = async () => this.no();
  liveness = async () => this.no();
  faceMatch = async () => this.no();
  gstin = async () => this.no();
}

export function createVerifier(config: Config, log: FastifyBaseLogger): Verifier {
  if (config.kyc.provider === "fake") {
    log.warn("KYC_PROVIDER is fake: verification passes without calling Cashfree.");
    return new FakeVerifier();
  }
  if (config.kyc.cashfree) return new CashfreeVerifier(config.kyc.cashfree, log);
  log.warn("CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET are not set. Verification is unavailable.");
  return new UnavailableVerifier();
}
