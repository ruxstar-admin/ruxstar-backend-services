import { Storage, type Bucket } from "@google-cloud/storage";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../platform/errors.js";

/**
 * Customers' print files, in a private bucket. Only the API reads them, for the customer and the
 * shop, so no link to a file ever leaves Ruxstar. The bucket deletes a file 30 days after its
 * custom time, which is set on upload (so abandoned files go too) and again when the order ends.
 */
export interface PrintFileStore {
  /** `keep` leaves the countdown off until `expire`, for files that must last however long a review takes. */
  save(key: string, data: Buffer, contentType: string, options?: { keep?: boolean }): Promise<void>;
  read(key: string): Promise<Buffer>;
  /** Starts the bucket's 30-day countdown. Logged, never thrown. */
  expire(key: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class GcsPrintFiles implements PrintFileStore {
  private readonly bucket: Bucket;

  constructor(
    bucket: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.bucket = new Storage().bucket(bucket);
  }

  async save(key: string, data: Buffer, contentType: string, options: { keep?: boolean } = {}) {
    try {
      const metadata = { cacheControl: "private, no-store", ...(options.keep ? {} : { customTime: new Date().toISOString() }) };
      await this.bucket.file(key).save(data, { resumable: false, contentType, metadata });
    } catch (err) {
      this.log.error({ err: (err as Error).message, key }, "Print file could not be saved");
      throw new AppError("FILES_UNAVAILABLE");
    }
  }

  async read(key: string) {
    try {
      const [data] = await this.bucket.file(key).download();
      return data;
    } catch (err) {
      this.log.error({ err: (err as Error).message, key }, "Print file could not be read");
      throw new AppError("FILES_UNAVAILABLE");
    }
  }

  async expire(key: string) {
    try {
      await this.bucket.file(key).setMetadata({ customTime: new Date().toISOString() });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "Print file expiry not set");
    }
  }

  async remove(key: string) {
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, key }, "Print file could not be deleted");
    }
  }
}

class UnavailablePrintFiles implements PrintFileStore {
  async save(): Promise<void> {
    throw new AppError("FILES_UNAVAILABLE");
  }
  async read(): Promise<Buffer> {
    throw new AppError("FILES_UNAVAILABLE");
  }
  async expire() {}
  async remove() {}
}

export function createPrintFileStore(config: Config, log: FastifyBaseLogger): PrintFileStore {
  if (config.printFiles) return new GcsPrintFiles(config.printFiles.bucket, log);
  log.warn("GCS_PRINT_BUCKET is not set. Customers cannot upload print files.");
  return new UnavailablePrintFiles();
}
