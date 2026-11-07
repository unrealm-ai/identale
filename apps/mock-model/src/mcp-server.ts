import { createServer as httpServer, type Server } from 'node:http';

export const MCP_PORT = 18303;
export const MCP_SERVICE = 'dentity-mock-mcp';
export const MCP_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
export const mcpDescription = (label: string) => `Local synthetic ${label} business lookup`;
export interface McpCall {
  sequence: number; label: string; name: 'lookup'; actor?: string; sessionId?: string; taskId?: string;
}
interface Options {
  observe?: (call: McpCall) => void;
  description?: (label: string) => string;
  maxAudit?: number;
}
const states = new WeakMap<Server, { stopping: boolean }>();
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(v) ? v : undefined;
/** Loopback test transport, not an authentication boundary. The Host owns tool authorization. */
export function createMcpServer(options: Options = {}): Server {
  const maxAudit = options.maxAudit ?? 1000;
  if (!Number.isSafeInteger(maxAudit) || maxAudit < 1 || maxAudit > 10000) throw new Error('Invalid MCP audit limit');
  const events: McpCall[] = [], counts = { alpha: 0, beta: 0 }, state = { stopping: false };
  let sequence = 0;
  const server = httpServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    void (async () => {
      if (req.method === 'GET' && ['/healthz', '/readyz'].includes(req.url ?? '')) return send(state.stopping ? 503 : 200, { service: MCP_SERVICE, protocolVersion: 1, status: state.stopping ? 'stopping' : req.url === '/readyz' ? 'ready' : 'alive' });
      if (req.method === 'GET' && req.url === '/calls') return send(200, { counts, total: sequence, retained: events.length, events });
      const label = req.url === '/alpha' ? 'alpha' : req.url === '/beta' ? 'beta' : undefined;
      if (!label) return send(404, { error: 'mock_mcp_route_not_found' });
      if (req.method !== 'POST') return send(405, { error: 'mock_mcp_method_not_allowed' });
      if (state.stopping) return send(503, { error: 'mock_mcp_stopping' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(415, { error: 'mock_mcp_json_required' });
      const chunks:Buffer[]=[];let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += Buffer.byteLength(chunk); if (size > 65536) { req.resume(); return send(413, { error: 'mock_mcp_request_too_large' }); }
        chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      }
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'mock_mcp_invalid_json' }); }
      if (!record(message) || message['jsonrpc'] !== '2.0' || typeof message['method'] !== 'string' || message['id'] !== undefined && typeof message['id'] !== 'string' && typeof message['id'] !== 'number') return send(400, { error: 'mock_mcp_invalid_request' });
      const id = message['id'];
      const rpcError = (code: number, text: string) => send(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
      if (id === undefined) {
        if (message['method'] !== 'notifications/initialized') return send(400, { error: 'mock_mcp_unknown_notification' });
        res.writeHead(202); res.end(); return;
      }
      let result: unknown;
      if (message['method'] === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'dentity-local-' + label, version: '1' } };
      else if (message['method'] === 'tools/list') result = { tools: [{ name: 'lookup', description: (options.description ?? mcpDescription)(label), inputSchema: MCP_SCHEMA }] };
      else if (message['method'] === 'ping') result = {};
      else if (message['method'] === 'tools/call') {
        const params = message['params'];
        if (!record(params) || params['name'] !== 'lookup' || !record(params['arguments']) || Object.keys(params['arguments']).length) return rpcError(-32602, 'Unknown tool or invalid arguments');
        let context: Record<string, unknown> = {};
        const header = req.headers['x-dentity-context'];
        try { const decoded: unknown = typeof header === 'string' ? JSON.parse(Buffer.from(header, 'base64url').toString()) : {}; if (record(decoded)) context = decoded; } catch { /* Metadata is optional and never authorization. */ }
        const trigger = context['trigger'], target = context['target'];
        const requester = record(trigger) ? trigger['requester'] : undefined;
        const actor = identifier(record(requester) ? requester['externalUserId'] : undefined), sessionId = identifier(context['sessionId']), taskId = identifier(record(target) ? target['taskId'] : undefined);
        const event: McpCall = { sequence: ++sequence, label, name: 'lookup', ...(actor ? { actor } : {}), ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) };
        counts[label]++; events.push(event); if (events.length > maxAudit) events.shift(); options.observe?.(event);
        result = { content: [{ type: 'text', text: 'LOCAL_MOCK_MCP_' + label.toUpperCase() + '_OK' }] };
      } else return rpcError(-32601, 'Method not found');
      send(200, { jsonrpc: '2.0', id, result });
    })().catch(() => { if (!res.writableEnded && !res.destroyed) send(500, { error: 'mock_mcp_internal_error' }); });
  });
  states.set(server, state); return server;
}
export async function closeMcpServer(server: Server): Promise<void> {
  const state = states.get(server); if (state) state.stopping = true;
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
