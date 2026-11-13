import type { FastifyBaseLogger } from "fastify";

/** One phone notification. `data` reaches the app, which uses it to open the right screen. */
export interface PushMessage {
  /** The OneSignal subscription id of one app install. */
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushSender {
  /** Answers with the installs that no longer exist (the app was removed), so they can be forgotten. Never throws. */
  send(messages: PushMessage[]): Promise<string[]>;
}

export interface OneSignalSettings {
  appId: string;
  apiKey: string;
}

const ONESIGNAL_URL = "https://api.onesignal.com/notifications?c=push";
/** OneSignal takes up to 20,000 installs per notification. */
const BATCH = 20_000;
const TIMEOUT_MS = 10_000;

interface Answer {
  id?: string;
  /** An object naming installs that don't exist, or a list of messages when nothing was sent. */
  errors?: { invalid_player_ids?: string[] } | string[];
}

/** Sends through OneSignal. Messages that differ only in `to` go out as one notification. */
class OneSignalPush implements PushSender {
  constructor(
    private readonly settings: OneSignalSettings,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(messages: PushMessage[]): Promise<string[]> {
    const groups = new Map<string, { message: PushMessage; to: string[] }>();
    for (const message of messages) {
      const key = JSON.stringify([message.title, message.body, message.data]);
      const group = groups.get(key) ?? { message, to: [] };
      group.to.push(message.to);
      groups.set(key, group);
    }

    const gone: string[] = [];
    for (const { message, to } of groups.values()) {
      for (let i = 0; i < to.length; i += BATCH) {
        gone.push(...(await this.post(message, to.slice(i, i + BATCH))));
      }
    }
    return gone;
  }

  private async post(message: PushMessage, to: string[]): Promise<string[]> {
    try {
      const response = await fetch(ONESIGNAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Key ${this.settings.apiKey}` },
        body: JSON.stringify({
          app_id: this.settings.appId,
          target_channel: "push",
          include_subscription_ids: to,
          headings: { en: message.title },
          contents: { en: message.body },
          data: message.data,
          priority: 10,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => null)) as Answer | null;
      if (!response.ok) {
        this.log.warn({ status: response.status, errors: answer?.errors }, "Push notifications not accepted");
        return [];
      }
      if (Array.isArray(answer?.errors)) {
        this.log.debug({ errors: answer.errors }, "Push notification reached no one");
        return [];
      }
      return answer?.errors?.invalid_player_ids ?? [];
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "Push notifications not sent");
      return [];
    }
  }
}

/** Without OneSignal keys, phones get nothing; everything else works the same. */
class NoPush implements PushSender {
  async send(): Promise<string[]> {
    return [];
  }
}

export function createPushSender(settings: OneSignalSettings | null, log: FastifyBaseLogger): PushSender {
  if (!settings) {
    log.info("Phone notifications are off: ONESIGNAL_APP_ID and ONESIGNAL_API_KEY are not set");
    return new NoPush();
  }
  return new OneSignalPush(settings, log);
}
