import { createMcpServer, closeMcpServer, MCP_PORT } from './mcp-server.js';
const raw = process.env['DENTITY_MOCK_MCP_PORT'] ?? String(MCP_PORT), port = Number(raw);
if (!/^\d+$/.test(raw) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local MCP port');
// Reads no model, platform or external service credentials.
const server = createMcpServer({ observe: call => console.log(JSON.stringify({ service: 'dentity-mock-mcp', event: 'tools/call', ...call })) });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5000).unref();
  void closeMcpServer(server).then(() => clearTimeout(deadline), () => { clearTimeout(deadline); process.exitCode = 1; });
});
server.on('error', () => { console.error('Unable to start local Mock MCP; check local port.'); process.exitCode = 1; });
server.listen({ host: '127.0.0.1', port });
