/** Isolated PI 1.4.0 lifecycle experiment. No production code/vendor changes. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync,readFileSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
const self=fileURLToPath(import.meta.url),argument=process.argv.slice(2);
const readJSON=p=>JSON.parse(readFileSync(p,'utf8'));
const saveJSON=(p,v)=>{writeFileSync(p+'.new',JSON.stringify(v,null,2));renameSync(p+'.new',p);};
const tool=(name,args={},id=name)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const ask=(id='q1')=>tool('ask_human',{requestId:id,version:1,question:'Synthetic approval '+id},'call-'+id);
const effect=(id='q1')=>tool('side_effect',{requestId:id},'effect-'+id);
const result=(value,terminate=false)=>({content:[{type:'text',text:JSON.stringify(value)}],details:value,...(terminate?{terminate:true}:{})});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function inspectJournal(file){const entries=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),calls=[],results=[];for(const entry of entries){const m=entry.message;if(m?.role==='assistant')for(const c of m.content??[])if(c.type==='toolCall')calls.push(c.id);if(m?.role==='toolResult')results.push(m.toolCallId);}return{calls,results,unpaired:calls.filter(id=>!results.includes(id)),duplicateResults:results.filter((id,i)=>results.indexOf(id)!==i),entryCount:entries.length,bytes:readFileSync(file).length};}
async function child(mode,dir){
 await mkdir(join(dir,'workspace'),{recursive:true});await mkdir(join(dir,'agent'),{recursive:true});
 const stateFile=join(dir,'host-state.json');if(!existsSync(stateFile))saveJSON(stateFile,{requests:{},effects:[],blocked:[],providerCalls:0});
 const state=readJSON(stateFile),save=()=>saveJSON(stateFile,state);let session,releaseLive,enteredResolve;const entered=new Promise(r=>enteredResolve=r),events=[],requests=[];
 const terminate=['terminate-single','terminate-mixed','safe-initial','safe-resume1','safe-resume2','safe-order','safe-two'].includes(mode);
 const guarded=mode.startsWith('safe-');
 const plan=(index,body)=>{
  if(mode==='safe-initial')return index===0?[tool('stage_effect',{},'stage')]:[ask(),effect()];
  if(mode==='safe-order')return [effect(),ask()];
  if(mode==='safe-no-ask')return [effect()];
  if(mode==='safe-two')return [ask(),ask('q2'),effect()];
  if(mode==='safe-resume1'){if(index===0){assert.ok(JSON.stringify(body.messages).includes('HUMAN_RESPONSE q1 approved'));return[tool('side_effect',{requestId:'q1'},'effect-q1-resumed')];}return[ask('q2'),effect('q2')];}
  if(mode==='safe-resume2'){assert.ok(JSON.stringify(body.messages).includes('HUMAN_RESPONSE q2 approved'));return index===0?[tool('side_effect',{requestId:'q2'},'effect-q2-resumed')]:null;}
  if(mode==='resume-orphan')return null;
  if(index===0)return ['live','terminate-mixed','abort','dispose','finish-end'].includes(mode)?[ask(),effect()]:[ask()];
  if(index===1&&['waiting-result','boundary-false'].includes(mode))return[effect()];
  return null;
 };
 const server=createServer(async(req,res)=>{try{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);const index=requests.length-1;state.providerCalls++;save();if(index>5)throw Error('fixture provider loop budget');const calls=plan(index,body);res.writeHead(200,{'content-type':'text/event-stream'});const chunk=(delta,finish=null)=>`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'pi-human-fixture',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;if(calls)res.end(chunk({tool_calls:calls.map((c,i)=>({...c,index:i}))})+chunk({},'tool_calls')+'data: [DONE]\n\n');else res.end(chunk({content:'Synthetic completed turn'})+chunk({},'stop')+'data: [DONE]\n\n');}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}});
 await new Promise((r,j)=>server.once('error',j).listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/v1';
 const runtime=await ModelRuntime.create({credentials:{read:async()=>undefined,list:async()=>[],modify:async()=>{throw Error('no credential writes');},delete:async()=>{}},modelsPath:null,modelsStorePath:join(dir,'model-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
 runtime.registerProvider('experiment',{api:'openai-completions',baseUrl:base,authHeader:true,models:[{id:'pi-human-fixture',name:'fixture',api:'openai-completions',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}]});await runtime.setRuntimeApiKey('experiment','synthetic-not-a-real-key');
 const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0}});
 const pending=()=>Object.values(state.requests).find(r=>r.status==='pending');
 const tools=[{name:'ask_human',label:'Ask human',description:'Request an external human decision. Tool availability is explicit, not a prompt-only convention.',exposure:'model-only',executionMode:'sequential',parameters:{type:'object',properties:{requestId:{type:'string'},version:{type:'integer'},question:{type:'string'}},required:['requestId','version','question'],additionalProperties:false},execute:async(callId,args,signal)=>{
  const old=state.requests[args.requestId];if(old)assert.equal(old.version,args.version);else state.requests[args.requestId]={...args,toolCallId:callId,status:'pending'};save();enteredResolve();
  if(mode==='live'){const answer=await new Promise((r,j)=>{releaseLive=r;signal?.addEventListener('abort',()=>j(Error('live request aborted')),{once:true});});state.requests[args.requestId].status='answered';state.requests[args.requestId].answer=answer;save();return result({status:'answered',answer});}
  if(mode==='orphan'){await new Promise(r=>setTimeout(r,40));saveJSON(join(dir,'orphan-before-exit.json'),{pid:process.pid,sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile()});process.exit(0);}
  if(mode==='dispose')await delay(70);
  return result({status:'waiting',requestId:args.requestId,version:args.version},terminate);
 }},{name:'side_effect',label:'Synthetic side effect',description:'Increment a fixture-only counter; no real external effect.',executionMode:'sequential',parameters:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false},execute:async(_id,args)=>{state.effects.push({requestId:args.requestId,approved:state.requests[args.requestId]?.status==='answered'});appendFileSync(join(dir,'workspace','effects.txt'),args.requestId+'\n');save();return result({done:true});}},{name:'stage_effect',label:'Fixture prep',description:'Write a synthetic workspace file before requesting human.',executionMode:'sequential',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{state.effects.push({requestId:'stage',approved:true});writeFileSync(join(dir,'workspace','prepared.txt'),'retained synthetic workspace');save();return result({prepared:true});}}];
 const factory=pi=>{
  if(guarded)pi.on('tool_call',(event,ctx)=>{
   const assistant=[...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==='message'&&e.message.role==='assistant')?.message;
   const batchHasAsk=assistant?.content?.some(c=>c.type==='toolCall'&&c.name==='ask_human');
   const waiting=pending();
   const missingApproval=event.toolName==='side_effect'&&state.requests[event.input.requestId]?.status!=='answered';
   if(event.toolName!=='ask_human'&&(waiting||batchHasAsk||missingApproval)||event.toolName==='ask_human'&&waiting&&waiting.requestId!==event.input.requestId){state.blocked.push({name:event.toolName,toolCallId:event.toolCallId});save();return{block:true,terminate:true,reason:'Waiting for a human decision; no sibling side effects run'};}
  });
  if(mode==='abort')pi.on('tool_result',(event,ctx)=>{if(event.toolName==='ask_human')ctx.abort();});
  if(mode==='boundary-false')pi.on('turn_end',()=>({continue:false}));
 };
 let loader;
 if(guarded||['abort','boundary-false'].includes(mode)){
  loader=new DefaultResourceLoader({cwd:join(dir,'workspace'),agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Isolated deterministic fixture. Use only registered tools.',extensionFactories:[factory]});await loader.reload();
 }else loader={getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=> 'Isolated deterministic fixture. Use only registered tools.',getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{throw Error('disabled');},reload:async()=>{}};
 const pointer=join(dir,'pointer.json'),resuming=mode.startsWith('safe-resume')||mode==='resume-orphan';
 const manager=resuming?SessionManager.open(readJSON(pointer),join(dir,'workspace'),join(dir,'sessions')):SessionManager.create(join(dir,'workspace'),join(dir,'sessions'));
 if(!resuming)saveJSON(pointer,manager.getSessionFile());
 const created=await createAgentSession({cwd:join(dir,'workspace'),agentDir:join(dir,'agent'),modelRuntime:runtime,model:runtime.getModel('experiment','pi-human-fixture'),thinkingLevel:'off',resourceLoader:loader,tools:tools.map(t=>t.name),noTools:'builtin',customTools:tools,sessionManager:manager,settingsManager:settings});session=created.session;
 session.subscribe(event=>{if(['agent_end','agent_settled','turn_end','tool_execution_end'].includes(event.type))events.push({type:event.type,aborted:event.aborted,stopReason:event.message?.stopReason,toolCallId:event.toolCallId,isError:event.isError});});
 if(mode==='finish-end'){const previous=session.agent.finishTurn;session.agent.finishTurn=async(...args)=>{await previous?.(...args);return{action:'end'};};}
 let error;let liveBefore;
 try{
  const prompt=session.prompt(mode==='safe-resume1'?'HUMAN_RESPONSE q1 approved':mode==='safe-resume2'?'HUMAN_RESPONSE q2 approved':mode==='resume-orphan'?'HUMAN_RESPONSE q1 approved':'Synthetic initial request');
  if(mode==='live'){await entered;await delay(100);liveBefore={providerCalls:requests.length,effects:state.effects.length,settled:events.some(e=>e.type==='agent_settled')};releaseLive('approved');}
  if(mode==='dispose'){await entered;session.dispose();}
  await prompt;
 }catch(e){error=e.message;}
 for(const request of Object.values(state.requests))if(request.status==='answered'&&resuming)request.consumed=true;save();
 const file=manager.getSessionFile();const summary={mode,pid:process.pid,sessionId:manager.getSessionId(),sessionFile:file,stopMethod:typeof session.stop,requests:requests.length,host:state,events,liveBefore,error,journal:inspectJournal(file),providerSawToolResults:requests.map(r=>r.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id)),workspaceRetained:existsSync(join(dir,'workspace','prepared.txt'))};
 saveJSON(join(dir,'result-'+mode+'.json'),summary);await writeFile(join(dir,'provider-'+mode+'.json'),JSON.stringify(requests,null,2));session.dispose();await new Promise(r=>{server.close(r);server.closeAllConnections();});console.log(JSON.stringify({mode,pid:process.pid,requests:requests.length,error,unpaired:summary.journal.unpaired,effects:state.effects}));
}
async function parent(){
 const output=argument[0]?resolve(argument[0]):await mkdtemp(join(tmpdir(),'identity-pi-human-'));await mkdir(output,{recursive:true});const results=[],failures=[];
 async function launch(mode,dir){await mkdir(dir,{recursive:true});const log=join(dir,'process-'+mode+'.log');const info=await new Promise(resolveChild=>{const c=fork(self,['--child',mode,dir],{env:{PATH:process.env.PATH,HOME:dir,TMPDIR:output,LANG:'en_US.UTF-8'},execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>{c.kill('SIGKILL');},20000);c.on('exit',(code,signal)=>{clearTimeout(timer);writeFileSync(log,stdout+stderr);resolveChild({mode,pid:c.pid,exit:code,signal});});});assert.equal(info.exit,0,JSON.stringify(info)+' '+readFileSync(log,'utf8').slice(-1200));const file=join(dir,'result-'+mode+'.json');const resultFile=existsSync(file)?readJSON(file):readJSON(join(dir,'orphan-before-exit.json'));results.push({...info,result:resultFile});return resultFile;}
 async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failures.push({name,error:e.message});console.log('FAIL '+name+' '+e.message);}}
 await check('A live external Promise waits and same-process answer continues',async()=>{const r=await launch('live',join(output,'live'));assert.deepEqual(r.liveBefore,{providerCalls:1,effects:0,settled:false});assert.equal(r.host.effects.length,1);assert.equal(r.host.effects[0].approved,true);assert.deepEqual(r.journal.unpaired,[]);});
 await check('negative structured waiting result alone does not stop model loop',async()=>{const r=await launch('waiting-result',join(output,'waiting-result'));assert.equal(r.host.effects[0].approved,false);assert.ok(r.requests>=3);});
 await check('B native terminate true ends single-tool batch cleanly',async()=>{const r=await launch('terminate-single',join(output,'terminate-single'));assert.equal(r.requests,1);assert.deepEqual(r.journal.unpaired,[]);assert.ok(r.events.some(e=>e.type==='agent_settled'&&e.aborted===false));});
 await check('negative terminate true on ask alone does not fence sibling tool',async()=>{const r=await launch('terminate-mixed',join(output,'terminate-mixed'));assert.equal(r.host.effects[0].approved,false);assert.ok(r.requests>1);});
 await check('negative turn_end continue:false is not forced stop',async()=>{const r=await launch('boundary-false',join(output,'boundary-false'));assert.equal(r.host.effects[0].approved,false);});
 await check('negative finishTurn end stops after batch, not before sibling effect',async()=>{const r=await launch('finish-end',join(output,'finish-end'));assert.equal(r.requests,1);assert.equal(r.host.effects[0].approved,false);});
 await check('abort records cancellation semantics and incomplete sibling results',async()=>{const r=await launch('abort',join(output,'abort'));assert.equal(r.host.effects.length,0);assert.ok(r.journal.unpaired.includes('effect-q1'));assert.ok(r.events.some(e=>e.type==='agent_settled'&&e.aborted));});
 await check('dispose is cleanup, not durable human checkpoint',async()=>{const r=await launch('dispose',join(output,'dispose'));assert.equal(r.host.effects.length,0);assert.ok(r.journal.unpaired.length>0);});
 await check('C public gate fences sibling even when side effect precedes ask',async()=>{const r=await launch('safe-order',join(output,'safe-order'));assert.equal(r.host.effects.length,0);assert.equal(r.requests,1);assert.deepEqual(r.journal.unpaired,[]);assert.ok(r.host.blocked.length);});
 await check('C skipping ask cannot bypass required approval gate',async()=>{const r=await launch('safe-no-ask',join(output,'safe-no-ask'));assert.equal(r.host.effects.length,0);assert.equal(r.requests,1);assert.deepEqual(r.journal.unpaired,[]);});
 await check('C one pending request for two ask calls in same batch',async()=>{const r=await launch('safe-two',join(output,'safe-two'));assert.equal(Object.keys(r.host.requests).length,1);assert.equal(r.host.effects.length,0);assert.deepEqual(r.journal.unpaired,[]);});
 await check('C new processes open same session, retain workspace, consume two replies once',async()=>{
  const dir=join(output,'safe-roundtrip'),first=await launch('safe-initial',dir),prefix=await readFile(first.sessionFile);assert.equal(first.requests,2);assert.deepEqual(first.host.effects.map(x=>x.requestId),['stage']);assert.deepEqual(first.journal.unpaired,[]);
  function answer(id,version,text){const state=readJSON(join(dir,'host-state.json')),r=state.requests[id];assert.ok(r);assert.equal(r.version,version,'answer version must match');if(r.status==='answered'){assert.equal(r.answer,text,'same request cannot accept another answer');return{reused:true,consumed:r.consumed===true};}r.status='answered';r.answer=text;saveJSON(join(dir,'host-state.json'),state);return{reused:false};}
  assert.throws(()=>answer('q1',2,'approved'));answer('q1',1,'approved');assert.deepEqual(answer('q1',1,'approved'),{reused:true,consumed:false});assert.throws(()=>answer('q1',1,'different'));
  const second=await launch('safe-resume1',dir);assert.equal(second.sessionId,first.sessionId);assert.equal(second.sessionFile,first.sessionFile);assert.notEqual(second.pid,first.pid);assert.deepEqual(second.host.effects.map(x=>x.requestId),['stage','q1']);assert.equal(second.host.requests.q2.status,'pending');assert.equal(second.workspaceRetained,true);assert.deepEqual(second.journal.unpaired,[]);assert.ok((await readFile(first.sessionFile)).subarray(0,prefix.length).equals(prefix));
  assert.deepEqual(answer('q1',1,'approved'),{reused:true,consumed:true});answer('q2',1,'approved');const third=await launch('safe-resume2',dir);assert.equal(third.sessionId,first.sessionId);assert.notEqual(third.pid,second.pid);assert.deepEqual(third.host.effects.map(x=>x.requestId),['stage','q1','q2']);assert.ok(third.host.effects.every(x=>x.approved));assert.deepEqual(third.journal.unpaired,[]);assert.deepEqual(third.journal.duplicateResults,[]);assert.deepEqual(answer('q2',1,'approved'),{reused:true,consumed:true});
 });
 await check('negative exiting live Promise does not persist its awaiting continuation',async()=>{const dir=join(output,'orphan'),r=await launch('orphan',dir);const before=inspectJournal(r.sessionFile);assert.ok(before.unpaired.includes('call-q1'));const resumed=await launch('resume-orphan',dir);assert.equal(resumed.sessionId,r.sessionId);assert.equal(resumed.host.requests.q1.status,'pending');assert.equal(resumed.host.effects.length,0);});
 const sdk=readJSON(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'));const summary={sdk:sdk.version,node:process.version,output,counts:{checks:13,pass:13-failures.length,fail:failures.length},failures,results,scope:'isolated loopback deterministic provider, synthetic custom tools; no production Host change, no real model/channel, no vendor patch'};await writeFile(join(output,'results.json'),JSON.stringify(summary,null,2));console.log('RESULT '+JSON.stringify({output,counts:summary.counts}));if(failures.length)process.exitCode=1;
}
if(argument[0]==='--child')await child(argument[1],argument[2]);else await parent();
