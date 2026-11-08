import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelError} from '@dentity/application';
import {FeishuConversationAdapter,feishuMediaCapabilities} from '../dist/adapters/channels/feishu.js';
import {DingTalkBotConversationAdapter,dingtalkMediaCapabilities} from '../dist/adapters/channels/dingtalk.js';
import {validateNativeAttachment} from '../dist/adapters/channels/native-media.js';
const connection=provider=>({workspaceId:'w',connectionId:'c',tenantId:'t',provider,identity:{kind:'bot',externalId:'bot'},credentialRef:'fixture'});
const target=(provider,kind='group')=>({provider,connectionId:'c',tenantId:'t',kind:'conversation',externalId:kind==='group'?'group':'user',conversationKind:kind,...(kind==='private'?{privateRecipientId:'user'}:{})});
const file={kind:'file',name:'report.pdf',mediaType:'application/pdf',bytes:Buffer.from('%PDF-fixture')};
const png=(width=1,height=1)=>{const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;};
const image={kind:'image',name:'image.png',mediaType:'image/png',bytes:png()};
const request=(provider,attachment=file,kind)=>({conversation:target(provider,kind),text:'',operationId:'operation',attachment});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const adapter=(provider,fetch,extra={})=>provider==='feishu'?new FeishuConversationAdapter(connection(provider),{appId:'app',grants:{proactiveSend:true},resolveCredential:async()=> 'fixture-token',fetch,...extra}):new DingTalkBotConversationAdapter(connection(provider),{robotCode:'robot',proactiveSendGranted:true,resolveCredential:async()=> 'fixture-token',fetch,...extra});

test('native safety validates nonempty bytes, MIME, names, size and bounded PNG/GIF/JPEG/WebP dimensions',()=>{
 const limits={image:1000,file:1000};validateNativeAttachment(image,limits);validateNativeAttachment(file,limits);
 for(const value of [{...file,bytes:new Uint8Array()},{...file,name:'../file.pdf'},{...file,mediaType:'application/pdf\r\nheader:x'},{...file,bytes:new Uint8Array(1001)},{...image,bytes:png(12001,1)},{...image,bytes:png(0,1)},{...image,bytes:Buffer.from('not png')}])assert.throws(()=>validateNativeAttachment(value,limits),e=>e.code==='invalid_request');
 const gif=Buffer.alloc(13);gif.write('GIF89a');gif.writeUInt16LE(2000,6);gif.writeUInt16LE(1,8);validateNativeAttachment({...image,mediaType:'image/gif',bytes:gif},limits);gif.writeUInt16LE(2001,6);assert.throws(()=>validateNativeAttachment({...image,mediaType:'image/gif',bytes:gif},limits),/dimensions/);
 const jpeg=Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0]);validateNativeAttachment({...image,mediaType:'image/jpeg',bytes:jpeg},limits);assert.throws(()=>validateNativeAttachment({...image,mediaType:'image/jpeg',bytes:jpeg.subarray(0,10)},limits),/dimensions/);
 for(const chunk of ['VP8X','VP8 ','VP8L']){const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBP',8);webp.write(chunk,12);webp.writeUInt32LE(10,16);if(chunk==='VP8 '){webp[23]=0x9d;webp[24]=1;webp[25]=0x2a;webp.writeUInt16LE(1,26);webp.writeUInt16LE(1,28);}if(chunk==='VP8L')webp[20]=0x2f;validateNativeAttachment({...image,mediaType:'image/webp',bytes:webp},limits);}
 assert.throws(()=>validateNativeAttachment({...image,mediaType:'image/svg+xml'},limits),e=>e.code==='unsupported');
});

for(const provider of ['feishu','dingtalk'])for(const kind of ['group','private'])for(const attachment of [image,file])test(`${provider} ${kind} ${attachment.kind} uploads trusted bytes and independently sends native media`,async()=>{
 const calls=[];let guards=0,assertions=0;
 const a=adapter(provider,async(url,init)=>{calls.push([new URL(url),init]);if(init.body instanceof FormData){assert.equal(init.redirect,'error');const uploaded=init.body.get(provider==='dingtalk'?'media':attachment.kind);assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()),attachment.bytes);return json(provider==='dingtalk'?{errcode:0,type:attachment.kind,media_id:'trusted-media'}:{code:0,data:attachment.kind==='image'?{image_key:'trusted-media'}:{file_key:'trusted-media'}});}return json(provider==='dingtalk'?{processQueryKey:'accepted'}:{code:0,data:{message_id:'sent'}});});
 const receipt=await a.sendMessage({...request(provider,attachment,kind),beforeSend:async()=>{guards++;},assertSendAllowed:()=>{assertions++;}});assert.equal(calls.length,2);assert.equal(guards,2);assert.ok(assertions>=2);assert.equal(receipt.status,provider==='dingtalk'?'accepted':'sent');
 const body=JSON.parse(calls[1][1].body);if(provider==='dingtalk'){assert.equal(calls[0][0].origin,'https://oapi.dingtalk.com');assert.equal(calls[0][0].pathname,'/media/upload');assert.equal(calls[0][0].searchParams.get('access_token'),'fixture-token');assert.equal(calls[0][1].body.get('type'),attachment.kind);assert.equal(body.msgKey,attachment.kind==='image'?'sampleImageMsg':'sampleFile');assert.deepEqual(JSON.parse(body.msgParam),attachment.kind==='image'?{photoURL:'trusted-media'}:{mediaId:'trusted-media',fileName:'report.pdf',fileType:'pdf'});assert.equal(calls[1][0].pathname,kind==='private'?'/v1.0/robot/oToMessages/batchSend':'/v1.0/robot/groupMessages/send');}else{assert.equal(body.msg_type,attachment.kind);assert.deepEqual(JSON.parse(body.content),attachment.kind==='image'?{image_key:'trusted-media'}:{file_key:'trusted-media'});}
});

for(const provider of ['feishu','dingtalk'])test(`${provider} upload failure is not delivery_unknown; revoked upload never sends; unclear send stays unknown`,async()=>{
 let calls=0;const failed=adapter(provider,async()=>{calls++;throw Error('private token-bearing URL must not escape');});await assert.rejects(failed.sendMessage(request(provider)),e=>e.code==='temporarily_unavailable'&&!e.message.includes('private'));assert.equal(calls,1);
 calls=0;let authorized=true;const revoked=adapter(provider,async()=>{calls++;authorized=false;return json(provider==='dingtalk'?{errcode:0,type:'file',media_id:'uploaded'}:{code:0,data:{file_key:'uploaded'}});});await assert.rejects(revoked.sendMessage({...request(provider),beforeSend:async()=>{if(!authorized)throw new ChannelError('forbidden');}}),e=>e.code==='forbidden');assert.equal(calls,1);
 calls=0;const unclear=adapter(provider,async()=>{calls++;return calls===1?json(provider==='dingtalk'?{errcode:0,type:'file',media_id:'uploaded'}:{code:0,data:{file_key:'uploaded'}}):json(provider==='feishu'?{code:0,data:{}}:{});});await assert.rejects(unclear.sendMessage(request(provider)),e=>e.code==='delivery_unknown');assert.equal(calls,2);
});

test('invalid DingTalk formats are rejected before upload; media declarations distinguish direction, context and grants',async()=>{
 let calls=0;const ding=adapter('dingtalk',async()=>{calls++;throw Error();});await assert.rejects(ding.sendMessage(request('dingtalk',{...file,name:'notes.txt',mediaType:'text/plain'})),e=>e.code==='unsupported');assert.equal(calls,0);
 const c=dingtalkMediaCapabilities({streamIngress:true,privateMessageEventsGranted:true,mentionEventsGranted:true,proactiveSendGranted:false});assert.equal(c.inbound.private.file.availability,'available');assert.equal(c.inbound.group.file.availability,'unsupported');assert.equal(c.outbound.group.file.availability,'authorization_required');assert.equal(feishuMediaCapabilities().outbound.private.file.availability,'authorization_required');
});
