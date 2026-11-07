import { createServer as httpServer, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuleEngine, MODEL_IDS } from './engine.js';
import { jsonCompletion, parseRequest, sseCompletion } from './protocol.js';
import { ModelError, fail, type CompletionRequest, type Rule } from './types.js';
export const DEFAULT_TOKEN = 'identity-local-test-token';
export const LEGACY_DEFAULT_TOKEN = 'dentity-local-test-token';
export const DEFAULT_PORT = 18302;
export const SERVICE_ID = 'dentity-rule-model';
export interface ServerOptions {
  token?: string; maxBodyBytes?: number; maxConcurrent?: number; rules?: readonly Rule[];
  /** Test-only, in-process observation. Never exposed as an HTTP endpoint or persisted. */
  observe?: (request: CompletionRequest, ruleId: string) => void;
}
interface State { controllers: Set<AbortController>; stopping: boolean }
const states = new WeakMap<Server,State>();
export function validateToken(token: string): string {
  if (token!==DEFAULT_TOKEN&&!/^dentity-local-test-[a-zA-Z0-9_-]{1,100}$/.test(token)) throw new Error('A synthetic local test token is required');
  return token;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const payload=JSON.stringify(value); if(Buffer.byteLength(payload)>65536) return fail(422,'mock_output_limit_exceeded');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(payload);
}
export function createServer(options: ServerOptions = {}): Server {
  const tokens = (options.token===undefined?[DEFAULT_TOKEN,LEGACY_DEFAULT_TOKEN]:[options.token]).map(value=>Buffer.from(validateToken(value)));
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576, maxConcurrent = options.maxConcurrent ?? 16;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 4_194_304 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error('Invalid local model limits');
  const engine = createRuleEngine(options.rules); const state: State = { controllers: new Set(), stopping: false };
  const server = httpServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, (request,response) => {
    void (async () => {
      if (request.url === '/healthz' && request.method === 'GET') return json(response,200,{ status: 'alive', service: SERVICE_ID, protocolVersion: 1 });
      if (request.url === '/readyz' && request.method === 'GET') return json(response,state.stopping?503:200,{ status: state.stopping?'stopping':'ready', service: SERVICE_ID, protocolVersion: 1 });
      if (!['/v1/models','/v1/chat/completions'].includes(request.url ?? '')) return fail(404,'mock_route_not_found');
      const header = request.headers.authorization;
      const supplied = Buffer.from(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '');
      if (!tokens.some(token=>supplied.length===token.length&&timingSafeEqual(supplied,token))) return fail(401,'mock_authentication_failed');
      if (request.url === '/v1/models' && request.method === 'GET') return json(response,200,{ object: 'list', data: MODEL_IDS.map(id=>({ id, object: 'model', created: 0, owned_by: SERVICE_ID })) });
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') return fail(405,'mock_method_not_allowed');
      if (state.stopping) return fail(503,'mock_service_stopping');
      if (state.controllers.size >= maxConcurrent) return fail(429,'mock_concurrency_limit');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415,'mock_json_content_type_required');
      const declared = Number(request.headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBodyBytes) return fail(413,'mock_request_too_large');
      const controller = new AbortController(); state.controllers.add(controller);
      const abort = () => controller.abort(); response.once('close',abort); request.once('aborted',abort);
      try {
        const chunks: Buffer[] = []; let size=0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.length; if (size > maxBodyBytes) { request.resume(); return fail(413,'mock_request_too_large'); } chunks.push(bytes); }
        let raw: unknown; try { raw=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400,'mock_invalid_json'); }
        const parsed = parseRequest(raw), completion = engine(parsed);
        options.observe?.(parsed,completion.ruleId);
        if (completion.delayMs) await delay(completion.delayMs,undefined,{ signal: controller.signal });
        if (controller.signal.aborted || response.destroyed) return;
        if (!parsed.stream) {
          const value = jsonCompletion(completion);
          if (completion.fault === 'invalid_arguments') for (const call of completion.calls) call.function.arguments = '{invalid';
          return json(response,200,value);
        }
        const frames=[...sseCompletion(completion,parsed.includeUsage)];
        if(frames.reduce((size,frame)=>size+Buffer.byteLength(frame),0)>65536) return fail(422,'mock_output_limit_exceeded');
        response.writeHead(200,{ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-content-type-options': 'nosniff', connection: 'keep-alive' });
        for (const frame of frames) {
          if (controller.signal.aborted || response.destroyed) return;
          if (!response.write(frame)) await new Promise<void>((resolve,reject)=>{
            const cleanup = () => { response.off('drain',drain); controller.signal.removeEventListener('abort',aborted); };
            const drain = () => { cleanup(); resolve(); }; const aborted = () => { cleanup(); reject(new Error('aborted')); };
            response.once('drain',drain); controller.signal.addEventListener('abort',aborted,{once:true});
          });
          await delay(1,undefined,{ signal: controller.signal });
        }
        response.end();
      } finally { response.off('close',abort); request.off('aborted',abort); state.controllers.delete(controller); }
    })().catch(error=>{
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const safe = error instanceof ModelError ? error : new ModelError(500,'mock_internal_error');
      json(response,safe.status,{ error: { code: safe.code, type: safe.status >= 500 ? 'server_error' : 'invalid_request_error', message: safe.code } });
    });
  });
  states.set(server,state); return server;
}
export async function closeServer(server: Server): Promise<void> {
  const state=states.get(server); if(state){state.stopping=true;for(const controller of state.controllers)controller.abort();}
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
