import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../dist/server.js';
import { EmployeeApplicationTransport } from '../dist/employee-channels/provider.js';
import { FeishuDirectoryAdapter, DingTalkDirectoryAdapter } from '../dist/adapters/directory/index.js';
import { wecomBotValidation, validateDirectory, ChannelValidationError } from '../dist/employee-channels/validation.js';

const appId='synthetic-app',appSecret='synthetic-private-secret',token='synthetic-private-token',personName='Synthetic private person';
const fsData=data=>({code:0,data});
const check=(report,id)=>report.checks.find(value=>value.id===id);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function vendor(overrides={}){
  const state={calls:[],mode:'ok',scopes:[{scope_name:'im:message.group_msg',grant_status:2,scope_type:'tenant'},{scope_name:'minutes:minutes.transcript:export',grant_status:1,scope_type:'tenant'}],...overrides};
  state.fetch=async(url,init={})=>{
    const target=new URL(url),path=target.pathname;
    assert.ok(['https://open.feishu.cn','https://api.dingtalk.com','https://oapi.dingtalk.com','https://qyapi.weixin.qq.com'].includes(target.origin));
    assert.equal(init.redirect,'error');state.calls.push({path,method:init.method,query:Object.fromEntries(target.searchParams)});
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
    if(path.endsWith('/children')){
      const id=path.split('/').at(-2),cursor=target.searchParams.get('page_token')??'';
      return json(fsData(state.childPages?.[id]?.[cursor]??{items:[],has_more:false}));
    }
    if(path==='/open-apis/contact/v3/users/find_by_department'){
      const id=target.searchParams.get('department_id'),cursor=target.searchParams.get('page_token')??'';
      if(state.deniedDepartment===id)return json({code:99991672},400);
      return json(fsData(state.memberPages?.[id]?.[cursor]??{items:state.members??[],has_more:false}));
    }
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

const samplePage=id=>({items:[{open_id:'ou_sample',name:personName,department_ids:[id]}],has_more:false});
const childPage=(id,parent)=>({open_department_id:id,name:'Synthetic department',parent_department_id:parent});
const sampleVendor=overrides=>vendor({contactScope:{department_ids:['od_a'],user_ids:[],has_more:false},...overrides});

test('directory validation finds a sample in the fourth authorized department without guessing other roots',async()=>{
  const state=sampleVendor({contactScope:{department_ids:['od_a','od_b','od_c','od_d'],user_ids:[],has_more:false},memberPages:{od_d:{'':samplePage('od_d')}}});
  assert.equal((await feishu(state)).validation.canContinue,true);
  assert.deepEqual(state.calls.filter(c=>c.path.endsWith('/find_by_department')).map(c=>c.query.department_id),['od_a','od_b','od_c','od_d']);
});

test('directory validation follows deep authorized descendants and both child and member pagination',async()=>{
  const state=sampleVendor({childPages:{
    od_a:{'':{items:[],has_more:true,page_token:'children-2'},'children-2':{items:[childPage('od_b','od_a')],has_more:false}},
    od_b:{'':{items:[childPage('od_c','od_b')],has_more:false}},
    od_c:{'':{items:[childPage('od_d','od_c')],has_more:false}}
  },memberPages:{od_d:{'':{items:[],has_more:true,page_token:'members-2'},'members-2':samplePage('od_d')}}});
  assert.equal((await feishu(state)).validation.canContinue,true);
  assert.ok(state.calls.some(c=>c.query.page_token==='children-2'));
  assert.ok(state.calls.some(c=>c.query.page_token==='members-2'));
});

test('directory validation reports limit rather than no_sample with authorized work remaining',async()=>{
  const roots=['od_a',...Array.from({length:20},(_,i)=>'od_b'+i)];
  const state=sampleVendor({contactScope:{department_ids:roots,user_ids:[],has_more:false}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='limit'&&check(error.validation,'user_name').status==='unverified');
  assert.equal(state.calls.filter(c=>c.path.endsWith('/children')||c.path.endsWith('/find_by_department')).length,32);
});

test('directory validation reports no_sample only after exhausting member and child pages',async()=>{
  const state=sampleVendor({memberPages:{od_a:{'':{items:[],has_more:true,page_token:'empty-2'},'empty-2':{items:[],has_more:false}}}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='no_sample');
  assert.ok(state.calls.some(c=>c.query.page_token==='empty-2'));
  assert.equal(state.calls.filter(c=>c.path.endsWith('/children')).length,1);
});

test('directory validation stops on denied reads rather than searching around authorization failures',async()=>{
  const state=sampleVendor({contactScope:{department_ids:['od_a','od_b'],user_ids:[],has_more:false},deniedDepartment:'od_a',memberPages:{od_b:{'':samplePage('od_b')}}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').status==='missing');
  assert.ok(!state.calls.some(c=>c.query.department_id==='od_b'));
});

test('directory validation rejects repeated member continuations and bounds endless distinct pages',async()=>{
  const state=sampleVendor({memberPages:{od_a:{'':{items:[],has_more:true,page_token:'loop'},loop:{items:[],has_more:true,page_token:'loop'}}}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='parse');
  const pages={};for(let i=0;i<40;i++)pages[i===0?'':String(i)]={items:[],has_more:true,page_token:String(i+1)};
  const endless=sampleVendor({memberPages:{od_a:pages}});
  await assert.rejects(feishu(endless),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='limit');
  assert.equal(endless.calls.filter(c=>c.path.endsWith('/find_by_department')).length,32);
});

test('directory validation deduplicates overlapping scope roots and discovered descendants',async()=>{
  const state=sampleVendor({contactScope:{department_ids:['od_a','od_b'],user_ids:[],has_more:false},childPages:{od_a:{'':{items:[childPage('od_b','od_a')],has_more:false}}}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='no_sample');
  assert.deepEqual(state.calls.filter(c=>c.path.endsWith('/find_by_department')).map(c=>c.query.department_id),['od_a','od_b']);
});

test('directory validation bounds discovered departments rather than silently truncating authorized children',async()=>{
  const pages={};for(let i=0;i<21;i++)pages[i===0?'':String(i)]={items:Array.from({length:50},(_,j)=>childPage('od_child_'+(i*50+j),'od_a')),has_more:i<20,...(i<20?{page_token:String(i+1)}:{})};
  const state=sampleVendor({childPages:{od_a:pages}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='limit');
  assert.equal(state.calls.filter(c=>c.path.endsWith('/children')).length,20);
});

test('directory validation bounds initial department roots unless a direct user sample is already available',async()=>{
  const roots=['od_a',...Array.from({length:1000},(_,i)=>'od_b'+i)];
  const state=sampleVendor({contactScope:{department_ids:roots,user_ids:[],has_more:false}});
  await assert.rejects(feishu(state),error=>error instanceof ChannelValidationError&&check(error.validation,'user_name').reason==='limit'&&check(error.validation,'user_name').status==='unverified');
  assert.ok(!state.calls.some(c=>c.path.endsWith('/find_by_department')||c.path.endsWith('/children')));
  const direct=sampleVendor({contactScope:{department_ids:roots,user_ids:['ou_a'],has_more:false}});
  assert.equal((await feishu(direct)).validation.canContinue,true);
  assert.ok(direct.calls.some(c=>c.path.endsWith('/users/ou_a')));
  assert.ok(!direct.calls.some(c=>c.path.endsWith('/find_by_department')||c.path.endsWith('/children')));
});

test('DingTalk actual contact/name reads pass while full scope inventory and unsupported optional features stay honest',async()=>{
  const state=vendor();const result=await new EmployeeApplicationTransport('dingtalk',appId,{appSecret},{fetch:state.fetch}).verify(new DingTalkDirectoryAdapter({appId,appSecret,fetch:state.fetch}));
  assert.equal(result.validation.canContinue,true);assert.equal(result.identity.tenantIdNamespace,'app_id');assert.equal(check(result.validation,'scope_inventory').status,'unverified');assert.equal(check(result.validation,'group_history').status,'unsupported');safeReport(result.validation);
});

test('WeCom bot preparation permits creation without claiming credentials or directory have passed',()=>{
  const validation=wecomBotValidation(()=>1800000000000);
  assert.equal(validation.canContinue,true);assert.equal(validation.checkedAt,1800000000000);
  assert.deepEqual(validation.checks.map(c=>[c.id,c.status,c.required]),[['credentials','unverified',false],['bot_identity','unverified',false]]);
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

test('WeCom draft rejects traditional directory fields and exposes real bot validation contract',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-verification-owner');
  const base=`/api/workspaces/${owner.workspace.id}/employee-channel-drafts`;
  const retired=await f.call('POST',base,{provider:'wecom',operation:'directory',directory:{corpId:'corp',agentId:'7',appSecret}},owner.cookie);
  assert.equal(retired.statusCode,400);
  const result=await f.call('POST',base,{provider:'wecom',appId:'synthetic-bot',appSecret:'synthetic-bot-secret'},owner.cookie);
  assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json().validation,result.json().source.validation);
  assert.equal(result.json().validation.canContinue,true);
  assert.equal(result.json().source.directoryMode,'member_search');
  assert.equal(result.json().source.directoryBinding,undefined);
  assert.equal(f.state.calls.length,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_connections').get().n,0);
});

test('wizard API exposes safe layered failure with no draft writes, and succeeds with optional warnings',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-layered-owner'),base=`/api/workspaces/${owner.workspace.id}/employee-channel-drafts`;
  f.state.mode='scope-denied';const failed=await f.call('POST',base,{provider:'feishu',appId,appSecret},owner.cookie);
  assert.equal(failed.statusCode,400);assert.equal(failed.json().error,'channel_validation_failed');assert.equal(failed.json().validation.canContinue,false);safeReport(failed.json().validation);assert.equal(failed.json().draftId,undefined);
  f.state.mode='ok';const success=await f.call('POST',base,{provider:'feishu',appId,appSecret},owner.cookie);
  assert.equal(success.statusCode,200,success.body);assert.equal(success.json().source.validation.canContinue,true);assert.equal(check(success.json().source.validation,'group_history').status,'missing');
  assert.equal(f.db.prepare('SELECT count(*) n FROM employee_channel_connections').get().n,0);
});

test('retired WeCom directory management routes are not available',async t=>{
  const f=await serverFixture(t),owner=await f.owner('channel-directory-editor'),base=`/api/workspaces/${owner.workspace.id}`;
  const entity=await f.call('POST',base+'/entities',{name:'Synthetic bot editor',ownWebUse:true},owner.cookie);assert.equal(entity.statusCode,200,entity.body);
  const path=base+`/entities/${entity.json().entity.id}/channels/wecom/directory-credentials`;
  const saved=await f.call('POST',path,{label:'Synthetic directory',corpId:'synthetic-corp',agentId:'7',appSecret},owner.cookie);assert.equal(saved.statusCode,404,saved.body);
  assert.equal(f.state.calls.length,0);
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
