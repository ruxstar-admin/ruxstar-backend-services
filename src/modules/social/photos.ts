import sharp from "sharp";
import { AppError } from "../../platform/errors.js";

/** Clients shrink photos before sending, so this only stops abuse. */
export const POST_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Long side in pixels. Sharp on a phone and on a 2x laptop screen, about 150 to 300 KB as WebP. */
const LONG_SIDE = 1440;
/** Widths of the smaller copies: a grid tile on a phone, and a grid tile or narrow card on a 2x screen. */
const SMALLER_WIDTHS = [320, 640];
const MIN_SIDE = 200;
const MAX_PIXELS = 40_000_000;
/** Wider than 1.91:1 or taller than 4:5 is cropped from the centre, so cards never get extreme. */
const WIDEST = 1.91;
const TALLEST = 0.8;

export interface PhotoFile {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Re-encodes an upload as WebP at most 1440 pixels on its long side, cropping extreme shapes, plus
 * narrower copies. The upload is decoded once; the copies are cut from the already-cropped pixels.
 * Re-encoding drops EXIF, so GPS and camera details never reach the public bucket.
 */
export async function toPostPhoto(input: Buffer): Promise<{ full: PhotoFile; smaller: PhotoFile[] }> {
  try {
    const options = { failOn: "error", limitInputPixels: MAX_PIXELS } as const;
    const meta = await sharp(input, options).metadata();
    const turned = (meta.orientation ?? 1) >= 5;
    const width = (turned ? meta.height : meta.width) ?? 0;
    const height = (turned ? meta.width : meta.height) ?? 0;
    if (Math.min(width, height) < MIN_SIDE) throw new Error("too small");
    const ratio = Math.min(Math.max(width / height, TALLEST), WIDEST);
    const cropW = Math.min(width, Math.round(height * ratio));
    const cropH = Math.min(height, Math.round(width / ratio));
    const scale = Math.min(1, LONG_SIDE / Math.max(cropW, cropH));

    const pixels = await sharp(input, options)
      .rotate()
      .resize(Math.round(cropW * scale), Math.round(cropH * scale), { fit: "cover", position: "centre" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { info } = pixels;
    const encode = async (toWidth: number): Promise<PhotoFile> => {
      const image = sharp(pixels.data, { raw: { width: info.width, height: info.height, channels: info.channels } });
      const out = await (toWidth < info.width ? image.resize({ width: toWidth }) : image)
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      return { data: out.data, width: out.info.width, height: out.info.height };
    };
    const [full, ...smaller] = await Promise.all([info.width, ...SMALLER_WIDTHS.filter((w) => w < info.width)].map(encode));
    return { full: full!, smaller };
  } catch {
    throw new AppError("PHOTO_INVALID", undefined, [{ path: "body", message: `Use a JPEG, PNG or WebP at least ${MIN_SIDE} pixels wide.` }]);
  }
}

const CHAT_LONG_SIDE = 1280;
const CHAT_MIN_SIDE = 50;

/** A chat photo keeps its shape, at most 1280 pixels on its long side, as WebP without its metadata. */
export async function toChatPhoto(input: Buffer): Promise<PhotoFile> {
  try {
    const out = await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize(CHAT_LONG_SIDE, CHAT_LONG_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (Math.min(out.info.width, out.info.height) < CHAT_MIN_SIDE) throw new Error("too small");
    return { data: out.data, width: out.info.width, height: out.info.height };
  } catch {
    throw new AppError("PHOTO_INVALID", undefined, [{ path: "body", message: "Use a JPEG, PNG or WebP photo." }]);
  }
}
