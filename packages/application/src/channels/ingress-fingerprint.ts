import{createHash}from'node:crypto';
import type{ChannelMessageEvent}from'./ports.js';
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key,v])=>key!=='assetId'&&v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Transport retry envelopes/timestamps and derived asset IDs do not alter original source identity. */
export function channelIngressFingerprint(binding:{workspaceId:string;entityId:string;connectionId:string;appId:string;bindingVersion:string},event:ChannelMessageEvent){
 const m=event.message;const sourceKey=digest([binding.workspaceId,binding.entityId,binding.connectionId,binding.appId,binding.bindingVersion,event.tenantId,m.id,event.revision??'initial']);
 const a=m.author;const payloadHash=digest({sourceKey,kind:m.conversationKind,conversation:m.conversation,actor:{id:a.externalId,namespace:a.idNamespace,applicationId:a.applicationId,kind:a.kind,identityEvidence:a.identityEvidence},occurredAt:m.occurredAt,...(m.content?{content:m.content}:{text:m.text}),mentions:m.mentions,mentionDetails:m.mentionDetails,root:m.rootMessageId,parent:m.replyToMessageId,thread:m.threadId,attachments:m.attachments});
 return{sourceKey,payloadHash};
}
