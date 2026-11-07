import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { InvocationContext } from '@dentity/domain';
import { digest, hasReservedFields, type RegisteredMcpServer } from './resources.js';
/** Registry-bound SDK adapter, not a general tool gateway. Remote business ACLs remain mandatory. */
export async function connectMcpTools(servers: RegisteredMcpServer[], context: InvocationContext, beforeTool?: (name: string) => Promise<void>, onUnknown?: (name: string) => Promise<void>) {
  const clients: McpClient[] = [];
  const tools: ToolDefinition[] = [];
  try {
    for (const server of servers) {
      const client = new McpClient({ name: 'dentity-pi-host', version: '0.2.0', capabilities: {}, requestTimeoutMs: 10_000 }); clients.push(client);
      const endpoint = new URL(server.endpoint).href;
      const transport = new StreamableHttpTransport({ url: endpoint, openGetStream: false, reconnect: { maxRetries: 0 }, maxMessageBytes: 1_048_576,
        fetch: async (url, init) => {
          if (new URL(String(url)).href !== endpoint || Date.parse(context.expiresAt) <= Date.now()) throw new Error('MCP scope expired or destination changed');
          const headers = new Headers(init?.headers);for(const [name,value]of Object.entries(server.headers??{}))headers.set(name,value); headers.set('x-dentity-context', Buffer.from(JSON.stringify(context)).toString('base64url'));
          // Identity header is trusted metadata, never model arguments. No OAuth/ambient auth recovery.
          return fetch(endpoint, { ...init, headers, redirect: 'error' });
        } });
      await client.connect(transport);
      const actual = await client.listTools();
      for (const reviewed of server.tools) {
        const advertised = actual.find(t => t.name === reviewed.name);
        if (!advertised || digest(advertised.inputSchema) !== digest(reviewed.inputSchema)) throw new Error('MCP schema differs from reviewed registration');
        tools.push({ executionMode: 'sequential', name: `mcp__${server.serverRef}__${reviewed.name}`, label: reviewed.name, description: reviewed.description,
          parameters: reviewed.inputSchema as ToolDefinition['parameters'],
          execute: async (_id, args, signal) => {
            if (Date.parse(context.expiresAt) <= Date.now() || hasReservedFields(args)) throw new Error('MCP arguments cannot override identity or credential binding');
            try {
              await beforeTool?.(`mcp__${server.serverRef}__${reviewed.name}`);
              const result = await client.callTool(reviewed.name, args as Record<string, unknown>, { ...(signal ? { signal } : {}), timeoutMs: 10_000 });
              if (result.isError) throw new Error('MCP business operation rejected');
              const content = result.content.filter(c => c.type === 'text').map(c => ({ type: 'text' as const, text: c.type === 'text' ? Object.values(server.headers??{}).flatMap(value=>[value,value.replace(/^Bearer /,'')]).filter(Boolean).reduce((text,secret)=>text.split(secret).join('[redacted]'),c.text) : '' }));
              if (Buffer.byteLength(JSON.stringify(content)) > 1_048_576) throw new Error('MCP result limit exceeded');
              return { content, details: {} };
            } catch { await onUnknown?.(`mcp__${server.serverRef}__${reviewed.name}`); throw new Error('MCP operation failed or outcome unknown; invocation stopped, do not retry'); }
          } });
      }
    }
    return { tools, close: async () => { await Promise.allSettled(clients.map(c => c.close())); } };
  } catch { await Promise.allSettled(clients.map(c => c.close())); throw new Error('Registered MCP initialization failed'); }
}
