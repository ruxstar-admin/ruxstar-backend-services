import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import { AppError } from "../../platform/errors.js";
import { signingKey } from "../pod/orders.js";
import { kycPhotoLinkValid } from "./cases.js";
import { DeliveryPhotoKind } from "./contracts.js";

/** Delivery verification photos for the console, by signed links that work for 10 minutes. Outside /v1 so an image tag can open them. */
const kycPhotoLinks: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  app.get(
    "/kyc-photos/:id/:kind",
    {
      schema: {
        hide: true,
        params: Strict({ id: ObjectIdString, kind: DeliveryPhotoKind }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }) }),
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id, kind } = request.params;
      if (!kycPhotoLinkValid(key, id, kind, request.query.exp, request.query.t)) {
        throw new AppError("UNAUTHENTICATED", "This link has expired. Open the case again.");
      }
      const doc = await db().kycCases.findOne({ _id: new ObjectId(id), track: "delivery" }, { projection: { steps: 1 } });
      const photo = doc?.steps[kind]?.photo;
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      const data = await app.printFiles.read(photo.key);
      return reply
        .headers({ "Cache-Control": "private, no-store", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" })
        .send(data);
    },
  );
};

export default kycPhotoLinks;
