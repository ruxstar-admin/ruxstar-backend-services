import sharp from "sharp";
import { AppError } from "../../platform/errors.js";

/** Clients shrink photos before sending, so this only stops abuse. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_SIZE = 512;
const MIN_SIDE = 64;
/** About a 40-megapixel image. Stops tiny files that decode to huge bitmaps. */
const MAX_PIXELS = 40_000_000;

/**
 * Re-encodes an upload as a square WebP. Re-encoding drops EXIF, so GPS and camera details never
 * reach the public bucket, and anything that is not really an image fails here.
 */
export async function toAvatar(input: Buffer): Promise<Buffer> {
  try {
    const image = sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS }).rotate();
    const { width = 0, height = 0 } = await image.metadata();
    if (Math.min(width, height) < MIN_SIDE) throw new Error("too small");
    return await image.resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new AppError("PHOTO_INVALID", undefined, [{ path: "body", message: `Use a JPEG, PNG or WebP at least ${MIN_SIDE} pixels wide.` }]);
  }
}
