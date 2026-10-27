import type { ObjectId } from "mongodb";
import type { Geocoder } from "../adapters/geocoder.js";
import type { SmsSender } from "../adapters/sms.js";
import type { Config } from "../config.js";
import type { Database, KycState, UserRoles } from "./db.js";
import type { EventBus } from "./events.js";
import { AppError } from "./errors.js";

export type ClientKind = "web" | "app" | "delivery";

export interface ClientInfo {
  kind: ClientKind;
  version: string | null;
}

export interface AuthContext {
  userId: ObjectId;
  sessionId: ObjectId;
  roles: UserRoles;
  kyc: { base?: KycState; vendor?: KycState; delivery?: KycState };
}

export interface IdempotencyState {
  key: string;
  owned: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database | null;
    events: EventBus;
    sms: SmsSender;
    geocoder: Geocoder;
  }

  interface FastifyRequest {
    client: ClientInfo | null;
    auth: AuthContext | null;
    idempotency: IdempotencyState | null;
  }
}

export function requireDatabase(db: Database | null): Database {
  if (!db) throw new AppError("NOT_READY", "The database is not configured.");
  if (!db.ready) throw new AppError("NOT_READY", "Still connecting. Try again in a few seconds.");
  return db;
}
