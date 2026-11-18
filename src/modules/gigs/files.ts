import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { GigFileDoc } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { UploadedOne, UploadQuery } from "./contracts.js";
import { sellingProfile } from "./quotes.js";
import { FILE_EXTENSIONS, FILE_TYPES, gigsSettings, MAX_UPLOAD_MB, MB } from "./rules.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** The kinds Ruxstar allows now, out of those the module can serve. */
export const allowedTypes = (fileTypes: string[]) => fileTypes.filter((ext) => FILE_TYPES[ext]);

const extensionOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
const cleanName = (name: string) => name.replace(/[\u0000-\u001f\\/]/g, "_").trim().slice(0, 120);

/** Uploading files for an order: the customer's for the brief, before ordering; the freelancer's for a delivery. */
const files: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_UPLOAD_MB * MB }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  app.post(
    "/files",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Upload a file to attach to an order or a delivery",
        description:
          `Send the file itself with Content-Type application/octet-stream and its name in \`name\`. Up to Ruxstar's delivery size (at most ${MAX_UPLOAD_MB} MB); ` +
          `the files on one order or one delivery add up to that too. Allowed: the kinds in GET /v1/gigs/rules \`limits.extensions\`, out of ${FILE_EXTENSIONS.join(", ")}. Then pass its id in \`fileIds\`. ` +
          "Files not used within a day are deleted; used ones go a set number of days after the order ends.",
        consumes: ["application/octet-stream"],
        querystring: UploadQuery,
        response: { 201: UploadedOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const { use } = request.query;
      if (use === "delivery") await sellingProfile(db(), userId);
      else if (!(await isModuleLive(db(), "gigs"))) throw new AppError("MODULE_OFF");
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) throw new AppError("FILE_INVALID", "Choose a file.");
      const name = cleanName(request.query.name);
      const extension = extensionOf(name);
      const { deliveryMaxMb, fileTypes } = await gigsSettings(db());
      const allowed = allowedTypes(fileTypes);
      const contentType = allowed.includes(extension) ? FILE_TYPES[extension] : undefined;
      if (!contentType) throw new AppError("FILE_INVALID", `This kind of file can't be sent. Use one of: ${allowed.join(", ")}.`);
      if (data.length > deliveryMaxMb * MB) throw new AppError("FILE_INVALID", `Files can be up to ${deliveryMaxMb} MB.`);
      const doc: GigFileDoc = {
        _id: new ObjectId(),
        userId,
        key: `gigs/${userId.toHexString()}/${randomUUID()}.${extension}`,
        name,
        contentType,
        bytes: data.length,
        use,
        orderId: null,
        createdAt: new Date(),
      };
      await app.printFiles.save(doc.key, data, contentType, { keep: true });
      try {
        await db().gigFiles.insertOne(doc);
      } catch (err) {
        await app.printFiles.remove(doc.key);
        throw err;
      }
      return reply.status(201).send(
        ok(request, { id: doc._id.toHexString(), name: doc.name, contentType, bytes: doc.bytes, use, createdAt: doc.createdAt.toISOString() }),
      );
    },
  );
};

export default files;
