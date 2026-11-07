import type {FastifyInstance,FastifyRequest} from 'fastify';
import {TaskError,ChannelError} from '@dentity/application';
import type {EmployeeChannelService} from '../employee-channels/service.js';
import type {DiscoveredGroups} from '../channel-loop/discovered-groups.js';
import {NotificationTargetCodec,type NotificationTarget} from './targets.js';
export function registerNotificationCatalog(app:FastifyInstance,o:{channels:EmployeeChannelService;codec:NotificationTargetCodec;groups?:DiscoveredGroups;role?:'platform'|'runtime';manager:(r:FastifyRequest,w:string,e:string)=>string;relay?:(actor:string,path:string)=>Promise<unknown>}){
 app.get('/api/workspaces/:workspaceId/entities/:entityId/notification-groups',async request=>{
  const p=request.params as{workspaceId:string;entityId:string},actor=o.manager(request,p.workspaceId,p.entityId),q=request.query as Record<string,unknown>;
  if(Object.keys(q).some(k=>!['connectionId','q','cursor'].includes(k))||q.connectionId!==undefined&&typeof q.connectionId!=='string')throw new TaskError(400,'invalid_group_query');
  const channels=o.channels.repository.list(p.workspaceId,p.entityId).filter(r=>r.enabled&&r.status==='verified');
  const connections=channels.map(r=>({id:r.id,provider:r.provider,appId:r.appId,label:r.provider==='feishu'?'飞书':r.provider==='dingtalk'?'钉钉':'企业微信'}));
  if(!q.connectionId)return{connections,items:[],nextCursor:null,coverage:'mentions_only'};
  const record=channels.find(c=>c.id===q.connectionId);if(!record)throw new TaskError(404,'channel_not_found');
  const b=await o.channels.resolveBinding(record.id);if(!b)throw new TaskError(409,'channel_not_ready');
  if(record.provider!=='feishu'&&o.role==='platform'){
   if(!o.relay)throw new TaskError(503,'runtime_service_unavailable');try{return await o.relay(actor,request.url);}catch(error){if(error instanceof TaskError)throw error;throw new TaskError(503,'notification_groups_unavailable');}
  }
  if(record.provider==='feishu'){
   if(o.role==='runtime')throw new TaskError(400,'feishu_groups_platform_only');
   if(q.cursor!==undefined&&typeof q.cursor!=='string')throw new TaskError(400,'invalid_group_cursor');
   if(!b.conversation.listJoinedGroups)throw new TaskError(409,'group_listing_unsupported');
   const scope=JSON.stringify([p.workspaceId,p.entityId,b.connectionId,b.bindingVersion,'feishu']);
   let page;try{page=await b.conversation.listJoinedGroups(q.cursor?{cursor:o.codec.readCursor(scope,q.cursor)}:{});}catch(error){if(error instanceof TaskError)throw error;if(error instanceof ChannelError&&['forbidden','unauthenticated'].includes(error.code))throw new TaskError(409,'notification_groups_authorization_required');if(error instanceof ChannelError&&error.code==='unsupported')throw new TaskError(409,'group_listing_unsupported');throw new TaskError(503,'notification_groups_unavailable');}
   if(o.channels.currentBindingVersion(b.connectionId)!==b.bindingVersion)throw new TaskError(409,'channel_binding_changed');
   return{connections,items:page.items.map(g=>{const target:NotificationTarget={kind:'group',provider:b.provider,connectionId:b.connectionId,appId:b.appId,tenantId:b.connection.tenantId,bindingVersion:b.bindingVersion,id:g.id,label:g.name||'未提供群名'};return{...o.codec.issue(p.workspaceId,p.entityId,target),name:g.name??null,preview:null,lastMessageAt:null,available:true};}),nextCursor:page.nextCursor?o.codec.cursor(scope,page.nextCursor):null,coverage:'joined_groups'};
  }
  if(!o.groups)throw new TaskError(503,'runtime_service_required');
  const page=o.groups.list(b,q);return{connections,...page,items:page.items.map(g=>{const label=b.provider==='wecom'?(g.preview||'收到过非文本消息'):g.name||'未提供群名';const target:NotificationTarget={kind:'group',provider:b.provider,connectionId:b.connectionId,appId:b.appId,tenantId:b.connection.tenantId,bindingVersion:b.bindingVersion,id:g.chatId,label};return{...o.codec.issue(p.workspaceId,p.entityId,target),name:g.name,preview:g.preview,lastMessageAt:g.lastMessageAt,available:g.available};})};
 });
}
