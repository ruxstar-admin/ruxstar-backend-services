import { Storage, type Bucket } from "@google-cloud/storage";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../platform/errors.js";

/**
 * Photos sent in chats, in a private bucket with no lifecycle rule: they stay until unsent or the
 * sender's account is deleted. Only the API reads them, for people in the chat, through short-lived signed links.
 */
export interface ChatPhotoStore {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  /** Logged, never thrown. */
  remove(key: string): Promise<void>;
}

class GcsChatPhotos implements ChatPhotoStore {
  private readonly bucket: Bucket;

  constructor(
    bucket: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.bucket = new Storage().bucket(bucket);
  }

  async save(key: string, data: Buffer) {
    try {
      await this.bucket.file(key).save(data, { resumable: false, contentType: "image/webp", metadata: { cacheControl: "private, no-store" } });
    } catch (err) {
      this.log.error({ err: (err as Error).message, key }, "Chat photo could not be saved");
      throw new AppError("PHOTO_UNAVAILABLE");
    }
  }

  async read(key: string) {
    try {
      const [data] = await this.bucket.file(key).download();
      return data;
    } catch (err) {
      this.log.error({ err: (err as Error).message, key }, "Chat photo could not be read");
      throw new AppError("PHOTO_UNAVAILABLE");
    }
  }

  async remove(key: string) {
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "Chat photo could not be deleted");
    }
  }
}

class UnavailableChatPhotos implements ChatPhotoStore {
  async save(): Promise<void> {
    throw new AppError("PHOTO_UNAVAILABLE", "Photos can't be sent in chats right now.");
  }
  async read(): Promise<Buffer> {
    throw new AppError("PHOTO_UNAVAILABLE");
  }
  async remove() {}
}

export function createChatPhotoStore(config: Config, log: FastifyBaseLogger): ChatPhotoStore {
  if (config.chatPhotos) return new GcsChatPhotos(config.chatPhotos.bucket, log);
  log.warn("GCS_CHAT_BUCKET is not set. Photos can't be sent in chats.");
  return new UnavailableChatPhotos();
}
