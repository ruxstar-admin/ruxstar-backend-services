import { Storage, type Bucket } from "@google-cloud/storage";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../platform/errors.js";

export interface PhotoStore {
  /** Saves a finished WebP under `key` and returns its public URL. */
  save(key: string, data: Buffer): Promise<string>;
  /** Missing objects are fine; a failure is logged, not thrown, so it never blocks the user. */
  remove(key: string): Promise<void>;
}

/** Credentials come from the environment: the service account on Cloud Run, ADC on a laptop. */
class GcsPhotos implements PhotoStore {
  private readonly bucket: Bucket;

  constructor(
    private readonly settings: NonNullable<Config["photos"]>,
    private readonly log: FastifyBaseLogger,
  ) {
    this.bucket = new Storage().bucket(settings.bucket);
  }

  async save(key: string, data: Buffer) {
    try {
      await this.bucket.file(key).save(data, {
        resumable: false,
        contentType: "image/webp",
        metadata: { cacheControl: "public, max-age=31536000, immutable" },
      });
    } catch (err) {
      this.log.error({ err: (err as Error).message, key }, "Photo could not be saved");
      throw new AppError("PHOTO_UNAVAILABLE");
    }
    return `${this.settings.publicBaseUrl}/${key}`;
  }

  async remove(key: string) {
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "Old photo could not be deleted");
    }
  }
}

class UnavailablePhotos implements PhotoStore {
  async save(): Promise<string> {
    throw new AppError("PHOTO_UNAVAILABLE");
  }

  async remove() {}
}

export function createPhotoStore(config: Config, log: FastifyBaseLogger): PhotoStore {
  if (config.photos) return new GcsPhotos(config.photos, log);
  log.warn("GCS_BUCKET is not set. Profile photos cannot be uploaded.");
  return new UnavailablePhotos();
}
