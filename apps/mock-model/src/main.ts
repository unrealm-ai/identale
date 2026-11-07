import { closeServer, createServer, DEFAULT_PORT } from './server.js';
const rawPort = process.env['DENTITY_MOCK_MODEL_PORT'] ?? String(DEFAULT_PORT);
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local model port');
// Explicit allowlist: no provider/Host/platform credential or secrets file is consulted.
const token = process.env['DENTITY_MOCK_MODEL_TOKEN'];
const server = createServer(token === undefined ? {} : { token });
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>process.exit(1),5000).unref();
  void closeServer(server).then(()=>clearTimeout(deadline),()=>{clearTimeout(deadline);process.exitCode=1;});
});
server.on('error',()=>{console.error('Unable to start local rule model; check local configuration and port.');process.exitCode=1;});
server.listen({host:'127.0.0.1',port});
