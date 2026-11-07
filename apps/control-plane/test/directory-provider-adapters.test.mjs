import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createDirectoryAdapter,FeishuDirectoryAdapter,DingTalkDirectoryAdapter} from '../dist/adapters/directory/index.js';

const now=1792750000000;
const options={appId:'fixture-app',appSecret:'fixture-secret',now:()=>now};
const feishuUser=(overrides={})=>({open_id:'ou_a',user_id:'user-a',union_id:'union-a',name:'Same Name',department_ids:['od_a','od_b'],status:{is_frozen:false,is_resigned:false,is_exited:false,is_activated:true},leader_user_id:'ou_manager',dotted_line_leader_user_ids:['ou_dotted'],orders:[{department_id:'od_b',is_primary_dept:true}],...overrides});
const feishuDepartment=(overrides={})=>({open_department_id:'od_a',name:'Department A',parent_department_id:'0',leaders:[{leaderType:1,leaderID:'ou_manager'}],...overrides});
const dingUser=(overrides={})=>({userid:'user-a',unionid:'union-a',name:'Same Name',dept_id_list:[2,3],active:true,manager_userid:'manager-a',...overrides});
const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const fsOk=(res,data)=>json(res,{code:0,data});
const dtOk=(res,result)=>json(res,{errcode:0,result});
async function fixture(handler){
  const calls=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const call={method:req.method,url:new URL(req.url,'http://fixture'),headers:req.headers,body:body?JSON.parse(body):undefined};calls.push(call);try{await handler(call,res);}catch(error){res.writeHead(500);res.end('fixture handler failed');throw error;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  return {calls,fetch:async(url,init)=>{const target=new URL(url);assert.ok(['https://open.feishu.cn','https://api.dingtalk.com','https://oapi.dingtalk.com'].includes(target.origin));assert.equal(init.redirect,'error');return fetch(base+target.pathname+target.search,init);},close:()=>new Promise(resolve=>server.close(resolve))};
}
function feishuFixture(handler,tenant={tenant_key:'tenant-key',display_id:'F123'}){return fixture((call,res)=>{
  if(call.url.pathname==='/open-apis/auth/v3/tenant_access_token/internal'){assert.deepEqual(call.body,{app_id:options.appId,app_secret:options.appSecret});return json(res,{code:0,tenant_access_token:'fixture-fs-token',expire:7200});}
  assert.equal(call.headers.authorization,'Bearer fixture-fs-token');
  if(call.url.pathname==='/open-apis/tenant/v2/tenant/query')return fsOk(res,{tenant});
  return handler(call,res);
});}
function dingFixture(handler){return fixture((call,res)=>{
  if(call.url.pathname==='/v1.0/oauth2/accessToken'){assert.deepEqual(call.body,{appKey:options.appId,appSecret:options.appSecret});return json(res,{accessToken:'fixture-dt-token',expireIn:7200});}
  assert.equal(call.url.searchParams.get('access_token'),'fixture-dt-token');return handler(call,res);
});}

test('Feishu derives tenant_key and preserves display_id-only identity namespace',async t=>{
  for(const [tenant,expected] of [[{tenant_key:'tenant-key',display_id:'F123'},{tenantId:'tenant-key',tenantIdNamespace:'tenant_key'}],[{display_id:'F123'},{tenantId:'F123',tenantIdNamespace:'display_id'}]]){
    const f=await feishuFixture(()=>assert.fail('unexpected directory request'),tenant);t.after(f.close);
    assert.deepEqual(await createDirectoryAdapter('feishu',{...options,fetch:f.fetch,tenantId:'forged'}).verify(),{...expected,appId:options.appId});
  }
});

test('Feishu rejects missing tenant identity and malformed token exchange without trusting supplied tenant',async t=>{
  const f=await feishuFixture(()=>assert.fail('unexpected directory request'),{name:'Tenant name is not identity'});t.after(f.close);
  await assert.rejects(createDirectoryAdapter('feishu',{...options,fetch:f.fetch,tenantId:'forged'}).verify(),{code:'invalid_response'});
  const bad=await fixture((_call,res)=>json(res,{code:0,tenant_access_token:'fixture-token',expire:-1}));t.after(bad.close);
  await assert.rejects(new FeishuDirectoryAdapter({...options,fetch:bad.fetch}).verify(),{code:'invalid_response'});
});

test('Feishu scope completes bounded pages with stable order-independent revision and no global-access assumption',async t=>{
  let reverse=false;
  const f=await feishuFixture((call,res)=>{
    assert.equal(call.url.pathname,'/open-apis/contact/v3/scopes');assert.equal(call.url.searchParams.get('user_id_type'),'open_id');assert.equal(call.url.searchParams.get('department_id_type'),'open_department_id');
    return fsOk(res,call.url.searchParams.has('page_token')?{department_ids:['od_b'],user_ids:[],group_ids:[],has_more:false}:{department_ids:reverse?['od_a','od_a']:['od_a'],user_ids:['ou_a'],group_ids:[],has_more:true,page_token:'scope-2'});
  });t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});const first=await adapter.getAuthorizedScope();
  assert.deepEqual(first.departmentIds,['od_a','od_b']);assert.deepEqual(first.userIds,[{id:'ou_a',namespace:'open_id',applicationId:options.appId}]);assert.equal(first.entireOrganization,false);
  reverse=true;assert.deepEqual(await adapter.getAuthorizedScope(),first);
});

test('Feishu refuses scope cursor loops, missing pagination, unsupported groups and page budget exhaustion',async t=>{
  let mode='loop';const f=await feishuFixture((_call,res)=>fsOk(res,{department_ids:[],...(mode==='users'?{}:{user_ids:[]}),group_ids:mode==='groups'?['group-a']:[],...(mode==='pagination'?{}:{has_more:mode!=='groups',page_token:'same'})}));t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  for(const [value,code] of [['loop','invalid_response'],['pagination','invalid_response'],['groups','unsupported']]){mode=value;await assert.rejects(adapter.getAuthorizedScope(),{code});}
  mode='loop';await assert.rejects(new FeishuDirectoryAdapter({...options,fetch:f.fetch,maxScopePages:1}).getAuthorizedScope(),{code:'limit_exceeded'});
});

test('Feishu projects multi-department, primary, manager, dotted managers and app-scoped verified aliases',async t=>{
  const f=await feishuFixture((_call,res)=>fsOk(res,{has_more:false,items:[feishuUser()]}));t.after(f.close);
  const page=await new FeishuDirectoryAdapter({...options,fetch:f.fetch}).listDepartmentMembers('od_a');const user=page.items[0];
  assert.deepEqual(user.departmentIds,['od_a','od_b']);assert.equal(user.departmentMembershipsKnown,true);assert.equal(user.status,'active');assert.deepEqual(user.primaryDepartmentId,{status:'known',value:'od_b'});
  assert.deepEqual(user.directManager,{status:'known',value:{id:'ou_manager',namespace:'open_id',applicationId:options.appId}});assert.equal(user.dottedLineManagers.value[0].id,'ou_dotted');
  assert.deepEqual(user.aliases,[{id:'user-a',namespace:'user_id'},{id:'union-a',namespace:'union_id',applicationId:options.appId}]);
});

test('Feishu job title is optional provider metadata and empty or malformed values are omitted',async t=>{
  let title='后端工程师';const f=await feishuFixture((_call,res)=>fsOk(res,{user:feishuUser({job_title:title})}));t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch}),id={id:'ou_a',namespace:'open_id',applicationId:options.appId};
  assert.equal((await adapter.getUser(id)).jobTitle,'后端工程师');
  for(const value of [undefined,null,'','  ',42]){title=value;assert.equal('jobTitle' in await adapter.getUser(id),false);}
});

test('Feishu missing organizational facts remain unknown, explicit empty facts remain known',async t=>{
  let empty=false;const f=await feishuFixture((_call,res)=>fsOk(res,{has_more:false,items:[{open_id:'ou_a',name:'Name',...(empty?{department_ids:[],leader_user_id:'',dotted_line_leader_user_ids:[]}:{} )}]}));t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});const user=(await adapter.listDepartmentMembers('od_a')).items[0];
  assert.equal(user.departmentMembershipsKnown,false);assert.deepEqual(user.departmentIds,['od_a']);assert.equal(user.status,'unknown');assert.equal(user.primaryDepartmentId.status,'unknown');assert.equal(user.directManager.status,'unknown');assert.equal(user.dottedLineManagers.status,'unknown');
  empty=true;await assert.rejects(adapter.listDepartmentMembers('od_a'),{code:'invalid_response'});
});

test('Feishu rejects foreign app IDs before requests and checks returned user identity',async t=>{
  const f=await feishuFixture((_call,res)=>fsOk(res,{user:feishuUser()}));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.getUser({id:'ou_a',namespace:'open_id',applicationId:'other-app'}),{code:'authorization_denied'});assert.equal(f.calls.length,0);
  assert.equal((await adapter.getUser({id:'user-a',namespace:'user_id'})).id.id,'ou_a');
  await assert.rejects(adapter.getUser({id:'other-user',namespace:'user_id'}),{code:'invalid_response'});
});

test('Feishu department tree and leader IDs preserve their namespaces',async t=>{
  const f=await feishuFixture((call,res)=>call.url.pathname.endsWith('/children')?fsOk(res,{items:[feishuDepartment()],has_more:false}):fsOk(res,{department:feishuDepartment()}));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  const department=await adapter.getDepartment('od_a');assert.equal(department.namespace,'open_department_id');assert.deepEqual(department.parentId,{status:'known',value:'0'});assert.equal(department.leaders.value[0].namespace,'open_id');
  assert.deepEqual((await adapter.listChildDepartments('0')).items,[department]);
  await assert.rejects(adapter.listChildDepartments('other-parent'),{code:'invalid_response'});await assert.rejects(adapter.getDepartment('other-id'),{code:'invalid_response'});
});

test('Feishu page cursors bind adapter and department; repeated continuation and duplicate users fail',async t=>{
  let duplicate=false;const f=await feishuFixture((_call,res)=>fsOk(res,{has_more:true,page_token:'page-2',items:duplicate?[feishuUser(),feishuUser()]:[feishuUser()]}));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  const page=await adapter.listDepartmentMembers('od_a');assert.notEqual(page.nextCursor,'page-2');
  await assert.rejects(adapter.listDepartmentMembers('od_b',page.nextCursor),{code:'invalid_response'});
  await assert.rejects(new FeishuDirectoryAdapter({...options,fetch:f.fetch}).listDepartmentMembers('od_a',page.nextCursor),{code:'invalid_response'});
  await assert.rejects(adapter.listDepartmentMembers('od_a',page.nextCursor),{code:'invalid_response'});duplicate=true;await assert.rejects(adapter.listDepartmentMembers('od_a'),{code:'invalid_response'});
});

test('Feishu refresh and explicit reverification reject changed tenant, retaining no usable session',async t=>{
  let tenant='tenant-a',time=now;const f=await fixture((call,res)=>{
    if(call.url.pathname.includes('tenant_access_token'))return json(res,{code:0,tenant_access_token:'fixture-token',expire:1});
    if(call.url.pathname.includes('tenant/query'))return fsOk(res,{tenant:{tenant_key:tenant}});
    return fsOk(res,{department_ids:[],user_ids:[],has_more:false});
  });t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch,now:()=>time});await adapter.verify();tenant='tenant-b';time+=2000;
  await assert.rejects(adapter.getAuthorizedScope(),{code:'authorization_denied'});await assert.rejects(adapter.verify(),{code:'authorization_denied'});
});

test('DingTalk default verification proves only app_id, never trusts supplied corpId or token response corpId',async t=>{
  const f=await fixture((_call,res)=>json(res,{accessToken:'fixture-token',expireIn:7200,corpId:'unverified-extension'}));t.after(f.close);
  const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch,corpId:'forged'});
  assert.deepEqual(await adapter.verify(),{tenantId:options.appId,tenantIdNamespace:'app_id',appId:options.appId});
});

test('DingTalk accepts independent trusted corp binding and rejects mismatched app or changed corp',async t=>{
  const f=await dingFixture(()=>assert.fail('unexpected directory request'));t.after(f.close);let corp='corp-a';
  const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch,verifyDingTalkIdentity:async input=>{assert.equal(input.accessToken,'fixture-dt-token');return {appId:input.appId,tenantId:corp,tenantIdNamespace:'corp_id'};}});
  assert.equal((await adapter.verify()).tenantId,'corp-a');corp='corp-b';await assert.rejects(adapter.verify(),{code:'authorization_denied'});
  const wrong=new DingTalkDirectoryAdapter({...options,fetch:f.fetch,verifyDingTalkIdentity:async()=>({appId:'other-app',tenantId:'corp-a',tenantIdNamespace:'corp_id'})});await assert.rejects(wrong.verify(),{code:'authorization_denied'});
});

test('DingTalk scopes stay bounded, normalize department IDs, and never imply global access from empty data',async t=>{
  let empty=false;const f=await dingFixture((_call,res)=>json(res,{errcode:0,auth_org_scopes:{authed_dept:empty?[]:[2,3],authed_user:empty?[]:['user-a']}}));t.after(f.close);const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch});
  const scope=await adapter.getAuthorizedScope();assert.deepEqual(scope.departmentIds,['2','3']);assert.deepEqual(scope.userIds,[{id:'user-a',namespace:'user_id'}]);assert.equal(scope.entireOrganization,false);empty=true;const reduced=await adapter.getAuthorizedScope();assert.notEqual(scope.revision,reduced.revision);assert.equal(reduced.entireOrganization,false);
});

test('DingTalk department relationships use details, child list is bounded and nonpaginated',async t=>{
  const f=await dingFixture((call,res)=>dtOk(res,call.url.pathname.endsWith('listsub')?[{dept_id:2,name:'Department',parent_id:1}]:{dept_id:2,name:'Department',parent_id:1,dept_manager_userid_list:['manager-a','manager-b']}));t.after(f.close);const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch});
  const department=await adapter.getDepartment('2');assert.equal(department.namespace,'department_id');assert.deepEqual(department.parentId,{status:'known',value:'1'});assert.deepEqual(department.leaders.value,[{id:'manager-a',namespace:'user_id'},{id:'manager-b',namespace:'user_id'}]);
  const children=await adapter.listChildDepartments('1');assert.equal(children.exhausted,true);assert.equal(children.items[0].leaders.status,'unknown');
  await assert.rejects(adapter.listChildDepartments('1','invented-page'),{code:'invalid_response'});await assert.rejects(adapter.getDepartment('9007199254740993'),{code:'invalid_response'});
});

test('DingTalk member pagination and relationships do not manufacture primary or dotted managers',async t=>{
  const f=await dingFixture((call,res)=>{
    if(call.url.pathname.endsWith('/get'))return dtOk(res,dingUser());
    assert.equal(call.body.size,100);return dtOk(res,{has_more:call.body.cursor===0,next_cursor:100,list:[dingUser()]});
  });t.after(f.close);const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch});
  const first=await adapter.listDepartmentMembers('2');assert.equal(first.exhausted,false);const second=await adapter.listDepartmentMembers('2',first.nextCursor);assert.equal(second.exhausted,true);
  const user=await adapter.getUser({id:'user-a',namespace:'user_id'});assert.deepEqual(user.departmentIds,['2','3']);assert.equal(user.departmentMembershipsKnown,true);assert.deepEqual(user.directManager,{status:'known',value:{id:'manager-a',namespace:'user_id'}});assert.equal(user.primaryDepartmentId.status,'unknown');assert.equal(user.dottedLineManagers.status,'unknown');
  await assert.rejects(adapter.listDepartmentMembers('3',first.nextCursor),{code:'invalid_response'});await assert.rejects(adapter.getUser({id:'union-a',namespace:'union_id'}),{code:'unsupported'});
});

test('DingTalk missing fields are unknown and unsafe cursor numbers fail closed',async t=>{
  let cursor=0;const f=await dingFixture((_call,res)=>dtOk(res,{has_more:cursor!==0,next_cursor:cursor,list:[{userid:'user-a',name:'Name',active:false}]}));t.after(f.close);const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch});const user=(await adapter.listDepartmentMembers('2')).items[0];
  assert.equal(user.departmentMembershipsKnown,false);assert.deepEqual(user.departmentIds,['2']);assert.equal(user.status,'unknown');assert.equal(user.directManager.status,'unknown');cursor=9007199254740992;await assert.rejects(adapter.listDepartmentMembers('2'),{code:'invalid_response'});
});

test('directory transport rejects redirects, oversized and malformed responses and sanitizes authentication failures',async t=>{
  let mode='redirect';const f=await fixture((_call,res)=>{if(mode==='redirect'){res.writeHead(302,{location:'https://example.invalid/never'});return res.end();}if(mode==='large')return res.end('x'.repeat(501));if(mode==='json')return res.end('not-json fixture-secret');return json(res,{message:'fixture-secret fixture-token'},400);});t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch,maxResponseBytes:500});
  for(const [value,code] of [['redirect','unavailable'],['large','limit_exceeded'],['json','invalid_response'],['auth','authentication_failed']]){mode=value;await assert.rejects(adapter.verify(),error=>error.code===code&&!error.message.includes('fixture'));}
});

test('directory credentials are exchanged in body only; timeout and denied reads do not become empty scopes',async t=>{
  const f=await feishuFixture((_call,res)=>json(res,{code:99991672,msg:'fixture-secret'},200));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.getAuthorizedScope(),{code:'authorization_denied'});assert.ok(f.calls.every(call=>!call.url.search.includes(options.appSecret)));
  const slow=await fixture(async(_call,res)=>{await new Promise(resolve=>setTimeout(resolve,50));json(res,{});});t.after(slow.close);await assert.rejects(new DingTalkDirectoryAdapter({...options,fetch:slow.fetch,timeoutMs:5}).verify(),{code:'unavailable'});
});

test('Feishu explicit empty relationship fields are known while missing department leaders stay unknown',async t=>{
  const f=await feishuFixture((call,res)=>call.url.pathname.includes('/users/')?fsOk(res,{user:{open_id:'ou_a',name:'Name',department_ids:[],leader_user_id:'',dotted_line_leader_user_ids:[]}}):fsOk(res,{department:{open_department_id:'od_a',name:'Dept'}}));t.after(f.close);
  const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});const user=await adapter.getUser({id:'ou_a',namespace:'open_id',applicationId:options.appId});
  assert.deepEqual(user.directManager,{status:'known',value:null});assert.deepEqual(user.dottedLineManagers,{status:'known',value:[]});assert.equal(user.departmentMembershipsKnown,true);assert.deepEqual(user.departmentIds,[]);
  const department=await adapter.getDepartment('od_a');assert.equal(department.leaders.status,'unknown');assert.equal(department.parentId.status,'unknown');
});

test('Feishu path traversal-shaped IDs cannot move an authenticated request to another endpoint',async t=>{
  const f=await feishuFixture(()=>assert.fail('no directory request allowed'));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.getDepartment('..'),{code:'invalid_response'});assert.equal(f.calls.length,0);
  await assert.rejects(adapter.getUser({id:'.',namespace:'open_id',applicationId:options.appId}),{code:'invalid_response'});assert.equal(f.calls.length,0);
});

test('Feishu invalidated credential requires reverification and same-app replacement never shares token cache',async t=>{
  let exchanges=0,deny=false;const f=await fixture((call,res)=>{
    if(call.url.pathname.includes('tenant_access_token')){exchanges++;return json(res,{code:0,tenant_access_token:`fixture-token-${exchanges}`,expire:7200});}
    if(call.url.pathname.includes('tenant/query'))return fsOk(res,{tenant:{tenant_key:'tenant-a'}});
    if(deny)return json(res,{code:99991664,msg:'secret should not escape'});
    return fsOk(res,{department_ids:[],user_ids:[],has_more:false});
  });t.after(f.close);const first=new FeishuDirectoryAdapter({...options,fetch:f.fetch});await first.getAuthorizedScope();await first.getAuthorizedScope();assert.equal(exchanges,1);
  deny=true;await assert.rejects(first.getAuthorizedScope(),{code:'authentication_failed'});deny=false;await first.getAuthorizedScope();assert.equal(exchanges,2);
  await new FeishuDirectoryAdapter({...options,appSecret:'rotated-fixture-secret',fetch:f.fetch}).getAuthorizedScope();assert.equal(exchanges,3);assert.equal(f.calls.findLast(call=>call.body)?.body.app_secret,'rotated-fixture-secret');
});

test('DingTalk pagination duplicates and missing scope envelopes are errors, not empty success',async t=>{
  let mode='duplicate';const f=await dingFixture((call,res)=>call.url.pathname==='/auth/scopes'?json(res,{errcode:0}):dtOk(res,{has_more:true,...(mode==='duplicate'?{next_cursor:1,list:[dingUser(),dingUser()]}:{next_cursor:0,list:[dingUser()]})}));t.after(f.close);const adapter=new DingTalkDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.listDepartmentMembers('2'),{code:'invalid_response'});mode='cursor';await assert.rejects(adapter.listDepartmentMembers('2'),{code:'invalid_response'});await assert.rejects(adapter.getAuthorizedScope(),{code:'invalid_response'});
});

test('Feishu alias lookup rereads canonical open_id before projecting reporting relationships',async t=>{
  const f=await feishuFixture((call,res)=>fsOk(res,{user:feishuUser({leader_user_id:call.url.searchParams.get('user_id_type')==='open_id'?'ou_manager':'user-manager'})}));t.after(f.close);
  const user=await new FeishuDirectoryAdapter({...options,fetch:f.fetch}).getUser({id:'user-a',namespace:'user_id'});
  assert.equal(user.directManager.value.id,'ou_manager');assert.equal(user.directManager.value.namespace,'open_id');
  assert.deepEqual(f.calls.filter(call=>call.url.pathname.includes('/contact/')).map(call=>call.url.searchParams.get('user_id_type')),['user_id','open_id']);
});

test('Feishu HTTP 400 directory scope revocations are authorization errors, not transient outages',async t=>{
  let code=41050;const f=await feishuFixture((_call,res)=>json(res,{code,msg:'provider details must not escape'},400));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch});
  for(code of [41050,40003,40004,41056])await assert.rejects(adapter.getAuthorizedScope(),{code:'authorization_denied',message:'authorization_denied'});
});

test('Feishu exhausted empty children page may omit items; explicit empty array remains equivalent',async t=>{
 for(const data of [{has_more:false},{has_more:false,items:[]}]){const f=await feishuFixture((_call,res)=>fsOk(res,data));t.after(f.close);const page=await new FeishuDirectoryAdapter({...options,fetch:f.fetch}).listChildDepartments('od_a');assert.deepEqual(page,{items:[],exhausted:true});}
});
for(const [label,items,actualType]of [['null',null,'null'],['object',{},'object'],['string','not-a-list','string']])test(`Feishu children rejects ${label} items with safe field diagnostics`,async t=>{
 const f=await feishuFixture((_call,res)=>fsOk(res,{has_more:false,items}));t.after(f.close);await assert.rejects(new FeishuDirectoryAdapter({...options,fetch:f.fetch}).listChildDepartments('od_a'),error=>{assert.equal(error.code,'invalid_response');assert.equal(error.details.field.path,'data.items');assert.equal(error.details.field.actualType,actualType);assert.equal('value' in error.details.field,false);return true;});
});
for(const [label,data]of [['continued page without items',{has_more:true,page_token:'synthetic-next'}],['unknown completion',{items:[]}],['invalid completion type',{items:[],has_more:'false'}],['missing continuation',{items:[],has_more:true}],['invalid continuation type',{items:[],has_more:true,page_token:1}]])test(`Feishu children rejects ${label} instead of publishing an empty snapshot`,async t=>{
 const f=await feishuFixture((_call,res)=>fsOk(res,data));t.after(f.close);await assert.rejects(new FeishuDirectoryAdapter({...options,fetch:f.fetch}).listChildDepartments('od_a'),{code:'invalid_response'});
});
test('Feishu children empty intermediate page still follows an authenticated non-repeating cursor',async t=>{
 let loop=false;const f=await feishuFixture((call,res)=>fsOk(res,!call.url.searchParams.has('page_token')||loop?{items:[],has_more:true,page_token:'synthetic-next'}:{has_more:false}));t.after(f.close);const adapter=new FeishuDirectoryAdapter({...options,fetch:f.fetch}),first=await adapter.listChildDepartments('od_a');assert.equal(first.exhausted,false);assert.ok(first.nextCursor);assert.deepEqual(await adapter.listChildDepartments('od_a',first.nextCursor),{items:[],exhausted:true});loop=true;await assert.rejects(adapter.listChildDepartments('od_a',first.nextCursor),{code:'invalid_response'});
});
