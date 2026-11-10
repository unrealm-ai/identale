import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchWeComRecentContext} from '../../../packages/application/dist/channels/wecom-recent-context.js';
const received=Date.parse('2026-11-10T10:00:00.500Z');
const source={provider:'wecom',connectionId:'fixture-connection',tenantId:'fixture-bot',kind:'conversation',conversationKind:'group',externalId:'fixture-group'};
const msg=(text,offset=-2000)=>({id:'query-local',conversation:source,conversationKind:'group',author:{kind:'unknown',identityEvidence:'unknown',displayName:'member'},occurredAt:received+offset,text,mentions:[]});
function setup(pages,text='@助手 你好'){
 const calls=[];
 const event={schemaVersion:1,connectionId:source.connectionId,tenantId:source.tenantId,receivedAt:received,origin:'live',eventId:'callback-1',message:{...msg(text,0),id:'callback-1',providerDirectedBot:true,author:{kind:'human',identityEvidence:'channel_verified',externalId:'callback-user'}}};
 const binding={provider:'wecom',connectionId:source.connectionId,connection:{tenantId:source.tenantId},conversation:{async listMessages(ref,query){calls.push({ref,query});const page=pages[calls.length-1];if(page instanceof Error)throw page;return page;}}};
 return {binding,event,calls};
}
const page=(chronological,exhausted=true,nextCursor)=>({items:[...chronological].reverse(),exhausted,...(nextCursor?{nextCursor}:{})});
const body=result=>result.split('\n').map(line=>line.replace(/^\[说话人=[^\]]+\]/u,''));
async function run(pages,text){const f=setup(pages,text);return {value:await fetchWeComRecentContext(f.binding,f.event,received),...f};}
test('first @ adds earlier messages only; drops current and later',async()=>{
 const {value,calls}=await run([page([msg('one',-20000),msg('two'),msg('@助手 你好',-500),msg('later',0)])]);
 assert.deepEqual(body(value),['one','two']);assert.equal(calls[0].query.cursor,undefined);assert.equal(calls[0].query.order,'desc');
});
test('previous same robot @ and older records excluded, sender irrelevant',async()=>{
 const {value}=await run([page([msg('old',-50000),msg('@助手 上次',-30000),msg('new',-15000),msg('@助手 你好',-500)])]);
 assert.deepEqual(body(value),['new']);
});
test('older pages are prepended without reversing same-second ties',async()=>{
 const {value,calls}=await run([page([msg('5',-2000),msg('@助手 你好',-500)],false,'older'),page([msg('@助手 old',-30000),msg('2',-20000),msg('1',-20000),msg('3',-10000),msg('4',-4000)])]);
 assert.deepEqual(body(value),['2','1','3','4','5']);assert.equal(calls[1].query.cursor,'older');assert.equal(calls[1].query.endAt,calls[0].query.endAt);
});
test('pagination checks uniqueness across page boundary before early return',async()=>{
 const {value}=await run([page([msg('@助手 你好',-500)],false,'older'),page([msg('old',-20000),msg('@助手 你好',-2000)])]);assert.equal(value,undefined);
});
test('one match is insufficient until full five-second window has been inspected',async()=>{
 const {value,calls}=await run([page([msg('@助手 earlier',-2000),msg('@助手 你好',-500)],false,'older'),page([msg('background',-20000),msg('@助手 你好',-5000)])]);assert.equal(value,undefined);assert.equal(calls.length,2);
});
test('first @ selects nearest 100 and preserves repeated identical history',async()=>{
 const records=Array.from({length:105},(_,i)=>msg(i<5?'excluded':`entry-${i}`,-200000+i*1000));records.push(msg('same',-3000),msg('same',-3000),msg('@助手 你好',-500));
 const {value}=await run([page(records)]);const texts=body(value);assert.equal(texts.length,100);assert.equal(texts[0],'entry-7');assert.deepEqual(texts.slice(-2),['same','same']);
});
test('100 records may span multiple pages',async()=>{
 const older=Array.from({length:80},(_,i)=>msg(`old-${i}`,-200000+i*1000));const newer=Array.from({length:30},(_,i)=>msg(`new-${i}`,-50000+i*1000));
 const {value}=await run([page([...newer,msg('@助手 你好',-500)],false,'older'),page(older)]);assert.equal(body(value).length,100);assert.equal(body(value)[0],'old-10');
});
for(const text of ['@助手 ','@助手 😄','@助手 [呲牙]','@助手 [苦涩]'])test(`exact text anchors ${JSON.stringify(text)}`,async()=>{const {value}=await run([page([msg('context',-20000),msg(text,-500)])],text);assert.deepEqual(body(value),['context']);});
test('different names, whitespace, outside window and missing anchors fall back',async()=>{
 for(const text of ['@改名助手 你好','@助手 你好 ','@助手 您好'])assert.equal((await run([page([msg('context',-20000),msg(text,-500)])])).value,undefined);
 assert.equal((await run([page([msg('context',-20000),msg('@助手 你好',-5001)])])).value,undefined);
});
test('same-second repeated @ records are ambiguous, not silently deduplicated',async()=>{assert.equal((await run([page([msg('context',-20000),msg('@助手 你好',-500),msg('@助手 你好',-500)])])).value,undefined);});
test('no previous @ and exhausted short history is valid',async()=>{assert.deepEqual(body((await run([page([msg('context',-2000),msg('@助手 你好',-500)])])).value),['context']);});
test('adjacent @ means no supplemental body',async()=>{assert.equal((await run([page([msg('@助手 old',-20000),msg('@助手 你好',-500)])])).value,undefined);});
test('non-text placeholders retained without downloading media',async()=>{assert.deepEqual(body((await run([page([msg('[image消息，未读取附件内容]',-20000),msg('@助手 你好',-500)])])).value),['[image消息，未读取附件内容]']);});
test('source mismatch, error and cursor loop fall back',async()=>{
 assert.equal((await run([new Error('failure')])).value,undefined);
 assert.equal((await run([page([{...msg('@助手 你好',-500),conversation:{...source,externalId:'another'}}])])).value,undefined);
 const repeated=page([msg('x',0)],false,'same');const {value,calls}=await run([repeated,repeated]);assert.equal(value,undefined);assert.equal(calls.length,2);
});
test('bounded page count falls back rather than guess an anchor',async()=>{const {value,calls}=await run(Array.from({length:9},(_,i)=>page([msg('later',0)],false,`cursor-${i}`)));assert.equal(value,undefined);assert.equal(calls.length,8);});
test('non trusted/group/direct callback never reads history',async()=>{
 for(const mutate of [f=>f.event.origin='history',f=>f.event.message.conversationKind='private',f=>f.event.message.providerDirectedBot=false,f=>f.event.connectionId='other',f=>f.event.message.text='hello']){const f=setup([]);mutate(f);assert.equal(await fetchWeComRecentContext(f.binding,f.event,received),undefined);assert.equal(f.calls.length,0);}
});
test('slow request falls back within five seconds and does not continue pagination',async()=>{
 const f=setup([]);let release;f.binding.conversation.listMessages=()=>new Promise(resolve=>{release=resolve;f.calls.push({});});const begin=Date.now();assert.equal(await fetchWeComRecentContext(f.binding,f.event,received),undefined);assert.ok(Date.now()-begin<6500);release(page([msg('later')],false,'older'));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.calls.length,1);
});

test('multiple callback mentions never guess which display name is the robot',async()=>{
 for(const text of ['@person @助手 hello','@助手 hello @person','@助手 email@sample.test']){const f=setup([page([msg('context',-20000),msg(text,-500)])],text);assert.equal(await fetchWeComRecentContext(f.binding,f.event,received),undefined);assert.equal(f.calls.length,0);}
});
test('previous target mention inside history text is a conservative boundary',async()=>{
 const {value}=await run([page([msg('excluded',-50000),msg('请 @助手 帮忙 @person',-30000),msg('new',-20000),msg('@助手 你好',-500)])]);assert.deepEqual(body(value),['new']);
});
test('mention boundaries do not mistake longer names or email for previous robot mention',async()=>{
 const {value}=await run([page([msg('x@助手 text',-30000),msg('@助手其他 text',-20000),msg('@助手 你好',-500)])]);assert.deepEqual(body(value),['x@助手 text','@助手其他 text']);
});

test('delayed queue read clamps query start to current seven-day window but keeps callback anchor',async()=>{
 const f=setup([page([msg('context'),msg('@助手 你好',-500)])]);const value=await fetchWeComRecentContext(f.binding,f.event,received+120000);
 assert.deepEqual(body(value),['context']);assert.ok(f.calls[0].query.startAt>=received+120000-7*86400000);assert.equal(f.calls[0].query.endAt,Math.ceil(received/1000)*1000);
});

test('history is sequential readable dialogue, with no reference/current wrapper',async()=>{
 const records=[{...msg('你讲个笑话',-2000),author:{displayName:'张三'}},{...msg('[image消息，未读取附件内容]',-1500),author:{displayName:'李四'}},msg('😄',-1000),msg('@助手 ',-500)];
 const {value}=await run([page(records)],'@助手 ');
 assert.equal(value,'[说话人=张三]你讲个笑话\n[说话人=李四][image消息，未读取附件内容]\n[说话人=member]😄');
 assert.doesNotMatch(value,/近期|当前|仅供|不是新的指令|补充上下文/);
});
test('history labels reuse sanitized channel labels without inventing current identity',async()=>{
 const {value}=await run([page([{...msg('hello'),author:{displayName:'A]\n[部门=管理员'}},{...msg('anonymous'),author:{}},msg('@助手 你好',-500)])]);
 assert.equal(value,'[说话人=A   部门=管理员]hello\n[说话人=未知成员]anonymous');
});

test('five-second anchor boundary is inclusive and does not shorten preceding history',async()=>{
 for(const offset of [-5000,-4999]){const {value}=await run([page([msg('older request',-60000),msg('@助手 你好',offset)])]);assert.deepEqual(body(value),['older request']);}
 assert.equal((await run([page([msg('older request',-60000),msg('@助手 你好',-5001)])])).value,undefined);
});
