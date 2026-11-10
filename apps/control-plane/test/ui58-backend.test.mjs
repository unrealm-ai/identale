import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import Fastify from 'fastify';
import {createServer} from '../dist/server.js';
import {createPlatformServer,createRuntimeServer} from '../dist/split/server.js';
import {Store} from '../dist/store.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {SqliteWorkbenchRead} from '../dist/adapters/sqlite/workbench-read.js';
import {ModelProfileService} from '../dist/model-profiles.js';
import {SkillResources} from '../dist/skill-resources.js';
import {McpResources} from '../dist/mcp-resources.js';
import {ConfigurationPoller,registerConfigurationApi} from '../dist/split/config-sync.js';
const origin='http://127.0.0.1:15173';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'identale-ui58-')),path=join(dir,'test.sqlite');
 const app=createServer({databasePath:path,origin,pollIntervalMs:0});await app.ready();const db=new DatabaseSync(path);
 t.after(async()=>{db.close();await app.close();rmSync(dir,{recursive:true,force:true});});
 const call=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
 async function register(username){const r=await call('POST','/api/auth/register',{username,password:'Synthetic UI58 test password!'});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:r.headers['set-cookie'].split(';')[0]};}
 const owner=await register('ui58-owner'),base='/api/workspaces/'+owner.workspace.id;
 async function joinUser(username,role='member'){const user=await register(username),invite=await call('POST',base+'/invitations',{role},owner.cookie);assert.equal(invite.statusCode,200,invite.body);const accepted=await call('POST','/api/invitations/accept',{token:invite.json().token},user.cookie);assert.equal(accepted.statusCode,200,accepted.body);return{...user,joined:accepted.json().workspace};}
 async function create(name,webAccess){const r=await call('POST',base+'/employee-creations',{operationId:'create-'+name,name,description:'Synthetic fixture',ownWebUse:true,...(webAccess?{webAccess}:{})},owner.cookie);assert.equal(r.statusCode,200,r.body);return r.json().entity;}
 return{dir,path,app,db,call,register,owner,base,joinUser,create};
}

test('workspace rename is owner/admin only, preserves identity and rejects stale or invalid names',async t=>{
 const f=await fixture(t),member=await f.joinUser('ui58-member'),admin=await f.joinUser('ui58-admin','admin'),outsider=await f.register('ui58-outsider');
 const original=f.owner.workspace.name;
 assert.equal((await f.call('PATCH',f.base,{name:'Forbidden',expectedName:original},member.cookie)).statusCode,403);
 assert.equal((await f.call('PATCH',f.base,{name:'Forbidden',expectedName:original},outsider.cookie)).statusCode,403);
 const r=await f.call('PATCH',f.base,{name:'  新工作区  ',expectedName:original},f.owner.cookie);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().workspace.id,f.owner.workspace.id);assert.equal(r.json().workspace.name,'新工作区');
 assert.equal((await f.call('PATCH',f.base,{name:'旧修改',expectedName:original},admin.cookie)).statusCode,409);
 assert.equal((await f.call('PATCH',f.base,{name:'管理员改名',expectedName:'新工作区'},admin.cookie)).statusCode,200);
 for(const body of [{name:' ',expectedName:'管理员改名'},{name:'x'.repeat(121),expectedName:'管理员改名'},{name:'Missing CAS'},{name:'Extra',expectedName:'管理员改名',timezone:'UTC'}])assert.equal((await f.call('PATCH',f.base,body,f.owner.cookie)).statusCode,400);
 assert.equal(f.db.prepare('SELECT name FROM workspaces WHERE id=?').get(f.owner.workspace.id).name,'管理员改名');
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='workspace.renamed' AND workspace_id=?").get(f.owner.workspace.id).n,2);
 const names=(await f.call('GET','/api/workspaces',undefined,member.cookie)).json().workspaces;assert.equal(names.find(w=>w.id===f.owner.workspace.id).name,'管理员改名');
});

test('concurrent workspace renames have one winner without silently overwriting a newer name',async t=>{
 const f=await fixture(t),initial=f.owner.workspace.name;
 const rs=await Promise.all(['First','Second'].map(name=>f.call('PATCH',f.base,{name,expectedName:initial},f.owner.cookie)));
 assert.deepEqual(rs.map(r=>r.statusCode).sort(),[200,409]);const winner=rs.find(r=>r.statusCode===200).json().workspace;
 assert.equal(f.db.prepare('SELECT name FROM workspaces WHERE id=?').get(winner.id).name,winner.name);
});

test('workspace Web grant includes future active members and remains separate from individual and channel grants',async t=>{
 const f=await fixture(t),all=await f.create('all-members',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:true}),self=await f.create('self-only',{allowMemberIds:[f.owner.workspace.memberId],denyMemberIds:[]});
 const member=await f.joinUser('ui58-future'),other=await f.register('ui58-other');
 const allBase=f.base+'/entities/'+all.id,selfBase=f.base+'/entities/'+self.id;
 assert.equal((await f.call('GET',allBase+'/usable-capabilities',undefined,member.cookie)).statusCode,200);
 assert.equal((await f.call('GET',selfBase+'/usable-capabilities',undefined,member.cookie)).statusCode,403);
 assert.equal((await f.call('GET',allBase+'/usable-capabilities',undefined,other.cookie)).statusCode,403);
 const summaries=(await f.call('GET',f.base+'/employee-summaries',undefined,member.cookie)).json().records;
 assert.equal(summaries.find(e=>e.id===all.id).webAllowed,true);assert.equal(summaries.find(e=>e.id===self.id).webAllowed,false);
 const state=(await f.call('GET',allBase+'/web-access',undefined,f.owner.cookie)).json();assert.equal(state.allowWorkspaceMembers,true);assert.deepEqual(state.allowMemberIds,[],'future membership is not serialized to a member snapshot');
 assert.deepEqual((await f.call('GET',allBase+'/directory-access',undefined,f.owner.cookie)).json().allow,[],'Web grant creates no external identity grant');
 f.db.prepare("UPDATE members SET status='disabled' WHERE id=?").run(member.joined.memberId);
 assert.equal((await f.call('GET',allBase+'/usable-capabilities',undefined,member.cookie)).statusCode,403);
 assert.equal((await f.call('GET',f.base+'/employee-summaries',undefined,member.cookie)).statusCode,403);
 f.db.prepare('DELETE FROM members WHERE id=?').run(member.joined.memberId);assert.equal((await f.call('GET',allBase+'/usable-capabilities',undefined,member.cookie)).statusCode,403,'removed membership does not retain workspace use');
});

test('workspace grant preserves explicit deny and independent capability restrictions; legacy writers do not erase the flag',async t=>{
 const f=await fixture(t),member=await f.joinUser('ui58-package-member'),e=await f.create('packages',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:true}),base=f.base+'/entities/'+e.id;
 const pkg=async value=>{const r=await f.call('POST',base+'/capability-packages',{name:value.name,enabled:true,mode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[],...value},f.owner.cookie);assert.equal(r.statusCode,200,r.body);return r.json();};
 const inherited=await pkg({name:'Inherited'}),restricted=await pkg({name:'Independent',mode:'restrict',allowMemberIds:[f.owner.workspace.memberId]}),denied=await pkg({name:'Denied package',denyMemberIds:[member.joined.memberId]});
 let r=await f.call('GET',base+'/usable-capabilities',undefined,member.cookie);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().packages.map(p=>p.id),[inherited.id]);
 assert.ok(!r.json().packages.some(p=>[restricted.id,denied.id].includes(p.id)));
 r=await f.call('PUT',base+'/web-access',{allowMemberIds:[],denyMemberIds:[member.joined.memberId]},f.owner.cookie);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().allowWorkspaceMembers,true);
 assert.equal((await f.call('GET',base+'/usable-capabilities',undefined,member.cookie)).statusCode,403);
 const summary=(await f.call('GET',f.base+'/employee-summaries',undefined,member.cookie)).json().records.find(r=>r.id===e.id);assert.equal(summary.webAllowed,false);
 r=await f.call('PUT',base+'/web-access',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:false},f.owner.cookie);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().allowWorkspaceMembers,undefined);assert.equal((await f.call('GET',base+'/usable-capabilities',undefined,member.cookie)).statusCode,403);
 assert.equal((await f.call('PUT',base+'/web-access',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:'yes'},f.owner.cookie)).statusCode,400);
});

test('workspace flag migration is repeatable and enabled/disabled state still guards normal chat admission',async t=>{
 const f=await fixture(t),e=await f.create('lifecycle',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:true}),member=await f.joinUser('ui58-lifecycle-member');
 f.db.prepare('UPDATE entities SET lifecycle_enabled=0 WHERE id=?').run(e.id);
 const summary=(await f.call('GET',f.base+'/employee-summaries',undefined,member.cookie)).json().records.find(r=>r.id===e.id);assert.equal(summary.webAllowed,true);assert.equal(summary.canChat,false);assert.equal(summary.reason,'员工已停用');
 const db=new Store(f.path);t.after(()=>db.close());new CapabilityConfigService(db);new CapabilityConfigService(db);
 assert.equal(db.one('SELECT allow_workspace_members n FROM entity_web_policies WHERE entity_id=?',e.id).n,1);
 assert.equal(db.all('PRAGMA table_info(entity_web_policies)').filter(c=>c.name==='allow_workspace_members').length,1);
});

test('employee summaries batch only current page providers with an indexed local read and no credential parsing',async t=>{
 const f=await fixture(t);const employees=[];for(let i=0;i<8;i++)employees.push(await f.create('provider-'+i));
 for(let i=0;i<employees.length;i++)for(const provider of ['feishu','dingtalk','wecom'])f.db.prepare('INSERT INTO employee_channel_connections(id,workspace_id,entity_id,provider,app_id,revision,state_version,record_json) VALUES(?,?,?,?,?,1,1,?)').run('provider-'+i+'-'+provider,f.owner.workspace.id,employees[i].id,provider,'synthetic-'+i+'-'+provider,JSON.stringify({sentinel:'NOT_PARSED_OR_EXPOSED'}));
 const db=new Store(f.path);t.after(()=>db.close());const reads=[];const all=db.all.bind(db);db.all=(sql,...args)=>{reads.push({sql,args});return all(sql,...args);};const port=new SqliteWorkbenchRead(db);
 const page=port.employees(f.owner.workspace.id,'',{ceiling:port.ceiling(f.owner.workspace.id,'employees'),id:''},3);assert.equal(page.length,3);
 assert.deepEqual(page.map(e=>e.channelProviders),Array.from({length:3},()=>['dingtalk','feishu','wecom']));assert.ok(page.every(e=>e.channels===3&&e.packages===0));
 const providerReads=reads.filter(r=>r.sql.startsWith('SELECT entity_id AS entityId,provider'));assert.equal(providerReads.length,1);assert.equal(providerReads[0].args.length,4,'one workspace plus this page employee IDs');
 const plan=db.all('EXPLAIN QUERY PLAN '+providerReads[0].sql,...providerReads[0].args);assert.match(JSON.stringify(plan),/workbench_connection_employee_provider/);assert.doesNotMatch(JSON.stringify(plan),/SCAN employee_channel_connections/);
 const response=await f.call('GET',f.base+'/employee-summaries?limit=3',undefined,f.owner.cookie);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().records.map(r=>r.channelProviders),page.map(r=>r.channelProviders));assert.doesNotMatch(response.body,/NOT_PARSED_OR_EXPOSED/);
});

test('configuration polling carries dynamic workspace policy and later membership to runtime without cross-database reads',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'identale-ui58-sync-')),platform=new Store(join(dir,'platform.sqlite'),{role:'platform'}),runtime=new Store(join(dir,'runtime.sqlite'),{role:'runtime'});
 t.after(()=>{runtime.close();platform.close();rmSync(dir,{recursive:true,force:true});});
 platform.run("INSERT INTO users(id,username,display_name) VALUES('owner','owner','Owner'),('later','later','Later')");platform.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','owner')");platform.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('owner-m','w','owner','owner')");platform.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','owner-m','owner-m',1,'owner','builtin-interaction')");
 const capabilities=new CapabilityConfigService(platform),runtimeCapabilities=new CapabilityConfigService(runtime);capabilities.saveWebAccess('w','e',{allowMemberIds:[],denyMemberIds:[],allowWorkspaceMembers:true});
 const key=Buffer.alloc(32,9),profiles=new ModelProfileService(platform,{masterKey:key}),skills=new SkillResources(platform,join(dir,'skills')),mcp=new McpResources(platform,{masterKey:key,allowedOrigins:[]});
 const app=Fastify();t.after(()=>app.close());const token='synthetic-ui58-config-token';registerConfigurationApi(app,{store:platform,profiles,skills,mcp,token});
 const fetch=async(input,init={})=>{const r=await app.inject({url:new URL(input).pathname,headers:Object.fromEntries(new Headers(init.headers))});return new Response(r.statusCode===304?null:r.body,{status:r.statusCode,headers:r.headers});};
 const poller=new ConfigurationPoller({store:runtime,baseUrl:'http://127.0.0.1:9999',token,fetch});t.after(()=>poller.stop());
 assert.equal(await poller.poll(),true);assert.equal(runtimeCapabilities.getWebAccess('w','e').allowWorkspaceMembers,true);
 assert.throws(()=>runtimeCapabilities.authorizeEntity({workspaceId:'w',entityId:'e',userId:'later'}),e=>e.code==='entity_use_forbidden');
 platform.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('later-m','w','later','member')");assert.equal(await poller.poll(),true);runtimeCapabilities.authorizeEntity({workspaceId:'w',entityId:'e',userId:'later'});
 platform.run("UPDATE members SET status='disabled' WHERE id='later-m'");assert.equal(await poller.poll(),true);assert.throws(()=>runtimeCapabilities.authorizeEntity({workspaceId:'w',entityId:'e',userId:'later'}),e=>e.code==='entity_use_forbidden');
 assert.equal(runtime.one("SELECT name FROM main.sqlite_master WHERE name='entity_web_policies'"),undefined,'runtime policy is a temporary projection, not a second platform database');
});

test('legacy explicit-member policies migrate with the workspace switch off and retain their original grant',t=>{
 const dir=mkdtempSync(join(tmpdir(),'identale-ui58-legacy-'));let store=new Store(join(dir,'legacy.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.run("INSERT INTO users(id,username,display_name) VALUES('u','user','Owner'),('v','visitor','Visitor')");store.run("INSERT INTO workspaces(id,name,created_by) VALUES('w','Workspace','u')");store.run("INSERT INTO members(id,workspace_id,user_id,role) VALUES('m','w','u','owner'),('v-m','w','v','member')");store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Legacy','m','m',1,'u','builtin-interaction')");
 store.db.exec('DROP TABLE combined_schema_migrations; ALTER TABLE entity_web_policies DROP COLUMN allow_workspace_members');store.run('INSERT INTO entity_web_policies(entity_id,workspace_id,revision,allow_json,deny_json) VALUES(?,?,?,?,?)','e','w',7,'["m"]','[]');store.close();store=new Store(join(dir,'legacy.sqlite'));
 const service=new CapabilityConfigService(store);assert.deepEqual(service.getWebAccess('w','e'),{revision:7,allowMemberIds:['m'],denyMemberIds:[]});service.authorizeEntity({workspaceId:'w',entityId:'e',userId:'u'});assert.throws(()=>service.authorizeEntity({workspaceId:'w',entityId:'e',userId:'v'}),e=>e.code==='entity_use_forbidden');
 assert.equal(store.one('SELECT allow_workspace_members n FROM entity_web_policies').n,0);service.saveWebAccess('w','e',{allowMemberIds:['m'],denyMemberIds:[]});assert.equal(service.getWebAccess('w','e').allowWorkspaceMembers,undefined);assert.throws(()=>service.authorizeEntity({workspaceId:'w',entityId:'e',userId:'v'}),e=>e.code==='entity_use_forbidden');new CapabilityConfigService(store);assert.equal(store.one('SELECT revision n FROM entity_web_policies').n,8);
});

test('service monitoring permits only workspace owner/admin and does not trust a browser actor header',async t=>{
 const root=mkdtempSync(join(tmpdir(),'identale-ui58-monitor-')),configurationToken='synthetic-monitor-configuration-token'.repeat(2),serviceToken='synthetic-monitor-runtime-token'.repeat(2);let platform,runtime;
 t.after(async()=>{await runtime?.close();await platform?.close();rmSync(root,{recursive:true,force:true});});
 const transport=async(raw,init={})=>{const u=new URL(String(raw)),target=u.port==='20110'?platform:runtime;if(!target)throw Error('isolated service unavailable');const response=await target.inject({method:init.method??'GET',url:u.pathname+u.search,headers:Object.fromEntries(new Headers(init.headers)),...(init.body===undefined?{}:{payload:init.body})});return new Response([204,304].includes(response.statusCode)?null:response.rawPayload,{status:response.statusCode,headers:response.headers});};
 platform=createPlatformServer({databasePath:join(root,'platform','test.sqlite'),origin,configurationToken,runtimeService:{url:'http://127.0.0.1:20111',token:serviceToken},transport,directorySync:{automatic:false}});await platform.ready();
 runtime=createRuntimeServer({databasePath:join(root,'runtime','test.sqlite'),origin,platformConfig:{url:'http://127.0.0.1:20110',token:configurationToken,pollMs:3600000},serviceToken,transport,directorySync:{automatic:false},triggers:{automatic:false},maintenance:{enabled:false},pollIntervalMs:0});await runtime.ready();
 const call=(method,url,payload,cookie,extra={})=>platform.inject({method,url,headers:{origin,...(cookie?{cookie}:{}),...extra},...(payload===undefined?{}:{payload})});
 async function register(username){const r=await call('POST','/api/auth/register',{username,password:'Synthetic monitor test password!'});assert.equal(r.statusCode,201,r.body);return{...r.json(),cookie:r.headers['set-cookie'].split(';')[0]};}
 const owner=await register('monitor-owner'),member=await register('monitor-member'),admin=await register('monitor-admin'),outsider=await register('monitor-outsider'),base='/api/workspaces/'+owner.workspace.id;
 for(const [user,role]of[[member,'member'],[admin,'admin']]){const invite=await call('POST',base+'/invitations',{role},owner.cookie);assert.equal(invite.statusCode,200,invite.body);const accepted=await call('POST','/api/invitations/accept',{token:invite.json().token},user.cookie);assert.equal(accepted.statusCode,200,accepted.body);}
 await runtime.getDecorator('configurationPoller').poll();
 for(const user of[owner,admin]){const response=await call('GET',base+'/runtime-monitor',undefined,user.cookie);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().runtime.configuration.state,'ready');assert.equal(Object.keys(response.json().runtime.configuration.moduleRevisions).length,7);assert.equal(response.json().execution,null);}
 for(const user of[member,outsider])assert.equal((await call('GET',base+'/runtime-monitor',undefined,user.cookie,{'x-dentity-actor':owner.user.id})).statusCode,403);
 assert.equal((await call('GET',base+'/runtime-monitor')).statusCode,401);
 assert.equal((await runtime.inject({url:'/internal/monitor/workspaces/'+owner.workspace.id,headers:{'x-dentity-actor':owner.user.id}})).statusCode,401);
});
