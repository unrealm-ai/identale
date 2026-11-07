import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createLocalTools} from '../dist/local-tools.js';
import {executionResourceFor,taskExecutionResource} from '../dist/execution-resources.js';
const text=result=>result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
async function fixture(t){const raw=await mkdtemp(join(tmpdir(),'dentity-local-directory-')),base=await realpath(raw),state=join(base,'host');await mkdir(state,{mode:0o700});t.after(()=>rm(raw,{recursive:true,force:true}));const spec={role:'execution',executionResources:[]},context={workspaceId:'qa-w',entityId:'qa-e',trigger:{kind:'human_request',requester:{externalUserId:'qa-a'}},sessionId:'qa-session',target:{kind:'task_run',taskId:'qa-task',runId:'qa-run'}};const registration=executionResourceFor(spec,[],state),resource=taskExecutionResource(registration,context,state);return{base,state,spec,context,registration,resource};}

test('local default cwd is namespace-derived and separate for actor/session/run; strong scope is not implied',async t=>{
 const f=await fixture(t);assert.deepEqual(f.resource.tools,['read','write','edit','bash']);
 for(const change of [{workspaceId:'other-w'},{entityId:'other-e'},{sessionId:'other-s'},{target:{...f.context.target,runId:'other-run'}},{trigger:{kind:'human_request',requester:{externalUserId:'qa-b'}}}])assert.notEqual(taskExecutionResource(f.registration,{...f.context,...change},f.state).directory,f.resource.directory);
 assert.equal(taskExecutionResource(f.registration,f.context,f.state).directory,f.resource.directory);
 assert.equal(executionResourceFor({role:'interaction'},[],f.state),undefined);
 assert.equal(f.resource.directory.includes('qa-session'),false,'untrusted path-like IDs never choose a directory name');
});

test('local tools keep native schemas and cwd but can read their own outside sentinel and reach own loopback',async t=>{
 const f=await fixture(t),calls=[],tools=await createLocalTools(f.resource,async name=>calls.push(name));t.after(()=>tools.close());const tool=name=>tools.tools.find(t=>t.name===name);
 await tool('write').execute('write',{path:'article.md',content:'# Local cwd\nBefore\n'});
 await tool('edit').execute('edit',{path:'article.md',edits:[{oldText:'Before',newText:'After'}]});assert.match(text(await tool('read').execute('read',{path:'article.md'})),/After/);
 const sentinel=join(f.base,'owned-outside.txt');await writeFile(sentinel,'LOCAL_OWNED_OUTSIDE');assert.match(text(await tool('read').execute('outside',{path:sentinel})),/LOCAL_OWNED_OUTSIDE/);
 const server=createServer((_req,res)=>res.end('LOCAL_OWNED_NETWORK'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const output=await tool('bash').execute('network',{command:`pwd; /usr/bin/curl --silent --fail http://127.0.0.1:${server.address().port}`});assert.ok(text(output).includes(f.resource.directory));assert.match(text(output),/LOCAL_OWNED_NETWORK/);assert.deepEqual(calls,['write','edit','read','read','bash']);
});

test('local mode still checks business authorization before native tools and does not inherit parent secret env',async t=>{
 const f=await fixture(t);process.env.DENTITY_QA_PARENT_SECRET='synthetic-private-parent';t.after(()=>delete process.env.DENTITY_QA_PARENT_SECRET);
 let allowed=false;const tools=await createLocalTools(f.resource,async()=>{if(!allowed)throw Error('Denied QA authority');});t.after(()=>tools.close());const tool=name=>tools.tools.find(t=>t.name===name);
 await assert.rejects(tool('write').execute('denied',{path:'denied.txt',content:'must not exist'}),/Denied/);await assert.rejects(readFile(join(f.resource.directory,'denied.txt')));allowed=true;
 const result=await tool('bash').execute('clean',{command:'test -z "$DENTITY_QA_PARENT_SECRET" && test -z "$DENTITY_RUNTIME_HOST_TOKEN" && test -z "$DENTITY_MODEL_MASTER_KEY" && printf LOCAL_CLEAN_ENV'});assert.match(text(result),/LOCAL_CLEAN_ENV/);
});

test('cancel after Bash actually starts remains unknown, stops its group and blocks follow-up tools',async t=>{
 const f=await fixture(t),unknown=[],tools=await createLocalTools(f.resource,async()=>{},name=>unknown.push(name));t.after(()=>tools.close());
 const tool=name=>tools.tools.find(t=>t.name===name),controller=new AbortController();
 // The pending command keeps running until cancellation; startup errors cannot satisfy this test.
 const pending=tool('bash').execute('cancel-started',{command:'printf "%s" "$$" > started.pid; printf started > started.txt; sleep 30; printf late > canceled-late.txt'},controller.signal);
 let settled=false;pending.then(()=>{settled=true},()=>{settled=true});
 const rejected=assert.rejects(pending,/execution outcome unknown/);
 const deadline=Date.now()+10000;let started=false;
 while(Date.now()<deadline){if(await readFile(join(f.resource.directory,'started.txt'),'utf8').catch(()=>null)==='started'){started=true;break}assert.equal(settled,false,'tool must still be active before its startup marker');await delay(20)}
 assert.equal(started,true,'Bash must create its marker before cancellation');assert.equal(settled,false);
 const bashPid=Number(await readFile(join(f.resource.directory,'started.pid'),'utf8'));assert.ok(Number.isSafeInteger(bashPid)&&bashPid>1);process.kill(bashPid,0);
 controller.abort();await rejected;assert.deepEqual(unknown,['bash']);
 let stopped=false;const stopDeadline=Date.now()+3000;
 while(Date.now()<stopDeadline){try{process.kill(bashPid,0)}catch(error){if(error.code!=='ESRCH')throw error;stopped=true;break}await delay(20)}
 assert.equal(stopped,true,'the Bash process proven active above must stop');
 await assert.rejects(tool('write').execute('after-cancel',{path:'after-cancel.md',content:'must not run'}),/not active/);
 await assert.rejects(readFile(join(f.resource.directory,'after-cancel.md')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.resource.directory,'canceled-late.txt')),{code:'ENOENT'});
});
