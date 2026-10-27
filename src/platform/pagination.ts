import { ObjectId, type Collection, type Document, type Filter, type FindOptions, type WithId } from "mongodb";
import { AppError } from "./errors.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

type CursorValue = string | number | Date;
interface CursorPayload {
  v: string | number;
  d?: 1;
  id: string;
}

export function encodeCursor(value: CursorValue, id: ObjectId): string {
  const payload: CursorPayload =
    value instanceof Date ? { v: value.toISOString(), d: 1, id: id.toHexString() } : { v: value, id: id.toHexString() };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor: string): { value: CursorValue; id: ObjectId } {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (!ObjectId.isValid(payload.id) || (typeof payload.v !== "string" && typeof payload.v !== "number")) throw new Error();
    const value = payload.d ? new Date(payload.v) : payload.v;
    if (value instanceof Date && Number.isNaN(value.getTime())) throw new Error();
    return { value, id: new ObjectId(payload.id) };
  } catch {
    throw new AppError("VALIDATION_FAILED", undefined, [{ path: "querystring/cursor", message: "Invalid cursor" }]);
  }
}

/**
 * Keyset page over `sortField` then `_id`, newest first. The collection needs an index that
 * ends in `{ [sortField]: -1, _id: -1 }` after the filter's equality fields.
 */
export async function findPage<T extends Document>(
  collection: Collection<T>,
  options: {
    filter: Filter<T>;
    sortField: keyof T & string;
    cursor?: string | undefined;
    limit?: number | undefined;
    projection?: FindOptions["projection"];
  },
): Promise<{ items: WithId<T>[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  let filter: Filter<T> = options.filter;

  if (options.cursor) {
    const { value, id } = decodeCursor(options.cursor);
    const after = {
      $or: [{ [options.sortField]: { $lt: value } }, { [options.sortField]: value, _id: { $lt: id } }],
    } as Filter<T>;
    filter = { $and: [options.filter, after] } as Filter<T>;
  }

  const rows = await collection
    .find(filter, { projection: options.projection })
    .sort({ [options.sortField]: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last ? encodeCursor(last[options.sortField] as CursorValue, last._id as ObjectId) : null;
  return { items, nextCursor };
}
