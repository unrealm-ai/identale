/** Disposable actual-browser QA composition. Synthetic model/MCP and MockRuntime;
 * no provider credentials, real channels, existing databases or external tasks. */
import {createServer as httpServer, request as httpRequest} from 'node:http';
import {mkdtemp, readFile, writeFile, rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, extname, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../../dist/server.js';
import {createServer as createRuleModel, closeServer as closeRuleModel} from '../../../mock-model/dist/server.js';
import {createMcpServer, closeMcpServer} from '../../../mock-model/dist/mcp-server.js';

const root=await mkdtemp(join(tmpdir(),'identity-page-operation-qa-'));
const statePath='/tmp/identity-page-operation-state.json';
const model=createRuleModel(),mcp=createMcpServer();
const listen=server=>new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
await listen(model);await listen(mcp);
const modelUrl='http://127.0.0.1:'+model.address().port+'/v1';
const mcpUrl='http://127.0.0.1:'+mcp.address().port+'/alpha';
let app,tasks,notices,db,timer,closing=false,ticking=false;const requests=[],checks=[];
class MockRuntime {
 idempotentDispatch=true;idempotentInput=true;idempotentCancel=true;
 commands=[];stream=[];seen=new Set();timers=new Set();
 add(runId,event){const sequence=this.stream.filter(e=>e.runId===runId).length+1;this.stream.push({eventId:runId+':'+sequence,runId,sequence,...event});}
 capabilities(runId){return{runId,runtimeId:'qa-mock',runtimeVersion:'1',bindingVersion:'1',observedAt:Date.now(),expiresAt:Date.now()+60000,appendInput:'supported',cancel:'supported'};}
 async dispatch(c){if(this.seen.has(c.operationId))return{status:'accepted'};this.seen.add(c.operationId);this.commands.push({taskId:c.taskId,runId:c.runId,inputRevision:c.inputRevision});this.add(c.runId,{type:'status',status:'running'});
  if(c.input.includes('QA_BROWSER_FINISH')){const id=setTimeout(()=>{this.timers.delete(id);if(this.stream.some(e=>e.runId===c.runId&&e.status==='canceled'))return;this.add(c.runId,{type:'final_result',text:'QA_BROWSER_FINISH_OK',inputRevision:c.inputRevision});this.add(c.runId,{type:'status',status:'succeeded'});},1500);this.timers.add(id);}return{status:'accepted'};}
 async events(runId,after){return this.stream.filter(e=>e.runId===runId&&e.sequence>after);}
 async input(c){if(!this.seen.has(c.operationId)){this.seen.add(c.operationId);this.add(c.runId,{type:'input_receipt',inputRevision:c.inputRevision,inputStatus:'applied'});}return{status:'received'};}
 async cancel(c){if(!this.seen.has(c.operationId)){this.seen.add(c.operationId);this.add(c.runId,{type:'status',status:'canceled'});}return{status:'confirmed'};}
 close(){for(const t of this.timers)clearTimeout(t);}
}
const runtime=new MockRuntime();
const state=()=>({at:new Date().toISOString(),pid:process.pid,root,url:origin,modelUrl,mcpUrl,mode:'synthetic rules/MCP + MockRuntime; actual API/SQLite/browser',
 users:db?.prepare('SELECT id,username FROM users').all()??[],workspaces:db?.prepare('SELECT id,name FROM workspaces').all()??[],employees:db?.prepare('SELECT id,name,lifecycle_enabled FROM entities').all()??[],
 tasks:db?.prepare('SELECT id,entity_id,conversation_id,status,run_id,input_revision,version FROM tasks').all()??[],runs:db?.prepare('SELECT id,task_id,session_id,status FROM runs').all()??[],commands:runtime.commands,requests:requests.slice(-500),checks});
async function save(){const tmp=statePath+'.next';await writeFile(tmp,JSON.stringify(state(),null,2)+'\n',{mode:0o600});await rename(tmp,statePath);}
const dist=resolve('apps/web/dist');
const front=httpServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/__qa/state'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(state()));return;}
 if(url.pathname==='/__qa/checkpoint'&&req.method==='POST'){let text='';for await(const chunk of req)text+=chunk;checks.push({at:new Date().toISOString(),...JSON.parse(text)});await save();res.end('ok');return;}
 if(url.pathname==='/__qa/stop'&&req.method==='POST'){res.end('stopping only disposable QA');setTimeout(()=>void stop(),0);return;}
 if(url.pathname.startsWith('/api/')){if(!app){res.writeHead(503);res.end();return;}const proxy=httpRequest({host:'127.0.0.1',port:app.server.address().port,path:req.url,method:req.method,headers:req.headers},reply=>{requests.push({at:new Date().toISOString(),method:req.method,path:url.pathname,http:reply.statusCode});res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);return;}
 const target=resolve(dist,'.'+url.pathname),file=target.startsWith(dist+sep)&&existsSync(target)&&extname(target)?target:join(dist,'index.html');const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(await readFile(file));
 }catch{res.writeHead(500);res.end('QA fixture error');}});
await listen(front);const origin='http://localhost:'+front.address().port;
app=createServer({databasePath:join(root,'qa.sqlite'),origin,pollIntervalMs:0,runtime,modelProfiles:{masterKey:Buffer.alloc(32,83),allowLoopbackHttp:true},mcpResources:{allowLoopbackHttp:true,allowedOrigins:[new URL(mcpUrl).origin]},skillResourceRoot:join(root,'skill-resources'),directorySync:{automatic:false},triggers:{automatic:false,allowLoopbackHttp:true},maintenance:{enabled:false},onService:s=>tasks=s,onTaskCompletionNotifications:s=>notices=s});
await app.listen({host:'127.0.0.1',port:0});db=new DatabaseSync(join(root,'qa.sqlite'));
async function tick(){if(ticking||closing)return;ticking=true;try{await tasks.tick();await notices.tick();await save();}catch(e){checks.push({at:new Date().toISOString(),fixtureError:e.code??e.name});}finally{ticking=false;}}
timer=setInterval(()=>void tick(),300);await save();console.log(JSON.stringify({origin,root,statePath,modelUrl,mcpUrl,scope:'disposable QA only; no existing data/cookies on 127.0.0.1'}));
async function stop(){if(closing)return;closing=true;clearInterval(timer);while(ticking)await new Promise(r=>setTimeout(r,20));runtime.close();await save();await app.close();db.close();await closeRuleModel(model);await closeMcpServer(mcp);await new Promise(r=>{front.close(r);front.closeAllConnections();});process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
