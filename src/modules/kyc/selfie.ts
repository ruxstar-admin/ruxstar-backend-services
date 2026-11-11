import sharp from "sharp";
import { AppError } from "../../platform/errors.js";

/** Cashfree takes images up to 5 MB. */
export const SELFIE_MAX_BYTES = 5 * 1024 * 1024;
const LONG_SIDE = 1080;
const MIN_SIDE = 240;

/** Turns whatever the camera produced into an upright JPEG Cashfree accepts, without its metadata. */
export async function toSelfie(input: Buffer): Promise<Buffer> {
  try {
    const image = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 }).rotate();
    const { width = 0, height = 0 } = await image.metadata();
    if (Math.min(width, height) < MIN_SIDE) throw new Error("too small");
    return await image.resize(LONG_SIDE, LONG_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch {
    throw new AppError("PHOTO_INVALID", undefined, [{ path: "body", message: `Take the selfie again. Use a JPEG, PNG or WebP at least ${MIN_SIDE} pixels wide.` }]);
  }
}
