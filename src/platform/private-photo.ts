import sharp from "sharp";
import { AppError } from "./errors.js";

const LONG_SIDE = 1600;
/** Phone camera photos, before they are made smaller here. */
export const PRIVATE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

/** An upright JPEG without the camera's metadata, so no location leaves the person's phone. For private photos only staff or a shop see. */
export async function toPrivateJpeg(input: unknown): Promise<Buffer> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new AppError("PHOTO_INVALID");
  try {
    return await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize(LONG_SIDE, LONG_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AppError("PHOTO_INVALID");
  }
}
