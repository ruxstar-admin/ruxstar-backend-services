import type { ObjectId } from "mongodb";
import type { ChatReaction } from "../../platform/db.js";
import { VOICE_LEVELS_MAX } from "./chat-contracts.js";

/**
 * Open chats wait on /updates until something changes. A change made on this server wakes them at once;
 * one made on another server is seen by the waiting call's own check of the chat, which runs every second.
 */
const waiting = new Map<string, Set<() => void>>();

export function wake(conversationId: ObjectId | string): void {
  const id = typeof conversationId === "string" ? conversationId : conversationId.toHexString();
  for (const resolve of waiting.get(id) ?? []) resolve();
}

/** Resolves after `ms`, or sooner when the chat is woken. */
export function nap(conversationId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const set = waiting.get(conversationId) ?? new Set();
    waiting.set(conversationId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) waiting.delete(conversationId);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

/** Chats waiting right now, for tests. */
export const waitingChats = () => waiting.size;

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\u200d|\ufe0f)+$/u;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** One emoji, skin tones and joined emoji included: no letters, digits on their own, or several emoji. */
export function isOneEmoji(text: string): boolean {
  if (!EMOJI.test(text) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return false;
  return [...segmenter.segment(text)].length === 1;
}

/** MP4 or M4A audio: a file that starts with an `ftyp` box. */
export function isMp4(data: Buffer): boolean {
  return data.length > 12 && data.subarray(4, 8).toString("latin1") === "ftyp";
}

export function parseLevels(levels: string | undefined): number[] {
  if (!levels) return [];
  return levels
    .split(",")
    .slice(0, VOICE_LEVELS_MAX)
    .map((n) => Math.min(100, Number(n)));
}

/** Each emoji once, in the order first used, with whether one of them is yours. */
export function reactionCounts(reactions: ChatReaction[] | undefined, viewer: ObjectId) {
  const counts = new Map<string, { emoji: string; count: number; mine: boolean; first: number }>();
  for (const r of reactions ?? []) {
    const entry = counts.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, first: r.at.getTime() };
    entry.count += 1;
    entry.mine ||= r.userId.equals(viewer);
    entry.first = Math.min(entry.first, r.at.getTime());
    counts.set(r.emoji, entry);
  }
  return [...counts.values()].sort((a, b) => a.first - b.first).map(({ emoji, count, mine }) => ({ emoji, count, mine }));
}

/** The bytes a `Range: bytes=…` header asks for, or null for the whole file. Throws when it can't be met. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) throw new RangeError("unsatisfiable");
  return { start, end };
}
