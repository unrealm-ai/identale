import { launcherDirectory, testHome } from './helpers/local-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { repositoryRoot } from '../shared/local-secrets.mjs';
import { baseEnvironment, superviseLocal, reservePorts } from '../local/local-start.mjs';
const exec = promisify(execFile);
// Build this real process explicitly so test:local also works after a clean checkout.
test.before(async () => { await exec(process.execPath, [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-b', 'apps/mock-model'], { cwd: repositoryRoot, env: baseEnvironment(process.env) }); });
async function ports() {
  const list = Array.from({ length: 5 }, () => net.createServer());
  for (const server of list) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = list.map(server => server.address().port);
  await Promise.all(list.map(server => new Promise(resolve => server.close(resolve)))); return result;
}
test('R10 real model and MCP processes join five-service ownership, restart and release ports', { timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/dentity-mock-launch-'));
  const allocated = await ports(), source = new EventEmitter();
  const commands = [
    { name: 'actual rule model', file: process.execPath, args: [path.join(repositoryRoot, 'apps/mock-model/dist/main.js')], port: allocated[0], env: { DENTITY_MOCK_MODEL_PORT: String(allocated[0]) }, health: { path: '/readyz', service: 'dentity-rule-model', protocolVersion: 1, status: 'ready' } },
    { name: 'actual Mock MCP', file: process.execPath, args: [path.join(repositoryRoot, 'apps/mock-model/dist/mcp-main.js')], port: allocated[1], env: { DENTITY_MOCK_MCP_PORT: String(allocated[1]) }, health: { path: '/readyz', service: 'dentity-mock-mcp', protocolVersion: 1, status: 'ready' } },
    ...allocated.slice(2).map((port, index) => ({ name: `local-service-fixture-${index}`, file: process.execPath, args: ['-e', "const s=require('node:net').createServer();s.listen(Number(process.argv[1]),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)))", String(port)], port, env: { HOME: testHome } })),
  ];
  let first, second;
  t.after(async () => { for (const instance of [first, second]) if (instance) { await instance.stop(); await instance.completion; } await fs.rm(root, { recursive: true, force: true }); });
  const start = () => superviseLocal({ cwd: root, commands, signalSource: source, log() {}, killAfterMs: 2000 });
  const chat = async () => {
    const response = await fetch(`http://127.0.0.1:${allocated[0]}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer identity-local-test-token' }, body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: '你好' }], stream: false }) });
    assert.equal(response.status, 200); return response.json();
  };
  const mcp = async () => { const response=await fetch(`http://127.0.0.1:${allocated[1]}/alpha`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'lookup',arguments:{}}})}); assert.equal(response.status,200);assert.equal((await response.json()).result.content[0].text,'LOCAL_MOCK_MCP_ALPHA_OK'); };
  first = await start(); assert.equal(first.started, true);
  await mcp(); assert.equal((await(await fetch(`http://127.0.0.1:${allocated[1]}/calls`)).json()).total,1);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${allocated[0]}/readyz`)).json(), { status: 'ready', service: 'dentity-rule-model', protocolVersion: 1 });
  assert.equal((await chat()).choices[0].message.content, '你好。我可以帮你做什么');
  second = await start(); assert.equal(await first.completion, 0); assert.notEqual(first.instance.instance, second.instance.instance);
  assert.equal((await(await fetch(`http://127.0.0.1:${allocated[1]}/calls`)).json()).total,0,'process audit resets on managed restart');await mcp();
  assert.equal((await chat()).choices[0].message.content, '你好。我可以帮你做什么');
  assert.deepEqual(await fs.readdir(root), [], 'launcher state stays outside the checkout; no business configuration is seeded');
  assert.deepEqual((await fs.readdir(launcherDirectory(root))).sort(), ['control.sock', 'diagnostics', 'instance.json']);
  source.emit('SIGTERM'); assert.equal(await second.completion, 143);
  const held = await reservePorts(allocated); await Promise.all(held.map(server => new Promise(resolve => server.close(resolve))));
});

test('R11 actual MCP readiness identity mismatch cleans model and MCP without business configuration', {timeout:15000},async t=>{
 const root=await fs.realpath(await fs.mkdtemp('/tmp/dentity-mcp-ready-')),allocated=(await ports()).slice(0,2);let running;
 t.after(async()=>{if(running){await running.stop();await running.completion;}await fs.rm(root,{recursive:true,force:true});});
 const commands=[
  {name:'model',file:process.execPath,args:[path.join(repositoryRoot,'apps/mock-model/dist/main.js')],port:allocated[0],env:{DENTITY_MOCK_MODEL_PORT:String(allocated[0])}},
  {name:'MCP wrong expected identity',file:process.execPath,args:[path.join(repositoryRoot,'apps/mock-model/dist/mcp-main.js')],port:allocated[1],env:{DENTITY_MOCK_MCP_PORT:String(allocated[1])},health:{path:'/readyz',service:'wrong-service',protocolVersion:1,status:'ready'}},
 ];
 running=await superviseLocal({cwd:root,commands,signalSource:new EventEmitter(),timeoutMs:300,killAfterMs:500,log(){}});assert.equal(running.started,false);assert.equal(await running.completion,1);assert.equal(running.cleanupConfirmed,true);
 const held=await reservePorts(allocated);await Promise.all(held.map(s=>new Promise(r=>s.close(r))));assert.deepEqual(await fs.readdir(root), []);assert.deepEqual(await fs.readdir(launcherDirectory(root)), ['diagnostics']);
});
