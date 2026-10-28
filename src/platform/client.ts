import type { FastifyInstance } from "fastify";
import type { ClientKind } from "./context.js";
import { AppError } from "./errors.js";

const KINDS: readonly ClientKind[] = ["web", "app", "delivery"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)!.slice(1).map(Number);
  const pb = SEMVER.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i]! - pb[i]!;
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** `/v1` callers say who they are. Apps below the minimum version get 426 and an update prompt. */
export function registerClientCheck(app: FastifyInstance) {
  app.decorateRequest("client", null);

  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || !request.url.startsWith("/v1/")) return;

    const kind = request.headers["x-client"];
    if (typeof kind !== "string" || !KINDS.includes(kind as ClientKind)) {
      throw new AppError("CLIENT_HEADER_REQUIRED");
    }

    const header = request.headers["x-app-version"];
    const version = typeof header === "string" && SEMVER.test(header) ? header : null;

    if (kind !== "web") {
      if (!version) throw new AppError("CLIENT_HEADER_REQUIRED", "Send X-App-Version like 1.2.3.");
      const min = kind === "app" ? app.config.minVersions.app : app.config.minVersions.delivery;
      if (min && compareVersions(version, min) < 0) {
        throw new AppError("UPGRADE_REQUIRED", undefined, [{ message: `Minimum version is ${min}`, minVersion: min }]);
      }
    }

    request.client = { kind: kind as ClientKind, version };
  });
}
