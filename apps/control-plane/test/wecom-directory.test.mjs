import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WeComDirectoryAdapter} from '../dist/adapters/directory/wecom.js';

// Local synthetic contract fixtures, not tenant verification. Shapes cross-checked against:
// https://github.com/go-laoji/wecom-go-sdk/blob/develop/{agent,department,user}.go
// https://cloud.tencent.com/document/product/1831/138259 (user field/status semantics).
// Official developer pages were inaccessible during implementation; no claim of live API validation.
const options={appId:'1000005',agentId:'1000005',corpId:'fixture-corp',appSecret:'fixture-directory-secret'};
const agent=(overrides={})=>({agentid:1000005,close:0,allow_userinfos:{user:[{userid:'person-a'}]},allow_partys:{partyid:[1]},allow_tags:{tagid:[]},...overrides});
const user=(overrides={})=>({userid:'person-a',name:'Person A',department:[2,3],main_department:3,direct_leader:['manager-a'],status:1,...overrides});
const department=(id=2,parentid=1)=>({id,parentid,name:`Department ${id}`,department_leader:['manager-a']});
async function fixture(handler=()=>({}),agentHandler=()=>agent()){
  const calls=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');calls.push(url);
    try{
      let value;
      if(url.pathname==='/cgi-bin/gettoken'){
        assert.equal(url.searchParams.get('corpid'),options.corpId);assert.equal(url.searchParams.get('corpsecret'),options.appSecret);
        value={access_token:'fixture-access-token',expires_in:7200};
      }else{
        assert.equal(url.searchParams.get('access_token'),'fixture-access-token');
        value=url.pathname==='/cgi-bin/agent/get'?await agentHandler(url):await handler(url);
      }
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({errcode:0,errmsg:'ok',...value}));
    }catch{res.writeHead(500);res.end('fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {calls,fetch:async(input,init)=>{const url=new URL(input);assert.equal(url.origin,'https://qyapi.weixin.qq.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return fetch(base+url.pathname+url.search,init);},close:()=>new Promise(resolve=>server.close(resolve))};
}

test('WeCom binds directory AgentId and corp through token and agent lookup; concurrent verification is single-flight',async t=>{
  const f=await fixture();t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  const identities=await Promise.all([adapter.verify(),adapter.verify()]);
  assert.deepEqual(identities,[{appId:options.agentId,tenantId:options.corpId,tenantIdNamespace:'corp_id'},{appId:options.agentId,tenantId:options.corpId,tenantIdNamespace:'corp_id'}]);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].searchParams.get('agentid'),options.agentId);
  assert.throws(()=>new WeComDirectoryAdapter({...options,appId:'bot-id'}),{code:'invalid_response'});
});

test('WeCom rejects wrong or disabled agent and undisclosed enabled state',async t=>{
  let value=agent({agentid:9});const f=await fixture(undefined,()=>value);t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.verify(),{code:'authorization_denied'});
  value=agent({close:1});await assert.rejects(adapter.verify(),{code:'authorization_denied'});
  value=agent({close:undefined});await assert.rejects(adapter.verify(),{code:'invalid_response'});
});

test('WeCom reads scoped user/department refs, never invents all-organization or silently drops tags',async t=>{
  let value=agent();const f=await fixture(undefined,()=>value);t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  const scope=await adapter.getAuthorizedScope();assert.deepEqual(scope.departmentIds,['1']);assert.deepEqual(scope.userIds,[{id:'person-a',namespace:'user_id'}]);assert.equal(scope.entireOrganization,false);
  value=agent({allow_tags:{tagid:[4]}});await assert.rejects(adapter.getAuthorizedScope(),{code:'unsupported'});
  for(const key of ['allow_tags','allow_userinfos','allow_partys']){value=agent({[key]:undefined});await assert.rejects(adapter.getAuthorizedScope(),{code:'invalid_response'});}
});

test('WeCom filters recursive subtree to direct children, fetches names and returns actual unpaginated result',async t=>{
  const f=await fixture(url=>url.pathname.endsWith('/simplelist')?{department_id:[{id:1,parentid:0},{id:2,parentid:1},{id:3,parentid:2}]}:{department:department()});t.after(f.close);
  const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});const page=await adapter.listChildDepartments('1');
  assert.equal(page.exhausted,true);assert.equal(page.nextCursor,undefined);assert.deepEqual(page.items.map(item=>item.id),['2']);assert.equal(page.items[0].displayName,'Department 2');assert.deepEqual(page.items[0].parentId,{status:'known',value:'1'});
  assert.equal(f.calls.filter(url=>url.pathname==='/cgi-bin/department/get').length,1);
  await assert.rejects(adapter.listChildDepartments('1','invented'),{code:'invalid_response'});
});

test('WeCom bounds detail fanout before fetching, rejects mismatched department results and duplicates',async t=>{
  let mode='budget';const f=await fixture(url=>url.pathname.endsWith('/simplelist')?{department_id:mode==='budget'?[{id:2,parentid:1},{id:3,parentid:1}]:[{id:2,parentid:1},{id:2,parentid:1}]}:{department:department(3)});t.after(f.close);
  const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch,maxScopePages:1});
  await assert.rejects(adapter.listChildDepartments('1'),{code:'limit_exceeded'});assert.equal(f.calls.filter(url=>url.pathname.endsWith('/get')&&!url.pathname.includes('/agent/')).length,0);
  mode='duplicate';await assert.rejects(adapter.listChildDepartments('1'),{code:'invalid_response'});await assert.rejects(adapter.getDepartment('2'),{code:'invalid_response'});
});

test('WeCom simple members stay status unknown and use nonrecursive reads; full lookup projects only organization facts',async t=>{
  const f=await fixture(url=>url.pathname.endsWith('/simplelist')?{userlist:[user({mobile:'private-phone',email:'private-mail'})]}:user({mobile:'private-phone',email:'private-mail',open_userid:'not-a-user-id-alias'}));t.after(f.close);
  const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});const page=await adapter.listDepartmentMembers('2');
  assert.equal(page.items[0].status,'unknown');assert.equal(page.items[0].directManager.status,'unknown');assert.equal(f.calls.at(-1).searchParams.get('fetch_child'),'0');
  const person=await adapter.getUser({id:'PERSON-A',namespace:'user_id'});assert.equal(person.status,'active');assert.deepEqual(person.departmentIds,['2','3']);assert.deepEqual(person.primaryDepartmentId,{status:'known',value:'3'});assert.deepEqual(person.directManager,{status:'known',value:{id:'manager-a',namespace:'user_id'}});assert.deepEqual(person.aliases,[]);
  assert.equal(JSON.stringify(person).includes('private'),false);
  await assert.rejects(adapter.getUser({id:'person-a',namespace:'user_id',applicationId:'bot'}),{code:'authorization_denied'});
  await assert.rejects(adapter.listDepartmentMembers('2','cursor'),{code:'invalid_response'});
});

test('WeCom current disabled/not-activated/exited users are inactive; missing or future status never active',async t=>{
  let status;const f=await fixture(()=>user({status}));t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  for(const value of [undefined,0,9,'1']){status=value;assert.equal((await adapter.getUser({id:'person-a',namespace:'user_id'})).status,'unknown');}
  for(const value of [2,4,5]){status=value;assert.equal((await adapter.getUser({id:'person-a',namespace:'user_id'})).status,'inactive');}
});

test('WeCom unknown facts remain unknown and contradictory organization fields fail closed',async t=>{
  let value={userid:'person-a'};const f=await fixture(()=>value);t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  const person=await adapter.getUser({id:'person-a',namespace:'user_id'});assert.equal(person.departmentMembershipsKnown,false);assert.equal(person.primaryDepartmentId.status,'unknown');assert.equal(person.directManager.status,'unknown');assert.equal(person.displayName,'person-a');
  value=user({direct_leader:['a','b']});const multiple=await adapter.getUser({id:'person-a',namespace:'user_id'});assert.equal(multiple.directManager.status,'unknown');assert.equal(multiple.status,'active');assert.deepEqual(multiple.departmentIds,['2','3']);
  for(const bad of [user({main_department:9}),user({userid:'different'})]){value=bad;await assert.rejects(adapter.getUser({id:'person-a',namespace:'user_id'}),{code:'invalid_response'});}
});

test('WeCom early token invalidation fails current call and reauthenticates next call, with no provider-secret error leakage',async t=>{
  let fail=true;const f=await fixture(()=>fail?{errcode:42001,errmsg:'private-secret-message'}:user());t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});
  await assert.rejects(adapter.getUser({id:'person-a',namespace:'user_id'}),error=>error.code==='authentication_failed'&&!error.message.includes('private'));
  fail=false;assert.equal((await adapter.getUser({id:'person-a',namespace:'user_id'})).status,'active');assert.equal(f.calls.filter(url=>url.pathname.endsWith('/gettoken')).length,2);
});

test('WeCom expired token refreshes and transport response-size limits remain enforced',async t=>{
  let now=0;const f=await fixture(()=>user());t.after(f.close);const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch,now:()=>now});
  await adapter.getUser({id:'person-a',namespace:'user_id'});now=7200001;await adapter.getUser({id:'person-a',namespace:'user_id'});assert.equal(f.calls.filter(url=>url.pathname.endsWith('/gettoken')).length,2);
  await assert.rejects(new WeComDirectoryAdapter({...options,fetch:f.fetch,maxResponseBytes:10}).verify(),{code:'limit_exceeded'});
});

test('WeCom HTTP failures, redirects, malformed JSON and deadline fail without leaking URL or secrets',async t=>{
  let mode='401';
  const server=createServer((req,res)=>{
    if(mode==='delay'){setTimeout(()=>res.end('{}'),100);return;}
    if(mode==='json'){res.writeHead(200);res.end('not json');return;}
    if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/credential-leak'});res.end();return;}
    res.writeHead(Number(mode));res.end('{"errcode":0}');
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const localFetch=(input,init)=>{const url=new URL(input);assert.equal(url.origin,'https://qyapi.weixin.qq.com');assert.equal(init.redirect,'error');return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,init);};
  for(const [value,code] of [['401','authentication_failed'],['403','authorization_denied'],['429','unavailable'],['500','unavailable'],['json','invalid_response'],['redirect','unavailable'],['delay','unavailable']]){
    mode=value;await assert.rejects(new WeComDirectoryAdapter({...options,fetch:localFetch,timeoutMs:20}).verify(),error=>error.code===code&&!error.message.includes('fixture'));
  }
});

test('WeCom concurrent invalidation of an old token does not clear a newly verified token',async t=>{
  let release;let block=true;const blocked=new Promise(resolve=>release=resolve);
  const f=await fixture(async()=>{if(block){await blocked;return {errcode:42001};}return user();});t.after(f.close);
  const adapter=new WeComDirectoryAdapter({...options,fetch:f.fetch});await adapter.verify();
  const pending=adapter.getUser({id:'person-a',namespace:'user_id'});const outcome=assert.rejects(pending,{code:'authentication_failed'});
  while(!f.calls.some(url=>url.pathname==='/cgi-bin/user/get'))await new Promise(resolve=>setTimeout(resolve,1));
  await adapter.verify();block=false;release();await outcome;
  await adapter.getUser({id:'person-a',namespace:'user_id'});assert.equal(f.calls.filter(url=>url.pathname.endsWith('/gettoken')).length,2);
});
