import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import { AppError } from "../../platform/errors.js";
import { signingKey } from "../pod/orders.js";
import { supportPhotoLinkValid } from "./tickets.js";

/** Photos on help tickets, by signed links that work for 10 minutes. Outside /v1 so an image tag can open them. */
const supportPhotoLinks: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  app.get(
    "/support-photos/:ticketId/:photoId",
    {
      schema: {
        hide: true,
        params: Strict({ ticketId: ObjectIdString, photoId: ObjectIdString }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }) }),
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { ticketId, photoId } = request.params;
      if (!supportPhotoLinkValid(key, ticketId, photoId, request.query.exp, request.query.t)) {
        throw new AppError("UNAUTHENTICATED", "This link has expired. Open the ticket again.");
      }
      const id = new ObjectId(photoId);
      const message = await db().supportMessages.findOne({ ticketId: new ObjectId(ticketId), "photos.id": id }, { projection: { photos: 1 } });
      const photo = message?.photos.find((p) => p.id.equals(id));
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      const data = await app.printFiles.read(photo.key);
      return reply
        .headers({ "Cache-Control": "private, no-store", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" })
        .send(data);
    },
  );
};

export default supportPhotoLinks;
