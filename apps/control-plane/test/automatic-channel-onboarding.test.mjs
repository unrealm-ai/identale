import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
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
 let now=1800000000000;const cleanup=[];
 const state={feishuTenantKey:true,directoryDenied:false,searchDenied:false,searchTimeout:false,wrongSchema:false,removed:false,sessionRows:[{chat_id:'member',chat_type:'single',chat_name:'Fixture Member',last_msg_time:1800000000},{chat_id:'other',chat_type:'single',chat_name:'Fixture Member',last_msg_time:1800000000}],sendFailure:false,onVerificationSend:undefined,diagnostics:[],calls:[]};
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
  else if(route==='/open-apis/tenant/v2/tenant/query')response={code:0,data:{tenant:{...(state.feishuTenantKey?{tenant_key:'feishu-tenant'}:{}),display_id:'display'}}};
  else if(route==='/open-apis/contact/v3/scopes')response={code:0,data:{department_ids:[],user_ids:['member'],group_ids:[],has_more:false}};
  else if(route.startsWith('/open-apis/')&&route.includes('scopes'))response={code:0,data:{scopes:[]}};
  else if(route.includes('scope'))response={code:0,data:{department_ids:[],user_ids:['member'],group_ids:[]}};
  else if(route.startsWith('/open-apis/')&&route.includes('/users/'))response={code:0,data:{user:{open_id:'member',name:'Fixture Member',department_ids:[],status:{is_activated:true,is_frozen:false,is_resigned:false,is_exited:false}}}};
  else if(route==='/cgi-bin/aibot/cli/get_cli_config'){
   const signature=createHash('sha256').update('fixture-secret'+input.bot_id+input.time+input.nonce).digest('hex');
   response=input.signature===signature&&input.bind_source===1?{errcode:0,token:'bot-only-token'}:{errcode:40001};
  }else if(route==='/cli/service/discovery'){
   const {service}=JSON.parse(input.payload);
   response=service==='message'?wrap({base_url:'https://qyapi.weixin.qq.com/cli',resources:{aibot:{methods:{send:{path:'/message/aibot/send',http_method:'POST'}},resources:{sessions:{methods:{list:{path:'/message/aibot/sessions/list',http_method:'POST'}}}}}}}):wrap({base_url:state.wrongSchema?'https://untrusted.invalid/cli':'https://qyapi.weixin.qq.com/cli',resources:{users:{methods:{search:{path:'/contact/users/search',http_method:'POST'}}}}});
  }else if(route==='/cli/contact/users/search'){
   if(state.searchTimeout)return;
   const {keywords}=JSON.parse(input.payload);
   const members=keywords.includes('none')||state.removed?[]:keywords.includes('other')?[person('member'),person('other'),person('member')]:[person('member')];
   response=state.searchDenied?{errcode:48002}:wrap({users:members,users_count:members.length,...(keywords.includes('other')?{hint:'partial'}:{})});
  }else if(route==='/cli/message/aibot/sessions/list')response=wrap({sessions:state.sessionRows,sessions_count:state.sessionRows.length});
  else if(route==='/cli/message/aibot/send'){
   if(state.onVerificationSend)await state.onVerificationSend(JSON.parse(input.payload));
   response=state.sendFailure?{errcode:853004}:wrap({success:true});
  }else if(route.startsWith('/v1.0/robot/'))response={processQueryKey:'provider-receipt'};
  else response={errcode:40004};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 store.run("INSERT INTO users VALUES('u','owner','Owner','active')");
 store.run("INSERT INTO workspaces VALUES('w','Fixture','u','active'),('other','Other','u','active')");
 store.run("INSERT INTO members(id,workspace_id,user_id,role,status) VALUES('m','w','u','owner','active'),('om','other','u','owner','active')");
 store.run("INSERT INTO entities(id,workspace_id,name,owner_member_id,created_by_member_id,own_web_use,web_use_user_id,interaction_runtime) VALUES('e','w','Employee','m','m',1,'u','builtin-interaction'),('e2','w','Second','m','m',1,'u','builtin-interaction'),('oe','other','Other','om','om',1,'u','builtin-interaction')");
 const options={masterKey:Buffer.alloc(32,7),now:()=>now,diagnostics:{event:event=>state.diagnostics.push(event)},fetch:(url,init)=>{
  const parsed=new URL(url);
  assert.ok(['https://api.dingtalk.com','https://oapi.dingtalk.com','https://qyapi.weixin.qq.com','https://open.feishu.cn'].includes(parsed.origin));
  return fetch('http://127.0.0.1:'+http.address().port+parsed.pathname+parsed.search,init);
 }};
 const repository=new EmployeeChannelRepository(store),channels=new EmployeeChannelService(repository,options);
 // Onboarding admission consults only pre-existing local directory facts, never the channel HTTP fixture.
 channels.setDirectorySnapshots({directory:connectionId=>({
  getUser:async id=>{const c=repository.byId(connectionId);if(!c||c.provider==='wecom'||!['member','other'].includes(id.id))throw Error('snapshot_user_missing');return{id,displayName:'Fixture Member',status:'active',aliases:[],departmentIds:c.provider==='dingtalk'?['1']:[],departmentMembershipsKnown:true,primaryDepartmentId:{status:'unknown'},directManager:{status:'unknown'},dottedLineManagers:{status:'unknown'}};},
  getDepartment:async id=>({id,namespace:'department_id',displayName:'Engineering',parentId:{status:'known',value:null},leaders:{status:'unknown'}})
 })});
 const capabilities=new CapabilityConfigService(store,[],channels,undefined,undefined,undefined,()=>now);
 channels.setAccessCheck((...args)=>capabilities.authorizeChannel(...args));
 const transport=ingressFixture(),inbox=new SqliteMessageLoopRepository(store,()=>now);
 const loop=new ChannelMessageLoop(inbox,channels,{}, {},()=>now);
 const supervisor=new ChannelIngressSupervisor(channels,loop,transport.factory,()=>now);
 await supervisor.start();
 const app=Fastify();
 await registerEmployeeChannelRoutes(app,channels,{requireManager:request=>{if(request.headers['x-test-manager']==='no')throw Object.assign(Error('forbidden'),{statusCode:403});return'u';}});
 registerHumanConfiguration(app,store,channels,()=>{},capabilities);
 const drafts=new EmployeeChannelCreationDrafts(channels,options);
 t.after(async()=>{for(const close of cleanup)await close();drafts.close();capabilities.close();await supervisor.stop();inbox.close();await app.close();await new Promise(resolve=>http.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
 const save=(provider,appId=provider+'-app',entity='e',workspace='w',appSecret='fixture-secret')=>channels.save(workspace,entity,provider,'u',{appId,appSecret,expectedRevision:0});
 const search=(words=['member'])=>app.inject({method:'POST',url:path+'/channels/wecom/member-search',payload:{keywords:words}});
 const select=async(words=['member'])=>{const response=await search(words);assert.equal(response.statusCode,200,response.body);const c=repository.byProvider('w','e','wecom');for(const p of response.json().items){const selected=await app.inject({method:'POST',url:path+'/channels/wecom/member-selection',payload:{sourceId:c.sourceId,userId:p.externalId,selectionToken:p.selectionToken}});assert.equal(selected.statusCode,200,selected.body);}return response;};
 const rule=(c,id='member',kind='channel_user')=>({sourceId:c.sourceId,kind,subjectId:channelSubject(kind,id,kind==='department'?'department_id':'user_id',c.appId),conversationKinds:['private','group']});
 const policy=(c,allow=[rule(c)],deny=[])=>capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,allow,deny,mode:'allowlist',expectedRevision:capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision});
 const receive=async(c,event)=>{const live=await transport.current(c.id);return live.sink.onEvent(event);};
 const count=()=>store.one("SELECT count(*) n FROM channel_inbox WHERE lane<>'' AND status<>'rejected'").n;
 return {cleanup,store,state,repository,channels,capabilities,supervisor,transport,app,drafts,save,search,select,rule,policy,receive,count,advance:ms=>now+=ms};
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
  if(provider==='wecom')await f.select();
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
  ding('group',{conversationType:'2',isInAtList:false}),ding('self',{senderId:'ding-bot'}),
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
 const resumedInbox=new SqliteMessageLoopRepository(f.store,clock);
 const resumed=new ChannelIngressSupervisor(f.channels,new ChannelMessageLoop(resumedInbox,f.channels,{},{},clock),f.transport.factory,clock);
 f.cleanup.push(async()=>{await resumed.stop();resumedInbox.close();});await resumed.start();
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
 const candidate=(await f.search()).json().items[0];const second=await f.save('wecom','other-bot','e2');
 assert.throws(()=>f.channels.validateRules('w','e2',[f.rule(second)]),/invalid_member_search_candidate/);
 assert.throws(()=>f.channels.validateRules('other','oe',[f.rule(c)]),/directory_source_not_found/);
 f.advance(30*60_000);assert.throws(()=>f.channels.selectWeComMember('w','e',{sourceId:c.sourceId,userId:candidate.externalId,selectionToken:candidate.selectionToken}),/invalid_member_search_candidate/);
});
test('A01 bot search gates authorization until an authenticated exact match and deny wins',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.select(['member','other']);
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
 const f=await setup(t),c=await f.save('wecom');await f.select();f.policy(c);
 assert.equal((await f.app.inject(path+'/human-confirmation')).json().candidates.filter(i=>i.target.kind==='wecom_directory').length,0);
 await f.receive(c,wecom(c));
 const candidate=(await f.app.inject(path+'/human-confirmation')).json().candidates.find(i=>i.target.kind==='wecom_directory');
 assert.equal(candidate.target.directoryUserId,'member');
 assert.match(candidate.label,/Engineering/);
 const save=await f.app.inject({method:'PUT',url:path+'/human-confirmation',payload:{expectedVersion:0,rules:[{questionScope:'*',target:candidate.target}]}});
 assert.equal(save.statusCode,200,save.body);
 f.advance(600001);
 assert.deepEqual((await f.app.inject(path+'/human-confirmation')).json().candidates.find(i=>i.target.kind==='wecom_directory'),candidate);
 await f.channels.assertWeComPrivateRecipient(c.id,'member');
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'not-selected'),/authorization_denied/);
 const b=await f.channels.resolveBinding(c.id),actor={kind:'human',externalId:'member',idNamespace:'user_id',applicationId:c.appId,identityEvidence:'channel_verified'};
 assert.deepEqual(await f.channels.describeActor(b,actor),{displayName:'Fixture Member'});
 assert.deepEqual(await f.channels.describeActor(b,{...actor,externalId:'different'}),{});
 f.state.removed=true;const before=f.state.calls.length;await f.channels.assertWeComPrivateRecipient(c.id,'member');assert.equal(f.state.calls.length,before,'recipient identity checks are local; provider delivery owns account availability');
});
test('R01 upgrade retains existing identity, old challenge dedupe and Feishu behavior',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');
 f.repository.markVerificationEvent(c.id,'old-event','old-id');
 assert.equal(await f.receive(c,ding('old-id')),'duplicate');assert.equal(f.repository.byId(c.id).status,'pending_verification');
 await f.receive(c,ding());const existing=f.repository.byId(c.id);
 assert.equal(existing.botId,'different-from-client');assert.equal(existing.robotCode,'different-from-client');
 assert.equal(f.channels.list('w','e').find(item=>item.id===c.id).inboundVerified,true);
 const feishu=await f.save('feishu');assert.equal(feishu.status,'verified');assert.equal(feishu.botId,'feishu-bot');
 assert.equal(feishu.identityEvidence,'provider_api');
});

function change(f,c,mode,extra={}){return f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode,expectedRevision:f.capabilities.getDirectoryAccess('w','e').channelPolicies.find(p=>p.sourceId===c.sourceId).revision,...extra});}
function request(c,id='member'){return {workspaceId:'w',entityId:'e',requesterKind:'channel_user',requesterId:id,requesterIdentity:{idNamespace:'user_id',applicationId:c.appId},conversationKind:'private'};}
const packageInput={name:'Fixture package',enabled:true,mode:'inherit',userPolicyMode:'inherit',allowMemberIds:[],denyMemberIds:[],resourceIds:[]};
test('P01 all and empty denylist need no search while nonempty lists fail closed until mapped',async t=>{
 const f=await setup(t),c=await f.save('wecom');
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies[0].mode,'denylist');
 assert.equal(f.capabilities.getDirectoryAccess('w','e').channelPolicies[0].allowGroupMembers,true);
 change(f,c,'all');
 assert.equal(await f.receive(c,wecom(c,'first',{from:{userid:'external-or-unknown'}})),'accepted');
 assert.equal(f.state.calls.some(c=>c.route.includes('/cli/')),false);
 assert.equal(f.repository.byId(c.id).wecomContactIdentityRevision,undefined);
 change(f,c,'allowlist',{allow:[]});await f.receive(c,wecom(c,'empty-allow'));assert.equal(f.count(),1);
 change(f,c,'denylist',{deny:[]});assert.equal(await f.receive(c,wecom(c,'unmapped-empty-deny')),'accepted');assert.equal(f.count(),2);
 assert.equal(f.state.calls.some(c=>c.route.includes('/cli/')),false);
 await f.select();change(f,c,'denylist',{deny:[f.rule(c)]});
 await f.receive(c,wecom(c,'unmapped-nonempty-deny',{from:{userid:'stranger'}}));assert.equal(f.count(),2);
 change(f,c,'denylist',{deny:[]});
 await f.select();assert.equal(await f.receive(c,wecom(c,'mapped-deny')),'accepted');
 change(f,c,'allowlist');await f.receive(c,wecom(c,'mapped-empty-allow'));assert.equal(f.count(),3);
});
test('P02 source revisions, dormant lists, expiry and package intersection',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.select(['member','other']);f.policy(c,[f.rule(c)],[f.rule(c,'other')]);
 await f.receive(c,wecom(c,'denied-person-evidence',{from:{userid:'other'}}));
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
 await f.select();
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:{allow:[],deny:[f.rule(c)]}},pkg.id);
 assert.equal((await f.capabilities.executionPackages(request(c,'stranger'),b.connection,'private')).length,0);
 f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:{allow:[],deny:[]}},pkg.id);
 assert.equal((await f.capabilities.executionPackages(request(c),b.connection,'private')).length,0);
 f.capabilities.save('w','e',packageInput,pkg.id);assert.equal((await f.capabilities.executionPackages(request(c),b.connection,'private')).length,1);
});
test('P04 saved lists survive candidate eviction and PUT keeps other provider policy independent',async t=>{
 const f=await setup(t),c=await f.save('wecom'),d=await f.save('dingtalk');await f.select();
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
 assert.deepEqual({mode:policy().mode,allow:policy().allow,deny:policy().deny,group:policy().allowGroupMembers},{mode:'denylist',allow:[],deny:[],group:true});
 f.capabilities.patchDirectoryAccess('w','e',{sourceId:c.sourceId,mode:'allowlist',expectedRevision:policy().revision});
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
 if(provider==='wecom'){await f.select();await f.receive(c,wecom(c,'mapped',{chattype:'group',chatid:'room'}));}
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

test('Feishu real HTTP application verification pins bot.open_id before first live event fills missing tenant_key',async t=>{
 const f=await setup(t);f.state.feishuTenantKey=false;const c=await f.save('feishu');assert.equal(c.status,'pending_verification');assert.equal(c.botId,'feishu-bot');assert.equal(c.tenantId,'display');assert.equal(c.tenantIdNamespace,'display_id');assert.ok(f.state.calls.some(c=>c.route==='/open-apis/bot/v3/info'));
 f.policy(c,[{sourceId:c.sourceId,kind:'channel_user',subjectId:channelSubject('channel_user','member','open_id',c.appId),conversationKinds:['private','group']}]);const live=await f.transport.current(c.id),before=f.repository.byId(c.id);
 const raw={schema:'2.0',header:{event_id:'first-feishu-event',event_type:'im.message.receive_v1',app_id:c.appId,tenant_key:'feishu-tenant'},event:{sender:{sender_id:{open_id:'member'},sender_type:'user',tenant_key:'feishu-tenant'},message:{message_id:'first-feishu-message',chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:'1800000000000',content:JSON.stringify({text:'Fixture request'}),mentions:[]}}};
 assert.equal(await live.sink.onEvent(raw),'accepted');assert.equal(await live.sink.onEvent(raw),'duplicate');assert.equal(f.count(),1);const after=f.repository.byId(c.id);assert.equal(after.eventTenantId,'feishu-tenant');assert.equal(after.botId,'feishu-bot');assert.equal(after.status,'verified');assert.equal(after.identityEvidence,'authenticated_first_message');assert.equal(after.revision,before.revision);assert.equal(after.authRevision,before.authRevision);assert.equal(after.stateVersion,before.stateVersion+1);assert.deepEqual(after.identity,before.identity);assert.equal((await f.transport.current(c.id)).session.generation,live.session.generation);
});

for(const first of ['private','group-one','group-two'])test('DingTalk six sender/conversation combinations bind one robot when first is '+first,async t=>{
 const f=await setup(t),c=await f.save('dingtalk');f.policy(c,[f.rule(c,'member'),f.rule(c,'other')]);
 const kinds=[first,...['private','group-one','group-two'].filter(kind=>kind!==first)],versions=new Set(),directoryVersion=f.channels.directorySource(c.id).sourceVersion;
 for(const kind of kinds)for(const senderStaffId of ['member','other']){
  const group=kind!=='private',messageId=kind+'-'+senderStaffId;
  const patch={chatbotUserId:kind+'-bot',conversationType:group?'2':'1',conversationId:group?kind:'private-'+senderStaffId,isInAtList:group?true:undefined,senderStaffId,senderId:'opaque-'+senderStaffId};
  const raw=ding(messageId,patch);assert.equal(await f.receive(c,raw),'accepted');
  const bound=f.repository.byId(c.id);assert.equal(bound.botId,'different-from-client');assert.equal(bound.robotCode,'different-from-client');assert.equal(bound.eventTenantId,'ding-corp');assert.equal(bound.sourceId,c.sourceId);
  versions.add(f.channels.currentBindingVersion(c.id));assert.equal(f.channels.directorySource(c.id).sourceVersion,directoryVersion,'learning the robot does not invalidate app-scoped staff directory evidence');
  raw.headers.messageId='retry-'+messageId;assert.equal(await f.receive(c,raw),'duplicate');
 }
 assert.equal(versions.size,1);assert.equal(f.count(),6);
 assert.equal(f.store.one('SELECT count(DISTINCT lane) n FROM channel_inbox').n,4,'two private and two shared group lanes');
 assert.equal(f.store.one("SELECT count(*) n FROM employee_channel_audit WHERE action='first_inbound_confirmed'").n,1);
 const before=f.repository.byId(c.id),version=f.channels.currentBindingVersion(c.id),oldLive=await f.transport.current(c.id);
 await f.channels.revalidate('w','e','dingtalk','u',before.revision);
 assert.equal(await f.receive(c,ding('after-revalidation',{conversationType:'2',conversationId:'group-two',isInAtList:true,chatbotUserId:'different-group-account'})),'accepted');
 assert.equal(f.channels.currentBindingVersion(c.id),version);assert.equal(f.repository.byId(c.id).sourceId,c.sourceId);
 await assert.rejects(oldLive.sink.onEvent(ding('old-runner')),/generation_expired|owner_lost/);
});

for(const legacyStatus of ['verified','pending_verification'])test('legacy DingTalk '+legacyStatus+' callback-scoped records remain unchanged and blocked until explicit revalidation',async t=>{
 const f=await setup(t),c=await f.save('dingtalk');f.policy(c);await f.receive(c,ding());
 const record=f.repository.byId(c.id);f.repository.save({...record,botId:'legacy-private-account',status:legacyStatus},record);
 const before=f.repository.byId(c.id);assert.equal(f.channels.currentBindingVersion(c.id),undefined);assert.equal(await f.channels.resolveBinding(c.id),undefined);assert.equal(f.channels.ingressConfiguration(c.id),undefined);
 const dto=f.channels.list('w','e')[0];assert.equal(dto.status,'invalid');assert.equal(dto.lastError,'channel_identity_revalidation_required');assert.equal(dto.botId,'different-from-client');assert.equal(dto.capabilities.groupMentions.availability,'authorization_required');assert.deepEqual(f.repository.byId(c.id),before);
 const next=await f.channels.revalidate('w','e','dingtalk','u',before.revision);assert.equal(next.status,'pending_verification');assert.equal(next.sourceId,c.sourceId);
 assert.equal(await f.receive(c,ding('new-after-explicit-revalidation',{chatbotUserId:'group-alias',conversationType:'2',isInAtList:true,conversationId:'group'})),'accepted');
 assert.equal(f.repository.byId(c.id).botId,'different-from-client');assert.equal(f.count(),2,'no previous inbox was deleted');
});


test('WeCom exact evidence is per person: another match cannot clear an unresolved deny or notification target',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.select(['member','other']);
 change(f,c,'all',{deny:[f.rule(c,'other')]});
 await f.receive(c,wecom(c,'known-member'));assert.equal(f.count(),0);
 assert.deepEqual(f.repository.byId(c.id).wecomVerifiedContactIds,['member']);
 const binding=await f.channels.resolveBinding(c.id);
 assert.equal(await f.channels.matches('w',f.rule(c,'other'),request(c),binding.connection,'private'),'unknown');
 assert.equal(await f.capabilities.authorizeChannel(request(c),binding.connection,'private'),false);
 const group={...request(c),conversationKind:'group',groupContext:{conversationId:'room',bindingVersion:binding.bindingVersion}};
 assert.equal(await f.capabilities.authorizeChannel(group,binding.connection,'group'),false);
 await f.receive(c,wecom(c,'opaque-other',{from:{userid:'different-callback-id'}}));assert.equal(f.count(),0);
 const candidates=(await f.app.inject(path+'/human-confirmation')).json().candidates.filter(x=>x.target.kind==='wecom_directory');
 assert.deepEqual(candidates.filter(x=>x.identityVerified).map(x=>x.target.directoryUserId),['member']);
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'other'),/authorization_denied/);
 assert.deepEqual(await f.channels.describeActor(binding,{kind:'human',externalId:'other',idNamespace:'user_id',applicationId:c.appId,identityEvidence:'channel_verified'}),{});
 // Only the blocked member's own authenticated exact-ID event resolves that deny.
 await f.receive(c,wecom(c,'verified-other',{from:{userid:'other'}}));assert.equal(f.count(),0);
 assert.equal(await f.capabilities.authorizeChannel(request(c),binding.connection,'private'),true);
 assert.equal(await f.capabilities.authorizeChannel(request(c,'other'),binding.connection,'private'),false);
 assert.equal(await f.channels.matches('w',f.rule(c,'other'),request(c),binding.connection,'private'),false);
});
test('WeCom legacy global identity flag never grants a member and package deny remains fail closed',async t=>{
 const f=await setup(t),c=await f.save('wecom');await f.select(['member','other']);change(f,c,'all');
 assert.equal(await f.receive(c,wecom(c,'legacy')),'accepted');
 const current=f.repository.byId(c.id),{wecomVerifiedContactIds:_ids,...legacy}=current;
 // This fixture models a legacy global flag without relational identity evidence.
 f.store.run('DELETE FROM wecom_identity_bindings WHERE connection_id=?',c.id);
 f.repository.save({...legacy,wecomContactIdentityRevision:c.authRevision},current);
 const binding=await f.channels.resolveBinding(c.id);
 assert.equal(await f.channels.matches('w',f.rule(c),request(c),binding.connection,'private'),'unknown');
 await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'member'),/authorization_denied/);
 assert.deepEqual((await f.app.inject(path+'/human-confirmation')).json().candidates.filter(x=>x.target.kind==='wecom_directory'&&x.identityVerified),[]);
 // Re-establish one person's evidence; a different package blacklist is unresolved.
 await f.receive(c,wecom(c,'again'));
 const pack=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:{allow:[],deny:[f.rule(c,'other')]}});
 assert.equal(await f.capabilities.authorizeChannel(request(c),binding.connection,'private'),true);
 assert.deepEqual(await f.capabilities.usableChannel(request(c),binding.connection,'private'),[]);
 const next=await f.channels.revalidate('w','e','wecom','u',c.revision);
 assert.deepEqual(f.repository.byId(c.id).wecomVerifiedContactIds,['member']);
 assert.equal(next.memberSearchIdentityVerified,false);
});


const memberVerificationPath=path+'/channels/wecom/member-verification';
const verificationSendCalls=f=>f.state.calls.filter(c=>c.route==='/cli/message/aibot/send');
const startMemberVerification=(f,c,userId='member',requestId=randomUUID())=>f.app.inject({method:'POST',url:memberVerificationPath,payload:{userId,sourceId:c.sourceId,requestId}});
const memberVerificationStatus=(f,c,userId='member')=>f.app.inject(memberVerificationPath+'?'+new URLSearchParams({userId,sourceId:c.sourceId}));
async function prepareMemberVerification(t){const f=await setup(t),c=await f.save('wecom');await f.select(['member','other']);f.policy(c);await f.receive(c,wecom(c,'callback-initial',{from:{userid:'callback-member'}}));return {f,c};}
test('WeCom administrator-relay challenge binds different IDs for whitelist, blacklist, package, human target and private recipient',async t=>{
 const {f,c}=await prepareMemberVerification(t);
 const sent=await startMemberVerification(f,c);assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().status,'pending');
 const phrase=sent.json().phrase;assert.match(phrase,/^[0-9]{6}$/);assert.equal(sent.headers['cache-control'],'no-store');assert.equal(verificationSendCalls(f).length,0);
 assert.equal(f.count(),0);assert.equal((await memberVerificationStatus(f,c)).json().status,'pending');
 assert.equal(await f.receive(c,wecom(c,'verified-challenge',{from:{userid:'callback-member'},text:{content:phrase}})),'accepted');
 assert.equal(f.count(),0,'control reply never enters the model/business inbox');assert.equal(JSON.stringify(f.state.diagnostics).includes(phrase),false,'the challenge is absent from diagnostic text');
 assert.equal((await memberVerificationStatus(f,c)).json().status,'verified');
 const r=f.repository.byId(c.id);assert.equal(JSON.stringify(r).includes(phrase),false);assert.equal(r.wecomContactMappings[0].userId,'member');assert.equal(r.wecomContactMappings[0].callbackUserId,'callback-member');
 const b=await f.channels.resolveBinding(c.id),scope=request(c,'callback-member');
 assert.equal(await f.capabilities.authorizeChannel(scope,b.connection,'private'),true);
 assert.equal(await f.capabilities.authorizeChannel(request(c,'member'),b.connection,'private'),false);
 assert.equal(await f.receive(c,wecom(c,'after-challenge',{from:{userid:'callback-member'}})),'accepted');assert.equal(f.count(),1);
 let pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'allowlist',directoryAccess:{allow:[f.rule(c)],deny:[]}});
 assert.deepEqual((await f.capabilities.usableChannel(scope,b.connection,'private')).map(p=>p.id),[pkg.id]);
 pkg=f.capabilities.save('w','e',{...packageInput,userPolicyMode:'denylist',directoryAccess:{allow:[],deny:[f.rule(c)]}},pkg.id);
 assert.deepEqual(await f.capabilities.usableChannel(scope,b.connection,'private'),[]);
 const candidate=(await f.app.inject(path+'/human-confirmation')).json().candidates.find(x=>x.target.kind==='wecom_directory');assert.equal(candidate.target.directoryUserId,'member');assert.equal(candidate.directorySubjectId,f.rule(c).subjectId);
 const saved=await f.app.inject({method:'PUT',url:path+'/human-confirmation',payload:{expectedVersion:0,rules:[{questionScope:'*',target:candidate.target}]}});assert.equal(saved.statusCode,200,saved.body);
 await f.channels.assertWeComPrivateRecipient(c.id,'callback-member');await assert.rejects(f.channels.assertWeComPrivateRecipient(c.id,'member'),/authorization_denied/);
 assert.deepEqual(await f.channels.describeActor(b,{kind:'human',externalId:'callback-member',idNamespace:'user_id',applicationId:c.appId,identityEvidence:'channel_verified'}),{displayName:'Fixture Member'});
 change(f,c,'denylist',{deny:[f.rule(c)]});assert.equal(await f.capabilities.authorizeChannel(scope,b.connection,'private'),false);
 assert.equal(await f.capabilities.authorizeChannel({...scope,conversationKind:'group',groupContext:{conversationId:'room',bindingVersion:b.bindingVersion}},b.connection,'group'),false);
});
test('WeCom binds only fresh same-bot private codes while group codes follow existing permission',async t=>{
 const {f,c}=await prepareMemberVerification(t);const phrase=(await startMemberVerification(f,c)).json().phrase;
 await f.receive(c,wecom(c,'wrong-token',{from:{userid:'callback-member'},text:{content:phrase==='000000'?'999999':'000000'}}));
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'group-token',{from:{userid:'callback-member'},chattype:'group',chatid:'room',text:{content:phrase}}));
 assert.equal(f.count(),1,'the group message follows the existing allowed group policy, without binding');assert.equal((await memberVerificationStatus(f,c)).json().status,'pending');
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'right-token',{from:{userid:'callback-member'},text:{content:phrase}}));
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'replayed-by-other',{from:{userid:'attacker'},text:{content:phrase}}));
 assert.deepEqual(f.repository.byId(c.id).wecomContactMappings.map(m=>m.callbackUserId),['callback-member']);assert.equal(f.count(),1,'known private verification traffic does not add business messages');
 const secondPhrase=(await startMemberVerification(f,c,'other')).json().phrase;
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'callback-conflict',{from:{userid:'callback-member'},text:{content:secondPhrase}}));
 assert.equal((await memberVerificationStatus(f,c,'other')).json().status,'failed');assert.equal(f.repository.byId(c.id).wecomContactMappings.length,1);
 const second=await f.save('wecom','other-bot','e2');await f.receive(second,wecom(second,'cross-bot',{from:{userid:'callback-member'},text:{content:phrase}}));
 assert.equal(f.repository.byId(second.id).wecomContactMappings,undefined);
});
test('WeCom administrator code is one-time, never sent, and explicit regeneration invalidates its predecessor',async t=>{
 const {f,c}=await prepareMemberVerification(t),id=randomUUID();
 const first=await startMemberVerification(f,c,'member',id),phrase=first.json().phrase;
 assert.equal(first.json().status,'pending');assert.match(phrase,/^[0-9]{6}$/);
 const repeated=await startMemberVerification(f,c,'member',id);assert.equal(repeated.json().phrase,phrase);assert.equal(repeated.json().status,'pending');
 f.advance(30_001);await f.supervisor.tick();const next=await f.app.inject({method:'POST',url:memberVerificationPath,payload:{userId:'member',sourceId:c.sourceId,requestId:randomUUID(),replace:true}}),nextPhrase=next.json().phrase;assert.notEqual(phrase,nextPhrase);
 await f.receive(c,wecom(c,'replaced-code',{from:{userid:'wrong-person'},text:{content:phrase}}));assert.equal(f.repository.byId(c.id).wecomContactMappings,undefined);
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'current-code',{from:{userid:'callback-member'},text:{content:nextPhrase}}));
 assert.equal((await memberVerificationStatus(f,c)).json().status,'verified');assert.equal(verificationSendCalls(f).length,0);
 assert.equal(f.state.calls.some(c=>c.route.includes('/message/')),false);
 assert.equal(JSON.stringify(f.repository.byId(c.id)).includes(nextPhrase),false);
});
test('WeCom code rejects expired, replaced-credential and missing receiver cases without requiring a provider session',async t=>{
 const {f,c}=await prepareMemberVerification(t);const phrase=(await startMemberVerification(f,c)).json().phrase;f.advance(86400001);await f.supervisor.tick();
 await f.receive(c,wecom(c,'expired-token',{from:{userid:'callback-member'},text:{content:phrase}}));assert.equal((await memberVerificationStatus(f,c)).json().status,'expired');assert.equal(f.repository.byId(c.id).wecomContactMappings,undefined);
 const currentPhrase=(await startMemberVerification(f,c)).json().phrase;await f.channels.revalidate('w','e','wecom','u',c.revision);
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'rotated-token',{from:{userid:'callback-member'},text:{content:currentPhrase}}));assert.equal(f.repository.byId(c.id).wecomContactMappings,undefined);
 await f.receive(c,wecom(c,'normal-after-rotation',{from:{userid:'callback-member'}}));await f.select();f.state.sessionRows=[];
 let response=await startMemberVerification(f,c);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,'pending');
 f.channels.setMemberVerificationReceiver(async()=>false);f.advance(30_001);await f.supervisor.tick();
 response=await f.app.inject({method:'POST',url:memberVerificationPath,payload:{userId:'member',sourceId:c.sourceId,requestId:randomUUID(),replace:true}});assert.equal(response.statusCode,409);assert.equal(response.json().error,'member_verification_receiver_not_ready');assert.equal(verificationSendCalls(f).length,0);
});
test('WeCom code requires manager auth, current source and a real selected search candidate',async t=>{
 const {f,c}=await prepareMemberVerification(t),payload={userId:'member',sourceId:c.sourceId,requestId:randomUUID()};
 let r=await f.app.inject({method:'POST',url:memberVerificationPath,headers:{'x-test-manager':'no'},payload});assert.equal(r.statusCode,403);
 r=await f.app.inject({method:'POST',url:memberVerificationPath,payload:{...payload,userId:'fabricated'}});assert.equal(r.statusCode,400);
 r=await f.app.inject({method:'POST',url:memberVerificationPath,payload:{...payload,sourceId:'wrong'}});assert.equal(r.statusCode,400);
 const issued=await startMemberVerification(f,c,'member',payload.requestId);assert.equal(issued.statusCode,200);
 r=await startMemberVerification(f,c,'other',payload.requestId);assert.equal(r.statusCode,409);
 const status=await memberVerificationStatus(f,c);assert.match(status.json().phrase,/^[0-9]{6}$/);assert.equal(status.headers['cache-control'],'no-store');
});

test('WeCom quoted and mixed codes cannot bypass private permission while a prefixed known code verifies',async t=>{
 const {f,c}=await prepareMemberVerification(t);const phrase=(await startMemberVerification(f,c)).json().phrase;
 const notification='请在机器人私聊发送：'+phrase;
 for(const [index,patch]of [{text:{content:'收到'},quote:{msgtype:'text',text:{content:notification}}},{msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'核验 '+phrase}}]}}].entries()){
  await f.receive(c,wecom(c,'embedded-'+index,{from:{userid:'callback-member'},...patch}));
  assert.equal((await memberVerificationStatus(f,c)).json().status,'pending');
 }
 assert.equal(f.count(),0);assert.equal(JSON.stringify(f.state.diagnostics).includes(phrase),false);
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'pure-control',{from:{userid:'callback-member'},text:{content:'验证码给你 '+phrase}}));assert.equal((await memberVerificationStatus(f,c)).json().status,'verified');
});
test('WeCom independent people may verify concurrently without overwriting or cross-binding',async t=>{
 const {f,c}=await prepareMemberVerification(t);
 const [one,two]=await Promise.all([startMemberVerification(f,c),startMemberVerification(f,c,'other')]);
 assert.equal(one.statusCode,200,one.body);assert.equal(two.statusCode,200,two.body);
 assert.notEqual(one.json().phrase,two.json().phrase);assert.equal(verificationSendCalls(f).length,0);
 await f.receive(c,wecom(c,'second-first',{from:{userid:'callback-other'},text:{content:two.json().phrase}}));
 f.advance(11_000);await f.supervisor.tick();await f.receive(c,wecom(c,'first-second',{from:{userid:'callback-member'},text:{content:one.json().phrase}}));
 assert.deepEqual(f.repository.byId(c.id).wecomContactMappings.map(m=>[m.userId,m.callbackUserId]).sort(),[['member','callback-member'],['other','callback-other']]);
 assert.equal(f.count(),0);
});
