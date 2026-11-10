import test from 'node:test';
import assert from 'node:assert/strict';
import {WeComBotGroupHistory} from '../dist/adapters/channels/wecom-group-history.js';
// Existing synthetic official-HTTP fixture convention; no live credentials or messages.
const wrap=result=>({errcode:0,results_json:JSON.stringify({result:JSON.stringify(result)})});
function fixture(change={}){
 const calls=[];let auths=0;
 const client=new WeComBotGroupHistory({appId:'fixture-bot',appSecret:'fixture-secret',now:()=>1800000000000,fetch:async(url,init)=>{
  const u=new URL(url),body=JSON.parse(init.body);assert.equal(u.origin,'https://qyapi.weixin.qq.com');calls.push({path:u.pathname,body});
  if(u.pathname.endsWith('get_cli_config')){auths++;return Response.json({errcode:0,token:'fixture-token'});}
  assert.equal(init.headers.authorization,'Bearer fixture-token');
  if(u.pathname.endsWith('/service/discovery'))return Response.json(wrap(change.schema??{resources:{groups:{methods:{list:{path:'/chat/groups/list',http_method:'POST'}}},messages:{methods:{list:{path:'/chat/messages/list',http_method:'POST'}}}}}));
  if(change.response)return Response.json(change.response(u.pathname));
  if(u.pathname.endsWith('/groups/list'))return Response.json(wrap({chats:[{chat_id:'opaque-cli-group',chat_name:'Fixture'}],has_more:false}));
  return Response.json(wrap({messages:[1,2].map(()=>({userid:'opaque-user',user_name:'Member',send_time:'2026-11-10 12:00:00',msg_type:'text',text:{content:'same second, same text'}})),has_more:true,next_cursor:'opaque-cursor'}));
 }});return{client,calls,auths:()=>auths};
}
const range={beginTime:'2026-11-10 00:00:00',endTime:'2026-11-10 23:59:59'};
test('official discovery and payload protocol preserve opaque IDs, raw time, duplicates and cursor',async()=>{
 const f=fixture();const groups=await f.client.listGroups(range);assert.equal(groups.items[0].chatId,'opaque-cli-group');
 const page=await f.client.listMessages(groups.items[0].chatId,range);assert.equal(page.items.length,2);assert.equal(page.items[0].sendTime,'2026-11-10 12:00:00');assert.equal(page.nextCursor,'opaque-cursor');assert.equal(f.auths(),1);
 await f.client.listMessages('opaque-cli-group',{...range,cursor:page.nextCursor});
 assert.deepEqual(JSON.parse(f.calls.at(-1).body.payload),{chat_id:'opaque-cli-group',begin_time:range.beginTime,end_time:range.endTime,cursor:'opaque-cursor'});
 assert.ok(!('id' in page.items[0]));
});
test('discovery cannot redirect credentials or call arbitrary methods',async()=>{
 const f=fixture({schema:{base_url:'https://attacker.invalid/cli',resources:{groups:{methods:{list:{path:'/chat/groups/list',http_method:'POST'}}},messages:{methods:{list:{path:'/chat/messages/list',http_method:'POST'}}}}}});
 await assert.rejects(f.client.listGroups(range),/invalid_response/);assert.equal(f.calls.length,2);
});
test('provider permission denial is not returned as empty history and is not retried',async()=>{
 const f=fixture({response:()=>({errcode:853006})});await assert.rejects(f.client.listGroups(range),/authorization_denied/);assert.equal(f.calls.length,3);
});
test('invalid pagination and malformed time fail explicitly',async()=>{
 const f=fixture({response:()=>wrap({messages:[],has_more:true})});await assert.rejects(f.client.listMessages('opaque-cli-group',range),/invalid_response/);
 await assert.rejects(f.client.listGroups({...range,beginTime:'yesterday'}),/invalid_response/);
});
test('expired token is refreshed only once and cannot retry forever',async()=>{
 const f=fixture({response:()=>({errcode:853004})});await assert.rejects(f.client.listGroups(range),/authentication_failed/);assert.equal(f.auths(),2);assert.equal(f.calls.length,6);
});
test('unexpected methods and missing schema are rejected before history request',async()=>{
 for(const method of [{path:'/chat/groups/delete',http_method:'POST'},{path:'/chat/groups/list',http_method:'GET'}]){
  const f=fixture({schema:{resources:{groups:{methods:{list:method}},messages:{methods:{list:{path:'/chat/messages/list',http_method:'POST'}}}}}});
  await assert.rejects(f.client.listGroups(range),/unsupported/);assert.equal(f.calls.length,2);
 }
});

test('unnamed groups remain selectable by opaque identity without invented name',async()=>{
 const f=fixture({response:()=>wrap({chats:[{chat_id:'opaque-unnamed'}],has_more:false})});const page=await f.client.listGroups(range);assert.deepEqual(page.items,[{chatId:'opaque-unnamed'}]);
});

import {WeComHistoryReader,parseWeComHistoryTime,weComHistoryTime} from '../dist/adapters/channels/wecom-history-reader.js';
const connection={workspaceId:'w',connectionId:'c',provider:'wecom',tenantId:'bot',identity:{kind:'bot',externalId:'bot'},credentialRef:'fixture'};
test('Beijing conversion is host-timezone independent across day and summer boundaries',()=>{
 for(const input of ['2026-01-01 00:00:00','2026-07-01 12:00:00','2026-11-10 16:56:51'])assert.equal(weComHistoryTime(parseWeComHistoryTime(input)),input);
 assert.equal(parseWeComHistoryTime('2026-11-10 16:56:51'),Date.UTC(2026,10,10,8,56,51));assert.throws(()=>parseWeComHistoryTime('2026-02-30 12:00:00'));
});
test('reader enforces scope, ordering and time bounds; repeated text is preserved with query-local record references',async()=>{
 const now=Date.UTC(2026,10,10,8,57),api=fixture(),fetch=async(url,init)=>{
  const u=new URL(url);if(u.pathname.endsWith('get_cli_config'))return Response.json({errcode:0,token:'t'});
  if(u.pathname.endsWith('discovery'))return Response.json(wrap({resources:{groups:{methods:{list:{path:'/chat/groups/list',http_method:'POST'}}},messages:{methods:{list:{path:'/chat/messages/list',http_method:'POST'}}}}}));
  return Response.json(wrap({messages:[1,2].map(()=>({userid:'opaque',user_name:'Name',send_time:'2026-11-10 16:56:51',msg_type:'text',text:{content:'duplicate'}})),has_more:true,next_cursor:'p2'}));
 };
 const reader=new WeComHistoryReader(connection,{appId:'bot',appSecret:'secret',now:()=>now,fetch}),ref={provider:'wecom',connectionId:'c',tenantId:'bot',kind:'conversation',conversationKind:'group',externalId:'g'},query={startAt:now-60000,endAt:now,limit:1};
 const page=await reader.listMessages(ref,query);assert.equal(page.items.length,2,'whole provider page is retained for durable service slicing');assert.notEqual(page.items[0].id,page.items[1].id);assert.equal(page.items[0].author.identityEvidence,'unknown');
 await assert.rejects(reader.listMessages({...ref,externalId:'other'},{...query,cursor:page.nextCursor}),/invalid_or_expired_channel_cursor/);
 await assert.rejects(reader.listMessages(ref,{...query,order:'asc'}),/wecom_history_descending_only/);
 await assert.rejects(reader.listMessages(ref,{...query,startAt:now-8*86400000}),/wecom_history_range_last_seven_days/);
 await assert.rejects(reader.listMessages({...ref,provider:'feishu'},query));
});
