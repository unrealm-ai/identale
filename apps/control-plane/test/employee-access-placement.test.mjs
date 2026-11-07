import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../dist/server.js';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
const origin='http://127.0.0.1:5173';
// Real API, auth and SQLite. Synthetic persisted connections only; no vendor transport or mock.
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'identity-access-placement-')),databasePath=join(dir,'test.sqlite');
 const app=createServer({databasePath,origin});await app.ready();
 async function register(username){const r=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin},payload:{username,password:'synthetic-isolated-password'}});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:String(r.headers['set-cookie']).split(';')[0]};}
 const owner=await register('access-owner'),other=await register('other-access-owner');
 async function call(method,url,payload,cookie=owner.cookie){return app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});}
 const base=`/api/workspaces/${owner.workspace.id}`,entity=(await call('POST',base+'/entities',{name:'权限归位员工',ownWebUse:true})).json().entity,second=(await call('POST',base+'/entities',{name:'另一员工',ownWebUse:false})).json().entity,eb=base+'/entities/'+entity.id;
 const store=new Store(databasePath),repo=new EmployeeChannelRepository(store);
 function seed(provider,id,entityId=entity.id){const row={id:'connection-'+id,sourceId:'source-'+id,workspaceId:owner.workspace.id,entityId,provider,appId:'app-'+id,botId:'bot-'+id,eventTenantId:'tenant-'+id,identity:{appId:'app-'+id,tenantId:'tenant-'+id,tenantIdNamespace:'tenant_key'},revision:1,authRevision:1,stateVersion:0,status:'verified',enabled:true,identityEvidence:'provider_api',inboundVerified:false,directoryStatus:'available',context:{historyEnabled:false,meetingRefs:[]},credential:{ciphertext:'synthetic-unusable',nonce:'',tag:''},createdBy:owner.user.id,updatedBy:owner.user.id};assert.equal(repo.save(row,undefined),true);return row;}
 const a=seed('feishu','a'),b=seed('dingtalk','b'),foreign=seed('feishu','foreign',second.id);
 const rule=(c,id='person',kind='channel_user')=>({sourceId:c.sourceId,kind,subjectId:JSON.stringify([kind,kind==='department'?(c.provider==='feishu'?'open_department_id':'department_id'):(c.provider==='feishu'?'open_id':'user_id'),c.appId,id]),...(kind==='department'?{includeDescendants:false}:{}),conversationKinds:['private','group']});
 t.after(async()=>{store.close();await app.close();await rm(dir,{recursive:true,force:true});});
 return{app,owner,other,call,eb,a,b,foreign,rule,store,repo};
}
test('source PATCH changes only selected allow rules and preserves other source and all deny rules',async t=>{
 const f=await setup(t),a=f.rule(f.a),b=f.rule(f.b),deny=f.rule(f.a,'denied');const initial=await f.call('PUT',f.eb+'/directory-access',{allow:[a,b],deny:[deny],allowGroupMembers:true});assert.equal(initial.statusCode,200,initial.body);
 const replacement=f.rule(f.a,'department-a','department');const saved=await f.call('PATCH',f.eb+'/directory-access',{sourceId:f.a.sourceId,allow:[replacement],expectedRevision:initial.json().revision,allowGroupMembers:false});assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().allow,[b,replacement]);assert.deepEqual(saved.json().deny,[deny]);assert.equal(saved.json().allowGroupMembers,false);assert.equal(saved.json().revision,initial.json().revision+1);
});
test('source PATCH is not blocked by removed connection references and cannot transfer them to a replacement',async t=>{
 const f=await setup(t),a=f.rule(f.a),b=f.rule(f.b),deny=f.rule(f.b,'old-deny');const initial=(await f.call('PUT',f.eb+'/directory-access',{allow:[a,b],deny:[deny]})).json();assert.equal(f.repo.remove(f.b),true);
 const saved=await f.call('PATCH',f.eb+'/directory-access',{sourceId:f.a.sourceId,allow:[],expectedRevision:initial.revision});assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().allow,[b]);assert.deepEqual(saved.json().deny,[deny]);
 const missing=await f.call('PATCH',f.eb+'/directory-access',{sourceId:f.b.sourceId,allow:[],expectedRevision:saved.json().revision});assert.equal(missing.statusCode,400);assert.equal(missing.json().error,'directory_source_not_found');
});
test('source PATCH rejects a concurrent revision and leaves the winning policy intact',async t=>{
 const f=await setup(t);const body={sourceId:f.a.sourceId,allow:[f.rule(f.a)],expectedRevision:0};const results=await Promise.all([f.call('PATCH',f.eb+'/directory-access',body),f.call('PATCH',f.eb+'/directory-access',{...body,allow:[]})]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);const winner=results.find(r=>r.statusCode===200).json();assert.deepEqual((await f.call('GET',f.eb+'/directory-access')).json(),winner);
});
test('source PATCH rejects cross-employee sources, mixed rules, malformed subjects and malformed group switches',async t=>{
 const f=await setup(t);for(const body of [
 {sourceId:f.foreign.sourceId,allow:[],expectedRevision:0},
 {sourceId:f.a.sourceId,allow:[f.rule(f.b)],expectedRevision:0},
 {sourceId:f.a.sourceId,allow:[{...f.rule(f.a),subjectId:'forged'}],expectedRevision:0},
 {sourceId:f.b.sourceId,allow:[],expectedRevision:0,allowGroupMembers:'true'},
 {sourceId:f.a.sourceId,allow:[]},
 {sourceId:f.a.sourceId,allow:[],expectedRevision:0,deny:[]},
 ]){const result=await f.call('PATCH',f.eb+'/directory-access',body);assert.equal(result.statusCode,400,result.body);}assert.equal((await f.call('GET',f.eb+'/directory-access')).json().revision,0);
});
test('source PATCH requires current workspace management access and authentication',async t=>{
 const f=await setup(t),body={sourceId:f.a.sourceId,allow:[],expectedRevision:0};const outsider=await f.call('PATCH',f.eb+'/directory-access',body,f.other.cookie);assert.ok([403,404].includes(outsider.statusCode),outsider.body);assert.equal((await f.call('PATCH',f.eb+'/directory-access',body,'')).statusCode,401);assert.equal((await f.call('GET',f.eb+'/directory-access')).json().revision,0);
});
test('source PATCH preserves global group switch on non-Feishu writes and legacy PUT remains compatible',async t=>{
 const f=await setup(t);const initial=(await f.call('PUT',f.eb+'/directory-access',{allow:[f.rule(f.a)],deny:[],allowGroupMembers:true})).json();const result=await f.call('PATCH',f.eb+'/directory-access',{sourceId:f.b.sourceId,allow:[f.rule(f.b)],expectedRevision:initial.revision});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().allowGroupMembers,true);const legacy=await f.call('PUT',f.eb+'/directory-access',{allow:[],deny:[],allowGroupMembers:false,expectedRevision:result.json().revision});assert.equal(legacy.statusCode,200,legacy.body);
});
test('source PATCH keeps the existing overall rule limit even when untouched sources fill it',async t=>{
 const f=await setup(t),existing=Array.from({length:100},(_,i)=>f.rule(f.b,'person-'+i));f.store.run('INSERT INTO entity_directory_policies(entity_id,workspace_id,revision,allow_json,deny_json,allow_group_members) VALUES(?,?,?,?,?,?)',f.a.entityId,f.owner.workspace.id,1,JSON.stringify(existing),'[]',0);
 const result=await f.call('PATCH',f.eb+'/directory-access',{sourceId:f.a.sourceId,allow:[f.rule(f.a)],expectedRevision:1});assert.equal(result.statusCode,400,result.body);const current=(await f.call('GET',f.eb+'/directory-access')).json();assert.equal(current.revision,1);assert.deepEqual(current.allow,existing);
});
