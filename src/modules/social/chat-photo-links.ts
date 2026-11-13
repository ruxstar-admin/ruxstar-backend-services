import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import { AppError } from "../../platform/errors.js";
import { apiOrigin, signingKey } from "../pod/orders.js";

/**
 * Links run to the end of the next 30-minute window plus an hour, so they last at least an hour and stay the
 * same between polls, letting the browser and the app reuse what they downloaded.
 */
const WINDOW_SECONDS = 30 * 60;
const LINK_SECONDS = 60 * 60;

const signature = (key: Uint8Array, messageId: string, exp: number) =>
  createHmac("sha256", key).update(`chat-photo.${messageId}.${exp}`).digest("base64url");

export function chatPhotoUrl(app: FastifyInstance, request: { protocol: string; host: string }, messageId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = (Math.floor(now / WINDOW_SECONDS) + 1) * WINDOW_SECONDS + LINK_SECONDS;
  const query = new URLSearchParams({ exp: String(exp), t: signature(signingKey(app), messageId, exp) });
  return `${apiOrigin(app, request)}/chat-photos/${messageId}?${query.toString()}`;
}

function linkValid(key: Uint8Array, messageId: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, messageId, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A chat photo, from a link the API gave someone in the chat. Outside /v1: an image tag sends no X-Client header. */
const chatPhotoLinks: FastifyPluginAsyncTypebox = async (app) => {
  const key = signingKey(app);

  app.get(
    "/chat-photos/:id",
    {
      schema: { hide: true, params: Strict({ id: ObjectIdString }), querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }) }) },
      config: { rateLimit: { max: 600, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!linkValid(key, id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open the chat again.");
      const message = await requireDatabase(app.db).chatMessages.findOne({ _id: new ObjectId(id), status: "live" }, { projection: { photo: 1 } });
      if (!message?.photo) throw new AppError("NOT_FOUND", "This photo was unsent.");
      const data = await app.chatPhotos.read(message.photo.key);
      const maxAge = Math.max(0, request.query.exp - Math.floor(Date.now() / 1000));
      return reply
        .headers({
          "Content-Type": "image/webp",
          "Cache-Control": `private, max-age=${maxAge}`,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        })
        .send(data);
    },
  );
};

export default chatPhotoLinks;
