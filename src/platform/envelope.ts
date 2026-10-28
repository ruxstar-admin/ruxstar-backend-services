import type { FastifyRequest } from "fastify";

export const ok = <T>(request: FastifyRequest, data: T) => ({ data, meta: { requestId: request.id } });

export const page = <T>(request: FastifyRequest, data: T[], nextCursor: string | null) => ({
  data,
  meta: { requestId: request.id, nextCursor },
});
