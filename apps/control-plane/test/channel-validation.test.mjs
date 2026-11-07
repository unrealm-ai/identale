import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../dist/server.js';
import { EmployeeApplicationTransport } from '../dist/employee-channels/provider.js';
import { FeishuDirectoryAdapter, DingTalkDirectoryAdapter, WeComDirectoryAdapter } from '../dist/adapters/directory/index.js';
import { validateDirectory, ChannelValidationError } from '../dist/employee-channels/validation.js';

const appId='synthetic-app',appSecret='synthetic-private-secret',token='synthetic-private-token',personName='Synthetic private person';
const fsData=data=>({code:0,data});
const check=(report,id)=>report.checks.find(value=>value.id===id);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function vendor(overrides={}){
  const state={calls:[],mode:'ok',scopes:[{scope_name:'im:message.group_msg',grant_status:2,scope_type:'tenant'},{scope_name:'minutes:minutes.transcript:export',grant_status:1,scope_type:'tenant'}],...overrides};
  state.fetch=async(url,init={})=>{
    const target=new URL(url),path=target.pathname;
    assert.ok(['https://open.feishu.cn','https://api.dingtalk.com','https://oapi.dingtalk.com','https://qyapi.weixin.qq.com'].includes(target.origin));
    assert.equal(init.redirect,'error');state.calls.push({path,method:init.method});
    assert.ok(!path.includes('/messages')&&!path.includes('/scopes/apply'),'No message or permission mutation probe');
    if(path==='/open-apis/auth/v3/tenant_access_token/internal')return json({code:0,tenant_access_token:token,expire:7200});
    if(path==='/open-apis/application/v6/scopes'){
      if(state.mode==='inventory-denied')return json({code:99991672,msg:appSecret},400);
      if(state.mode==='inventory-json')return new Response('not json');
      return json(fsData({scopes:state.scopes}));
    }
    if(path==='/open-apis/bot/v3/info')return json({code:0,bot:{open_id:'synthetic-bot'}});
    if(path==='/open-apis/tenant/v2/tenant/query'){
      if(state.mode==='identity-denied')return json({code:99991672,msg:appSecret,error:{permission_violations:[{type:'action_privilege_required',subject:'tenant:tenant:readonly'}],log_id:'20261024ABCDEF0123456789ABCDEF0123'}},400);
      if(state.mode==='identity-timeout')return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error(token)),{once:true}));
      if(state.mode==='identity-json')return new Response('not json');
      return json(fsData({tenant:{tenant_key:'synthetic-tenant'}}));
    }
    if(path==='/open-apis/contact/v3/scopes'){
      if(state.mode==='scope-denied')return json({code:99991672,msg:`${appSecret} ${token} ${personName}`,error:{permission_violations:[{type:'action_privilege_required',subject:'contact:contact.base:readonly'},{type:'action_privilege_required',subject:'not a scope '+appSecret}],log_id:'20261024ABCDEF0123456789ABCDEF0123'}},400);
      return json(fsData(state.contactScope??{department_ids:state.mode==='empty'?[]:['od_a'],user_ids:state.mode==='empty'||state.mode==='no-sample'?[]:['ou_a'],has_more:false}));
    }
    if(path==='/open-apis/contact/v3/departments/od_a')return json(fsData({department:{open_department_id:'od_a',name:'Synthetic department',parent_department_id:'0'}}));
    if(path.endsWith('/children'))return json(fsData({items:[],has_more:false}));
    if(path==='/open-apis/contact/v3/users/find_by_department')return json(fsData({items:state.members??[],has_more:false}));
    if(path==='/open-apis/contact/v3/users/ou_a')return json(fsData({user:{open_id:'ou_a',department_ids:['od_a'],...(state.mode==='no-name'?{}:{name:personName})}}));
    if(path==='/v1.0/oauth2/accessToken')return json({accessToken:token,expireIn:7200});
    if(path==='/auth/scopes')return json({errcode:0,auth_org_scopes:{authed_dept:[1],authed_user:['user-a']}});
    if(path==='/topapi/v2/department/get')return json({errcode:0,result:{dept_id:1,name:'Synthetic department',parent_id:0}});
    if(path==='/topapi/v2/user/get')return json({errcode:0,result:{userid:'user-a',name:personName,dept_id_list:[1]}});
    if(path==='/cgi-bin/gettoken')return json({errcode:0,access_token:token,expires_in:7200});
    if(path==='/cgi-bin/agent/get')return json({errcode:0,agentid:7,close:0,allow_userinfos:{user:[{userid:'user-a'}]},allow_partys:{partyid:[1]},allow_tags:{tagid:[]}});
    if(path==='/cgi-bin/department/get')return json({errcode:0,department:{id:1,name:'Synthetic department',parentid:0}});
    if(path==='/cgi-bin/user/get')return json({errcode:0,userid:'user-a',department:[1],...(state.mode==='no-name'?{}:{name:personName})});
    assert.fail('Unexpected official fixture route '+path);
  };return state;
}
const feishu=state=>new EmployeeApplicationTransport('feishu',appId,{appSecret},{fetch:state.fetch}).verify(new FeishuDirectoryAdapter({appId,appSecret,fetch:state.fetch,timeoutMs:20}));
function safeReport(report){const text=JSON.stringify(report);for(const sensitive of [appSecret,token,personName])assert.ok(!text.includes(sensitive));}

test('Feishu scopes and actual directory/name reads are independent; optional denial warns and no message is sent',async()=>{
  const state=vendor(),result=await feishu(state);
  assert.equal(result.validation.canContinue,true);assert.equal(check(result.validation,'user_name').status,'pass');
  assert.equal(check(result.validation,'scope_inventory').status,'pass');
  assert.equal(check(result.validation,'group_history').status,'missing');
  assert.deepEqual(check(result.validation,'group_history').missingScopes,['im:message.group_msg']);
  assert.equal(check(result.validation,'meeting_materials').status,'unverified');
  assert.equal(state.calls.filter(c=>c.path==='/open-apis/contact/v3/scopes').length,1);
  assert.ok(state.calls.some(c=>c.path==='/open-apis/contact/v3/users/ou_a'));safeReport(result.validation);
});

test('tenant-only inventory never counts user grants, missing identity types or unknown grant enums as granted',async()=>{
  const state=vendor({scopes:[{scope_name:'im:message.group_msg',grant_status:1,scope_type:'user'},{scope_name:'minutes:minutes.transcript:export',grant_status:1},{scope_name:'minutes:minutes.artifacts:read',grant_status:99,scope_type:'tenant'}]});
  const result=await feishu(state);assert.equal(result.validation.canContinue,true);
  for(const id of ['group_history','meeting_materials']){const item=check(result.validation,id);assert.equal(item.status,'unverified');assert.ok(item.scopeEvidence.every(v=>v.status==='unverified'));assert.equal(item.missingScopes,undefined);}
});

test('granular and legacy scope names are not enforced as an AND prerequisite when actual reads succeed',async()=>{
  const state=vendor({scopes:[{scope_name:'contact:contact:access_as_app',grant_status:1,scope_type:'tenant'},{scope_name:'contact:user.base:readonly',grant_status:2,scope_type:'tenant'}]});
  const result=await feishu(state);assert.equal(result.validation.canContinue,true);assert.equal(check(result.validation,'user_name').status,'pass');
});

test('inventory unavailable or malformed does not block confirmed necessary directory reads or invent missing scopes',async()=>{
  for(const mode of ['inventory-denied','inventory-json']){const result=await feishu(vendor({mode}));assert.equal(result.validation.canContinue,true);assert.notEqual(check(result.validation,'scope_inventory').status,'pass');assert.equal(check(result.validation,'group_history').missingScopes,undefined);}
});

for(const [mode,id,reason] of [['identity-denied','directory_identity','denied'],['identity-timeout','directory_identity','timeout'],['identity-json','directory_identity','parse'],['scope-denied','directory_scope','denied'],['empty','directory_scope','empty_scope'],['no-name','user_name','parse'],['no-sample','user_name','no_sample']]){
  test(`required ${mode} blocks with its exact stage and never becomes a generic directory permission claim`,async()=>{
    const state=vendor({mode});
    await assert.rejects(feishu(state),error=>{
      assert.ok(error instanceof ChannelValidationError);const report=error.validation;assert.equal(report.canContinue,false);assert.equal(check(report,id).reason,reason);
      if(mode==='scope-denied'){assert.equal(check(report,id).httpStatus,400);assert.equal(check(report,id).providerCode,99991672);assert.deepEqual(check(report,id).missingScopes,['contact:contact.base:readonly']);}
      if(mode.startsWith('identity-'))assert.equal(check(report,'directory_scope').reason,'prerequisite');safeReport(report);return true;
    });
  });
}

test('DingTalk actual contact/name reads pass while full scope inventory and unsupported optional features stay honest',async()=>{
  const state=vendor();const result=await new EmployeeApplicationTransport('dingtalk',appId,{appSecret},{fetch:state.fetch}).verify(new DingTalkDirectoryAdapter({appId,appSecret,fetch:state.fetch}));
  assert.equal(result.validation.canContinue,true);assert.equal(result.identity.tenantIdNamespace,'app_id');assert.equal(check(result.validation,'scope_inventory').status,'unverified');assert.equal(check(result.validation,'group_history').status,'unsupported');safeReport(result.validation);
});

test('WeCom ID label fallback is not evidence of required real name access',async()=>{
  const state=vendor({mode:'no-name'}),directory=new WeComDirectoryAdapter({appId:'7',agentId:'7',corpId:'synthetic-corp',appSecret,fetch:state.fetch});
  await assert.rejects(validateDirectory(directory,'wecom'),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='required_field'&&!error.validation.canContinue);
});

async function serverFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'identity-channel-validation-')),state=vendor();let now=Date.now();
  const app=createServer({databasePath:join(dir,'test.sqlite'),origin:'http://127.0.0.1:5173',pollIntervalMs:0,now:()=>now,employeeChannels:{masterKey:Buffer.alloc(32,17),fetch:state.fetch,now:()=>now},channelIngressFactory:()=>({async start(){assert.fail('Validation must not start a connection');},async stop(){}})});
  await app.ready();const db=new DatabaseSync(join(dir,'test.sqlite'));
  t.after(async()=>{db.close();await app.close();await rm(dir,{recursive:true,force:true});});
  const call=(method,url,payload,cookie)=>app.inject({method,url,payload,headers:{origin:'http://127.0.0.1:5173',...(cookie?{cookie}:{})}});
  async function owner(username){const result=await call('POST','/api/auth/register',{username,password:'Synthetic verification password 2026!'});assert.equal(result.statusCode,201);return{...result.json(),cookie:result.headers['set-cookie'].split(';')[0]};}
  return{state,db,call,owner,advance:()=>{now+=11*60_000;}};
}

test('independent WeCom directory draft needs no bot, persists nothing and enforces workspace/actor/expiry',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-verification-owner'),other=await f.owner('channel-verification-other');
  const base=`/api/workspaces/${owner.workspace.id}/employee-channel-drafts`;
  const prepare=()=>f.call('POST',base,{provider:'wecom',operation:'directory',directory:{label:'Synthetic directory',corpId:'synthetic-corp',agentId:'7',appSecret}},owner.cookie);
  const response=await prepare();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().validation.canContinue,true);safeReport(response.json().validation);
  assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_connections').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_directory_credentials').get().n,0);
  const body={provider:'wecom',appId:'synthetic-bot',appSecret:'synthetic-bot-secret',directory:{draftId:response.json().draftId,confirmSameCorp:true}};
  const cross=await f.call('POST',`/api/workspaces/${other.workspace.id}/employee-channel-drafts`,body,other.cookie);assert.equal(cross.statusCode,409);assert.equal(cross.json().error,'channel_creation_draft_required');
  f.advance();const expired=await f.call('POST',base,body,owner.cookie);assert.equal(expired.statusCode,409);assert.equal(expired.json().error,'channel_creation_draft_required');
  assert.ok(!f.state.calls.some(c=>c.path.includes('bot/v3/info')));
});

test('wizard API exposes safe layered failure with no draft writes, and succeeds with optional warnings',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-layered-owner'),base=`/api/workspaces/${owner.workspace.id}/employee-channel-drafts`;
  f.state.mode='scope-denied';const failed=await f.call('POST',base,{provider:'feishu',appId,appSecret},owner.cookie);
  assert.equal(failed.statusCode,400);assert.equal(failed.json().error,'channel_validation_failed');assert.equal(failed.json().validation.canContinue,false);safeReport(failed.json().validation);assert.equal(failed.json().draftId,undefined);
  f.state.mode='ok';const success=await f.call('POST',base,{provider:'feishu',appId,appSecret},owner.cookie);
  assert.equal(success.statusCode,200,success.body);assert.equal(success.json().source.validation.canContinue,true);assert.equal(check(success.json().source.validation,'group_history').status,'missing');
  assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_connections').get().n,0);
});

test('editing independently revalidates a stored WeCom directory before any bot and rejects stale revisions',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-directory-editor'),base=`/api/workspaces/${owner.workspace.id}`;
  const entity=await f.call('POST',base+'/entities',{name:'Synthetic directory editor',ownWebUse:true},owner.cookie);assert.equal(entity.statusCode,200,entity.body);
  const path=base+`/entities/${entity.json().entity.id}/channels/wecom/directory-credentials`;
  const saved=await f.call('POST',path,{label:'Synthetic directory',corpId:'synthetic-corp',agentId:'7',appSecret},owner.cookie);assert.equal(saved.statusCode,200,saved.body);
  const current=saved.json();const verified=await f.call('POST',path+`/${current.id}/revalidate`,{expectedRevision:current.revision},owner.cookie);
  assert.equal(verified.statusCode,200,verified.body);assert.equal(verified.json().validation.canContinue,true);
  const stale=await f.call('POST',path+`/${current.id}/revalidate`,{expectedRevision:current.revision},owner.cookie);assert.equal(stale.statusCode,409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_connections').get().n,0);safeReport(verified.json().validation);
});

test('inventory response includes returned scopes with separate user/tenant identity without granting user privileges to the bot',async()=>{
  const state=vendor({scopes:[{scope_name:'im:message.group_msg',grant_status:1,scope_type:'user'},{scope_name:'im:message:send_as_bot',grant_status:1,scope_type:'tenant'}]});
  const result=await feishu(state),inventory=check(result.validation,'scope_inventory').scopeInventory;
  assert.deepEqual(inventory,[{scope:'im:message.group_msg',identity:'user',status:'granted'},{scope:'im:message:send_as_bot',identity:'tenant',status:'granted'}]);
  assert.equal(check(result.validation,'group_history').status,'unverified');safeReport(result.validation);
});

test('wizard preserves undisclosed user counts while probing only its explicitly granted department',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-scope-disclosure'),base=`/api/workspaces/${owner.workspace.id}/employee-channel-drafts`;
  f.state.contactScope={department_ids:['od_a'],has_more:false};f.state.members=[{open_id:'ou_a',name:personName,department_ids:['od_a']}];
  const result=await f.call('POST',base,{provider:'feishu',appId,appSecret},owner.cookie);assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json().scope,{entireOrganization:false,departmentCount:1,userCount:null,disclosed:{departments:true,users:false}});
  assert.equal(result.json().source.validation.canContinue,true);assert.equal(f.state.calls.filter(c=>c.path.endsWith('/find_by_department')).length,1);
  assert.ok(!f.state.calls.some(c=>c.path.includes('/departments/0')));safeReport(result.json().source.validation);assert.ok(!result.body.includes(personName));
});
