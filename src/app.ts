import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyServerOptions } from "fastify";
import { createChatPhotoStore, type ChatPhotoStore } from "./adapters/chat-photos.js";
import { createEmailSender, type EmailSender } from "./adapters/email.js";
import { createGeocoder, type Geocoder } from "./adapters/geocoder.js";
import { createPaymentGateway, type PaymentGateway } from "./adapters/payments.js";
import { createMediaStore, createPhotoStore, type PhotoStore } from "./adapters/photos.js";
import { createPrintFileStore, type PrintFileStore } from "./adapters/print-files.js";
import { createPushSender, type PushSender } from "./adapters/push.js";
import { createSmsSender, type SmsSender } from "./adapters/sms.js";
import { createVerifier, type Verifier } from "./adapters/verification.js";
import type { Config } from "./config.js";
import { ErrorEnvelope } from "./contracts/common.js";
import { registerModules } from "./modules/index.js";
import health from "./modules/health.js";
import { usePush } from "./modules/notifications/push.js";
import { googleJobAuth, jobs, type JobAuth } from "./modules/jobs.js";
import checkout from "./modules/pod/checkout.js";
import chatPhotoLinks from "./modules/social/chat-photo-links.js";
import { registerAuth } from "./platform/auth.js";
import { registerClientCheck } from "./platform/client.js";
import "./platform/context.js";
import type { Database } from "./platform/db.js";
import { AppError, registerErrorHandling } from "./platform/errors.js";
import { EventBus } from "./platform/events.js";
import { registerIdempotency } from "./platform/idempotency.js";

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Cloud Logging reads `severity` and `message`. Secrets and phone numbers never reach the log. */
const loggerOptions = (config: Config): FastifyServerOptions["logger"] => ({
  level: config.logLevel,
  messageKey: "message",
  formatters: { level: (label) => ({ severity: label === "warn" ? "WARNING" : label.toUpperCase() }) },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["idempotency-key"]',
      'res.headers["set-cookie"]',
      "*.phone",
      "*.otp",
      "*.password",
      "*.currentPassword",
      "*.newPassword",
      "*.refreshToken",
      "*.verificationToken",
      "*.pushToken",
      "*.pan",
      "*.gstin",
    ],
    censor: "[redacted]",
  },
});

export interface AppOptions {
  config: Config;
  db: Database | null;
  logger?: boolean;
  /** Tests pass a sender that records codes instead of texting them. */
  sms?: SmsSender;
  email?: EmailSender;
  geocoder?: Geocoder;
  photos?: PhotoStore;
  media?: PhotoStore;
  verifier?: Verifier;
  payments?: PaymentGateway;
  printFiles?: PrintFileStore;
  chatPhotos?: ChatPhotoStore;
  /** Tests record phone notifications instead of sending them. */
  push?: PushSender;
  /** Tests accept their own token for the scheduler's routes. */
  jobAuth?: JobAuth;
  /** Tests send every request from one address, so most of them switch per-IP limits off. */
  rateLimit?: boolean;
}

export async function buildApp({
  config,
  db,
  logger = true,
  sms,
  email,
  geocoder,
  photos,
  media,
  verifier,
  payments,
  printFiles,
  chatPhotos,
  push,
  jobAuth,
  rateLimit: limitByIp = true,
}: AppOptions) {
  const app = Fastify({
    logger: logger ? loggerOptions(config) : false,
    // Trust only Cloud Run's front end (hop 0). `true` would let a client fake its IP through X-Forwarded-For and
    // dodge every per-IP limit. Add a hop if a load balancer is ever put in front.
    trustProxy: (_address: string, hop: number) => hop < 1,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true, allErrors: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("events", new EventBus(app.log));
  app.decorate("sms", sms ?? createSmsSender(config, app.log));
  app.decorate("email", email ?? createEmailSender(config, app.log));
  app.decorate("geocoder", geocoder ?? createGeocoder(app.log));
  app.decorate("photos", photos ?? createPhotoStore(config, app.log));
  app.decorate("media", media ?? createMediaStore(config, app.log));
  app.decorate("verifier", verifier ?? createVerifier(config, app.log));
  app.decorate("payments", payments ?? createPaymentGateway(config, app.log));
  app.decorate("printFiles", printFiles ?? createPrintFileStore(config, app.log));
  app.decorate("chatPhotos", chatPhotos ?? createChatPhotoStore(config, app.log));
  app.decorate("push", push ?? createPushSender(config.push, app.log));
  if (db) usePush(db, app.push, app.log);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onClose", async () => {
    await db?.close();
  });

  registerErrorHandling(app);
  registerClientCheck(app);
  registerAuth(app);
  registerIdempotency(app);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    ...(limitByIp ? {} : { allowList: () => true }),
    hook: "preHandler",
    errorResponseBuilder: (_request, context) =>
      new AppError("RATE_LIMITED", undefined, [
        { message: `Try again in ${Math.ceil(context.ttl / 1000)} seconds.`, retryAfterSeconds: Math.ceil(context.ttl / 1000) },
      ]),
  });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Client", "X-App-Version", "X-Request-Id", "X-File-Name"],
    exposedHeaders: ["X-Request-Id", "Idempotent-Replayed"],
    maxAge: 600,
  });
  await app.register(swagger, {
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => String(json.$id ?? `def-${i}`) },
    openapi: {
      openapi: "3.1.0",
      info: { title: "Ruxstar API", version: "1.0.0", description: "Shared by the website and the mobile apps." },
      servers: [{ url: "https://api.ruxstar.com" }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "Mobile apps" },
          cookie: { type: "apiKey", in: "cookie", name: "rx_at", description: "Website" },
        },
      },
    },
  });

  app.addSchema(ErrorEnvelope);
  await app.register(health);
  await registerModules(app);
  await app.register(checkout);
  await app.register(chatPhotoLinks);
  await app.register(jobs(jobAuth ?? googleJobAuth(config)));

  if (config.env !== "prod") {
    app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
