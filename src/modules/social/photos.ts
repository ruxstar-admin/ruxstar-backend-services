import sharp from "sharp";
import { AppError } from "../../platform/errors.js";

/** Clients shrink photos before sending, so this only stops abuse. */
export const POST_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Long side in pixels. Sharp on a phone and on a 2x laptop screen, about 150 to 300 KB as WebP. */
const LONG_SIDE = 1440;
const MIN_SIDE = 200;
const MAX_PIXELS = 40_000_000;
/** Wider than 1.91:1 or taller than 4:5 is cropped from the centre, so cards never get extreme. */
const WIDEST = 1.91;
const TALLEST = 0.8;

/**
 * Re-encodes an upload as WebP at most 1440 pixels on its long side, cropping extreme shapes.
 * Re-encoding drops EXIF, so GPS and camera details never reach the public bucket.
 */
export async function toPostPhoto(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    const rotated = await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS }).rotate().toBuffer({ resolveWithObject: true });
    const { width, height } = rotated.info;
    if (Math.min(width, height) < MIN_SIDE) throw new Error("too small");
    const ratio = Math.min(Math.max(width / height, TALLEST), WIDEST);
    const cropW = Math.min(width, Math.round(height * ratio));
    const cropH = Math.min(height, Math.round(width / ratio));
    const scale = Math.min(1, LONG_SIDE / Math.max(cropW, cropH));
    const out = await sharp(rotated.data)
      .resize(Math.round(cropW * scale), Math.round(cropH * scale), { fit: "cover", position: "centre" })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { data: out.data, width: out.info.width, height: out.info.height };
  } catch {
    throw new AppError("PHOTO_INVALID", undefined, [{ path: "body", message: `Use a JPEG, PNG or WebP at least ${MIN_SIDE} pixels wide.` }]);
  }
}
