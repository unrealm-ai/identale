import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../dist/server.js';
import {SqliteTaskRepository} from '../dist/adapters/sqlite/task-repository.js';
import {recipientCandidate} from '../dist/human-recipient-router.js';

// Real HTTP authorization, repositories and projection services; only isolated synthetic rows.
// No model, runtime dispatch, external search, channel send or production database is used.
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'work-item-human-recipients-'));
 let items,channels;
 const origin='http://127.0.0.1:5173',app=createServer({databasePath:join(root,'db.sqlite'),origin,pollIntervalMs:0,triggers:{automatic:false},directorySync:{automatic:false},maintenance:{enabled:false},onWorkItemService:value=>items=value,onEmployeeChannelService:value=>channels=value});
 await app.ready();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
 async function register(name){const response=await call('POST','/api/auth/register',{username:name,password:'Synthetic Recipient Password 2026!'});assert.equal(response.statusCode,201,response.body);return{...response.json(),cookie:response.headers['set-cookie'].split(';')[0]};}
 const owner=await register('recipient-owner'),member=await register('recipient-member'),outside=await register('recipient-outsider'),workspaceId=owner.workspace.id,base='/api/workspaces/'+workspaceId;
 const invitation=(await call('POST',base+'/invitations',{},owner.cookie)).json().token;assert.equal((await call('POST','/api/invitations/accept',{token:invitation},member.cookie)).statusCode,200);
 async function entity(account,name){const response=await call('POST','/api/workspaces/'+account.workspace.id+'/entities',{name,ownWebUse:true},account.cookie);assert.equal(response.statusCode,200,response.body);return response.json().entity;}
 const employee=await entity(owner,'Synthetic proposer'),otherEmployee=await entity(owner,'Other proposer'),foreignEmployee=await entity(outside,'Foreign proposer'),store=items.store,tasks=new SqliteTaskRepository(store);
 function connection(id,w,e,actor){const record={id,sourceId:'source-'+id,workspaceId:w,entityId:e,provider:'wecom',appId:'bot-'+id,botId:'bot-'+id,eventTenantId:'bot-'+id,identity:{appId:'bot-'+id,tenantId:'bot-'+id,tenantIdNamespace:'app_id'},revision:1,authRevision:1,stateVersion:0,status:'verified',enabled:true,directoryStatus:'unavailable',lastError:null,credential:{ciphertext:'unused',nonce:'unused',tag:'unused'},createdBy:actor,updatedBy:actor};assert.equal(channels.repository.save(record,undefined),true);return record;}
 const current=connection('current',workspaceId,employee.id,owner.user.id),other=connection('other',workspaceId,otherEmployee.id,owner.user.id),foreign=connection('foreign',outside.workspace.id,foreignEmployee.id,outside.user.id);
 const target=(id='search-b',record=current)=>({kind:'wecom_directory',connectionId:record.id,provider:'wecom',appId:record.appId,tenantId:record.eventTenantId,sourceId:record.sourceId,authRevision:record.authRevision,directoryUserId:id,identityNamespace:'user_id'});
 const contact=(id,name,record=current)=>channels.botContacts.remember(record,[{id,displayName:name,departmentPaths:[]}]);
 const map=(searchId,callbackUserId)=>{const previous=channels.repository.byId(current.id);assert.equal(channels.repository.save({...previous,wecomContactIdentityRevision:previous.authRevision,wecomContactMappings:[...(previous.wecomContactMappings??[]),{userId:searchId,callbackUserId,requestId:'verify-'+searchId,verifiedAt:Date.now(),method:'administrator_relay'}]},previous),true);};
 const canonical=(searchId,callbackUserId,includeReference=true)=>({kind:'channel',connectionId:current.id,provider:'wecom',appId:current.appId,tenantId:current.eventTenantId,userId:callbackUserId,identityNamespace:'user_id',...(includeReference?{directoryReference:{sourceId:current.sourceId,authRevision:current.authRevision,directoryUserId:searchId}}:{})});
 function rules(values){const json=JSON.stringify(values);store.run('INSERT INTO employee_human_rules VALUES(?,?,1,?) ON CONFLICT(workspace_id,entity_id) DO UPDATE SET version=version+1,rules_json=excluded.rules_json',workspaceId,employee.id,json);return values.map(rule=>({version:1,status:'waiting_identity',configDigest:createHash('sha256').update(json).digest('hex'),candidateId:recipientCandidate(rule.questionScope,rule.target).candidateId}));}
 function request(id,value,{selection,linked=false,conversationId,status='waiting',notificationStatus=selection||value?.kind==='wecom_directory'?'blocked':'queued'}={}){
  const now=Date.now(),taskId='task-'+id,runId='run-'+id,scope={workspaceId,entityId:employee.id,userId:owner.user.id,conversationId:null};tasks.insertPlannedTask(taskId,scope,id,'hash','Synthetic task','fresh','[]','[]',null,now);tasks.insertRun(runId,taskId,'session-'+id,now);tasks.startPlannedTask(taskId,1,runId,'snapshot','[]',null,1,now);
  store.run('INSERT INTO human_requests(request_id,workspace_id,entity_id,task_id,source_run_id,session_id,question_json,question_digest,content_version,target_json,selection_json,target_conversation_id,status,notification_status,notification_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,1,?,?,?,?,?,?,?,?)',id,workspaceId,employee.id,taskId,runId,'session-'+id,'{}','hash',value?JSON.stringify(value):null,selection?JSON.stringify(selection):null,conversationId??null,status,notificationStatus,notificationStatus==='blocked'?'human_recipient_identity_pending':null,now,now);
  if(linked){const itemId='item-'+id;store.run('INSERT INTO work_items VALUES(?,?,?,?,?)',itemId,workspaceId,taskId,'{}',JSON.stringify({id:itemId,title:'Shared work item',currentAssignmentId:'assignment-'+id}));store.run('INSERT INTO work_item_task_links VALUES(?,?,?)',taskId,itemId,'assignment-'+id);}
 }
 const list=async(cookie=owner.cookie)=>{const response=await call('GET',base+'/work-items/pending-human',undefined,cookie);assert.equal(response.statusCode,200,response.body);return response.json().items;};
 return{app,store,channels,call,owner,member,outside,workspaceId,base,current,other,foreign,target,contact,map,canonical,rules,request,list};
}

test('selected B is named as pending, not unselected or A; the board is read-only and groups by stable identity',async t=>{
 const f=await fixture(t);f.contact('search-a','Confirmer A');f.contact('search-b','Confirmer B');f.map('search-a','callback-a');
 const selections=f.rules([{questionScope:'first',target:f.target('search-a')},{questionScope:'second',target:f.target('search-b')}]);
 f.request('a',f.canonical('search-a','callback-a'));f.request('b',undefined,{selection:selections[1]});f.request('direct-b',f.target('search-b'));f.request('reordered-b',Object.fromEntries(Object.entries(f.target('search-b')).reverse()));
 const before=f.store.all('SELECT * FROM human_requests ORDER BY request_id'),rulesBefore=f.store.one('SELECT * FROM employee_human_rules');
 let rows=await f.list(),a=rows.find(row=>row.requestId==='a'),b=rows.find(row=>row.requestId==='b');
 assert.equal(a.recipientLabel,'Confirmer A · 企业微信');assert.equal(b.recipientLabel,'Confirmer B · 待验证');assert.equal(b.notificationStatus,'blocked');assert.equal(b.canOpenConversation,false);assert.equal('conversationId'in b,false);
 assert.notEqual(a.recipientKey,b.recipientKey);assert.equal(b.recipientKey,rows.find(row=>row.requestId==='direct-b').recipientKey);assert.equal(b.recipientKey,rows.find(row=>row.requestId==='reordered-b').recipientKey);
 assert.deepEqual(f.store.all('SELECT * FROM human_requests ORDER BY request_id'),before);assert.deepEqual(f.store.one('SELECT * FROM employee_human_rules'),rulesBefore);
 f.map('search-b','callback-b');f.store.run("UPDATE human_requests SET target_json=?,notification_status='queued',notification_error=NULL WHERE request_id='b'",JSON.stringify(f.canonical('search-b','callback-b')));
 rows=await f.list();assert.equal(rows.find(row=>row.requestId==='b').recipientKey,b.recipientKey);assert.equal(rows.find(row=>row.requestId==='b').recipientLabel,'Confirmer B · 企业微信');
});

test('canonical callback resolves through both directions of the current mapping, never by callback/name coincidence',async t=>{
 const f=await fixture(t);f.contact('search-a','Correct searched person');f.contact('callback-a','Wrong callback collision');f.contact('same-name','Correct searched person');f.map('search-a','callback-a');
 f.request('mapped',f.canonical('search-a','callback-a'));f.request('legacy',f.canonical('search-a','callback-a',false));f.request('homonym',f.target('same-name'));f.request('unmapped',f.canonical('none','same-name',false));
 let rows=await f.list();assert.equal(rows.find(row=>row.requestId==='mapped').recipientLabel,'Correct searched person · 企业微信');assert.equal(rows.find(row=>row.requestId==='legacy').recipientKey,rows.find(row=>row.requestId==='mapped').recipientKey);assert.notEqual(rows.find(row=>row.requestId==='homonym').recipientKey,rows.find(row=>row.requestId==='mapped').recipientKey);assert.equal(rows.find(row=>row.requestId==='unmapped').recipientLabel,'same-name · 企业微信');assert.ok(!JSON.stringify(rows).includes('Wrong callback collision'));
 f.map('other-search','callback-a');rows=await f.list();assert.equal(rows.find(row=>row.requestId==='mapped').recipientLabel,'callback-a · 企业微信');assert.equal(rows.find(row=>row.requestId==='legacy').recipientLabel,'callback-a · 企业微信');
});

test('directory names are fenced by workspace, employee, bot, source, credentials, tenant and namespace',async t=>{
 const f=await fixture(t);f.contact('search-b','Current secret name');f.contact('search-b','Other employee secret',f.other);f.contact('search-b','Other workspace secret',f.foreign);
 const changes=[{connectionId:f.other.id,appId:f.other.appId,tenantId:f.other.eventTenantId,sourceId:f.other.sourceId},{connectionId:f.foreign.id,appId:f.foreign.appId,tenantId:f.foreign.eventTenantId,sourceId:f.foreign.sourceId},{appId:'another-bot'},{tenantId:'another-tenant'},{sourceId:'old-source'},{authRevision:0},{identityNamespace:'open_id'}];
 changes.forEach((change,index)=>f.request('wrong-'+index,{...f.target(),...change}));
 const rows=await f.list();assert.equal(rows.length,changes.length);for(const row of rows)assert.equal(row.recipientLabel,'search-b · 待验证');assert.ok(!JSON.stringify(rows).includes('secret'));
});

test('changed or disabled connections and stale, missing or ambiguous mappings cannot reveal a canonical name',async t=>{
 const f=await fixture(t);f.contact('search-b','Current secret name');f.map('search-b','callback-b');f.request('canonical',f.canonical('search-b','callback-b'));
 const original=f.channels.repository.byId(f.current.id),changes=[{sourceId:'changed-source'},{authRevision:2},{wecomContactIdentityRevision:0},{wecomContactMappings:[]},{enabled:false,status:'disabled'},{status:'pending_verification'},{identity:{...original.identity,tenantIdNamespace:'corp_id'}},{wecomContactMappings:[...original.wecomContactMappings,{userId:'search-b',callbackUserId:'other-callback'}]}];
 for(const change of changes){const previous=f.channels.repository.byId(f.current.id);assert.equal(f.channels.repository.save({...original,...change},previous),true);assert.equal((await f.list())[0].recipientLabel,'callback-b · 企业微信');}
});

test('a saved choice survives cache age but missing or foreign-scope cache falls back to ID, not a guessed person',async t=>{
 const f=await fixture(t);f.contact('search-b','Known B');f.request('b',f.target());f.store.run('UPDATE wecom_bot_contacts SET found_at=0');assert.equal((await f.list())[0].recipientLabel,'Known B · 待验证');
 f.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=?',f.current.id);f.contact('search-b','Foreign cache',f.other);f.store.run('INSERT INTO wecom_bot_contacts VALUES(?,?,?,?,?,?,?)',f.current.id,'old-source',0,'search-b','Stale name','[]',Date.now());assert.equal((await f.list())[0].recipientLabel,'search-b · 待验证');
});

test('rule replacement or unmatched candidate reports configuration changed without substituting A',async t=>{
 const f=await fixture(t);f.contact('search-a','Confirmer A');f.contact('search-b','Confirmer B');const selected=f.rules([{questionScope:'first',target:f.target('search-a')},{questionScope:'second',target:f.target('search-b')}]);
 f.request('b',undefined,{selection:selected[1]});f.request('missing-candidate',undefined,{selection:{...selected[1],candidateId:'not-a-candidate'}});assert.equal((await f.list()).find(row=>row.requestId==='missing-candidate').recipientLabel,'确认人配置已变更');
 f.rules([{questionScope:'second',target:f.target('search-a')}]);let rows=await f.list();assert.ok(rows.every(row=>row.recipientLabel==='确认人配置已变更'));assert.ok(rows.every(row=>row.recipientKey!=='unassigned'));assert.ok(!JSON.stringify(rows).includes('Confirmer A'));
 f.request('unselected',undefined);rows=await f.list();assert.equal(rows.find(row=>row.requestId==='unselected').recipientLabel,'等待选择确认人');
});

test('name enrichment preserves manager, own-Web, shared-item and workspace read boundaries',async t=>{
 const f=await fixture(t);f.contact('search-b','Private B');const [selection]=f.rules([{questionScope:'second',target:f.target()}]);f.request('private-b',undefined,{selection});f.request('shared-b',f.target(),{linked:true});f.request('own-web',{kind:'web',userId:f.member.user.id},{conversationId:'own-conversation'});f.request('other-web',{kind:'web',userId:f.owner.user.id},{conversationId:'owner-conversation'});
 const ownerRows=await f.list(),memberRows=await f.list(f.member.cookie);assert.equal(ownerRows.length,4);assert.deepEqual(memberRows.map(row=>row.requestId).sort(),['own-web','shared-b']);assert.equal(memberRows.find(row=>row.requestId==='own-web').canOpenConversation,true);assert.equal(memberRows.find(row=>row.requestId==='own-web').conversationId,'own-conversation');const shared=memberRows.find(row=>row.requestId==='shared-b');assert.equal(shared.recipientLabel,'Private B · 待验证');assert.equal(shared.canOpenConversation,false);assert.equal(shared.canRetryNotification,false);assert.equal('conversationId'in shared,false);
 const denied=await f.call('GET',f.base+'/work-items/pending-human',undefined,f.outside.cookie);assert.equal(denied.statusCode,403);assert.ok(!denied.body.includes('Private B'));
 for(const row of ownerRows)for(const field of ['target','selection','sourceId','directoryUserId','callbackUserId','credential'])assert.equal(field in row,false);
});
