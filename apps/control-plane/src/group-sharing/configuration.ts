import{createHmac,timingSafeEqual,randomUUID}from'node:crypto';
import type{GroupSharingRule,SharingDestination,GroupSharingSnapshot}from'@dentity/contracts';
import{TaskError,sharingIdentityKey,sharingTargetKey,sharingSources,type TaskScope}from'@dentity/application';
import type{Store}from'../store.js';
import{groupHistoryPermission,type EmployeeChannelService}from'../employee-channels/service.js';
import type{FastifyInstance,FastifyRequest}from'fastify';
export class GroupSharingConfiguration{
 constructor(readonly store:Store,readonly channels:EmployeeChannelService,private key:string,private now:()=>number){
  store.db.exec(`CREATE TABLE IF NOT EXISTS employee_group_sharing_rules(workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,rules_json TEXT NOT NULL,PRIMARY KEY(workspace_id,entity_id));`);
 }
 get(w:string,e:string){const r=this.store.one<{revision:number;rules_json:string}>('SELECT revision,rules_json FROM employee_group_sharing_rules WHERE workspace_id=? AND entity_id=?',w,e);return{revision:r?.revision??0,rules:JSON.parse(r?.rules_json??'[]')as GroupSharingRule[]};}
 private mac(p:string){return createHmac('sha256',this.key).update('group-sharing-selection-v1\0'+p).digest();}
 issue(w:string,e:string,ref:SharingDestination){const p=Buffer.from(JSON.stringify({w,e,ref})).toString('base64url');return{ref,proof:p+'.'+this.mac(p).toString('base64url')};}
 selection(w:string,e:string,v:unknown):SharingDestination{
  try{const proof=(v as{proof:string}).proof;if(typeof proof!=='string'||proof.length>16000)throw Error();const[p,s,...rest]=proof.split('.');if(!p||!s||rest.length)throw Error();const a=Buffer.from(s,'base64url'),b=this.mac(p);if(a.length!==b.length||!timingSafeEqual(a,b))throw Error();const data=JSON.parse(Buffer.from(p,'base64url').toString())as{w:string;e:string;ref:SharingDestination};if(data.w!==w||data.e!==e)throw Error();this.assertCurrent(w,e,data.ref);return data.ref;}catch{throw new TaskError(400,'invalid_sharing_selection');}
 }
 assertCurrent(w:string,e:string,ref:SharingDestination){const c=this.channels.repository.byId(ref.connectionId);if(ref.provider!=='feishu'||!c||c.workspaceId!==w||c.entityId!==e||c.appId!==ref.appId||c.eventTenantId!==ref.tenantId||this.channels.currentBindingVersion(c.id)!==ref.bindingVersion)throw new TaskError(409,'sharing_binding_changed');}
 save(w:string,e:string,actor:string,value:unknown){
  const b=value as{expectedRevision:number;rules:{id?:string;name:string;enabled:boolean;type:'mutual'|'directed';sources:unknown[];targets:unknown[]}[]};
  if(!b||Object.keys(b).some(k=>!['expectedRevision','rules'].includes(k))||!Number.isSafeInteger(b.expectedRevision)||!Array.isArray(b.rules)||b.rules.length>50)throw new TaskError(400,'invalid_sharing_rules');
  return this.store.transaction(()=>{const old=this.get(w,e);if(old.revision!==b.expectedRevision)throw new TaskError(409,'sharing_rules_changed');const seen=new Set<string>();
   const rules=b.rules.map(r=>{if(!r||Object.keys(r).some(k=>!['id','name','enabled','type','sources','targets'].includes(k))||typeof r.name!=='string'||!r.name.trim()||r.name.length>100||typeof r.enabled!=='boolean'||!['mutual','directed'].includes(r.type)||!Array.isArray(r.sources)||!Array.isArray(r.targets)||r.sources.length>30||r.targets.length>50)throw new TaskError(400,'invalid_sharing_rule');
    const previous=r.id?old.rules.find(o=>o.id===r.id):undefined;if(r.id&&!previous||r.id&&seen.has(r.id))throw new TaskError(400,'invalid_sharing_rule_id');
    // An unchanged stale selector may be retained or disabled, but cannot acquire a new grant.
    const read=(v:unknown)=>{const candidate=(v as{ref?:SharingDestination})?.ref;const prior=previous&&[...previous.sources,...previous.targets].find(t=>candidate&&sharingTargetKey(t)===sharingTargetKey(candidate));if(prior&&(!r.enabled||previous.enabled)){
      try{return this.selection(w,e,v);}catch{if(!r.enabled)return prior;throw new TaskError(409,'sharing_binding_changed');}
     }return this.selection(w,e,v);};
    const sources=[...new Map(r.sources.map(v=>{const ref=read(v);if(ref.kind!=='group')throw new TaskError(400,'sharing_source_must_be_group');return[sharingTargetKey(ref),ref]as const;})).values()];
    const targets=[...new Map(r.targets.map(v=>{const ref=read(v);return[sharingTargetKey(ref),ref]as const;})).values()];
    if(!sources.length||r.type==='mutual'&&(sources.length<2||targets.length)||r.type==='directed'&&!targets.length||[...sources,...targets].some(ref=>sharingIdentityKey(ref)!==sharingIdentityKey(sources[0]!)))throw new TaskError(400,'invalid_sharing_scope');
    const id=previous?.id??randomUUID();seen.add(id);const content={name:r.name.trim(),enabled:r.enabled,type:r.type,sources,targets};const same=previous&&JSON.stringify(content)===JSON.stringify({name:previous.name,enabled:previous.enabled,type:previous.type,sources:previous.sources,targets:previous.targets});return{id,revision:same?previous.revision:(previous?.revision??0)+1,...content};
   });const revision=old.revision+1;this.store.run('INSERT INTO employee_group_sharing_rules VALUES(?,?,?,?) ON CONFLICT(workspace_id,entity_id) DO UPDATE SET revision=excluded.revision,rules_json=excluded.rules_json',w,e,revision,JSON.stringify(rules));
   this.store.run('INSERT INTO audit(at,action,user_id,workspace_id) VALUES(?,?,?,?)',this.now(),'group-sharing.updated',actor,w);return{revision,rules};
  });
 }
 view(w:string,e:string){const c=this.get(w,e);const edges=(r:GroupSharingRule)=>{const destinations=r.type==='mutual'?r.sources:r.targets;return new Set(destinations.flatMap(d=>r.sources.filter(s=>sharingTargetKey(s)!==sharingTargetKey(d)).map(s=>JSON.stringify([sharingTargetKey(s),sharingTargetKey(d)]))));};const expanded=c.rules.map(r=>({rule:r,edges:edges(r)}));return{...c,rules:c.rules.map(r=>({...r,overlappingRules:expanded.filter(other=>other.rule.id!==r.id&&other.rule.enabled&&[...edges(r)].some(edge=>other.edges.has(edge))).map(other=>({id:other.rule.id,name:other.rule.name})),sources:r.sources.map(ref=>this.issue(w,e,ref)),targets:r.targets.map(ref=>this.issue(w,e,ref)),historyReady:r.sources.every(ref=>{const record=this.channels.repository.byId(ref.connectionId);return !!record&&groupHistoryPermission(record);}),available:[...r.sources,...r.targets].every(ref=>{try{this.assertCurrent(w,e,ref);return true;}catch{return false;}})}))};}
 snapshot(scope:TaskScope):GroupSharingSnapshot|undefined{
  const s=scope.source;if(!s||!scope.principal||s.channelType!=='feishu')return;const r=this.channels.repository.byId(s.connectionId);if(!r||r.appId!==s.applicationId||r.eventTenantId!==s.tenantId||this.channels.currentBindingVersion(r.id)!==s.bindingVersion)return;
  const identity={provider:'feishu' as const,connectionId:s.connectionId,appId:s.applicationId,tenantId:s.tenantId,bindingVersion:s.bindingVersion};
  const destination:SharingDestination=s.conversationKind==='group'?{...identity,kind:'group',id:s.conversationId,label:'当前群'}:{...identity,kind:'person',id:scope.principal.externalUserId,namespace:'open_id',label:'当前私聊'};
  if(s.conversationKind==='private'&&scope.principal.identityNamespace!=='open_id')return;
  const cfg=this.get(scope.workspaceId,scope.entityId);return{version:1,revision:cfg.revision,workspaceId:scope.workspaceId,entityId:scope.entityId,destination,...(s.threadId?{destinationThreadId:s.threadId,...(s.conversationKind==='group'&&s.replyToMessageId?{topicRead:{threadId:s.threadId,chatId:s.conversationId,messageId:s.replyToMessageId}}:{})}:{}),sources:sharingSources(cfg.rules,destination)};
 }
 async candidates(w:string,e:string,q:Record<string,unknown>){
  if(Object.keys(q).some(k=>!['connectionId','cursor','q'].includes(k))||q.connectionId!==undefined&&typeof q.connectionId!=='string'||q.cursor!==undefined&&typeof q.cursor!=='string'||q.q!==undefined&&(typeof q.q!=='string'||q.q.length>100))throw new TaskError(400,'invalid_sharing_query');
  const records=this.channels.repository.list(w,e).filter(c=>c.provider==='feishu'&&c.enabled&&c.status==='verified'&&c.eventTenantId);const connections=records.map(c=>({id:c.id,appId:c.appId,label:'飞书 · '+c.appId}));if(!q.connectionId)return{connections,groups:[],people:[],nextCursor:null};
  const record=records.find(c=>c.id===q.connectionId);if(!record)throw new TaskError(404,'sharing_connection_not_found');const binding=await this.channels.resolveBinding(record.id);if(!binding?.conversation.listJoinedGroups)throw new TaskError(409,'sharing_channel_unavailable');
  const base={provider:'feishu' as const,connectionId:record.id,appId:record.appId,tenantId:binding.connection.tenantId,bindingVersion:binding.bindingVersion};
  // Provider page tokens never establish a read grant; this endpoint is manager-only.
  const page=await binding.conversation.listJoinedGroups(q.cursor?{cursor:String(q.cursor)}:{});this.assertCurrent(w,e,{...base,kind:'group',id:'validation',label:''});
  const rows=this.store.all<{person_json:string}>('SELECT u.person_json FROM directory_snapshot_users u JOIN directory_sync_tasks t ON t.id=u.task_id WHERE t.workspace_id=? AND t.invalidated=0 AND t.connection_id=? AND (length(?)=0 OR instr(u.person_json,?)>0) LIMIT 1001',w,record.id,q.q??'',q.q??'');
  const people=rows.flatMap(row=>{const p=JSON.parse(row.person_json)as{displayName:string;status?:string;id:{id:string;namespace:string;applicationId?:string};aliases:{id:string;namespace:string;applicationId?:string}[]};if(p.status==='inactive')return[];const id=[p.id,...p.aliases].find(i=>i.namespace==='open_id'&&(!i.applicationId||i.applicationId===record.appId));return id&&(!q.q||p.displayName.includes(String(q.q)))?[this.issue(w,e,{...base,kind:'person',id:id.id,namespace:'open_id',label:p.displayName})]:[];});
  return{connections,groups:page.items.map(g=>this.issue(w,e,{...base,kind:'group',id:g.id,label:g.name??'未提供群名'})),people:people.slice(0,200),peopleTruncated:people.length>200||rows.length>1000,nextCursor:page.nextCursor??null,coverage:'joined_groups'};
 }
}
export function registerSharingConfiguration(app:FastifyInstance,c:GroupSharingConfiguration,o:{role?:'platform'|'runtime';manager:(r:FastifyRequest,w:string,e:string)=>string;relay?:(actor:string,path:string)=>Promise<unknown>}){
 const base='/api/workspaces/:workspaceId/entities/:entityId/group-sharing';
 if(o.role!=='runtime'){
  app.get(base,r=>{const p=r.params as{workspaceId:string;entityId:string};o.manager(r,p.workspaceId,p.entityId);return c.view(p.workspaceId,p.entityId);});
  app.put(base,{bodyLimit:1048576},r=>{const p=r.params as{workspaceId:string;entityId:string};const actor=o.manager(r,p.workspaceId,p.entityId);c.save(p.workspaceId,p.entityId,actor,r.body);return c.view(p.workspaceId,p.entityId);});
 }
 app.get(base+'/candidates',async r=>{const p=r.params as{workspaceId:string;entityId:string},actor=o.manager(r,p.workspaceId,p.entityId);if(o.role==='platform'){if(!o.relay)throw new TaskError(503,'runtime_service_unavailable');return o.relay(actor,r.url);}try{return await c.candidates(p.workspaceId,p.entityId,r.query as Record<string,unknown>);}catch(error){if(error instanceof TaskError)throw error;throw new TaskError(503,'sharing_candidates_unavailable');}});
 app.get(base+'/status',async r=>{const p=r.params as{workspaceId:string;entityId:string},actor=o.manager(r,p.workspaceId,p.entityId);if(o.role==='platform'){if(!o.relay)throw new TaskError(503,'runtime_service_unavailable');return o.relay(actor,r.url);}return{appliedRevision:c.get(p.workspaceId,p.entityId).revision,observedAt:Date.now()};});
}
