import {TriggerError} from '../triggers/protocol.js';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { AccountError, TaskError } from '@dentity/application';
import { CapabilityConfigError } from '../capability-config.js';
import { ModelProfileError } from '../model-profiles.js';
import { EmployeeChannelError } from '../employee-channels/service.js';

export interface HttpSecurityOptions {
  origin: string;
  secureCookies: boolean;
  sessionTtlMs: number;
}
export function validateHttpSecurity(config: HttpSecurityOptions): void {
  const parsedOrigin = new URL(config.origin);
  if (!Number.isSafeInteger(config.sessionTtlMs) || config.sessionTtlMs < 1000) throw new Error('Session TTL must be a positive integer of at least one second');
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== config.origin || (!config.secureCookies && !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)) || (config.secureCookies && parsedOrigin.protocol !== 'https:')) throw new Error('Use an exact HTTPS origin and secure cookies outside local loopback development');
}
export async function registerHttpSecurity(server: FastifyInstance, config: HttpSecurityOptions): Promise<void> {
  await server.register(cookie);
  await server.register(rateLimit, { global: false });
  server.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
    if ((request.routeOptions.config as {channelWebhook?:boolean}).channelWebhook!==true && (request.routeOptions.config as {triggerWebhook?:boolean}).triggerWebhook!==true && !request.url.startsWith('/internal/runtime/') && !request.url.startsWith('/internal/config/') && !request.url.startsWith('/internal/control/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.origin) return reply.code(403).send({ error: 'invalid_origin' });
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof TriggerError || error instanceof AccountError || error instanceof TaskError || error instanceof CapabilityConfigError || error instanceof ModelProfileError || error instanceof EmployeeChannelError) return reply.code(error.status).send({ error: error.code, ...(error instanceof EmployeeChannelError && error.validation ? {validation: error.validation} : {}) });
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.statusCode === 429 ? 'rate_limited' : 'invalid_input' });
    return reply.code(500).send({ error: 'internal_error' });
  });
}
