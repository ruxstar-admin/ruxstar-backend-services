import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import { AppError } from "../../platform/errors.js";
import { apiOrigin, signingKey } from "../pod/orders.js";
import { byteRange } from "./chat-live.js";

/**
 * Links run to the end of the next 30-minute window plus an hour, so they last at least an hour and stay the
 * same between polls, letting the browser and the app reuse what they downloaded.
 */
const WINDOW_SECONDS = 30 * 60;
const LINK_SECONDS = 60 * 60;

type Media = "photo" | "voice";

const signature = (key: Uint8Array, media: Media, messageId: string, exp: number) =>
  createHmac("sha256", key).update(`chat-${media}.${messageId}.${exp}`).digest("base64url");

function mediaUrl(app: FastifyInstance, request: { protocol: string; host: string }, media: Media, messageId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = (Math.floor(now / WINDOW_SECONDS) + 1) * WINDOW_SECONDS + LINK_SECONDS;
  const query = new URLSearchParams({ exp: String(exp), t: signature(signingKey(app), media, messageId, exp) });
  return `${apiOrigin(app, request)}/chat-${media === "photo" ? "photos" : "voice"}/${messageId}?${query.toString()}`;
}

export const chatPhotoUrl = (app: FastifyInstance, request: { protocol: string; host: string }, messageId: string) => mediaUrl(app, request, "photo", messageId);
export const chatVoiceUrl = (app: FastifyInstance, request: { protocol: string; host: string }, messageId: string) => mediaUrl(app, request, "voice", messageId);

function linkValid(key: Uint8Array, media: Media, messageId: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, media, messageId, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const LinkParams = Strict({ id: ObjectIdString });
const LinkQuery = Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }) });
const private_ = (exp: number) => ({
  "Cache-Control": `private, max-age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

/** Chat photos and voice messages, from links the API gave someone in the chat. Outside /v1: an image or audio tag sends no X-Client header. */
const chatPhotoLinks: FastifyPluginAsyncTypebox = async (app) => {
  const key = signingKey(app);

  app.get(
    "/chat-photos/:id",
    { schema: { hide: true, params: LinkParams, querystring: LinkQuery }, config: { rateLimit: { max: 600, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { id } = request.params;
      if (!linkValid(key, "photo", id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open the chat again.");
      const message = await requireDatabase(app.db).chatMessages.findOne({ _id: new ObjectId(id), status: "live" }, { projection: { photo: 1 } });
      if (!message?.photo) throw new AppError("NOT_FOUND", "This photo was unsent.");
      const data = await app.chatPhotos.read(message.photo.key);
      return reply.headers({ "Content-Type": "image/webp", ...private_(request.query.exp) }).send(data);
    },
  );

  // Phones play audio from a link by asking for it in pieces, and iPhones won't play it without that.
  app.get(
    "/chat-voice/:id",
    { schema: { hide: true, params: LinkParams, querystring: LinkQuery }, config: { rateLimit: { max: 600, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { id } = request.params;
      if (!linkValid(key, "voice", id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open the chat again.");
      const message = await requireDatabase(app.db).chatMessages.findOne({ _id: new ObjectId(id), status: "live" }, { projection: { voice: 1 } });
      if (!message?.voice) throw new AppError("NOT_FOUND", "This voice message was unsent.");
      const data = await app.chatPhotos.read(message.voice.key);
      reply.headers({ "Content-Type": "audio/mp4", "Accept-Ranges": "bytes", ...private_(request.query.exp) });
      let range: ReturnType<typeof byteRange>;
      try {
        range = byteRange(request.headers.range, data.length);
      } catch {
        return reply.status(416).header("Content-Range", `bytes */${data.length}`).send();
      }
      if (!range) return reply.send(data);
      return reply
        .status(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${data.length}`)
        .send(data.subarray(range.start, range.end + 1));
    },
  );
};

export default chatPhotoLinks;
