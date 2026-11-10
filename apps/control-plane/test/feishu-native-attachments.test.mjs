import test from'node:test';import assert from'node:assert/strict';
import{FeishuConversationAdapter}from'../dist/adapters/channels/feishu.js';
const connection={workspaceId:'w',connectionId:'app',provider:'feishu',tenantId:'tenant',identity:{kind:'bot',externalId:'bot'},credentialRef:'synthetic'};
const conversation={provider:'feishu',connectionId:'app',tenantId:'tenant',kind:'conversation',externalId:'group'};
const options={appId:'app',grants:{proactiveSend:true,replyToMessage:true},resolveCredential:async()=> 'synthetic-token'};
for(const kind of ['image','file'])test('native '+kind+' uploads trusted bytes then sends only its provider key with stable operation',async()=>{
 const calls=[];let guards=0;
 const bytes=kind==='image'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVf8AAAAASUVORK5CYII=','base64'):Buffer.from('SYNTHETIC_BYTES');
 const adapter=new FeishuConversationAdapter(connection,{...options,fetch:async(url,init)=>{calls.push({url:String(url),body:init.body});if(init.body instanceof FormData){assert.equal(init.headers.authorization,'Bearer synthetic-token');assert.equal(init.headers['content-type'],undefined);assert.deepEqual(Buffer.from(await init.body.get(kind==='image'?'image':'file').arrayBuffer()),bytes);return Response.json({code:0,data:kind==='image'?{image_key:'uploaded-image'}:{file_key:'uploaded-file'}});}const body=JSON.parse(init.body);assert.equal(body.uuid,'stable-operation');assert.equal(body.msg_type,kind);assert.deepEqual(JSON.parse(body.content),kind==='image'?{image_key:'uploaded-image'}:{file_key:'uploaded-file'});return Response.json({code:0,data:{message_id:'sent-message'}});}});
 const receipt=await adapter.sendMessage({conversation,text:'',operationId:'stable-operation',attachment:{kind,name:kind==='image'?'synthetic.png':'report.txt',mediaType:kind==='image'?'image/png':'text/plain',bytes},assertSendAllowed(){guards++;}});
 assert.equal(receipt.status,'sent');assert.equal(receipt.messageId,'sent-message');assert.equal(calls.length,2);assert.ok(guards>=2);
});
test('failed upload never becomes a text-only success and unknown send is not silently replayed',async()=>{
 let calls=0;const attachment={kind:'file',name:'report.txt',mediaType:'text/plain',bytes:new Uint8Array([1])};
 const denied=new FeishuConversationAdapter(connection,{...options,fetch:async()=>{calls++;return Response.json({code:99991672},{status:403});}});
 await assert.rejects(denied.sendMessage({conversation,text:'',operationId:'upload-denied',attachment}));assert.equal(calls,1);
 calls=0;const uncertain=new FeishuConversationAdapter(connection,{...options,fetch:async(_url,init)=>{calls++;if(init.body instanceof FormData)return Response.json({code:0,data:{file_key:'ready'}});throw Error('network outcome unknown');}});
 await assert.rejects(uncertain.sendMessage({conversation,text:'',operationId:'send-unknown',attachment}));assert.equal(calls,2);
});
