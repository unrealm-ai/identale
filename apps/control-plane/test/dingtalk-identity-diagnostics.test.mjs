import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelError,diagnosticFailure,dingtalkIdentityErrors,dingtalkIdentityFields,safeDingtalkIdentityDiagnostic} from '@dentity/application';
import {normalizeChannelIngressEvent as normalize} from '../dist/adapters/channels/ingress/normalize.js';
import {dingtalkIdentityDiagnostic as diagnose} from '../dist/adapters/channels/ingress/identity-diagnostics.js';
import {FileDiagnostics} from '../dist/adapters/diagnostics.js';

const sensitive={app:'PRIVATE_DING_APP',bot:'PRIVATE_DING_BOT',corp:'PRIVATE_DING_CORP',robot:'PRIVATE_DING_ROBOT',staff:'PRIVATE_DING_STAFF',sender:'PRIVATE_DING_ENCRYPTED_SENDER',message:'PRIVATE_DING_MESSAGE',event:'PRIVATE_DING_EVENT',chat:'PRIVATE_DING_CHAT',body:'PRIVATE_DING_BODY',webhook:'https://fixture.invalid/PRIVATE_DING_WEBHOOK',token:'PRIVATE_DING_TOKEN',secret:'PRIVATE_DING_SECRET'};
const session={provider:'dingtalk',connectionId:'conn',appId:sensitive.app,generation:'gen',revision:1,authRevision:1};
const hints={botId:sensitive.bot,tenantId:sensitive.corp,tenantNamespace:'corp_id',robotCode:sensitive.robot};
// Same synthetic CALLBACK shape as ingress-normalize.test.mjs; no provider calls.
function ding(change={}){return{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:sensitive.event},data:JSON.stringify({msgId:sensitive.message,chatbotCorpId:sensitive.corp,chatbotUserId:sensitive.bot,robotCode:sensitive.robot,senderCorpId:sensitive.corp,senderStaffId:sensitive.staff,senderId:sensitive.sender,conversationType:'2',conversationId:sensitive.chat,msgtype:'text',text:{content:sensitive.body},createAt:123,isInAtList:true,appId:sensitive.app,appKey:sensitive.app,sessionWebhook:sensitive.webhook,token:sensitive.token,Secret:sensitive.secret,...change})};}
const cases=[
 ['ingress_bot_mismatch','forbidden',()=>[ding({chatbotUserId:'PRIVATE_OTHER_BOT'}),hints],'chatbotUserId','mismatch'],
 ['ingress_robot_mismatch','forbidden',()=>[ding({robotCode:'PRIVATE_OTHER_ROBOT'}),hints],'robotCode','mismatch'],
 ['ingress_tenant_mismatch','forbidden',()=>[ding({chatbotCorpId:'PRIVATE_OTHER_CORP'}),hints],'chatbotCorpId','mismatch'],
 ['ingress_tenant_namespace_mismatch','forbidden',()=>[ding(),{...hints,tenantNamespace:'tenant_key'}],'tenantNamespace','mismatch'],
 ['ingress_app_mismatch','forbidden',()=>[ding({appId:'PRIVATE_OTHER_APP'}),hints],'appId','mismatch'],
 ['ingress_app_mismatch','forbidden',()=>[ding({appKey:'PRIVATE_OTHER_KEY'}),hints],'appKey','mismatch'],
 ['ingress_sender_tenant_mismatch','forbidden',()=>[ding({senderCorpId:'PRIVATE_OTHER_SENDER_CORP'}),hints],'senderCorpId','mismatch'],
 ['ingress_sender_identity_invalid','unauthenticated',()=>[ding({senderStaffId:undefined}),hints],'senderStaffId','missing'],
 ['invalid_ingress_object','invalid_request',()=>[[],hints]],
 ['invalid_ingress_id','invalid_request',()=>[ding({chatbotUserId:undefined}),hints],'chatbotUserId','missing'],
 ['invalid_ingress_id','invalid_request',()=>[ding({robotCode:'PRIVATE_BAD\nROBOT'}),hints],'robotCode','invalid'],
 ['invalid_ingress_id','invalid_request',()=>[ding({senderCorpId:null}),hints],'senderCorpId','missing'],
 ['invalid_ingress_id','invalid_request',()=>[ding({senderStaffId:17}),hints],'senderStaffId','invalid'],
 ['invalid_ingress_timestamp','invalid_request',()=>[ding({createAt:'PRIVATE_BAD_TIME'}),hints]],
 ['invalid_ingress_text','invalid_request',()=>[ding({text:{content:{secret:sensitive.secret}}}),hints]],
 ['invalid_ingress_json','invalid_request',()=>[{...ding(),data:'PRIVATE_INVALID_JSON'},hints]],
 ['invalid_ingress_mentions','invalid_request',()=>[ding({isInAtList:sensitive.token}),hints]],
 ['ingress_too_large','invalid_request',()=>[ding({text:{content:sensitive.body.repeat(100000)}}),hints]],
 ['unsupported_dingtalk_frame','invalid_request',()=>[{...ding(),type:'EVENT'},hints]],
 ['unsupported_dingtalk_topic','invalid_request',()=>[{...ding(),headers:{topic:'PRIVATE_OTHER_TOPIC',messageId:sensitive.event}},hints]],
 ['unsupported_conversation_kind','invalid_request',()=>[ding({conversationType:'PRIVATE_OTHER_KIND'}),hints]],
];
function failure(raw,bound){let error;try{normalize(session,raw,bound,1000);}catch(e){error=e;}assert.ok(error instanceof ChannelError);return error;}
function clean(value){const serialized=JSON.stringify(value);assert.equal(serialized.includes('PRIVATE_'),false);for(const value of Object.values(sensitive))assert.equal(serialized.includes(value),false);}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'identity-dingtalk-diagnostic-')),log=new FileDiagnostics(dir,{warn:()=>{}});t.after(async()=>{await log.close();await rm(dir,{recursive:true,force:true});});return{log,async rows(){await log.flush();const serialized=(await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.jsonl')).sort().map(n=>readFile(join(dir,n),'utf8')))).join('');clean(serialized);return serialized.trim()?serialized.trim().split('\n').map(JSON.parse):[];}};}
const failureEvent=ingressIdentity=>({stage:'ingress.received',phase:'point',outcome:'failure',status:'failed',reason:'identity_invalid',ingressIdentity});

test('every fixed DingTalk normalization failure survives the file whitelist without private payloads',async t=>{
 const f=await fixture(t),expected=[];
 for(const [reason,code,make,field,state]of cases){
  const [raw,bound]=make(),before=JSON.stringify(raw),error=failure(raw,bound);
  assert.equal(error.message,reason);assert.equal(error.code,code);
  const diagnostic=diagnose(session,raw,bound,error);assert.equal(diagnostic.error,reason);assert.equal(diagnostic.channel,'dingtalk');
  if(field)assert.equal(diagnostic.fields[field],state);clean(diagnostic);assert.equal(JSON.stringify(raw),before);
  // Running the observation does not repair, relax or mutate the rejected input.
  assert.equal(failure(raw,bound).message,reason);
  f.log.event({...failureEvent(diagnostic),...diagnosticFailure(error)});expected.push(diagnostic);
 }
 const rows=await f.rows();assert.equal(rows.length,cases.length);assert.deepEqual(rows.map(row=>row.ingressIdentity),expected);
 assert.deepEqual(new Set(expected.map(d=>d.error)),new Set(dingtalkIdentityErrors.filter(reason=>reason!=='unknown')));
 for(const row of rows){assert.equal(row.text,undefined);assert.equal(row.json,undefined);assert.equal(row.error,undefined);}
 assert.equal(rows.find(row=>row.ingressIdentity.error==='ingress_sender_identity_invalid').category,'authentication');
 assert.equal(rows.find(row=>row.ingressIdentity.error==='ingress_bot_mismatch').category,'permission');
});

test('group/private, mentioned/missing/invalid, comparisons and optional fields have explicit meanings',()=>{
 const error=new ChannelError('forbidden','ingress_bot_mismatch');
 const good=diagnose(session,ding(),hints,error);assert.equal(good.conversationKind,'group');assert.equal(good.mentioned,'yes');
 assert.deepEqual(good.fields,{chatbotUserId:'match',robotCode:'match',chatbotCorpId:'match',appId:'match',appKey:'match',senderCorpId:'match',senderStaffId:'present',tenantNamespace:'match',eventId:'present',messageId:'present',conversationId:'present'});
 for(const [mentioned,expected]of [[true,'yes'],[false,'no'],[undefined,'unknown'],['PRIVATE_INVALID','invalid']])for(const [kind,expectedKind]of [['1','private'],['2','group'],['PRIVATE_INVALID','unknown']]){const d=diagnose(session,ding({isInAtList:mentioned,conversationType:kind}),hints,error);assert.equal(d.mentioned,expected);assert.equal(d.conversationKind,expectedKind);clean(d);}
 const absent=diagnose(session,ding({appId:undefined,appKey:undefined}),{},error);assert.equal(absent.fields.chatbotUserId,'unknown');assert.equal(absent.fields.robotCode,'unknown');assert.equal(absent.fields.chatbotCorpId,'unknown');assert.equal(absent.fields.tenantNamespace,'missing');assert.equal(absent.fields.appId,'missing');assert.equal(absent.fields.appKey,'missing');
 assert.equal(diagnose(session,ding(),{...hints,tenantNamespace:'app_id',tenantId:session.appId},error).fields.chatbotCorpId,'unknown');
 assert.equal(diagnose(session,ding({senderStaffId:''}),hints,error).fields.senderStaffId,'missing');
});

test('unknown exception text and malformed or throwing data never escape the observer',()=>{
 for(const error of [new Error(sensitive.token),new ChannelError('forbidden',sensitive.body),{message:'ingress_bot_mismatch'},null]){const d=diagnose(session,ding(),hints,error);assert.equal(d.error,'unknown');clean(d);}
 for(const raw of [null,[],{data:[]},{data:'[]'},{data:'PRIVATE_INVALID_JSON'},{data:'x'.repeat(1024*1024+1)},Object.defineProperty({},'data',{get(){throw Error(sensitive.secret);}})]){const d=diagnose(session,raw,hints,new Error(sensitive.body));assert.equal(d.error,'unknown');clean(d);}
 const error=Object.defineProperty(new ChannelError('forbidden','ingress_bot_mismatch'),'message',{get(){throw Error(sensitive.secret);}});assert.equal(diagnose(session,ding(),hints,error).error,'unknown');
 assert.equal(diagnose({...session,provider:'feishu'},ding(),hints,new Error(sensitive.secret)),undefined);
});

test('file sink reconstructs nested whitelist, bounds stage scope and strips accidental failure text/JSON',async t=>{
 const f=await fixture(t),valid=diagnose(session,ding(),hints,new ChannelError('forbidden','ingress_bot_mismatch'));
 const untrusted={...valid,botId:sensitive.bot,raw:ding(),fields:{...valid.fields,sessionWebhook:sensitive.webhook}};
 assert.deepEqual(safeDingtalkIdentityDiagnostic(untrusted),valid);
 f.log.event({...failureEvent(untrusted),text:sensitive.body,json:ding(),messageKind:'receive',error:sensitive.secret});
 f.log.event({...failureEvent({...valid,error:sensitive.token}),text:sensitive.body,json:ding(),messageKind:'receive'});
 f.log.event({...failureEvent(valid),stage:'ingress'});
 const rows=await f.rows();assert.equal(rows.length,3);assert.deepEqual(rows[0].ingressIdentity,valid);assert.equal(rows[1].ingressIdentity,undefined);assert.equal(rows[2].ingressIdentity,undefined);
 for(const row of rows){assert.equal(row.text,undefined);assert.equal(row.json,undefined);assert.equal(row.messageKind,undefined);}
});

test('diagnostic validator rejects arbitrary enums and nested strings rather than persisting them',()=>{
 const valid=diagnose(session,ding(),hints,new ChannelError('forbidden','ingress_bot_mismatch'));
 for(const value of [null,[],{...valid,channel:sensitive.token},{...valid,error:sensitive.token},{...valid,conversationKind:sensitive.bot},{...valid,mentioned:sensitive.body},{...valid,fields:null},{...valid,fields:[]}])assert.equal(safeDingtalkIdentityDiagnostic(value),undefined);
 for(const key of dingtalkIdentityFields){assert.equal(safeDingtalkIdentityDiagnostic({...valid,fields:{...valid.fields,[key]:sensitive.token}}),undefined);assert.equal(safeDingtalkIdentityDiagnostic({...valid,fields:{...valid.fields,[key]:undefined}}),undefined);}
 assert.equal(safeDingtalkIdentityDiagnostic(Object.defineProperty({},'fields',{get(){throw Error(sensitive.secret);}})),undefined);
});
