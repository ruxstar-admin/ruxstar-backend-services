import type { FastifyInstance, FastifyError } from "fastify";

/**
 * Stable error codes. Clients branch on `code`, so a code is never renamed or reused.
 * Add new ones at the end of their group.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, message: "Some fields are missing or invalid." },
  BAD_REQUEST: { status: 400, message: "The request could not be read." },
  CLIENT_HEADER_REQUIRED: { status: 400, message: "Send X-Client as web, app or delivery." },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: "Send an Idempotency-Key header for this request." },
  UNAUTHENTICATED: { status: 401, message: "Sign in to continue." },
  FORBIDDEN: { status: 403, message: "You do not have access to this." },
  KYC_REQUIRED: { status: 403, message: "Finish verification to continue." },
  NOT_FOUND: { status: 404, message: "Not found." },
  CONFLICT: { status: 409, message: "This changed while you were working. Refresh and try again." },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "The first attempt is still running. Try again in a moment." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request is too large." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Send JSON." },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: "This Idempotency-Key was already used for a different request." },
  UPGRADE_REQUIRED: { status: 426, message: "Update the app to keep using Ruxstar." },
  RATE_LIMITED: { status: 429, message: "Too many attempts. Wait a moment and try again." },
  INTERNAL: { status: 500, message: "Something went wrong on our side." },
  MODULE_OFF: { status: 503, message: "This service is paused right now. Try again later." },
  NOT_READY: { status: 503, message: "The service is starting up." },
  // Account
  PHONE_TAKEN: { status: 409, message: "This number already has an account. Sign in instead." },
  USERNAME_TAKEN: { status: 409, message: "That username is taken. Try another." },
  OTP_INVALID: { status: 422, message: "That code is not right. Check the SMS and try again." },
  OTP_EXPIRED: { status: 422, message: "That code has expired. Ask for a new one." },
  OTP_LIMIT: { status: 429, message: "Too many codes or attempts. Try again later." },
  VERIFICATION_INVALID: { status: 422, message: "Your verification has expired. Start again." },
  INVALID_CREDENTIALS: { status: 401, message: "That number and password do not match." },
  ACCOUNT_LOCKED: { status: 423, message: "Too many wrong passwords. Try again in a few minutes or reset your password." },
  PASSWORD_REUSED: { status: 422, message: "Choose a password you have not used recently." },
  SMS_UNAVAILABLE: { status: 503, message: "We cannot send codes right now. Try again shortly." },
  LOCATION_UNAVAILABLE: { status: 503, message: "We could not find your city right now. Type it instead." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetail {
  path?: string;
  message: string;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message ?? ERROR_CODES[code].message);
    this.name = "AppError";
    this.status = ERROR_CODES[code].status;
  }
}

export const errorBody = (code: ErrorCode, message?: string, details: ErrorDetail[] = []) => ({
  error: { code, message: message ?? ERROR_CODES[code].message, details },
});

const FASTIFY_CODES: Record<string, ErrorCode> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  FST_ERR_CTP_BODY_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  FST_ERR_CTP_EMPTY_JSON_BODY: "BAD_REQUEST",
  FST_ERR_CTP_INVALID_JSON_BODY: "BAD_REQUEST",
};

/** Driver errors that mean the database is unreachable for now, not that the request was wrong. */
const DATABASE_DOWN = new Set([
  "MongoServerSelectionError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoOperationTimeoutError",
]);

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (!(err instanceof AppError) && DATABASE_DOWN.has(err.name)) {
      request.log.warn({ err: err.name }, "Database unavailable");
      err = new AppError("NOT_READY", "The service is busy. Try again in a few seconds.");
    }
    if (err instanceof AppError) {
      if (err.status === 503) request.log.warn({ code: err.code }, err.message);
      else if (err.status >= 500) request.log.error({ err }, err.message);
      const wait = err.code === "NOT_READY" ? 5 : err.details.find((d) => typeof d.retryAfterSeconds === "number")?.retryAfterSeconds;
      if (typeof wait === "number") reply.header("Retry-After", String(wait));
      return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
    }

    if (err.validation) {
      const details = err.validation.map((issue) => ({
        path: `${err.validationContext ?? "body"}${issue.instancePath || ""}`,
        message:
          issue.keyword === "additionalProperties"
            ? `Unknown field "${String(issue.params.additionalProperty)}"`
            : (issue.message ?? "Invalid value"),
      }));
      return reply.status(400).send(errorBody("VALIDATION_FAILED", undefined, details));
    }

    const mapped = err.code ? FASTIFY_CODES[err.code] : undefined;
    if (mapped) return reply.status(ERROR_CODES[mapped].status).send(errorBody(mapped));

    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send(errorBody("BAD_REQUEST"));
    }

    request.log.error({ err }, "Unhandled error");
    return reply.status(500).send(errorBody("INTERNAL"));
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(errorBody("NOT_FOUND", "Route not found.")));
}
