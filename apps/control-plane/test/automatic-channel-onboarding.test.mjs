import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {ChannelMessageLoop} from '@dentity/application';
import {Store} from '../dist/store.js';
import {EmployeeChannelRepository} from '../dist/employee-channels/repository.js';
import {EmployeeChannelService,channelSubject} from '../dist/employee-channels/service.js';
import {EmployeeChannelCreationDrafts} from '../dist/employee-channels/creation-drafts.js';
import {registerEmployeeChannelRoutes} from '../dist/employee-channels/routes.js';
import {CapabilityConfigService} from '../dist/capability-config.js';
import {ChannelIngressSupervisor} from '../dist/channel-loop/ingress-supervisor.js';
import {SqliteMessageLoopRepository} from '../dist/channel-loop/repository.js';
import {registerHumanConfiguration} from '../dist/human-configuration.js';
import {ingressFixture} from './helpers/ingress-fixture.mjs';

const path='/api/workspaces/w/entities/e';
const wrap=result=>({errcode:0,results_json:JSON.stringify({result:JSON.stringify(result)})});
const person=id=>({userid:id,name:'Fixture Member',departments:[id==='member'?'Engineering':'Support']});

async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'automatic-channel-')),store=new Store(join(dir,'test.sqlite'));
 let now=1800000000000;
 const state={directoryDenied:false,searchDenied:false,searchTimeout:false,wrongSchema:false,removed:false,calls:[]};
 const http=createServer(async(req,res)=>{
  let body='';
  for await(const chunk of req)body+=chunk;
  const input=body?JSON.parse(body):{},url=new URL(req.url,'http://fixture'),route=url.pathname;
  state.calls.push({route,input});
  let response;
  if(route==='/v1.0/oauth2/accessToken')response=input.appSecret==='wrong'?{code:'InvalidSecret'}:{accessToken:'ding-token',expireIn:7200};
  else if(route==='/topapi/v2/user/get')response={errcode:0,result:{userid:input.userid,name:'Synthetic Member',active:true,dept_id_list:[1]}};
  else if(route==='/topapi/v2/department/get')response={errcode:0,result:{dept_id:input.dept_id,name:'Engineering',parent_id:0}};
  else if(route==='/auth/scopes'||route.startsWith('/topapi/'))response=state.directoryDenied?{errcode:60011}:{errcode:0,auth_org_scopes:{authed_dept:[1],authed_user:['member']}};
  else if(route==='/open-apis/auth/v3/tenant_access_token/internal')response={code:0,tenant_access_token:'feishu-token',expire:7200};
  else if(route==='/open-apis/bot/v3/info')response={code:0,bot:{open_id:'feishu-bot'}};
  else if(route==='/open-apis/tenant/v2/tenant/query')response={code:0,data:{tenant:{tenant_key:'feishu-tenant',display_id:'display'}}};
  else if(route==='/open-apis/contact/v3/scopes')response={code:0,data:{department_ids:[],user_ids:['member'],group_ids:[],has_more:false}};
  else if(route.startsWith('/open-apis/')&&route.includes('scopes'))response={code:0,data:{scopes:[]}};
  else if(route.includes('scope'))response={code:0,data:{department_ids:[],user_ids:['member'],group_ids:[]}};
  else if(route.startsWith('/open-apis/')&&route.includes('/users/'))response={code:0,data:{user:{open_id:'member',name:'Fixture Member',department_ids:[],status:{is_activated:true,is_frozen:false,is_resigned:false,is_exited:false}}}};
  else if(route==='/cgi-bin/aibot/cli/get_cli_config'){
   const signature=createHash('sha256').update('fixture-secret'+input.bot_id+input.time+input.nonce).digest('hex');
   response=input.signature===signature&&input.bind_source===1?{errcode:0,token:'bot-only-token'}:{errcode:40001};
  }else if(route==='/cli/service/discovery'){
   response=wrap({base_url:state.wrongSchema?'https://untrusted.invalid/cli':'https://qyapi.weixin.qq.com/cli',resources:{users:{methods:{search:{path:'/contact/users/search',http_method:'POST'}}}}});
  }else if(route==='/cli/contact/users/search'){
   if(state.searchTimeout)return;
   const {keywords}=JSON.parse(input.payload);
   const members=keywords.includes('none')||state.removed?[]:keywords.includes('other')?[person('member'),person('other'),person('member')]:[person('member')];
   response=state.searchDenied?{errcode:48002}:wrap({users:members,users_count:members.length,...(keywords.includes('other')?{hint:'partial'}:{})});
  }else if(route.startsWith('/v1.0/robot/'))response={processQueryKey:'provider-receipt'};
  else response={errcode:40004};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 store.run("INSERT INTO users VALUES('u','owner','Owner','active')");
 store.run("INSERT INTO workspaces VALUES('w','Fixture','u','active'),('other','Other','u','active')");
 store.run("INSERT INTO members VALUES('m','w','u','owner','active'),('om','other','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction'),('e2','w','Second','m','m',1,'u','builtin-interaction'),('oe','other','Other','om','om',1,'u','builtin-interaction')");
 const options={masterKey:Buffer.alloc(32,7),now:()=>now,fetch:(url,init)=>{
  const parsed=new URL(url);
  assert.ok(['https://api.dingtalk.com','https://oapi.dingtalk.com','https://qyapi.weixin.qq.com','https://open.feishu.cn'].includes(parsed.origin));
  return fetch('http://127.0.0.1:'+http.address().port+parsed.pathname+parsed.search,init);
 }};
 const repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,options);
 const capabilities=new CapabilityConfigService(store,[],channels,undefined,undefined,undefined,()=>now);
 channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 const transport=ingressFixture(),inbox=new SqliteMessageLoopRepository(store);
 const loop=new ChannelMessageLoop(inbox,channels,{}, {},()=>now);
 const supervisor=new ChannelIngressSupervisor(channels,loop,transport.factory,()=>now);
 await supervisor.start();
 const app=Fastify();
 await registerEmployeeChannelRoutes(app,channels,{requireManager:request=>{if(request.headers['x-test-manager']==='no')throw Object.assign(Error('forbidden'),{statusCode:403});return'u';}});
 registerHumanConfiguration(app,store,channels,()=>{},capabilities);
 const drafts=new EmployeeChannelCreationDrafts(channels,options);
 t.after(async()=>{drafts.close();capabilities.close();await supervisor.stop();await app.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
 const save=(provider,appId=provider+'-app',entity='e',workspace='w',appSecret='fixture-secret')=>channels.save(workspace,entity,provider,'u',{appId,appSecret,expectedRevision:0});
 const search=(words=['member'])=>app.inject({method:'POST',url:path+'/channels/wecom/member-search',payload:{keywords:words}});
 const rule=(c,id='member',kind='channel_user')=>({sourceId:c.sourceId,kind,subjectId:channelSubject(kind,id,kind==='department'?'department_id':'user_id',c.appId),conversationKinds:['private','group']});
 const policy=(c,allow=[rule(c)],deny=[])=>capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,allow,...(c.provider==='wecom'?{deny,mode:'allowlist'}:{}),expectedRevision:capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 const receive=async(c,event)=>{const live=await transport.current(c.id);return live.sink.onEvent(event);};
 const count=()=>store.one("SELECT count(*) n FROM channel_inbox WHERE lane<>'' AND status<>'rejected'").n;
 return {store,state,repository,channels,capabilities,supervisor,transport,app,drafts,save,search,rule,policy,receive,count,advance:ms=>now+=ms};
}
function ding(id='first',patch={}){
 return {type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'event-'+id},data:JSON.stringify({
  msgId:id,chatbotCorpId:'ding-corp',chatbotUserId:'ding-bot',robotCode:'different-from-client',
  senderCorpId:'ding-corp',senderStaffId:'member',senderId:'opaque-member',conversationId:'chat',
  conversationType:'1',msgtype:'text',createAt:1800000000000,text:{content:'fixture message'},...patch,
 })};
}
function wecom(c,id='first',patch={}){
 return {cmd:'aibot_msg_callback',headers:{req_id:'event-'+id},body:{
  msgid:id,aibotid:c.appId,chattype:'single',from:{userid:'member'},msgtype:'text',text:{content:'fixture message'},...patch,
 }};
}

test('C01 credential-only save and wizard preparation',async t=>{
 const f=await setup(t);f.state.directoryDenied=true;
 const ding=await f.save('dingtalk'),wecom=await f.save('wecom');
 for(const c of [ding,wecom]){
  assert.equal(c.status,'pending_verification');assert.equal(c.directoryStatus,'unavailable');
  await f.transport.current(c.id);
  assert.equal(f.supervisor.status(c.id).state,'connected');
  assert.equal(f.channels.verification('w','e',c.provider).status,'not_started');
 }
 assert.equal(ding.validation.canContinue,true);
 for(const provider of ['dingtalk','wecom']){
  const draft=await f.drafts.prepare('w','u',{provider,appId:provider+'-draft',appSecret:'fixture-secret'});
  assert.equal(draft.source.status,'pending_verification');assert.equal(draft.scope.departmentCount,null);
  if(provider==='wecom'){assert.equal(draft.validation.canContinue,true);assert.equal(draft.source.validation.canContinue,true);assert.notEqual(draft.validation.checks.find(c=>c.id==='credentials')?.status,'pass');}
  assert.equal(JSON.stringify(draft).includes('fixture-secret'),false);
 }
});
test('C02 invalid credentials, transport failure and duplicate binding',async t=>{
 const f=await setup(t);
 await assert.rejects(f.save('dingtalk','bad','e','w','wrong'),/channel_validation_failed|authentication_failed/);
 const c=await f.save('wecom'),live=await f.transport.current(c.id);
 live.sink.onStatus({state:'failed',error:'channel_authentication_failed',changedAt:0});
 await f.supervisor.tick();
 assert.equal(f.supervisor.status(c.id).error,'channel_authentication_failed');
 await assert.rejects(live.sink.onEvent(wecom(c)),/channel_ingress_generation_expired/);
 await assert.rejects(f.save('wecom',c.appId,'e2'),/channel_connection_conflict/);
 assert.equal(f.repository.byId(c.id).inboundVerified,false);
});
test('I01 first authorized private or directed group message is admitted on the live generation',async t=>{
 for(const provider of ['dingtalk','wecom'])for(const group of [false,true])await t.test(provider+(group?' group':' private'),async t=>{
  const f=await setup(t),c=await f.save(provider),live=await f.transport.current(c.id);
  if(provider==='wecom')await f.search();
  f.policy(c);
  const event=provider==='dingtalk'?ding('first',group?{conversationType:'2',isInAtList:true}:{}):wecom(c,'first',group?{chattype:'group',chatid:'room'}:{});
  assert.equal(await live.sink.onEvent(event),'accepted');assert.equal(f.count(),1);
  assert.equal(await live.sink.onEvent(event),'duplicate');assert.equal(f.count(),1);
  const observed=f.repository.byId(c.id);assert.equal(observed.inboundVerified,true);assert.equal(observed.revision,c.revision);
  assert.equal((await f.transport.current(c.id)).session.generation,live.session.generation);
  if(provider==='dingtalk'){
   const binding=await f.channels.resolveBinding(c.id);
   const result=await binding.conversation.sendMessage({conversation:{provider:'dingtalk',connectionId:c.id,tenantId:'ding-corp',externalId:'chat',kind:'conversation',
    conversationKind:group?'group':'private',...(group?{}:{privateRecipientId:'member'})},text:'fixture reply',operationId:'fixture-op'});
   assert.equal(result.providerRequestId,'provider-receipt');
  }
 });
});
test('I02 unapproved first sender records robot without a business run and another sender can use it',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');f.policy(c,[f.rule(c,'other')]);
 await f.receive(c,ding());assert.equal(f.repository.byId(c.id).inboundVerified,true);assert.equal(f.count(),0);
 assert.equal(await f.receive(c,ding('later',{senderStaffId:'other'})),'accepted');assert.equal(f.count(),1);
});
test('I03 ordinary group, self, old verification and malformed messages cannot bind',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');
 for(const event of [
  ding('group',{conversationType:'2',isInAtList:false}),ding('self',{senderStaffId:'ding-bot'}),
  ding('old',{text:{content:'identity-verify-00000000-0000-0000-0000-000000000000'}}),
 ])assert.equal(await f.receive(c,event),'ignored');
 await assert.rejects(f.receive(c,ding('bad',{senderStaffId:''})),/ingress_sender_identity_invalid/);
 assert.equal(f.repository.byId(c.id).status,'pending_verification');assert.equal(f.count(),0);
});
test('I04 reject changed robot and known enterprise, allow WeCom bot scope without a fabricated CorpID',async t=>{
 const f=await setup(t),d=await f.save('dingtalk'),w=await f.save('wecom');
 await f.receive(d,ding());
 await assert.rejects(f.receive(d,ding('wrong-code',{robotCode:'different'})),/ingress_robot_mismatch/);
 await assert.rejects(f.receive(d,ding('wrong-corp',{chatbotCorpId:'other',senderCorpId:'other'})),/ingress_tenant_mismatch/);
 await assert.rejects(f.receive(w,wecom(w,'other',{aibotid:'other-bot'})),/ingress_bot_mismatch/);
 await f.receive(w,wecom(w));const raw=f.repository.byId(w.id);
 assert.equal(raw.identity.tenantIdNamespace,'app_id');assert.equal(raw.eventTenantId,w.appId);
});
test('I05 concurrent first events pin one identity and duplicate delivery has one inbox row',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');f.policy(c);
 const live=await f.transport.current(c.id);
 const jobs=await Promise.allSettled([live.sink.onEvent(ding()),live.sink.onEvent(ding()),live.sink.onEvent(ding('other-code',{robotCode:'conflict'}))]);
 assert.equal(jobs.filter(j=>j.status==='fulfilled'&&j.value==='accepted').length,1);
 assert.equal(jobs.filter(j=>j.status==='rejected').length,1);
 assert.equal(f.count(),1);
 assert.equal(f.store.one("SELECT count(*) n FROM employee_channel_audit WHERE action='first_inbound_confirmed'").n,1);
});
test('I06 persistence failure cannot admit first message, replay is recoverable',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');f.policy(c);
 f.store.db.exec("CREATE TRIGGER fail_observe BEFORE UPDATE ON employee_channel_connections BEGIN SELECT RAISE(ABORT,'local_write_failure'); END");
 await assert.rejects(f.receive(c,ding()),/local_write_failure/);assert.equal(f.count(),0);
 f.store.db.exec('DROP TRIGGER fail_observe');
 assert.equal(await f.receive(c,ding()),'accepted');assert.equal(f.count(),1);
});
test('I07 revalidation fences old runner, rechecks identity and never enables a disabled connection',async t=>{
 const f=await setup(t),c=await f.save('dingtalk'),live=await f.transport.current(c.id);f.policy(c);
 await live.sink.onEvent(ding());await f.supervisor.stop();
 const clock=()=>1800000000000;
 const resumed=new ChannelIngressSupervisor(f.channels,new ChannelMessageLoop(new SqliteMessageLoopRepository(f.store),f.channels,{},{},clock),f.transport.factory,clock);
 t.after(()=>resumed.stop());await resumed.start();
 assert.equal(f.repository.byId(c.id).status,'verified');
 const next=await f.channels.revalidate('w','e','dingtalk','u',c.revision);
 await assert.rejects(live.sink.onEvent(ding('old')),/channel_ingress_generation_expired|channel_ingress_owner_lost/);
 await assert.rejects(f.receive(c,ding('wrong',{robotCode:'different'})),/ingress_robot_mismatch/);
 assert.equal(await f.receive(c,ding('rotated')),'accepted');
 const disabled=f.channels.settings('w','e','dingtalk','u',{enabled:false,expectedRevision:next.revision});
 assert.equal((await f.channels.revalidate('w','e','dingtalk','u',disabled.revision)).status,'disabled');
 await resumed.stop();
});
test('S01 batched search respects keyword budget and returns deduplicated people with paths',async t=>{
 const f=await setup(t);await f.save('wecom');
 assert.equal((await f.search(Array(11).fill('member'))).statusCode,400);
 const res=await f.search(['member','other']);assert.equal(res.statusCode,200,res.body);
 assert.equal(res.json().items.length,2);assert.equal(res.json().limited,true);
 assert.deepEqual(res.json().items.map(i=>i.departmentPaths),[['Engineering'],['Support']]);
 assert.equal(res.body.includes('bot-only-token'),false);
 const req=f.state.calls.find(call=>call.route==='/cli/contact/users/search');
 assert.deepEqual(JSON.parse(req.input.payload).keywords,['member','other']);
});
test('S02 empty, permission failure, forged, expired and cross-source candidates',async t=>{
 const f=await setup(t),c=await f.save('wecom');
 assert.equal((await f.app.inject({method:'POST',url:path+'/channels/wecom/member-search',headers:{'x-test-manager':'no'},payload:{keywords:['member']}})).statusCode,403);
 f.state.wrongSchema=true;
 assert.equal((await f.search()).json().error,'invalid_response');
 assert.equal(f.state.calls.some(call=>call.route==='/cli/contact/users/search'),false);
 f.state.wrongSchema=false;
 const empty=await f.search(['none']);assert.equal(empty.statusCode,200);assert.deepEqual(empty.json().items,[]);
 assert.throws(()=>f.policy(c),/invalid_member_search_candidate/);
 f.state.searchDenied=true;assert.equal((await f.search()).json().error,'authorization_denied');f.state.searchDenied=false;
 f.state.searchTimeout=true;assert.equal((await f.search()).json().error,'channel_member_search_timeout');f.state.searchTimeout=false;
 await f.search();const second=await f.save('wecom','other-bot','e2');
 assert.throws(()=>f.channels.validateRules('w','e2',[f.rule(second)]),/invalid_member_search_candidate/);
 assert.throws(()=>f.channels.validateRules('other','oe',[f.rule(c)]),/directory_source_not_found/);
 f.advance(600001);assert.throws(()=>f.policy(c),/invalid_member_search_candidate/);
});
test('A01 bot search gates authorization until an authenticated exact match and deny wins',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.search(['member','other']);
 f.policy(c,[f.rule(c),f.rule(c,'other')],[f.rule(c)]);
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:'denylist',expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 assert.throws(()=>f.channels.validateRules('w','e',[f.rule(c,'1','department')]),/channel_directory_rule_unsupported/);
 await f.receive(c,wecom(c,'stranger',{from:{userid:'unknown'}}));assert.equal(f.count(),0);
 assert.equal(f.repository.byId(c.id).wecomContactIdentityRevision,undefined);
 await f.receive(c,wecom(c));assert.equal(f.count(),0);
 assert.equal(f.repository.byId(c.id).wecomContactIdentityRevision,c.authRevision);
 assert.equal(await f.receive(c,wecom(c,'allowed',{from:{userid:'other'}})),'accepted');
 assert.equal(f.count(),1);
});
test('A02 candidate, approved recipient and speaker lookup require current exact source',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.search();f.policy(c);
 assert.equal((await f.app.inject(path+'/human-confirmation')).json().candidates.filter(i=>i.target.kind==='channel').length,0);
 await f.receive(c,wecom(c));
 const candidate=(await f.app.inject(path+'/human-confirmation')).json().candidates.find(i=>i.target.kind==='channel');
 assert.equal(candidate.target.userId,'member');
 assert.match(candidate.label,/Engineering/);
 const save=await f.app.inject({method:'PUT',url:path+'/human-confirmation',payload:{expectedVersion:0,rules:[{questionScope:'*',target:candidate.target}]}});
 assert.equal(save.statusCode,200,save.body);
 f.advance(600001);
 assert.deepEqual((await f.app.inject(path+'/human-confirmation')).json().candidates.find(i=>i.target.kind==='channel'),candidate);
 await f.channels.assertWeComPrivateRecipient(c.id,'member');
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'not-selected'),/authorization_denied/);
 const b=await f.channels.resolveBinding(c.id),actor={kind:'human',externalId:'member',idNamespace:'user_id',applicationId:c.appId,identityEvidence:'channel_verified'};
 assert.deepEqual(await f.channels.describeActor(b,actor),{displayName:'Fixture Member'});
 assert.deepEqual(await f.channels.describeActor(b,{...actor,externalId:'different'}),{});
 f.state.removed=true;await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'member'),/authorization_denied/);
});
test('R01 upgrade retains existing identity, old challenge dedupe and Feishu behavior',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');
 f.repository.markVerificationEvent(c.id,'old-event','old-id');
 assert.equal(await f.receive(c,ding('old-id')),'duplicate');assert.equal(f.repository.byId(c.id).status,'pending_verification');
 await f.receive(c,ding());const existing=f.repository.byId(c.id);
 assert.equal(existing.botId,'ding-bot');assert.equal(existing.robotCode,'different-from-client');
 assert.equal(f.channels.list('w','e').find(item=>item.id===c.id).inboundVerified,true);
 const feishu=await f.save('feishu');assert.equal(feishu.status,'verified');assert.equal(feishu.botId,'feishu-bot');
 assert.equal(feishu.identityEvidence,'provider_api');
});

function change(f,c,mode,extra={}){return f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode,expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision,...extra});}
function request(c,id='member'){return {workspaceId:'w',entityId:'e',requesterKind:'channel_user',requesterId:id,requesterIdentity:{idNamespace:'user_id',applicationId:c.appId},conversationKind:'private'};}
const packageInput={name:'Fixture package',enabled:true,mode:'inherit',userPolicyMode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]};
test('P01 all and empty denylist need no search while nonempty lists fail closed until mapped',async t=>{
 const f=await setup(t),c=await f.save('wecom');
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies[0].mode,'allowlist');
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies[0].allowGroupMembers,true);
 change(f,c,'all');
 assert.equal(await f.receive(c,wecom(c,'first',{from:{userid:'external-or-unknown'}})),'accepted');
 assert.equal(f.state.calls.some(c=>c.route.includes('/cli/')),false);
 assert.equal(f.repository.byId(c.id).wecomContactIdentityRevision,undefined);
 change(f,c,'allowlist',{allow:[]});await f.receive(c,wecom(c,'empty-allow'));assert.equal(f.count(),1);
 change(f,c,'denylist',{deny:[]});assert.equal(await f.receive(c,wecom(c,'unmapped-empty-deny')),'accepted');assert.equal(f.count(),2);
 assert.equal(f.state.calls.some(c=>c.route.includes('/cli/')),false);
 await f.search();change(f,c,'denylist',{deny:[f.rule(c)]});
 await f.receive(c,wecom(c,'unmapped-nonempty-deny',{from:{userid:'stranger'}}));assert.equal(f.count(),2);
 change(f,c,'denylist',{deny:[]});
 await f.search();assert.equal(await f.receive(c,wecom(c,'mapped-deny')),'accepted');
 change(f,c,'allowlist');await f.receive(c,wecom(c,'mapped-empty-allow'));assert.equal(f.count(),3);
});
test('P02 source revisions, dormant lists, expiry and package intersection',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.search(['member','other']);f.policy(c,[f.rule(c)],[f.rule(c,'other')]);
 await f.receive(c,wecom(c));const b=await f.channels.resolveBinding(c.id),scope=request(c);
 const legacyLists={allow:[f.rule(c)],deny:[f.rule(c)]};
 let pkg=f.capabilities.save('w','e',{...packageInput,directoryAccess:legacyLists});
 assert.equal((await f.capabilities.executionPackages(scope,b.connection,'private')).length,1);
 pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:legacyLists},pkg.id);
 assert.equal((await f.capabilities.executionPackages(scope,b.connection,'private')).length,0);
 pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:legacyLists},pkg.id);
 assert.equal((await f.capabilities.executionPackages(scope,b.connection,'private')).length,1);
 const revision=f.capabilities.getDirectoryAccess('w','e').channelPolicies[0].revision;
 change(f,c,'all',{expectedRevision:revision});assert.throws(()=>change(f,c,'denylist',{expectedRevision:revision}),/directory_policy_changed/);
 f.advance(600001);
 change(f,c,'allowlist');const policy=f.capabilities.getDirectoryAccess('w','e').channelPolicies[0];assert.equal(policy.allow.length,1);assert.equal(policy.deny.length,1);
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:legacyLists},pkg.id);
 change(f,c,'denylist');assert.equal((await f.capabilities.executionPackages(scope,b.connection,'private')).length,1);
 await assert.rejects(f.capabilities.executionPackages(request(c,'other'),b.connection,'private'),/entity_use_forbidden/);
 change(f,c,'allowlist',{allow:[]});await assert.rejects(f.capabilities.executionPackages(scope,b.connection,'private'),/entity_use_forbidden/);
 const second=await f.save('wecom','second-bot','e2');assert.throws(()=>f.capabilities.patchDirectoryAccess('w','e2',{sourceId:second.sourceId,mode:'allowlist',allow:[f.rule(c)],expectedRevision:f.capabilities.getDirectoryAccess('w','e2').channelPolicies.find(p=>p.sourceId===second.sourceId).revision}),/invalid_directory_access_rule/);
});
test('P03 empty package denylist inherits without mapping but nonempty lists fail closed',async t=>{
 const f=await setup(t),c=await f.save('wecom');change(f,c,'all');await f.receive(c,wecom(c));const b=await f.channels.resolveBinding(c.id);
 let pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:{allow:[],deny:[]}});
 assert.equal((await f.capabilities.executionPackages(request(c),b.connection,'private')).length,1);
 assert.equal(f.state.calls.some(c=>c.route.includes('/cli/')),false);
 assert.equal(f.repository.byId(c.id).wecomContactIdentityRevision,undefined);
 await f.search();
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:{allow:[],deny:[f.rule(c)]}},pkg.id);
 assert.equal((await f.capabilities.executionPackages(request(c,'stranger'),b.connection,'private')).length,0);
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:{allow:[],deny:[]}},pkg.id);
 assert.equal((await f.capabilities.executionPackages(request(c),b.connection,'private')).length,0);
 f.capabilities.save('w','e',packageInput,pkg.id);assert.equal((await f.capabilities.executionPackages(request(c),b.connection,'private')).length,1);
});
test('P04 saved lists survive candidate eviction and PUT keeps other provider policy independent',async t=>{
 const f=await setup(t),c=await f.save('wecom'),d=await f.save('dingtalk');await f.search();
 const saved=f.capabilities.saveDirectoryAccess('w','e',{channelPolicies:[{sourceId:c.sourceId,mode:'allowlist',allow:[f.rule(c)],deny:[]}]});
 let pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:{allow:[f.rule(c)],deny:[]}});
 const revision=saved.channelPolicies.find(p=>p.sourceId===c.sourceId).revision;f.policy(d);
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision,revision);
 await f.receive(c,wecom(c));f.store.run('DELETE FROM wecom_bot_contacts WHERE connection_id=?',c.id);f.advance(600001);await f.supervisor.tick();
 change(f,c,'all',{expectedRevision:revision});change(f,c,'allowlist');
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:pkg.directoryAccess},pkg.id);
 assert.throws(()=>change(f,c,'allowlist',{allow:[f.rule(c,'unsearched')]}),/invalid_member_search_candidate/);
 assert.equal(await f.receive(c,wecom(c,'saved-still-allowed')),'accepted');
 assert.equal(await f.receive(d,ding()),'accepted');
});

// Reuse the local HTTP + SDK ingress fixture; no real tenant, outbound user or new mock.
for(const provider of ['feishu','dingtalk','wecom'])test('U01 '+provider+' defaults, source CAS, inherited group and deny priority',async t=>{
 const f=await setup(t),c=await f.save(provider);
 const policy=()=>f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId);
 assert.deepEqual({mode:policy().mode,allow:policy().allow,deny:policy().deny,group:policy().allowGroupMembers},{mode:'allowlist',allow:[],deny:[],group:true});
 if(provider==='dingtalk')assert.equal(await f.receive(c,ding('group-default',{conversationType:'2',isInAtList:true})),'accepted');
 if(provider==='wecom')assert.equal(await f.receive(c,wecom(c,'group-default',{chattype:'group',chatid:'room'})),'accepted');
 const binding=await f.channels.resolveBinding(c.id),namespace=provider==='feishu'?'open_id':'user_id';assert.ok(binding);
 const privateScope={workspaceId:'w',entityId:'e',requesterKind:'channel_user',requesterId:'member',requesterIdentity:{idNamespace:namespace,applicationId:c.appId},conversationKind:'private'};
 const groupScope={...privateScope,conversationKind:'group',groupContext:{conversationId:'room',bindingVersion:binding.bindingVersion}};
 assert.equal(await f.capabilities.authorizeChannel(privateScope,binding.connection,'private'),false);
 assert.equal(await f.capabilities.authorizeChannel(groupScope,binding.connection,'group'),true);
 assert.equal(await f.capabilities.authorizeChannel({...groupScope,groupContext:undefined},binding.connection,'group'),false);
 const pack=f.capabilities.save('w','e',{name:'Inherited source',enabled:true,allowMemberIds:[],denyMemberIds:[],resourceIds:[]});
 assert.equal(f.capabilities.list('w','e').find(p=>p.id===pack.id).directoryAccess.channelPolicies.find(p=>p.sourceId===c.sourceId).mode,'inherit');
 assert.deepEqual((await f.capabilities.usableChannel(groupScope,binding.connection,'group')).map(p=>p.id),[pack.id]);
 await assert.rejects(f.capabilities.usableChannel(privateScope,binding.connection,'private'),/entity_use_forbidden/);
 if(provider==='wecom'){await f.search();await f.receive(c,wecom(c,'mapped',{chattype:'group',chatid:'room'}));}
 const person={sourceId:c.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','member',namespace,c.appId),conversationKinds:['private','group']};
 for(const mode of ['allowlist','all','denylist']){
  const old=policy().revision;
  f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode,allow:[person],deny:[person],allowGroupMembers:true,expectedRevision:old});
  assert.equal(await f.capabilities.authorizeChannel(groupScope,binding.connection,'group'),false);
  assert.equal(await f.capabilities.authorizeChannel(privateScope,binding.connection,'private'),false);
  assert.throws(()=>f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode,expectedRevision:old}),/directory_policy_changed/);
 }
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:'allowlist',allow:[],deny:[],allowGroupMembers:true,expectedRevision:policy().revision});
 const packagePolicy=mode=>({allow:[],deny:[],channelPolicies:[{sourceId:c.sourceId,mode,allow:[],deny:[]}]});
 f.capabilities.save('w','e',{...packageInput,directoryAccess:packagePolicy('allowlist')},pack.id);
 assert.deepEqual(await f.capabilities.usableChannel(groupScope,binding.connection,'group'),[]);
 f.capabilities.save('w','e',{...packageInput,directoryAccess:packagePolicy('inherit')},pack.id);
 assert.deepEqual((await f.capabilities.usableChannel(groupScope,binding.connection,'group')).map(p=>p.id),[pack.id]);
 f.capabilities.save('w','e',{...packageInput,directoryAccess:{allow:[],deny:[],channelPolicies:[{sourceId:c.sourceId,mode:'inherit',allow:[],deny:[person]}]}},pack.id);
 assert.deepEqual(await f.capabilities.usableChannel(groupScope,binding.connection,'group'),[]);
});

test('U02 source writes keep other channels and existing implicit all remains all',async t=>{
 const f=await setup(t),a=await f.save('feishu'),b=await f.save('dingtalk'),c=await f.save('wecom');
 const before=f.capabilities.getDirectoryAccess('w','e');
 for(const channel of [a,b,c])f.capabilities.patchDirectoryAccess('w','e',{sourceId:channel.sourceId,mode:'denylist',allowGroupMembers:false,expectedRevision:before.channelPolicies.find(p=>p.sourceId===channel.sourceId).revision});
 const saved=f.capabilities.getDirectoryAccess('w','e');assert.ok(saved.channelPolicies.every(p=>p.mode==='denylist'&&p.allowGroupMembers===false));
 const raw=f.store.one('SELECT * FROM entity_directory_policies WHERE entity_id=?','e');
 f.store.run('UPDATE entity_directory_policies SET channel_policies_json=? WHERE entity_id=?',JSON.stringify(JSON.parse(raw.channel_policies_json).filter(p=>p.sourceId!==c.sourceId)),'e');
 const legacy=f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId);
 assert.equal(legacy.mode,'all');assert.equal(legacy.allowGroupMembers,false);
 assert.equal(JSON.parse(f.store.one('SELECT channel_policies_json FROM entity_directory_policies WHERE entity_id=?','e').channel_policies_json).some(p=>p.sourceId===c.sourceId),false,'reading legacy configuration never rewrites it');
});
