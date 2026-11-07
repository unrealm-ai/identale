import Fastify from 'fastify';
import { resolveStoragePaths } from './storage-config.js';
import { bootstrap, type ControlPlaneConfig } from './bootstrap.js';
import {
  PROTOCOL_VERSION,
  healthResponseSchema,
  readinessResponseSchema,
  type HealthResponse,
  type ReadinessResponse,
} from '@dentity/contracts';

/** Local development process only. Liveness is not runtime capability/readiness. */
export function createServer(options: Partial<ControlPlaneConfig> = {}) {
  const storage = resolveStoragePaths(options);
  const server = Fastify({ logger: false, bodyLimit: 16384 });
  server.register(bootstrap, {
    ...options,
    ...storage,
    origin: options.origin ?? 'http://127.0.0.1:3000',
    secureCookies: options.secureCookies ?? false,
    sessionTtlMs: options.sessionTtlMs ?? 8 * 60 * 60 * 1000,
    now: options.now ?? Date.now,
  });
  server.get('/healthz', { schema: { response: { 200: healthResponseSchema } } }, () => ({
    protocolVersion: PROTOCOL_VERSION,
    service: 'control-plane',
    status: 'alive',
    executionAvailable: false,
  } satisfies HealthResponse));
  server.get('/readyz', { schema: { response: { 503: readinessResponseSchema } } }, (_request, reply) => {
    return reply.code(503).send({
      protocolVersion: PROTOCOL_VERSION,
      service: 'control-plane',
      status: 'not_ready',
      reason: 'runtime_not_verified',
    } satisfies ReadinessResponse);
  });
  return server;
}
