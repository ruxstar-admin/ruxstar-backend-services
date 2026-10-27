import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { Envelope, Errors, Strict } from "../contracts/common.js";
import { ok } from "../platform/envelope.js";
import { AppError } from "../platform/errors.js";

const health: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    { schema: { tags: ["health"], response: { 200: Envelope(Strict({ name: Type.String(), liveOn: Type.String() })) } } },
    async (request) => ok(request, { name: "Ruxstar API", liveOn: "2026-11-30" }),
  );

  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "The process is up. Does not touch the database.",
        response: { 200: Envelope(Strict({ status: Type.Literal("ok"), revision: Type.String() })) },
      },
    },
    async (request) => ok(request, { status: "ok" as const, revision: app.config.revision }),
  );

  app.get(
    "/ready",
    {
      schema: {
        tags: ["health"],
        summary: "The database answers.",
        response: { 200: Envelope(Strict({ status: Type.Literal("ready") })), ...Errors },
      },
    },
    async (request) => {
      if (!app.db) throw new AppError("NOT_READY", "The database is not configured.");
      try {
        await app.db.ping();
      } catch (err) {
        request.log.warn({ err }, "Database ping failed");
        throw new AppError("NOT_READY", "The database is not answering.");
      }
      return ok(request, { status: "ready" as const });
    },
  );
};

export default health;
