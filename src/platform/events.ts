import type { FastifyBaseLogger } from "fastify";

/**
 * In-process events between modules. Modules add their events by merging into this interface.
 * Handlers run after the response and must not be needed for correctness; anything that has to
 * survive a crash goes through the outbox instead.
 */
export interface PlatformEvents {
  "module.settings.changed": { module: string; changes: string[]; by: string };
}

type Handler<K extends keyof PlatformEvents> = (payload: PlatformEvents[K]) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<keyof PlatformEvents, Handler<never>[]>();

  constructor(private readonly log: FastifyBaseLogger) {}

  on<K extends keyof PlatformEvents>(name: K, handler: Handler<K>): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(name, list);
  }

  emit<K extends keyof PlatformEvents>(name: K, payload: PlatformEvents[K]): void {
    for (const handler of this.handlers.get(name) ?? []) {
      setImmediate(async () => {
        try {
          await (handler as Handler<K>)(payload);
        } catch (err) {
          this.log.error({ err, event: name }, "Event handler failed");
        }
      });
    }
  }
}
