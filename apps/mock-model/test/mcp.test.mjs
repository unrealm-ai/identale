import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpServer,closeMcpServer,MCP_SERVICE} from '../dist/mcp-server.js';
async function fixture(t){const events=[],server=createMcpServer({maxAudit:2,observe:e=>events.push(e)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>closeMcpServer(server));const url=`http://127.0.0.1:${server.address().port}`;return{url,events,rpc:async(method,params={},path='/alpha',extra={})=>{const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return{status:r.status,body:await r.json()};}};}
test('standalone MCP implements initialize/list/call, bounded metadata audit and explicit close',async t=>{
 const f=await fixture(t);assert.deepEqual(await(await fetch(f.url+'/readyz')).json(),{service:MCP_SERVICE,protocolVersion:1,status:'ready'});
 assert.equal((await f.rpc('initialize')).body.result.protocolVersion,'2025-11-25');assert.equal((await f.rpc('tools/list')).body.result.tools[0].name,'lookup');
 const context=Buffer.from(JSON.stringify({sessionId:'session',target:{taskId:'task'},trigger:{requester:{externalUserId:'actor'}},privateSecret:'never-store-this',input:'never-store-input'})).toString('base64url');
 for(const path of ['/alpha','/beta','/alpha'])assert.match((await f.rpc('tools/call',{name:'lookup',arguments:{}},path,{'x-dentity-context':context})).body.result.content[0].text,/LOCAL_MOCK_MCP_/);
 const audit=await(await fetch(f.url+'/calls')).json();assert.deepEqual(audit.counts,{alpha:2,beta:1});assert.equal(audit.total,3);assert.equal(audit.retained,2);assert.deepEqual(audit.events.map(e=>e.sequence),[2,3]);assert.equal(audit.events[0].actor,'actor');assert.equal(f.events.length,3);assert.equal(JSON.stringify(audit).includes('never-store'),false);
});
test('invalid protocol, unknown methods/tools and oversized bodies never count as MCP executions',async t=>{
 const f=await fixture(t);assert.equal((await f.rpc('missing')).body.error.code,-32601);
 for(const params of [{name:'dangerous',arguments:{}},{name:'lookup',arguments:{actor:'spoof'}},{name:'lookup'}])assert.equal((await f.rpc('tools/call',params)).body.error.code,-32602);
 assert.equal((await fetch(f.url+'/missing')).status,404);assert.equal((await fetch(f.url+'/alpha')).status,405);
 assert.equal((await fetch(f.url+'/alpha',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
 for(const body of ['{','[]','{}'])assert.equal((await fetch(f.url+'/alpha',{method:'POST',headers:{'content-type':'application/json'},body})).status,400);
 assert.equal((await fetch(f.url+'/alpha',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(65537)})).status,413);
 assert.equal((await(await fetch(f.url+'/calls')).json()).total,0);
});
