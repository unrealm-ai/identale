import test from 'node:test';
import assert from 'node:assert/strict';
import {FeishuDirectoryAdapter} from '../dist/adapters/directory/index.js';
import {EmployeeApplicationTransport} from '../dist/employee-channels/provider.js';
import {ChannelValidationError} from '../dist/employee-channels/validation.js';

const appId='synthetic-compat-app',appSecret='synthetic-private-secret',token='synthetic-private-token',name='Synthetic private person';
const check=(report,id)=>report.checks.find(c=>c.id===id);
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json','x-tt-logid':'20261024ABCDEF0123456789ABCDEF0123'}});
function fixture(options={}){
  const state={calls:[],page:0,...options};
  state.fetch=async(url,init)=>{
    const target=new URL(url),path=target.pathname;assert.equal(target.origin,'https://open.feishu.cn');assert.equal(init.redirect,'error');state.calls.push({path,departmentId:target.searchParams.get('department_id')});
    if(path==='/open-apis/auth/v3/tenant_access_token/internal')return response({code:0,tenant_access_token:token,expire:7200});
    if(path==='/open-apis/tenant/v2/tenant/query')return response({code:0,data:{tenant:{tenant_key:'synthetic-tenant'}}});
    if(path==='/open-apis/bot/v3/info')return response({code:0,bot:{open_id:'synthetic-bot'}});
    if(path==='/open-apis/application/v6/scopes')return response({code:0,data:{scopes:state.scopes??[{scope_name:'offline_access',grant_status:1,scope_type:'user'}]}});
    if(path==='/open-apis/contact/v3/scopes')return response({code:0,data:(state.pages??[{department_ids:['od_allowed'],has_more:false}])[state.page++]});
    if(path==='/open-apis/contact/v3/departments/od_allowed')return response({code:0,data:{department:{open_department_id:'od_allowed',name:'Synthetic department',parent_department_id:'0'}}});
    if(path==='/open-apis/contact/v3/users/find_by_department'){
      assert.equal(target.searchParams.get('department_id'),'od_allowed','Never guess an ungranted root');
      if(state.failMembers)return response({code:99991672,msg:`${appSecret} ${token} ${name}`});
      return response({code:0,data:{items:[{open_id:'ou_allowed',name,department_ids:['od_allowed']}],has_more:false}});
    }
    if(path==='/open-apis/contact/v3/users/ou_allowed')return response({code:0,data:{user:{open_id:'ou_allowed',name,department_ids:['od_allowed']}}});
    assert.fail('Unexpected/ungranted fixture read '+path);
  };
  state.directory=()=>new FeishuDirectoryAdapter({appId,appSecret,fetch:state.fetch});
  state.verify=()=>new EmployeeApplicationTransport('feishu',appId,{appSecret},{fetch:state.fetch}).verify(state.directory());
  return state;
}
function safe(report){const serialized=JSON.stringify(report);for(const text of [appSecret,token,name,'od_allowed','ou_allowed'])assert.ok(!serialized.includes(text),text);}

for(const scope_name of ['offline_access','user_profile','im:message.group_msg','security_and_compliance:user_migration:multi-geo'])test(`valid scope ${scope_name} no longer poisons the inventory`,async()=>{
  const state=fixture({scopes:[{scope_name,grant_status:1,scope_type:'user'}]});const result=await state.verify();
  assert.equal(check(result.validation,'scope_inventory').status,'pass');assert.equal(check(result.validation,'scope_inventory').scopeInventory[0].scope,scope_name);assert.equal(check(result.validation,'group_history').status,'unverified');safe(result.validation);
});

test('omitted user/group arrays retain undisclosed user entries and validate one explicitly granted department/member',async()=>{
  const state=fixture(),result=await state.verify();assert.equal(result.validation.canContinue,true);
  assert.deepEqual(result.authorizedScope.disclosed,{departments:true,users:false});assert.equal(result.authorizedScope.entireOrganization,false);
  assert.deepEqual(check(result.validation,'directory_scope').scopeDisclosure,{departments:true,users:false});
  assert.equal(check(result.validation,'department_read').status,'pass');assert.equal(check(result.validation,'user_name').status,'pass');
  assert.equal(state.calls.filter(c=>c.path.endsWith('/find_by_department')).length,1);assert.ok(!state.calls.some(c=>c.path.includes('/departments/0')));safe(result.validation);
});

test('omitted department array permits only an explicitly returned direct user and never probes root',async()=>{
  const state=fixture({pages:[{user_ids:['ou_allowed'],has_more:false}]}),result=await state.verify();
  assert.equal(result.validation.canContinue,true);assert.deepEqual(result.authorizedScope.disclosed,{departments:false,users:true});assert.ok(!state.calls.some(c=>c.path.includes('/departments/')));safe(result.validation);
});

test('all omitted entries differ from explicit empty scope, neither implies whole organization or triggers root',async()=>{
  for(const [data,reason] of [[{has_more:false},'scope_not_disclosed'],[{department_ids:[],user_ids:[],has_more:false},'empty_scope']]){
    const state=fixture({pages:[data]});await assert.rejects(state.verify(),e=>{assert.ok(e instanceof ChannelValidationError);assert.equal(check(e.validation,'directory_scope').reason,reason);assert.equal(e.validation.canContinue,false);safe(e.validation);return true;});
    assert.ok(!state.calls.some(c=>/\/departments\/|\/users\//.test(c.path)));
  }
});

test('array disclosure participates in scope revision rather than silently treating an omitted list as empty',async()=>{
  const omitted=await fixture({pages:[{department_ids:['od_allowed'],has_more:false}]}).directory().getAuthorizedScope();
  const explicit=await fixture({pages:[{department_ids:['od_allowed'],user_ids:[],has_more:false}]}).directory().getAuthorizedScope();
  assert.notEqual(omitted.revision,explicit.revision);assert.deepEqual(omitted.departmentIds,explicit.departmentIds);
});

test('omitted arrays across bounded pages remain undisclosed even if another page supplies an empty list',async()=>{
  const state=fixture({pages:[{department_ids:['od_allowed'],has_more:true,page_token:'synthetic-next'},{department_ids:[],user_ids:[],has_more:false}]});
  const scope=await state.directory().getAuthorizedScope();assert.deepEqual(scope.disclosed,{departments:true,users:false});assert.deepEqual(scope.departmentIds,['od_allowed']);assert.equal(state.page,2);
});

for(const [key,value,type,count] of [['department_ids',null,'null',undefined],['user_ids',{},'object',undefined],['user_ids',[name,4],'array',2],['group_ids','unexpected','string',undefined]])test(`wrong ${key} type ${type} still fails with value-free field diagnostics`,async()=>{
  const state=fixture({pages:[{department_ids:['od_allowed'],user_ids:[],has_more:false,[key]:value}]});
  await assert.rejects(state.verify(),e=>{const c=check(e.validation,'directory_scope');assert.equal(c.reason,'parse');assert.deepEqual(c.field,{path:`data.${key}`,expected:'array<string>',actualType:type,...(count===undefined?{}:{itemCount:count})});assert.equal(c.httpStatus,200);assert.equal(c.providerCode,0);safe(e.validation);return true;});
});

test('nonempty directory groups remain unsupported with count only, rather than silently dropped',async()=>{
  const state=fixture({pages:[{department_ids:['od_allowed'],group_ids:['synthetic-group'],has_more:false}]});
  await assert.rejects(state.verify(),e=>{const c=check(e.validation,'directory_scope');assert.equal(c.status,'unsupported');assert.equal(c.field.path,'data.group_ids');assert.equal(c.field.itemCount,1);assert.ok(!JSON.stringify(e.validation).includes('synthetic-group'));safe(e.validation);return true;});
});

for(const [data,path] of [[{department_ids:['od_allowed']},'data.has_more'],[{department_ids:['od_allowed'],has_more:'false'},'data.has_more'],[{department_ids:['od_allowed'],has_more:true},'data.page_token']])test(`pagination ${path} remains strict and identifies the failing field`,async()=>{
  await assert.rejects(fixture({pages:[data]}).verify(),e=>{assert.equal(check(e.validation,'directory_scope').field.path,path);assert.equal(e.validation.canContinue,false);safe(e.validation);return true;});
});

test('repeated continuations remain rejected without exposing continuation values',async()=>{
  const state=fixture({pages:[{department_ids:['od_allowed'],has_more:true,page_token:'synthetic-cursor-secret'},{has_more:true,page_token:'synthetic-cursor-secret'}]});
  await assert.rejects(state.verify(),e=>{assert.equal(check(e.validation,'directory_scope').field.path,'data.page_token');assert.ok(!JSON.stringify(e.validation).includes('synthetic-cursor-secret'));safe(e.validation);return true;});
});

for(const [row,path,type] of [[{scope_name:'bad scope '+appSecret,grant_status:1},'scope_name','string'],[{scope_name:42,grant_status:1},'scope_name','number'],[{scope_name:'offline_access',grant_status:'1'},'grant_status','string']])test(`inventory invalid ${path} remains unverified with safe type diagnostics`,async()=>{
  const state=fixture({scopes:[row]}),result=await state.verify();const c=check(result.validation,'scope_inventory');
  assert.equal(c.status,'unverified');assert.equal(c.field.path,`data.scopes[0].${path}`);assert.equal(c.field.actualType,type);assert.equal(c.httpStatus,200);assert.equal(c.providerCode,0);assert.equal(result.validation.canContinue,true);safe(result.validation);
});

test('valid unknown grant enum stays unknown and missing scope type never becomes tenant authorization',async()=>{
  const state=fixture({scopes:[{scope_name:'offline_access',grant_status:99},{scope_name:'im:message.group_msg',grant_status:1}]}),result=await state.verify();
  const rows=check(result.validation,'scope_inventory').scopeInventory;assert.equal(rows[0].status,'unverified');assert.equal(rows[1].identity,'unknown');assert.equal(check(result.validation,'group_history').status,'unverified');
});

test('bounded real adapter member denial after optional-array parsing still blocks readiness',async()=>{
  const state=fixture({failMembers:true});await assert.rejects(state.verify(),e=>{assert.equal(check(e.validation,'directory_scope').status,'pass');assert.equal(check(e.validation,'department_read').status,'pass');assert.equal(check(e.validation,'user_name').status,'missing');assert.equal(e.validation.canContinue,false);safe(e.validation);return true;});
});

test('a malformed unrelated scope preserves usable permission evidence and marks inventory partial',async()=>{
  const state=fixture({scopes:[{scope_name:'im:message:readonly',grant_status:1,scope_type:'tenant'},{scope_name:'invalid '+appSecret,grant_status:1},{scope_name:'im:message.group_msg',grant_status:1,scope_type:'tenant'}]});
  const result=await state.verify(),inventory=check(result.validation,'scope_inventory');
  assert.equal(inventory.status,'unverified');assert.deepEqual(inventory.inventoryDiagnostics,{totalRows:3,issueCount:1});assert.equal(inventory.field.path,'data.scopes[1].scope_name');
  assert.equal(inventory.scopeInventory.length,2);assert.equal(inventory.scopeEvidence.find(s=>s.scope==='im:message.group_msg').status,'granted');
  assert.equal(check(result.validation,'group_history').status,'unverified','scope evidence is not a resource read');assert.equal(result.validation.canContinue,true);safe(result.validation);
});

test('the known legal hyphenated scope at row 1062 is accepted without discarding the inventory',async()=>{
  const scopes=Array.from({length:1061},(_,i)=>({scope_name:`synthetic:scope_${i}`,grant_status:1,scope_type:'tenant'}));
  scopes.push({scope_name:'security_and_compliance:user_migration:multi-geo',grant_status:1,scope_type:'tenant'});
  const result=await fixture({scopes}).verify(),inventory=check(result.validation,'scope_inventory');assert.equal(inventory.status,'pass');assert.equal(inventory.scopeInventory.length,1062);assert.equal(inventory.inventoryDiagnostics,undefined);safe(result.validation);
});

test('conflicting duplicate tenant grants stay unknown while unrelated valid scopes are retained',async()=>{
  const result=await fixture({scopes:[{scope_name:'im:message.group_msg',grant_status:1,scope_type:'tenant'},{scope_name:'im:message.group_msg',grant_status:2,scope_type:'tenant'},{scope_name:'offline_access',grant_status:1,scope_type:'user'}]}).verify();
  const inventory=check(result.validation,'scope_inventory');assert.equal(inventory.status,'unverified');assert.equal(inventory.scopeInventory.find(s=>s.scope==='im:message.group_msg').status,'unverified');assert.equal(inventory.scopeInventory.find(s=>s.scope==='offline_access').status,'granted');assert.equal(check(result.validation,'group_history').status,'unverified');safe(result.validation);
});

for(const reverse of [false,true])test(`a malformed duplicate grant cannot be hidden by a granted row (${reverse?'bad first':'bad last'})`,async()=>{
  const rows=[{scope_name:'im:message.group_msg',grant_status:1,scope_type:'tenant'},{scope_name:'im:message.group_msg',grant_status:'1',scope_type:'tenant'}];if(reverse)rows.reverse();
  const result=await fixture({scopes:rows}).verify(),inventory=check(result.validation,'scope_inventory');
  assert.equal(inventory.status,'unverified');assert.equal(inventory.scopeInventory.find(s=>s.scope==='im:message.group_msg').status,'unverified');assert.equal(inventory.scopeEvidence.find(s=>s.scope==='im:message.group_msg').status,'unverified');assert.equal(check(result.validation,'group_history').status,'unverified');safe(result.validation);
});
