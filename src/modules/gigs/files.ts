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
import { gigsSettings, MAX_UPLOAD_MB, MB } from "./rules.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** What can be uploaded, by extension, and the type it is served as. Pages and scripts aren't on it; only images and PDFs open in the browser. */
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  psd: "image/vnd.adobe.photoshop",
  ai: "application/postscript",
  eps: "application/postscript",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  zip: "application/zip",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ttf: "font/ttf",
  otf: "font/otf",
};
export const FILE_EXTENSIONS = Object.keys(TYPES);

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
          `the files on one order or one delivery add up to that too. Allowed: ${FILE_EXTENSIONS.join(", ")}. Then pass its id in \`fileIds\`. ` +
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
      const contentType = TYPES[extension];
      if (!contentType) throw new AppError("FILE_INVALID", `This kind of file can't be sent. Use one of: ${FILE_EXTENSIONS.join(", ")}.`);
      const { deliveryMaxMb } = await gigsSettings(db());
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
