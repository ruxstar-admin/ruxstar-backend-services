import type { FastifyBaseLogger } from "fastify";

/** One phone notification. `data` reaches the app, which uses it to open the right screen. */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Android channel the app creates: `messages` for chats, `activity` for everything else. */
  channelId: "messages" | "activity";
}

export interface PushSender {
  /** Answers with the tokens that no longer reach a phone (the app was removed), so they can be forgotten. Never throws. */
  send(messages: PushMessage[]): Promise<string[]>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes up to 100 notifications per request. */
const BATCH = 100;
const TIMEOUT_MS = 10_000;

interface Ticket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

/** Expo's push service: free, with no keys, for Expo push tokens (ExponentPushToken[…]). */
class ExpoPush implements PushSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(messages: PushMessage[]): Promise<string[]> {
    const gone: string[] = [];
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(batch.map((m) => ({ ...m, sound: "default", priority: "high" }))),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await response.json().catch(() => null)) as { data?: Ticket[] } | null;
        if (!response.ok || !Array.isArray(body?.data)) {
          this.log.warn({ status: response.status }, "Push notifications not accepted");
          continue;
        }
        body.data.forEach((ticket, n) => {
          if (ticket.status !== "error") return;
          if (ticket.details?.error === "DeviceNotRegistered") gone.push(batch[n]!.to);
          else this.log.warn({ error: ticket.details?.error, message: ticket.message }, "Push notification refused");
        });
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "Push notifications not sent");
      }
    }
    return gone;
  }
}

export function createPushSender(log: FastifyBaseLogger): PushSender {
  return new ExpoPush(log);
}
