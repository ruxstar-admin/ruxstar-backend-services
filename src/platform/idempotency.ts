import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MongoServerError } from "mongodb";
import { requireDatabase } from "./context.js";
import type { IdempotencyDoc } from "./db.js";
import { AppError } from "./errors.js";

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const KEEP_MS = 24 * 60 * 60 * 1000;
/** A key still marked running after this long belongs to a request that died. */
const STALE_MS = 60 * 1000;

const hashRequest = (request: FastifyRequest) =>
  createHash("sha256")
    .update(`${request.method} ${request.url}\n${JSON.stringify(request.body ?? null)}`)
    .digest("base64url");

function replay(reply: FastifyReply, doc: IdempotencyDoc) {
  return reply
    .status(doc.status!)
    .header("content-type", "application/json; charset=utf-8")
    .header("idempotent-replayed", "true")
    .send(doc.body);
}

export function registerIdempotency(app: FastifyInstance) {
  app.decorateRequest("idempotency", null);

  app.addHook("onSend", async (request, reply, payload) => {
    const state = request.idempotency;
    if (!state?.owned || !app.db) return payload;
    if (reply.statusCode >= 500) {
      await app.db.idempotencyKeys.deleteOne({ _id: state.key });
    } else {
      await app.db.idempotencyKeys.updateOne(
        { _id: state.key },
        { $set: { state: "done", status: reply.statusCode, body: typeof payload === "string" ? payload : "" } },
      );
    }
    return payload;
  });
}

/**
 * Put after the auth guard on every create and money route. The first result for a key is stored
 * for 24 hours and replayed to retries; the same key with a different body is refused.
 */
export async function idempotent(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || !KEY.test(header)) throw new AppError("IDEMPOTENCY_KEY_REQUIRED");

  const db = requireDatabase(request.server.db);
  const owner = request.auth?.userId.toHexString() ?? "anonymous";
  const key = `${owner}:${request.routeOptions.url}:${header}`;
  const requestHash = hashRequest(request);
  const now = new Date();

  try {
    await db.idempotencyKeys.insertOne({
      _id: key,
      state: "running",
      requestHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + KEEP_MS),
    });
    request.idempotency = { key, owned: true };
    return;
  } catch (err) {
    if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
  }

  const existing = await db.idempotencyKeys.findOne({ _id: key });
  if (!existing) throw new AppError("IDEMPOTENCY_IN_PROGRESS");
  if (existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_KEY_REUSED");
  if (existing.state === "done") return replay(reply, existing);

  const takenOver = await db.idempotencyKeys.updateOne(
    { _id: key, state: "running", createdAt: { $lt: new Date(now.getTime() - STALE_MS) } },
    { $set: { createdAt: now, expiresAt: new Date(now.getTime() + KEEP_MS) } },
  );
  if (takenOver.modifiedCount !== 1) throw new AppError("IDEMPOTENCY_IN_PROGRESS");
  request.idempotency = { key, owned: true };
}
